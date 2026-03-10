/**
 * BatchPost — Paste JSON payloads and execute them against the Xano API.
 *
 * Primary mode: "edit" operations — simple find/replace on wiki/blog content.
 * Paste a JSON array like:
 *   [
 *     { "type": "edit", "record_id": "wiki:operators", "find": "old text", "replace": "new text" },
 *     { "type": "edit", "record_id": "wiki:operators", "find": "another", "replace": "changed" }
 *   ]
 *
 * The tool groups edits by record_id, fetches current content, applies all
 * replacements, shows a diff preview, and executes everything as one bulk
 * operation (new revision + state upsert per record).
 *
 * Also supports:
 *   - "event"  — append EO events to the event log
 *   - "upsert" — overwrite a current-state snapshot
 *   - "raw"    — direct POST/PATCH to any endpoint
 */

import React, { useState, useCallback, useRef } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useSettings } from '../settings/SettingsContext';
import {
  addRecord,
  upsertCurrentRecord,
  eventToPayload,
  type XanoCurrentRecord,
} from '../xano/client';
import { fetchCurrentRecordCached, invalidateCurrentCache } from '../xano/stateCache';
import { insRevision } from '../eo/events';
import type { EOEvent } from '../eo/types';

// ── Types ──────────────────────────────────────────────────────────────────

interface EditOp {
  type: 'edit';
  record_id: string;
  find: string;
  replace: string;
  /** Case-sensitive match (default: true) */
  case_sensitive?: boolean;
}

interface EventOp {
  type: 'event';
  op: string;
  target: string;
  operand: Record<string, unknown>;
  agent?: string;
  txn?: string;
}

interface UpsertOp {
  type: 'upsert';
  record_id: string;
  snapshot: unknown;
  agent?: string;
}

interface RawOp {
  type: 'raw';
  method: 'POST' | 'PATCH';
  endpoint: string;
  body: Record<string, unknown>;
  id?: number;
}

type BatchOp = EditOp | EventOp | UpsertOp | RawOp;

interface OpResult {
  index: number;
  label: string;
  success: boolean;
  response?: unknown;
  error?: string;
}

/** A resolved edit group: all find/replace pairs for one record, with fetched content. */
interface ResolvedEditGroup {
  record_id: string;
  record: XanoCurrentRecord;
  snapshot: Record<string, unknown>;
  originalContent: string;
  newContent: string;
  edits: EditOp[];
  matchCounts: number[]; // how many times each find was found
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Escape regex special chars for literal matching. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Count occurrences of a literal string in text. */
function countMatches(text: string, find: string, caseSensitive: boolean): number {
  if (!find) return 0;
  const flags = caseSensitive ? 'g' : 'gi';
  const m = text.match(new RegExp(escapeRegex(find), flags));
  return m ? m.length : 0;
}

/** Apply a literal find/replace. */
function applyReplace(text: string, find: string, replace: string, caseSensitive: boolean): string {
  const flags = caseSensitive ? 'g' : 'gi';
  return text.replace(new RegExp(escapeRegex(find), flags), replace);
}

/** Extract the current revision content from a snapshot. */
function getRevisionContent(snapshot: Record<string, unknown>): string | null {
  const rev = snapshot.current_revision as Record<string, unknown> | null;
  if (rev && typeof rev.content === 'string') return rev.content;
  return null;
}

/** Build a simple line-level diff. Returns array of { type, text } segments. */
function simpleDiff(oldText: string, newText: string): Array<{ type: 'same' | 'del' | 'add'; text: string }> {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: Array<{ type: 'same' | 'del' | 'add'; text: string }> = [];

  // Simple LCS-based diff
  const m = oldLines.length;
  const n = newLines.length;

  // For very large content, just show before/after
  if (m + n > 2000) {
    return [
      { type: 'del', text: `[${m} lines removed - too large for inline diff]` },
      { type: 'add', text: `[${n} lines added - too large for inline diff]` },
    ];
  }

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to build diff
  const diff: Array<{ type: 'same' | 'del' | 'add'; text: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diff.unshift({ type: 'same', text: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ type: 'add', text: newLines[j - 1] });
      j--;
    } else {
      diff.unshift({ type: 'del', text: oldLines[i - 1] });
      i--;
    }
  }

