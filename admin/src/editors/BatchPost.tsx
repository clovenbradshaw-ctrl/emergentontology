/**
 * BatchPost — Paste-and-execute content editing tool.
 *
 * Two input modes:
 *
 * 1. **Patch Text** (primary): Paste human-readable patches in FIND/REPLACE
 *    format. The converter parses them, auto-maps article names to record_ids
 *    by fetching live records, and generates one bulk JSON.
 *
 * 2. **JSON**: Paste raw JSON edit arrays directly.
 *
 * Patch text format:
 *   PATCH 001 [L] — Article Name, line 13
 *   FIND: old text here
 *   REPLACE: new text here
 *
 *   PATCH 002 [N] — Another Article
 *   FIND: multi-line
 *   find text
 *   REPLACE: multi-line
 *   replace text
 *
 * JSON edit format:
 *   [{ "type": "edit", "record_id": "wiki:slug", "find": "...", "replace": "..." }]
 */

import React, { useState, useCallback, useRef } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useSettings } from '../settings/SettingsContext';
import {
  logEvent,
  upsertCurrentRecord,
  eventToPayload,
  type XanoCurrentRecord,
} from '../xano/client';
import {
  fetchAllCurrentRecordsCached,
  fetchCurrentRecordCached,
  invalidateCurrentCache,
} from '../xano/stateCache';
import { insRevision } from '../eo/events';
import type { EOEvent } from '../eo/types';

// ── Types ──────────────────────────────────────────────────────────────────

interface ParsedPatch {
  id: string;
  category: string;
  article: string;
  find: string;
  replace: string;
}

interface ArticleMapping {
  article: string;
  recordId: string;
  autoMatched: boolean;
  /** All candidate record_ids for the dropdown */
  candidates: Array<{ record_id: string; title: string }>;
}

interface EditOp {
  type: 'edit';
  record_id: string;
  find: string;
  replace: string;
}

interface ResolvedEditGroup {
  record_id: string;
  record: XanoCurrentRecord;
  snapshot: Record<string, unknown>;
  originalContent: string;
  newContent: string;
  edits: EditOp[];
  matchCounts: number[];
}

interface OpResult {
  index: number;
  label: string;
  success: boolean;
  response?: unknown;
  error?: string;
}

// ── Patch text parser ──────────────────────────────────────────────────────

function parsePatchText(text: string): ParsedPatch[] {
  const patches: ParsedPatch[] = [];
  const lines = text.split('\n');

  let current: Partial<ParsedPatch> | null = null;
  let mode: 'idle' | 'find' | 'replace' = 'idle';
  let findLines: string[] = [];
  let replaceLines: string[] = [];
  let globalCounter = 0;
  let currentArticle = 'GLOBAL';

  function saveCurrent() {
    if (current && findLines.length > 0) {
      current.find = findLines.join('\n').trim();
      current.replace = replaceLines.join('\n').trim();
      if (current.find) {
        patches.push(current as ParsedPatch);
      }
    }
    current = null;
    findLines = [];
    replaceLines = [];
    mode = 'idle';
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const trimmed = line.trim();

    // Skip blank lines unless we're inside a multi-line find/replace
    if (!trimmed) {
      if (mode === 'find') findLines.push('');
      else if (mode === 'replace') replaceLines.push('');
      continue;
    }

    // Skip comment / section header lines
    if (/^(END OF PATCHES|Total:|Application order:|Categories:|\*|Do NOT apply|The following|These \d|Each is|Apply these|Order does not)/.test(trimmed)) {
      continue;
    }

    // Section headers like "GLOBAL URL PATCHES [U] — All articles"
    const sectionMatch = trimmed.match(/^GLOBAL\b.*?[—–-]\s*(.+)/i);
    if (sectionMatch) {
      saveCurrent();
      currentArticle = 'ALL';
      continue;
    }

    // PATCH header: "PATCH 001 [L] — Main page, line 13"
    const patchMatch = trimmed.match(
      /^PATCH\s+(\d+)\s*\[(.*?)\]\s*[—–-]+\s*(.+?)(?:,\s*line\s+\d+.*)?$/
    );
    if (patchMatch) {
      saveCurrent();
      currentArticle = patchMatch[3].trim()
        // Clean up suffixes like "(second half)", "(continued)"
        .replace(/\s*\((?:second half|continued)\)\s*$/, '');
      current = {
        id: patchMatch[1],
        category: patchMatch[2],
        article: currentArticle,
      };
      continue;
    }

    // Description line between PATCH header and FIND (e.g. "Section heading rename")
    // — skip if we have a current patch but haven't started FIND yet
    if (current && mode === 'idle' && !trimmed.startsWith('FIND:') && !trimmed.startsWith('REPLACE:')) {
      // Skip description lines like '"formal proof" → "dependency argument"'
      continue;
    }

    // FIND: line
    if (trimmed.startsWith('FIND:')) {
      // If we were in a replace, save the previous patch first
      if (mode === 'replace') {
        saveCurrent();
      }
      // Start a new patch if we don't have one (global patterns)
      if (!current) {
        globalCounter++;
        current = {
          id: `G${globalCounter}`,
          category: 'U',
          article: currentArticle,
        };
      }
      const content = trimmed.slice(5).trim();
      findLines = content ? [content] : [];
      mode = 'find';
      continue;
    }

    // REPLACE: line
    if (trimmed.startsWith('REPLACE:')) {
      const content = trimmed.slice(8).trim();
      replaceLines = content ? [content] : [];
      mode = 'replace';
      continue;
    }

    // Continuation of find or replace
    if (mode === 'find') {
      findLines.push(line);
    } else if (mode === 'replace') {
      replaceLines.push(line);
    }
  }

  saveCurrent();
  return patches.filter(p => p.find.length > 0);
}

