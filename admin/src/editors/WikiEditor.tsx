/**
 * WikiEditor — rich text editor for wiki pages and blog posts.
 *
 * Data flow:
 *   Load  →  GET /eowikicurrent (record_id = contentId) → current state
 *            Fall back to static snapshot if no Xano record exists yet.
 *   Save  →  POST /eowiki (append INS rev event)
 *            UPSERT /eowikicurrent (update current state snapshot)
 */

import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useSettings } from '../settings/SettingsContext';
import { useXRay } from '../components/XRayOverlay';
import {
  addRecord,
  upsertCurrentRecord,
  eventToPayload,
  type XanoCurrentRecord,
} from '../xano/client';
import { loadState, fetchCurrentRecordCached, applyFreshnessUpdate } from '../xano/stateCache';
import { insRevision } from '../eo/events';
import type { WikiRevision, ContentMeta } from '../eo/types';
import RichTextEditor from './RichTextEditor';
import MetadataBar from '../components/MetadataBar';

interface WikiState {
  meta: Partial<ContentMeta>;
  current_revision: WikiRevision | null;
  revisions: WikiRevision[];
}

interface Props {
  contentId: string;  // e.g. "wiki:operators" or "blog:intro"
  siteBase: string;
}

interface ContentEntry {
  content_id: string;
  slug: string;
  title: string;
  content_type: string;
}