  // Collapse consecutive same lines, keeping only context around changes
  const CONTEXT = 3;
  const hasChange = diff.map(d => d.type !== 'same');
  for (let idx = 0; idx < diff.length; idx++) {
    if (diff[idx].type !== 'same') {
      result.push(diff[idx]);
      continue;
    }
    // Check if this same-line is within CONTEXT lines of a change
    let nearChange = false;
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(diff.length - 1, idx + CONTEXT); k++) {
      if (hasChange[k]) { nearChange = true; break; }
    }
    if (nearChange) {
      result.push(diff[idx]);
    } else {
      // Collapse into separator if not already one
      if (result.length === 0 || result[result.length - 1].type !== 'same' || result[result.length - 1].text !== '⋯') {
        result.push({ type: 'same', text: '⋯' });
      }
    }
  }

  return result;
}

// ── Component ──────────────────────────────────────────────────────────────

interface Props {
  siteBase: string;
}

export default function BatchPost({ siteBase }: Props) {
  const { isAuthenticated } = useAuth();
  const { settings } = useSettings();

  const [input, setInput] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [results, setResults] = useState<OpResult[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const abortRef = useRef(false);

  // Resolved state after validation
  const [editGroups, setEditGroups] = useState<ResolvedEditGroup[]>([]);
  const [otherOps, setOtherOps] = useState<BatchOp[]>([]);
  const [validated, setValidated] = useState(false);

  // ── Validate & Resolve ─────────────────────────────────────────────────

  const doValidate = useCallback(async () => {
    setParseError(null);
    setResults([]);
    setEditGroups([]);
    setOtherOps([]);
    setValidated(false);

    if (!input.trim()) {
      setParseError('Paste a JSON payload first.');
      return;
    }

    let ops: BatchOp[];
    try {
      const data = JSON.parse(input);
      ops = Array.isArray(data) ? data : [data];
    } catch (err) {
      setParseError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Validate structure
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!op || typeof op !== 'object' || !('type' in op)) {
        setParseError(`Operation ${i}: missing or invalid "type" (must be "edit", "event", "upsert", or "raw")`);
        return;
      }
      if (op.type === 'edit') {
        if (!op.record_id) { setParseError(`Op ${i}: edit missing "record_id"`); return; }
        if (typeof op.find !== 'string') { setParseError(`Op ${i}: edit missing "find" string`); return; }
        if (typeof op.replace !== 'string') { setParseError(`Op ${i}: edit missing "replace" string`); return; }
      } else if (op.type === 'event') {
        if (!op.op || !op.target || !op.operand) { setParseError(`Op ${i}: event missing op/target/operand`); return; }
      } else if (op.type === 'upsert') {
        if (!op.record_id || op.snapshot === undefined) { setParseError(`Op ${i}: upsert missing record_id/snapshot`); return; }
      } else if (op.type === 'raw') {
        if (!op.method || !op.endpoint || !op.body) { setParseError(`Op ${i}: raw missing method/endpoint/body`); return; }
      } else {
        setParseError(`Op ${i}: unknown type "${(op as { type: string }).type}"`);
        return;
      }
    }

    // Separate edit ops from others
    const edits = ops.filter((o): o is EditOp => o.type === 'edit');
    const others = ops.filter((o): o is Exclude<BatchOp, EditOp> => o.type !== 'edit');

    // Group edits by record_id
    const editsByRecord = new Map<string, EditOp[]>();
    for (const e of edits) {
      const arr = editsByRecord.get(e.record_id) || [];
      arr.push(e);
      editsByRecord.set(e.record_id, arr);
    }

    // Resolve: fetch current content for each record
    if (editsByRecord.size > 0) {
      setResolving(true);
      try {
        invalidateCurrentCache();
        const groups: ResolvedEditGroup[] = [];

        for (const [recordId, recordEdits] of editsByRecord) {
          const rec = await fetchCurrentRecordCached(recordId);
          if (!rec) {
            setParseError(`Record "${recordId}" not found in database. Check the record_id.`);
            setResolving(false);
            return;
          }

          let snapshot: Record<string, unknown>;
          try {
            snapshot = JSON.parse(rec.values);
          } catch {
            setParseError(`Record "${recordId}": failed to parse stored snapshot.`);
            setResolving(false);
            return;
          }

          const originalContent = getRevisionContent(snapshot);
          if (originalContent === null) {
            setParseError(`Record "${recordId}": no current_revision.content found. Edit type only works on wiki/blog content.`);
            setResolving(false);
            return;
          }

          // Apply all edits sequentially
          let content = originalContent;
          const matchCounts: number[] = [];
          for (const edit of recordEdits) {
            const cs = edit.case_sensitive !== false; // default true
            const count = countMatches(content, edit.find, cs);
            matchCounts.push(count);
            if (count > 0) {
              content = applyReplace(content, edit.find, edit.replace, cs);
            }
          }

          groups.push({
            record_id: recordId,
            record: rec,
            snapshot,
            originalContent,
            newContent: content,
            edits: recordEdits,
            matchCounts,
          });
        }

        setEditGroups(groups);
      } catch (err) {
        setParseError(`Failed to resolve edits: ${err instanceof Error ? err.message : String(err)}`);
        setResolving(false);
        return;
      }
      setResolving(false);
    }

    setOtherOps(others);
    setValidated(true);
  }, [input]);

  // ── Execute all ────────────────────────────────────────────────────────

  const doExecute = useCallback(async () => {
    setExecuting(true);
    setResults([]);
    abortRef.current = false;

    const agent = settings.displayName || 'batch-post';
    const allResults: OpResult[] = [];
    const totalOps = editGroups.length + otherOps.length;
    setProgress({ done: 0, total: totalOps });
    let doneCount = 0;

    // 1. Execute edit groups (each group = one record)
    for (const group of editGroups) {
      if (abortRef.current) {
        allResults.push({ index: doneCount, label: `edit: ${group.record_id}`, success: false, error: 'Aborted' });
        doneCount++;
        continue;
      }

      try {
        // Check if anything actually changed
        if (group.originalContent === group.newContent) {
          allResults.push({
            index: doneCount,
            label: `edit: ${group.record_id}`,
            success: true,
            response: 'No changes (all find strings not found)',
          });
          doneCount++;
          setProgress({ done: doneCount, total: totalOps });
          setResults([...allResults]);
          continue;
        }

        const snapshot = { ...group.snapshot };
        const oldRev = snapshot.current_revision as Record<string, unknown>;
        const newRevId = `r_${Date.now()}`;
        const ts = new Date().toISOString();
        const format = (oldRev.format as string) || 'html';
        const summary = `Batch edit: ${group.edits.length} replacement${group.edits.length !== 1 ? 's' : ''}`;

        const newRev = {
          ...oldRev,
          rev_id: newRevId,
          content: group.newContent,
          summary,
          ts,
        };
        snapshot.current_revision = newRev;
        const revisions = (snapshot.revisions || []) as Array<Record<string, unknown>>;
        revisions.push(newRev);
        snapshot.revisions = revisions;

        // Update meta timestamp
        const meta = (snapshot.meta || {}) as Record<string, unknown>;
        meta.updated_at = ts;
        snapshot.meta = meta;

        // 1a. Append INS revision event
        const event = insRevision(group.record_id, {
          rev_id: newRevId,
          format: format as 'markdown' | 'html',
          content: group.newContent,
          summary,
          ts,
        }, agent);
        await addRecord(eventToPayload(event));

        // 1b. Upsert the updated snapshot
        const result = await upsertCurrentRecord(group.record_id, snapshot, agent, group.record);

        allResults.push({
          index: doneCount,
          label: `edit: ${group.record_id} (${group.edits.length} replacements)`,
          success: true,
          response: { id: result.id, record_id: result.record_id },
        });
      } catch (err) {
        allResults.push({
          index: doneCount,
          label: `edit: ${group.record_id}`,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      doneCount++;
      setProgress({ done: doneCount, total: totalOps });
      setResults([...allResults]);
    }

    // 2. Execute other operations (event, upsert, raw)
    for (const op of otherOps) {
      if (abortRef.current) {
        allResults.push({ index: doneCount, label: op.type, success: false, error: 'Aborted' });
        doneCount++;
        continue;
      }

      try {
        let response: unknown;

        if (op.type === 'event') {
          const event: EOEvent = {
            op: op.op as EOEvent['op'],
            target: op.target,
            operand: op.operand,
            ctx: {
              agent: op.agent || agent,
              ts: new Date().toISOString(),
              txn: op.txn || `batch-${Date.now()}-${doneCount}`,
            },
          };
          response = await addRecord(eventToPayload(event));
          allResults.push({ index: doneCount, label: `event: ${op.op} ${op.target}`, success: true, response });
        } else if (op.type === 'upsert') {
          const existing = await fetchCurrentRecordCached(op.record_id);
          response = await upsertCurrentRecord(op.record_id, op.snapshot, op.agent || agent, existing);
          allResults.push({ index: doneCount, label: `upsert: ${op.record_id}`, success: true, response });
        } else if (op.type === 'raw') {
          const XANO_BASE = 'https://xvkq-pq7i-idtl.n7d.xano.io/api:GGzWIVAW';
          const url = op.id ? `${XANO_BASE}/${op.endpoint}/${op.id}` : `${XANO_BASE}/${op.endpoint}`;
          const resp = await fetch(url, {
            method: op.method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(op.body),
            signal: AbortSignal.timeout(15_000),
          });
          if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new Error(`HTTP ${resp.status}: ${body}`);
          }
          response = await resp.json();
          allResults.push({ index: doneCount, label: `raw: ${op.method} ${op.endpoint}`, success: true, response });
        }
      } catch (err) {
        allResults.push({
          index: doneCount,
          label: op.type,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      doneCount++;
      setProgress({ done: doneCount, total: totalOps });
      setResults([...allResults]);
    }

    invalidateCurrentCache();
    setExecuting(false);
  }, [editGroups, otherOps, settings.displayName]);

  const doAbort = useCallback(() => { abortRef.current = true; }, []);

  // ── Template ───────────────────────────────────────────────────────────

  const insertTemplate = useCallback((t: string) => {
    setInput(t);
    setValidated(false);
    setEditGroups([]);
    setOtherOps([]);
    setParseError(null);
    setResults([]);
  }, []);

  const totalEdits = editGroups.reduce((s, g) => s + g.edits.length, 0);
  const totalMatches = editGroups.reduce((s, g) => s + g.matchCounts.reduce((a, b) => a + b, 0), 0);
  const zeroMatchEdits = editGroups.reduce((s, g) => s + g.matchCounts.filter(c => c === 0).length, 0);
  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;

  return (
    <div className="batch-post">
      <div className="batch-post-header">
        <h2>Batch Post</h2>
        <p className="batch-post-desc">
          Paste a JSON array of edits and execute them in bulk. Use <code>"type": "edit"</code> for
          find/replace on wiki/blog content. The tool fetches current content, shows a diff preview,
          and applies all changes as new revisions.
        </p>
      </div>

      {/* Templates */}
      <div className="batch-post-templates">
        <span className="batch-post-templates-label">Templates:</span>
        <button className="btn btn-xs" onClick={() => insertTemplate(JSON.stringify([
          { type: 'edit', record_id: 'wiki:example', find: 'old text here', replace: 'new text here' },
          { type: 'edit', record_id: 'wiki:example', find: 'another phrase', replace: 'replacement phrase' },
          { type: 'edit', record_id: 'wiki:other-article', find: 'find this', replace: 'replace with this' },
        ], null, 2))}>
          Bulk edits
        </button>
        <button className="btn btn-xs" onClick={() => insertTemplate(JSON.stringify([
          { type: 'event', op: 'SIG', target: 'wiki:example', operand: { set: { title: 'New Title' } } },
        ], null, 2))}>
          Event (SIG)
        </button>
        <button className="btn btn-xs" onClick={() => insertTemplate(JSON.stringify([
          { type: 'upsert', record_id: 'wiki:example', snapshot: { meta: { title: 'Example' }, current_revision: { rev_id: 'r_1', format: 'html', content: '<p>Content</p>', summary: '', ts: new Date().toISOString() } } },
        ], null, 2))}>
          Upsert
        </button>
      </div>

      {/* Input area */}
      <div className="batch-post-input">
        <label className="field">
          <span>JSON Payload</span>
          <textarea
            className="batch-post-textarea"
            value={input}
            onChange={e => { setInput(e.target.value); setValidated(false); setParseError(null); }}
            placeholder={'[\n  { "type": "edit", "record_id": "wiki:my-article", "find": "old text", "replace": "new text" },\n  { "type": "edit", "record_id": "wiki:my-article", "find": "another old", "replace": "another new" }\n]'}
            spellCheck={false}
          />
        </label>
        <div className="batch-post-input-actions">
          <button className="btn btn-primary" onClick={doValidate} disabled={!input.trim() || resolving}>
            {resolving ? 'Resolving…' : 'Validate & Preview'}
          </button>
          <button
            className="btn btn-sm"
            onClick={() => { setInput(''); setValidated(false); setEditGroups([]); setOtherOps([]); setParseError(null); setResults([]); }}
            disabled={!input}
          >
            Clear
          </button>
          {input && (
            <span className="batch-post-size">
              {(new TextEncoder().encode(input).length / 1024).toFixed(1)} KB
            </span>
          )}
        </div>
      </div>

      {/* Parse error */}
      {parseError && (
        <div className="error-banner">
          {parseError}
          <button onClick={() => setParseError(null)}>&times;</button>
        </div>
      )}

      {/* Validated preview */}
      {validated && (
        <div className="batch-post-preview">
          {/* Summary bar */}
          <div className="batch-post-preview-header">
            <h3>
              {editGroups.length > 0 && (
                <>{totalEdits} edit{totalEdits !== 1 ? 's' : ''} across {editGroups.length} record{editGroups.length !== 1 ? 's' : ''} ({totalMatches} match{totalMatches !== 1 ? 'es' : ''})</>
              )}
              {otherOps.length > 0 && (
                <>{editGroups.length > 0 ? ' + ' : ''}{otherOps.length} other op{otherOps.length !== 1 ? 's' : ''}</>
              )}
            </h3>
            <div className="batch-post-preview-actions">
              <button
                className="btn btn-primary btn-danger-confirm"
                onClick={doExecute}
                disabled={executing || !isAuthenticated || (totalMatches === 0 && otherOps.length === 0)}
                title={!isAuthenticated ? 'Login required' : totalMatches === 0 && otherOps.length === 0 ? 'No matches found' : undefined}
              >
                {executing
                  ? `Executing… (${progress.done}/${progress.total})`
                  : `Execute all`
                }
              </button>
              {executing && <button className="btn btn-sm" onClick={doAbort}>Abort</button>}
              {!isAuthenticated && <span className="gsr-auth-warn">Login required</span>}
            </div>
          </div>

          {/* Warnings */}
          {zeroMatchEdits > 0 && (
            <div className="batch-post-warn">
              {zeroMatchEdits} edit{zeroMatchEdits !== 1 ? 's' : ''} had no matches (find string not found in current content).
              These will be skipped.
            </div>
          )}

          {/* Edit group diffs */}
          {editGroups.map((group) => (
            <div key={group.record_id} className="batch-post-group">
              <div className="batch-post-group-header">
                <span className="gsr-badge gsr-badge-wiki">edit</span>
                <span className="batch-post-op-target">{group.record_id}</span>
                <span className="batch-post-group-stats">
                  {group.edits.length} replacement{group.edits.length !== 1 ? 's' : ''},
                  {' '}{group.matchCounts.reduce((a, b) => a + b, 0)} match{group.matchCounts.reduce((a, b) => a + b, 0) !== 1 ? 'es' : ''}
                </span>
              </div>

              {/* Edit list with match counts */}
              <div className="batch-post-edit-list">
                {group.edits.map((edit, i) => (
                  <div key={i} className={`batch-post-edit-item ${group.matchCounts[i] === 0 ? 'batch-post-edit-nomatch' : ''}`}>
                    <span className="batch-post-edit-count">{group.matchCounts[i]}x</span>
                    <span className="batch-post-edit-find">{truncate(edit.find, 80)}</span>
                    <span className="batch-post-edit-arrow">&rarr;</span>
                    <span className="batch-post-edit-replace">{truncate(edit.replace, 80)}</span>
                  </div>
                ))}
              </div>

              {/* Diff preview */}
              {group.originalContent !== group.newContent && (
                <details className="batch-post-diff-details">
                  <summary>Show diff</summary>
                  <div className="batch-post-diff">
                    {simpleDiff(group.originalContent, group.newContent).map((seg, i) => (
                      <div key={i} className={`batch-post-diff-line batch-post-diff-${seg.type}`}>
                        <span className="batch-post-diff-marker">
                          {seg.type === 'del' ? '-' : seg.type === 'add' ? '+' : ' '}
                        </span>
                        <span>{seg.text}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          ))}

          {/* Other ops */}
          {otherOps.length > 0 && (
            <div className="batch-post-other-ops">
              <h4>Other operations</h4>
              {otherOps.map((op, i) => (
                <div key={i} className="batch-post-op">
                  <div className="batch-post-op-header">
                    <span className="batch-post-op-index">#{i}</span>
                    <span className={`gsr-badge gsr-badge-${op.type}`}>{op.type}</span>
                    {op.type === 'event' && <><span className="batch-post-op-detail">{op.op}</span><span className="batch-post-op-target">{op.target}</span></>}
                    {op.type === 'upsert' && <span className="batch-post-op-target">{op.record_id}</span>}
                    {op.type === 'raw' && <><span className="batch-post-op-detail">{op.method}</span><span className="batch-post-op-target">{op.endpoint}</span></>}
                  </div>
                  <details className="batch-post-op-details">
                    <summary>Payload</summary>
                    <pre><code>{JSON.stringify(op, null, 2)}</code></pre>
                  </details>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="batch-post-results">
          <h3>Results</h3>
          <div className="batch-post-result-list">
            {results.map((r, i) => (
              <div key={i} className={`batch-post-result ${r.success ? 'batch-post-result-ok' : 'batch-post-result-err'}`}>
                <span className={r.success ? 'gsr-status-ok' : 'gsr-status-err'}>
                  {r.success ? 'OK' : 'ERR'}
                </span>
                <span>{r.label}</span>
                {r.error && <span className="batch-post-op-error">{r.error}</span>}
                {r.response && (
                  <details className="batch-post-op-details">
                    <summary>Response</summary>
                    <pre><code>{JSON.stringify(r.response, null, 2)}</code></pre>
                  </details>
                )}
              </div>
            ))}
          </div>
          {!executing && (
            <div className="batch-post-summary">
              <span className="gsr-status-ok">{successCount} succeeded</span>
              {failCount > 0 && <span className="gsr-status-err">{failCount} failed</span>}
            </div>
          )}
        </div>
      )}

      {/* Progress bar */}
      {executing && progress.total > 0 && (
        <div className="batch-post-progress">
          <div className="batch-post-progress-bar" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
        </div>
      )}
    </div>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
