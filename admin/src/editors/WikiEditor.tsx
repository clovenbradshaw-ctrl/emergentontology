/**
 * WikiEditor — rich text editor for wiki pages and blog posts.
 *
 * Data flow (current-state-first):
 *   Load  →  GET /eowikicurrent (record_id = contentId) → current state
 *            Fall back to static snapshot if no Xano record exists yet.
 *   Save  →  UPSERT /eowikicurrent (update current state — authoritative)
 *            POST /eowiki (fire-and-forget event log for change tracking)
 */

import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useSettings } from '../settings/SettingsContext';
import { useXRay } from '../components/XRayOverlay';
import {
  logEvent,
  upsertCurrentRecord,
  eventToPayload,
  type XanoCurrentRecord,
} from '../xano/client';
import { loadState, fetchCurrentRecordCached, applyFreshnessUpdate } from '../xano/stateCache';
import { insRevision } from '../eo/events';
import type { WikiRevision, ContentMeta } from '../eo/types';
import { mdToHtml } from '../eo/markdown';
import { smartDiff, groupDiffChunks, DIFF_DELETE, DIFF_INSERT, DIFF_EQUAL } from '../eo/smartDiff';
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
  const savedContentRef = useRef(''); // tracks last-saved editor HTML for dirty detection
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
          const html = rev.format === 'markdown' ? mdToHtml(rev.content) : rev.content;
          setEditorContent(html);
          savedContentRef.current = html;
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
              const html = rev.format === 'markdown' ? mdToHtml(rev.content) : rev.content;
              setEditorContent(html);
              savedContentRef.current = html;
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

    // Don't create a revision if content hasn't actually changed
    if (editorContent === savedContentRef.current) {
      setIsDirty(false);
      return;
    }

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
      // 1. Build updated state
      const newRev: WikiRevision = { rev_id: revId, format: 'html' as WikiRevision['format'], content: editorContent, summary: summary || 'Edit', ts };
      const updatedState: WikiState = {
        meta: state?.meta ?? {},
        revisions: [...(state?.revisions ?? []), newRev],
        current_revision: newRev,
      };

      // 2. Upsert current-state record (authoritative)
      const updated = await upsertCurrentRecord(contentId, updatedState, agent, currentRecordRef.current);
      currentRecordRef.current = updated;

      // 3. Fire-and-forget: log event for change tracking
      logEvent(eventToPayload(event));
      registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'sent' });

      setState(updatedState);
      savedContentRef.current = editorContent;
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
    setIsDirty(html !== savedContentRef.current);
  }

  // ── Restore revision ───────────────────────────────────────────────────────

  function restoreRevision(rev: WikiRevision) {
    const html = rev.format === 'markdown' ? mdToHtml(rev.content) : rev.content;
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

/**
 * Character-level diff with semantic cleanup (diff-match-patch).
 *
 * Uses `diff_cleanupSemantic()` to shift edit boundaries to natural
 * word/sentence breaks so that copy-paste-and-tweak workflows produce
 * meaningful, human-legible diffs instead of a wall of red/green.
 */
function RevisionDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const spans = smartDiff(oldText, newText);
  const hasChanges = spans.some(s => s.op !== DIFF_EQUAL);
  if (!hasChanges) return <div className="rev-diff-empty">No changes</div>;

  const chunks = groupDiffChunks(spans);

  return (
    <div className="rev-diff-content">
      {chunks.map((chunk, i) => {
        if (chunk.type === 'equal') {
          return <div key={i} className="diff-line diff-ctx">{chunk.text}</div>;
        }
        // 'change' chunk — render each span inline with del/ins markup.
        return (
          <div key={i} className="diff-line diff-change">
            {chunk.spans!.map((s, j) =>
              s.op === DIFF_DELETE
                ? <del key={j} className="diff-span-del">{s.text}</del>
                : <ins key={j} className="diff-span-ins">{s.text}</ins>
            )}
          </div>
        );
      })}
    </div>
  );
}