// ── Article name → record_id matching ──────────────────────────────────────

function autoMatchArticle(
  articleName: string,
  records: XanoCurrentRecord[],
): string | null {
  const lower = articleName.toLowerCase().trim();

  // Direct slug match: "NUL article" → wiki:nul, "REC article" → wiki:rec
  const slugFromName = lower
    .replace(/\s*article\s*$/, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  for (const r of records) {
    if (r.record_id === `wiki:${slugFromName}`) return r.record_id;
  }

  // Match by title in metadata
  for (const r of records) {
    try {
      const snap = JSON.parse(r.values);
      const title = ((snap.meta?.title as string) || '').toLowerCase();
      // Exact title match
      if (title === lower) return r.record_id;
      // "Main page" → record with "emergent ontology" in title
      if (lower === 'main page' && title.includes('emergent ontology')) return r.record_id;
      // Article name is substring of title
      if (title.includes(lower)) return r.record_id;
      // Title is substring of article name
      if (lower.includes(title) && title.length > 3) return r.record_id;
    } catch { /* skip */ }
  }

  // Try matching record_id slug more loosely
  const words = lower.split(/[\s-]+/).filter(w => w.length > 2 && w !== 'article' && w !== 'the');
  for (const r of records) {
    const rid = r.record_id.toLowerCase();
    if (words.every(w => rid.includes(w))) return r.record_id;
  }

  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countMatches(text: string, find: string, cs: boolean): number {
  if (!find) return 0;
  const m = text.match(new RegExp(escapeRegex(find), cs ? 'g' : 'gi'));
  return m ? m.length : 0;
}

function applyReplace(text: string, find: string, replace: string, cs: boolean): string {
  return text.replace(new RegExp(escapeRegex(find), cs ? 'g' : 'gi'), replace);
}

function getRevisionContent(snapshot: Record<string, unknown>): string | null {
  const rev = snapshot.current_revision as Record<string, unknown> | null;
  if (rev && typeof rev.content === 'string') return rev.content;
  return null;
}

function simpleDiff(oldText: string, newText: string): Array<{ type: 'same' | 'del' | 'add'; text: string }> {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: Array<{ type: 'same' | 'del' | 'add'; text: string }> = [];
  const m = oldLines.length;
  const n = newLines.length;
  if (m + n > 2000) {
    return [
      { type: 'del', text: `[${m} lines - too large for inline diff]` },
      { type: 'add', text: `[${n} lines - too large for inline diff]` },
    ];
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const diff: Array<{ type: 'same' | 'del' | 'add'; text: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diff.unshift({ type: 'same', text: oldLines[i - 1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ type: 'add', text: newLines[j - 1] }); j--;
    } else {
      diff.unshift({ type: 'del', text: oldLines[i - 1] }); i--;
    }
  }
  const CONTEXT = 3;
  const hasChange = diff.map(d => d.type !== 'same');
  for (let idx = 0; idx < diff.length; idx++) {
    if (diff[idx].type !== 'same') { result.push(diff[idx]); continue; }
    let near = false;
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(diff.length - 1, idx + CONTEXT); k++) {
      if (hasChange[k]) { near = true; break; }
    }
    if (near) { result.push(diff[idx]); }
    else if (result.length === 0 || result[result.length - 1].text !== '\u22EF') {
      result.push({ type: 'same', text: '\u22EF' });
    }
  }
  return result;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\u2026' : s;
}

// ── Component ──────────────────────────────────────────────────────────────

interface Props {
  siteBase: string;
}

export default function BatchPost({ siteBase }: Props) {
  const { isAuthenticated } = useAuth();
  const { settings } = useSettings();

  // ── Mode toggle ────────────────────────────────────────────────────────
  const [mode, setMode] = useState<'patches' | 'json'>('patches');

  // ── Patch converter state ──────────────────────────────────────────────
  const [patchText, setPatchText] = useState('');
  const [parsedPatches, setParsedPatches] = useState<ParsedPatch[]>([]);
  const [articleMappings, setArticleMappings] = useState<ArticleMapping[]>([]);
  const [allRecords, setAllRecords] = useState<XanoCurrentRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [parseStatus, setParseStatus] = useState<string | null>(null);

  // ── JSON / execution state ─────────────────────────────────────────────
  const [jsonInput, setJsonInput] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [results, setResults] = useState<OpResult[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const abortRef = useRef(false);
  const [editGroups, setEditGroups] = useState<ResolvedEditGroup[]>([]);
  const [skippedRecords, setSkippedRecords] = useState<string[]>([]);
  const [validated, setValidated] = useState(false);

  // ── Parse patch text ───────────────────────────────────────────────────

  const doParsePatchText = useCallback(async () => {
    setParseStatus(null);
    setParsedPatches([]);
    setArticleMappings([]);

    if (!patchText.trim()) {
      setParseStatus('Paste patch text first.');
      return;
    }

    const patches = parsePatchText(patchText);
    if (patches.length === 0) {
      setParseStatus('No patches found. Check the format (need FIND: / REPLACE: blocks).');
      return;
    }
    setParsedPatches(patches);

    // Get unique article names
    const articleNames = [...new Set(patches.map(p => p.article))];

    // Fetch records for auto-mapping
    setLoadingRecords(true);
    let records: XanoCurrentRecord[] = allRecords;
    if (records.length === 0) {
      try {
        invalidateCurrentCache();
        records = await fetchAllCurrentRecordsCached();
        setAllRecords(records);
      } catch (err) {
        setParseStatus(`Failed to load records: ${err instanceof Error ? err.message : String(err)}`);
        setLoadingRecords(false);
        return;
      }
    }
    setLoadingRecords(false);

    // Build candidate list for dropdowns
    const candidates = records
      .filter(r => r.record_id !== 'site:index')
      .map(r => {
        let title = r.record_id;
        try {
          const snap = JSON.parse(r.values);
          title = (snap.meta?.title as string) || r.record_id;
        } catch { /* use record_id */ }
        return { record_id: r.record_id, title };
      })
      .sort((a, b) => a.title.localeCompare(b.title));

    // Auto-map each article name
    const mappings: ArticleMapping[] = articleNames.map(name => {
      if (name === 'ALL') {
        return {
          article: name,
          recordId: '__ALL__',
          autoMatched: true,
          candidates,
        };
      }
      const match = autoMatchArticle(name, records);
      return {
        article: name,
        recordId: match || '',
        autoMatched: !!match,
        candidates,
      };
    });

    setArticleMappings(mappings);
    const matched = mappings.filter(m => m.recordId).length;
    const total = mappings.length;
    setParseStatus(`Parsed ${patches.length} patches across ${total} articles. Auto-matched ${matched}/${total}.`);
  }, [patchText, allRecords]);

  // ── Update article mapping ─────────────────────────────────────────────

  const updateMapping = useCallback((article: string, recordId: string) => {
    setArticleMappings(prev =>
      prev.map(m => m.article === article ? { ...m, recordId, autoMatched: false } : m)
    );
  }, []);

  // ── Generate JSON from patches ─────────────────────────────────────────

  const generateJson = useCallback(() => {
    // Check all articles are mapped
    const unmapped = articleMappings.filter(m => !m.recordId);
    if (unmapped.length > 0) {
      setParseStatus(`Missing record_id for: ${unmapped.map(m => m.article).join(', ')}`);
      return;
    }

    // Build article → record_ids map
    const articleToRecordIds = new Map<string, string[]>();
    for (const m of articleMappings) {
      if (m.recordId === '__ALL__') {
        // "ALL" means apply to every record
        const allIds = m.candidates.map(c => c.record_id);
        articleToRecordIds.set(m.article, allIds);
      } else {
        articleToRecordIds.set(m.article, [m.recordId]);
      }
    }

    // Generate edit ops
    const edits: EditOp[] = [];
    for (const patch of parsedPatches) {
      const recordIds = articleToRecordIds.get(patch.article) || [];
      for (const rid of recordIds) {
        edits.push({
          type: 'edit',
          record_id: rid,
          find: patch.find,
          replace: patch.replace,
        });
      }
    }

    const json = JSON.stringify(edits, null, 2);
    setJsonInput(json);
    setMode('json');
    setValidated(false);
    setEditGroups([]);
    setResults([]);
    setParseStatus(null);
    setParseError(null);
  }, [parsedPatches, articleMappings]);

  // ── Validate JSON & resolve ────────────────────────────────────────────

  const doValidate = useCallback(async () => {
    setParseError(null);
    setResults([]);
    setEditGroups([]);
    setSkippedRecords([]);
    setValidated(false);

    if (!jsonInput.trim()) { setParseError('Paste or generate a JSON payload first.'); return; }

    let ops: EditOp[];
    try {
      const data = JSON.parse(jsonInput);
      ops = Array.isArray(data) ? data : [data];
    } catch (err) {
      setParseError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!op?.type || op.type !== 'edit') { setParseError(`Op ${i}: type must be "edit"`); return; }
      if (!op.record_id) { setParseError(`Op ${i}: missing record_id`); return; }
      if (typeof op.find !== 'string') { setParseError(`Op ${i}: missing find`); return; }
      if (typeof op.replace !== 'string') { setParseError(`Op ${i}: missing replace`); return; }
    }

    // Group by record_id
    const byRecord = new Map<string, EditOp[]>();
    for (const op of ops) {
      const arr = byRecord.get(op.record_id) || [];
      arr.push(op);
      byRecord.set(op.record_id, arr);
    }

    setResolving(true);
    try {
      invalidateCurrentCache();
      const groups: ResolvedEditGroup[] = [];
      const skipped: string[] = [];

      for (const [recordId, recordEdits] of byRecord) {
        const rec = await fetchCurrentRecordCached(recordId);
        if (!rec) {
          skipped.push(recordId);
          continue;
        }

        let snapshot: Record<string, unknown>;
        try { snapshot = JSON.parse(rec.values); } catch {
          skipped.push(`${recordId} (bad snapshot)`);
          continue;
        }

        const originalContent = getRevisionContent(snapshot);
        if (originalContent === null) {
          // Skip records without revision content (pages, etc.)
          continue;
        }

        let content = originalContent;
        const matchCounts: number[] = [];
        for (const edit of recordEdits) {
          const count = countMatches(content, edit.find, true);
          matchCounts.push(count);
          if (count > 0) {
            content = applyReplace(content, edit.find, edit.replace, true);
          }
        }

        // Skip records where nothing matched
        const totalMatches = matchCounts.reduce((a, b) => a + b, 0);
        if (totalMatches === 0) continue;

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
      setSkippedRecords(skipped);
    } catch (err) {
      setParseError(`Resolve failed: ${err instanceof Error ? err.message : String(err)}`);
      setResolving(false);
      return;
    }
    setResolving(false);
    setValidated(true);
  }, [jsonInput]);

  // ── Execute ────────────────────────────────────────────────────────────

  const doExecute = useCallback(async () => {
    setExecuting(true);
    setResults([]);
    abortRef.current = false;
    setProgress({ done: 0, total: editGroups.length });

    const agent = settings.displayName || 'batch-post';
    const allResults: OpResult[] = [];

    for (let gi = 0; gi < editGroups.length; gi++) {
      if (abortRef.current) {
        allResults.push({ index: gi, label: `edit: ${editGroups[gi].record_id}`, success: false, error: 'Aborted' });
        setProgress({ done: gi + 1, total: editGroups.length });
        setResults([...allResults]);
        continue;
      }

      const group = editGroups[gi];
      try {
        if (group.originalContent === group.newContent) {
          allResults.push({ index: gi, label: `edit: ${group.record_id}`, success: true, response: 'No changes' });
        } else {
          const snapshot = { ...group.snapshot };
          const oldRev = snapshot.current_revision as Record<string, unknown>;
          const newRevId = `r_${Date.now()}_${gi}`;
          const ts = new Date().toISOString();
          const format = (oldRev.format as string) || 'html';
          const matchTotal = group.matchCounts.reduce((a, b) => a + b, 0);
          const summary = `Batch edit: ${matchTotal} replacement${matchTotal !== 1 ? 's' : ''}`;

          const newRev = { ...oldRev, rev_id: newRevId, content: group.newContent, summary, ts };
          snapshot.current_revision = newRev;
          const revisions = [...((snapshot.revisions || []) as Array<Record<string, unknown>>), newRev];
          snapshot.revisions = revisions;
          const meta = { ...((snapshot.meta || {}) as Record<string, unknown>), updated_at: ts };
          snapshot.meta = meta;

          const event = insRevision(group.record_id, {
            rev_id: newRevId,
            format: format as 'markdown' | 'html',
            content: group.newContent,
            summary,
            ts,
          }, agent);
          // 1. Upsert current-state snapshot (authoritative)
          const result = await upsertCurrentRecord(group.record_id, snapshot, agent, group.record);

          // 2. Fire-and-forget: log event for change tracking
          logEvent(eventToPayload(event));

          allResults.push({
            index: gi,
            label: `edit: ${group.record_id} (${matchTotal} replacements)`,
            success: true,
            response: { id: result.id, record_id: result.record_id },
          });
        }
      } catch (err) {
        allResults.push({
          index: gi,
          label: `edit: ${group.record_id}`,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      setProgress({ done: gi + 1, total: editGroups.length });
      setResults([...allResults]);
    }

    invalidateCurrentCache();
    setExecuting(false);
  }, [editGroups, settings.displayName]);

  const doAbort = useCallback(() => { abortRef.current = true; }, []);

  // ── Computed values ────────────────────────────────────────────────────
  const totalEdits = editGroups.reduce((s, g) => s + g.matchCounts.reduce((a, b) => a + b, 0), 0);
  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;
  const unmappedCount = articleMappings.filter(m => !m.recordId).length;
  const uniqueArticles = [...new Set(parsedPatches.map(p => p.article))];

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="batch-post">
      <div className="batch-post-header">
        <h2>Batch Post</h2>
        <p className="batch-post-desc">
          Paste patches or JSON to edit wiki/blog content in bulk.
          Fetches current content, shows diffs, and executes as new revisions.
        </p>
      </div>

      {/* Mode tabs */}
      <div className="batch-post-tabs">
        <button
          className={`batch-post-tab ${mode === 'patches' ? 'active' : ''}`}
          onClick={() => setMode('patches')}
        >
          Patch Text
        </button>
        <button
          className={`batch-post-tab ${mode === 'json' ? 'active' : ''}`}
          onClick={() => setMode('json')}
        >
          JSON
        </button>
      </div>

      {/* ── Patch Text Mode ──────────────────────────────────────────── */}
      {mode === 'patches' && (
        <div className="batch-post-converter">
          <div className="batch-post-input">
            <label className="field">
              <span>Patch Text</span>
              <textarea
                className="batch-post-textarea"
                value={patchText}
                onChange={e => { setPatchText(e.target.value); setParsedPatches([]); setArticleMappings([]); setParseStatus(null); }}
                placeholder={'PATCH 001 [L] \u2014 Article Name, line 13\nFIND: old text here\nREPLACE: new text here\n\nPATCH 002 [N] \u2014 Another Article\nFIND: another find\nREPLACE: another replace'}
                spellCheck={false}
              />
            </label>
            <div className="batch-post-input-actions">
              <button
                className="btn btn-primary"
                onClick={doParsePatchText}
                disabled={!patchText.trim() || loadingRecords}
              >
                {loadingRecords ? 'Loading records\u2026' : 'Parse & Map Articles'}
              </button>
              <button
                className="btn btn-sm"
                onClick={() => { setPatchText(''); setParsedPatches([]); setArticleMappings([]); setParseStatus(null); }}
                disabled={!patchText}
              >
                Clear
              </button>
              {patchText && (
                <span className="batch-post-size">
                  {(new TextEncoder().encode(patchText).length / 1024).toFixed(1)} KB
                </span>
              )}
            </div>
          </div>

          {parseStatus && (
            <div className="batch-post-status">{parseStatus}</div>
          )}

          {/* Parsed patches summary + article mapping */}
          {parsedPatches.length > 0 && articleMappings.length > 0 && (
            <div className="batch-post-mapping">
              <h3>Article Mapping ({articleMappings.length} articles, {parsedPatches.length} patches)</h3>
              <p className="batch-post-mapping-desc">
                Map each article name to its record_id. Auto-matched entries are pre-filled.
                {unmappedCount > 0 && <strong> {unmappedCount} need manual mapping.</strong>}
              </p>

              <div className="batch-post-mapping-list">
                {articleMappings.map(m => {
                  const patchCount = parsedPatches.filter(p => p.article === m.article).length;
                  return (
                    <div
                      key={m.article}
                      className={`batch-post-mapping-row ${!m.recordId ? 'batch-post-mapping-unmapped' : ''}`}
                    >
                      <div className="batch-post-mapping-article">
                        <span className="batch-post-mapping-name">{m.article}</span>
                        <span className="batch-post-mapping-count">{patchCount} patch{patchCount !== 1 ? 'es' : ''}</span>
                      </div>
                      {m.article === 'ALL' ? (
                        <div className="batch-post-mapping-all">
                          All records ({m.candidates.length})
                        </div>
                      ) : (
                        <select
                          className="batch-post-mapping-select"
                          value={m.recordId}
                          onChange={e => updateMapping(m.article, e.target.value)}
                        >
                          <option value="">-- select record --</option>
                          {m.candidates.map(c => (
                            <option key={c.record_id} value={c.record_id}>
                              {c.title} ({c.record_id})
                            </option>
                          ))}
                        </select>
                      )}
                      {m.autoMatched && m.recordId && m.recordId !== '__ALL__' && (
                        <span className="batch-post-mapping-auto">auto</span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Patch preview */}
              <details className="batch-post-patch-preview">
                <summary>Preview all {parsedPatches.length} patches</summary>
                <div className="batch-post-patch-list">
                  {parsedPatches.map((p, i) => (
                    <div key={i} className="batch-post-patch-item">
                      <div className="batch-post-patch-header">
                        <span className="batch-post-op-index">#{p.id}</span>
                        <span className={`gsr-badge gsr-badge-${p.category === 'L' ? 'wiki' : p.category === 'N' ? 'blog' : 'page'}`}>
                          {p.category}
                        </span>
                        <span className="batch-post-op-target">{p.article}</span>
                      </div>
                      <div className="batch-post-edit-item">
                        <span className="batch-post-edit-find">{truncate(p.find, 120)}</span>
                        <span className="batch-post-edit-arrow">&rarr;</span>
                        <span className="batch-post-edit-replace">{truncate(p.replace, 120)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </details>

              {/* Generate JSON button */}
              <div className="batch-post-generate">
                <button
                  className="btn btn-primary"
                  onClick={generateJson}
                  disabled={unmappedCount > 0}
                >
                  Generate JSON ({parsedPatches.length} patches)
                </button>
                {unmappedCount > 0 && (
                  <span className="batch-post-warn-inline">
                    Map all articles first
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── JSON Mode ────────────────────────────────────────────────── */}
      {mode === 'json' && (
        <>
          <div className="batch-post-input">
            <label className="field">
              <span>JSON Payload</span>
              <textarea
                className="batch-post-textarea"
                value={jsonInput}
                onChange={e => { setJsonInput(e.target.value); setValidated(false); setParseError(null); }}
                placeholder={'[\n  { "type": "edit", "record_id": "wiki:my-article", "find": "old text", "replace": "new text" }\n]'}
                spellCheck={false}
              />
            </label>
            <div className="batch-post-input-actions">
              <button className="btn btn-primary" onClick={doValidate} disabled={!jsonInput.trim() || resolving}>
                {resolving ? 'Resolving\u2026' : 'Validate & Preview'}
              </button>
              <button
                className="btn btn-sm"
                onClick={() => { setJsonInput(''); setValidated(false); setEditGroups([]); setSkippedRecords([]); setParseError(null); setResults([]); }}
                disabled={!jsonInput}
              >
                Clear
              </button>
              {jsonInput && (
                <span className="batch-post-size">
                  {(new TextEncoder().encode(jsonInput).length / 1024).toFixed(1)} KB
                </span>
              )}
            </div>
          </div>

          {parseError && (
            <div className="error-banner">
              {parseError}
              <button onClick={() => setParseError(null)}>&times;</button>
            </div>
          )}

          {skippedRecords.length > 0 && (
            <div className="error-banner" style={{ background: 'var(--warning-bg, #fef3c7)', borderColor: 'var(--warning-border, #f59e0b)', color: 'var(--warning-text, #92400e)' }}>
              <strong>Skipped {skippedRecords.length} record{skippedRecords.length !== 1 ? 's' : ''} (not found):</strong>{' '}
              {skippedRecords.join(', ')}
              <button onClick={() => setSkippedRecords([])}>&times;</button>
            </div>
          )}

          {/* Validated preview */}
          {validated && (
            <div className="batch-post-preview">
              <div className="batch-post-preview-header">
                <h3>
                  {editGroups.length} record{editGroups.length !== 1 ? 's' : ''} with changes ({totalEdits} total replacement{totalEdits !== 1 ? 's' : ''})
                </h3>
                <div className="batch-post-preview-actions">
                  <button
                    className="btn btn-primary btn-danger-confirm"
                    onClick={doExecute}
                    disabled={executing || !isAuthenticated || editGroups.length === 0}
                    title={!isAuthenticated ? 'Login required' : undefined}
                  >
                    {executing
                      ? `Executing\u2026 (${progress.done}/${progress.total})`
                      : `Execute all`
                    }
                  </button>
                  {executing && <button className="btn btn-sm" onClick={doAbort}>Abort</button>}
                  {!isAuthenticated && <span className="gsr-auth-warn">Login required</span>}
                </div>
              </div>

              {editGroups.map(group => {
                const groupMatches = group.matchCounts.reduce((a, b) => a + b, 0);
                const withMatches = group.edits.filter((_, i) => group.matchCounts[i] > 0);
                return (
                  <div key={group.record_id} className="batch-post-group">
                    <div className="batch-post-group-header">
                      <span className="gsr-badge gsr-badge-wiki">edit</span>
                      <span className="batch-post-op-target">{group.record_id}</span>
                      <span className="batch-post-group-stats">
                        {withMatches.length} of {group.edits.length} edits matched, {groupMatches} replacement{groupMatches !== 1 ? 's' : ''}
                      </span>
                    </div>

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
                );
              })}
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
                    {r.response != null && (
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

          {executing && progress.total > 0 && (
            <div className="batch-post-progress">
              <div className="batch-post-progress-bar" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