export default function WikiEditor({ contentId, siteBase }: Props) {
  const { isAuthenticated } = useAuth();
  const { settings } = useSettings();
  const { registerEvent } = useXRay();

  const [state, setState] = useState<WikiState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentRecordRef = useRef<XanoCurrentRecord | null>(null);

  const [editorContent, setEditorContent] = useState('');
  const [summary, setSummary] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [contentEntries, setContentEntries] = useState<ContentEntry[]>([]);

  // ── Load current state from Xano (with static snapshot fallback) ──────────

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      // 1. Primary: current state (cached) → static fallback
      const result = await loadState<WikiState>(contentId, siteBase);

      if (cancelled) return;
      if (result.record) currentRecordRef.current = result.record;

      let wikiState = result.state;

      // Normalize static snapshots that may have a different shape
      if (wikiState && !wikiState.revisions) {
        const snap = wikiState as unknown as { meta: ContentMeta; current_revision?: WikiRevision; revisions?: WikiRevision[] };
        wikiState = {
          meta: snap.meta ?? {},
          current_revision: snap.current_revision ?? null,
          revisions: snap.revisions ?? [],
        };
      }

      if (wikiState) {
        setState(wikiState);
        const rev = wikiState.current_revision;
        if (rev) {
          const html = rev.format === 'markdown' ? simpleMarkdownToHtml(rev.content) : rev.content;
          setEditorContent(html);
        }

        // 2. Background freshness check: look for newer events in the log
        if (result.record && wikiState.meta?.content_type) {
          applyFreshnessUpdate(contentId, wikiState as unknown as import('../eo/types').ProjectedContent, result.record, {
            persist: true,
            agent: settings.displayName || 'editor',
          }).then(({ updated, hadUpdates }) => {
            if (cancelled || !hadUpdates) return;
            const freshState = updated as unknown as WikiState;
            setState(freshState);
            const rev = freshState.current_revision;
            if (rev) {
              const html = rev.format === 'markdown' ? simpleMarkdownToHtml(rev.content) : rev.content;
              setEditorContent(html);
            }
          }).catch((err) => { console.warn('[WikiEditor] freshness check failed:', err); });
        }
      }
      setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, [contentId, siteBase, settings.displayName]);

  // ── Load content entries for internal link picker ──────────────────────────

  useEffect(() => {
    async function loadEntries() {
      const result = await loadState<{ entries?: ContentEntry[] }>(
        'site:index',
        siteBase,
        '/generated/state/index.json',
      );
      if (result.state) {
        setContentEntries(result.state.entries ?? []);
      }
    }

    loadEntries();
  }, [siteBase]);

  // ── Warn on unload with unsaved changes ──────────────────────────────────

  useEffect(() => {
    function handler(e: BeforeUnloadEvent) {
      if (isDirty) { e.preventDefault(); e.returnValue = ''; }
    }
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // ── Save revision ──────────────────────────────────────────────────────────

  async function save() {
    if (!isAuthenticated || !isDirty) return;
    setSaving(true);
    setError(null);

    const revId = `r_${Date.now()}`;
    const agent = settings.displayName || 'editor';
    const ts = new Date().toISOString();
    const event = insRevision(contentId, {
      rev_id: revId,
      format: 'html' as WikiRevision['format'],
      content: editorContent,
      summary: summary || 'Edit',
      ts,
    }, agent);

    const xid = `${event.op}-${revId}`;
    registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'pending' });

    try {
      // 1. Append to event log
      await addRecord(eventToPayload(event));
      registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'sent' });

      // 2. Build updated state
      const newRev: WikiRevision = { rev_id: revId, format: 'html' as WikiRevision['format'], content: editorContent, summary: summary || 'Edit', ts };
      const updatedState: WikiState = {
        meta: state?.meta ?? {},
        revisions: [...(state?.revisions ?? []), newRev],
        current_revision: newRev,
      };

      // 3. Upsert current-state record
      const updated = await upsertCurrentRecord(contentId, updatedState, agent, currentRecordRef.current);
      currentRecordRef.current = updated;

      setState(updatedState);
      setIsDirty(false);
      setSummary('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'error', error: msg });
      setError(`Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  // ── Handle content change from RichTextEditor ──────────────────────────────

  function handleContentChange(html: string) {
    setEditorContent(html);
    setIsDirty(true);
  }

  // ── Restore revision ───────────────────────────────────────────────────────

  function restoreRevision(rev: WikiRevision) {
    const html = rev.format === 'markdown' ? simpleMarkdownToHtml(rev.content) : rev.content;
    setEditorContent(html);
    setIsDirty(true);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) return <div className="editor-loading">Loading {contentId}…</div>;

  return (
    <div className="wiki-editor">
      <MetadataBar contentId={contentId} />
      <div className="editor-toolbar">
        {isDirty && <span className="dirty-indicator">Unsaved changes</span>}
      </div>

      {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>&times;</button></div>}

      <RichTextEditor
        content={editorContent}
        onChange={handleContentChange}
        placeholder="Start writing…"
        contentEntries={contentEntries}
      />

      <div className="editor-footer-row">
        <input
          className="summary-input"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Revision summary (optional)"
          maxLength={120}
        />
        <button
          className="btn btn-primary"
          onClick={save}
          disabled={!isDirty || saving || !isAuthenticated}
        >
          {saving ? 'Saving…' : 'Save revision'}
        </button>
      </div>

      {state && state.revisions.length > 0 && (
        <section className="revision-list">
          <h3>Revisions ({state.revisions.length})</h3>
          {!!(state.meta as Record<string, unknown>).first_public_at && (
            <div className="public-since-banner">
              Public since {new Date(String((state.meta as Record<string, unknown>).first_public_at)).toLocaleString()}
              {' — '}revisions after this date are publicly visible
            </div>
          )}
          <ol reversed>
            {state.revisions.slice().reverse().map((r, idx, arr) => {
              const firstPublicAt = String((state.meta as Record<string, unknown>).first_public_at ?? '');
              const isPublicBoundary = firstPublicAt && idx < arr.length - 1 &&
                r.ts >= firstPublicAt && arr[idx + 1].ts < firstPublicAt;
              const prevRev = idx < arr.length - 1 ? arr[idx + 1] : null;
              return (
                <React.Fragment key={r.rev_id}>
                  <RevisionItem
                    rev={r}
                    prevRev={prevRev}
                    isPublic={!!(firstPublicAt && r.ts >= firstPublicAt)}
                    onRestore={() => restoreRevision(r)}
                  />
                  {isPublicBoundary && (
                    <li className="rev-public-divider">
                      <span>&uarr; public</span>
                      <hr />
                      <span>pre-public &darr;</span>
                    </li>
                  )}
                </React.Fragment>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}

// ── Revision item with inline diff ────────────────────────────────────────────

function RevisionItem({ rev, prevRev, isPublic, onRestore }: {
  rev: WikiRevision;
  prevRev: WikiRevision | null;
  isPublic: boolean;
  onRestore: () => void;
}) {
  const [showDiff, setShowDiff] = useState(false);

  return (
    <li className={`rev-item rev-item-expandable${isPublic ? ' rev-public' : ''}`}>
      <div className="rev-item-header">
        <span className="rev-id">{rev.rev_id}</span>
        <span className="rev-ts">{new Date(rev.ts).toLocaleString()}</span>
        <span className="rev-summary">{rev.summary || '—'}</span>
        <span className="rev-format-badge">{rev.format}</span>
        {isPublic && (
          <span className="rev-public-badge" title="Created while content was public">pub</span>
        )}
        {prevRev && (
          <button
            className="btn btn-xs"
            onClick={(e) => { e.stopPropagation(); setShowDiff(!showDiff); }}
          >
            {showDiff ? 'Hide diff' : 'Diff'}
          </button>
        )}
        {!prevRev && <span style={{ color: 'var(--text-dim)', fontSize: '.75rem' }}>initial</span>}
        <button className="btn btn-xs" onClick={onRestore}>Restore</button>
      </div>
      {showDiff && prevRev && (
        <div className="rev-diff">
          <RevisionDiff oldText={prevRev.content} newText={rev.content} />
        </div>
      )}
    </li>
  );
}

/** Simple line-level diff with word-level highlighting for changed lines. */
function RevisionDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const diff = computeLineDiff(oldText, newText);
  if (diff.length === 0) return <div className="rev-diff-empty">No changes</div>;

  return (
    <div className="rev-diff-content">
      {diff.map((chunk, i) => {
        if (chunk.type === 'equal') {
          return <div key={i} className="diff-line diff-ctx">{chunk.line}</div>;
        }
        if (chunk.type === 'removed') {
          return <div key={i} className="diff-line diff-del"><del>{chunk.line}</del></div>;
        }
        if (chunk.type === 'added' && i > 0 && diff[i - 1].type === 'removed') {
          const words = wordDiff(diff[i - 1].line, chunk.line);
          return (
            <div key={i} className="diff-line diff-add">
              {words.map((w, j) =>
                w.type === 'equal' ? <span key={j}>{w.text}</span>
                : w.type === 'added' ? <ins key={j}>{w.text}</ins>
                : null
              )}
            </div>
          );
        }
        return <div key={i} className="diff-line diff-add"><ins>{chunk.line}</ins></div>;
      })}
    </div>
  );
}

function computeLineDiff(oldText: string, newText: string): Array<{ type: 'equal' | 'added' | 'removed'; line: string }> {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: Array<{ type: 'equal' | 'added' | 'removed'; line: string }> = [];

  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const items: Array<{ type: 'equal' | 'added' | 'removed'; line: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      items.push({ type: 'equal', line: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      items.push({ type: 'added', line: newLines[j - 1] });
      j--;
    } else {
      items.push({ type: 'removed', line: oldLines[i - 1] });
      i--;
    }
  }
  items.reverse();

  let lastChange = -1;
  const changeIndices = new Set<number>();
  items.forEach((item, idx) => { if (item.type !== 'equal') changeIndices.add(idx); });
  items.forEach((item, idx) => {
    if (item.type !== 'equal') {
      lastChange = idx;
      result.push(item);
    } else {
      const nearChange = changeIndices.has(idx - 1) || changeIndices.has(idx - 2) || changeIndices.has(idx + 1) || changeIndices.has(idx + 2);
      if (nearChange) {
        result.push(item);
      } else if (lastChange >= 0 && result.length > 0 && result[result.length - 1].type !== 'equal') {
        result.push({ type: 'equal', line: '···' });
      }
    }
  });

  return result;
}

function wordDiff(oldLine: string, newLine: string): Array<{ type: 'equal' | 'added' | 'removed'; text: string }> {
  const oldWords = oldLine.split(/(\s+)/);
  const newWords = newLine.split(/(\s+)/);
  const result: Array<{ type: 'equal' | 'added' | 'removed'; text: string }> = [];

  const m = oldWords.length;
  const n = newWords.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldWords[i - 1] === newWords[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const items: Array<{ type: 'equal' | 'added' | 'removed'; text: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      items.push({ type: 'equal', text: oldWords[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      items.push({ type: 'added', text: newWords[j - 1] });
      j--;
    } else {
      items.push({ type: 'removed', text: oldWords[i - 1] });
      i--;
    }
  }
  items.reverse();

  for (const item of items) {
    if (result.length > 0 && result[result.length - 1].type === item.type) {
      result[result.length - 1].text += item.text;
    } else {
      result.push({ ...item });
    }
  }

  return result;
}

// ── Markdown to HTML converter (for loading legacy markdown revisions) ───────

function simpleMarkdownToHtml(md: string): string {
  // 1. Fenced code blocks
  const codeBlocks: string[] = [];
  let s = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cls = lang ? ` class="language-${lang}"` : '';
    codeBlocks.push(`<pre><code${cls}>${escaped}</code></pre>`);
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });

  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  s = s
    .replace(/^#{4}\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^#{3}\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^#{2}\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^#{1}\s+(.+)$/gm, '<h1>$1</h1>');

  s = s.replace(/^---$/gm, '<hr>');

  s = s.replace(/((?:^[ \t]*[-*]\s+.+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map((l) => `<li>${l.replace(/^[ \t]*[-*]\s+/, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });

  s = s.replace(/((?:^[ \t]*\d+\.\s+.+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map((l) => `<li>${l.replace(/^[ \t]*\d+\.\s+/, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // Tables (pipe syntax)
  s = s.replace(
    /((?:^\|.+\|[ \t]*\n){2,})/gm,
    (tableBlock) => {
      const lines = tableBlock.trim().split('\n');
      if (lines.length < 2) return tableBlock;
      const sepLine = lines[1];
      if (!/^\|[\s\-:|]+\|$/.test(sepLine.trim())) return tableBlock;
      const parseRow = (line: string) =>
        line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c: string) => c.trim());
      const headers = parseRow(lines[0]);
      const headHtml = '<thead><tr>' + headers.map((h: string) => `<th>${h}</th>`).join('') + '</tr></thead>';
      const bodyRows = lines.slice(2).filter((l: string) => l.trim());
      const bodyHtml = '<tbody>' + bodyRows.map((line: string) => {
        const cells = parseRow(line);
        return '<tr>' + cells.map((c: string) => `<td>${c}</td>`).join('') + '</tr>';
      }).join('') + '</tbody>';
      return `<table>${headHtml}${bodyHtml}</table>`;
    }
  );

  s = s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  s = s.replace(/\n\n+/g, '</p><p>');
  s = `<p>${s}</p>`;

  s = s.replace(/\x00CODE(\d+)\x00/g, (_m, i) => codeBlocks[Number(i)]);

  s = s.replace(/<p>(<(?:h[1-6]|ul|ol|hr|pre|blockquote)[^>]*>)/g, '$1');
  s = s.replace(/(<\/(?:h[1-6]|ul|ol|hr|pre|blockquote)>)<\/p>/g, '$1');

  return s;
}
