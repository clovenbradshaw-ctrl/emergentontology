/**
 * WikiEditor — markdown editor for wiki pages and blog posts.
 *
 * Load strategy:
 *   1. Fetch pre-built snapshot from /generated/state/content/<id>.json  (fast)
 *   2. Fetch delta events from Matrix since snapshot.meta.updated_at
 *   3. Apply delta on top of snapshot
 *   4. Render editor with current content
 *   5. On save: emit eo.op INS rev event → snapshot stays cached until next build
 */

import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useXRay } from '../components/XRayOverlay';
import { fetchRoomDelta, sendEOEvent, resolveAlias } from '../matrix/client';
import { insRevision, synRevision } from '../eo/events';
import { applyDelta } from '../eo/replay';
import type { ProjectedWiki, ProjectedBlog, WikiRevision } from '../eo/types';

type WikiOrBlog = ProjectedWiki | ProjectedBlog;

interface Props {
  contentId: string;  // e.g. "wiki:operators" or "blog:intro"
  siteBase: string;   // e.g. "" or "/my-repo"
}

export default function WikiEditor({ contentId, siteBase }: Props) {
  const { creds } = useAuth();
  const { registerEvent } = useXRay();

  const [state, setState] = useState<WikiOrBlog | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [syncToken, setSyncToken] = useState<string | undefined>(undefined);

  const [editorContent, setEditorContent] = useState('');
  const [summary, setSummary] = useState('');
  const [isDirty, setIsDirty] = useState(false);

  const snapshotTsRef = useRef<string | undefined>(undefined);

  // ── 1. Load snapshot + delta ───────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      // Load snapshot
      const fileName = contentId.replace(':', '-') + '.json';
      let snapshot: WikiOrBlog | null = null;
      try {
        const resp = await fetch(`${siteBase}/generated/state/content/${fileName}`);
        if (resp.ok) {
          snapshot = await resp.json() as WikiOrBlog;
          snapshotTsRef.current = snapshot.meta.updated_at;
        }
      } catch { /* no snapshot yet */ }

      if (cancelled) return;

      // Resolve room ID
      if (creds) {
        try {
          const serverName = new URL(creds.homeserver).hostname;
          const alias = `#${contentId}:${serverName}`;
          const rid = await resolveAlias(creds.homeserver, alias);
          setRoomId(rid);

          // Fetch delta events since snapshot
          const { events: delta, end } = await fetchRoomDelta(
            creds.homeserver,
            rid,
            undefined,
            creds.access_token
          );
          setSyncToken(end);

          if (snapshot && delta.length > 0) {
            const updated = applyDelta(snapshot, delta as Parameters<typeof applyDelta>[1]);
            snapshot = updated as WikiOrBlog;
          }
        } catch (err) {
          console.warn('[WikiEditor] Could not fetch delta:', err);
        }
      }

      if (cancelled) return;

      if (snapshot) {
        setState(snapshot);
        setEditorContent(snapshot.current_revision?.content ?? '');
      }
      setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, [contentId, creds, siteBase]);

  // ── 2. Save revision ───────────────────────────────────────────────────────

  async function save() {
    if (!creds || !roomId || !isDirty) return;
    setSaving(true);
    setError(null);

    const revId = `r_${Date.now()}`;
    const event = insRevision(contentId, {
      rev_id: revId,
      format: 'markdown',
      content: editorContent,
      summary: summary || 'Edit',
      ts: new Date().toISOString(),
    }, creds.user_id);

    const xrayId = `${event.op}-${revId}`;
    registerEvent({ id: xrayId, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'pending' });

    try {
      const eventId = await sendEOEvent(creds, roomId, event as unknown as Record<string, unknown>, event.ctx.txn);
      registerEvent({ id: xrayId, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'sent' });

      // Optimistically update local state
      const newRev: WikiRevision = { rev_id: revId, format: 'markdown', content: editorContent, summary: summary || 'Edit', ts: event.ctx.ts, _event_id: eventId };
      setState((prev) => {
        if (!prev) return prev;
        const revisions = [...(prev.revisions ?? []), newRev];
        return { ...prev, current_revision: newRev, revisions } as WikiOrBlog;
      });
      setIsDirty(false);
      setSummary('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      registerEvent({ id: xrayId, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'error', error: msg });
      setError(`Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  // ── Conflict resolution ────────────────────────────────────────────────────

  async function resolveConflict(chosenRevId: string) {
    if (!creds || !roomId || !state || !('conflict_candidates' in state)) return;
    const event = synRevision(contentId, chosenRevId, state.conflict_candidates, creds.user_id);
    registerEvent({ id: `syn-${Date.now()}`, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'pending' });
    try {
      await sendEOEvent(creds, roomId, event as unknown as Record<string, unknown>);
      setState((prev) => prev ? { ...prev, has_conflict: false, conflict_candidates: [] } as WikiOrBlog : prev);
    } catch (err) {
      setError(`Conflict resolution failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) return <div className="editor-loading">Loading {contentId}…</div>;

  return (
    <div className="wiki-editor">
      <div className="editor-toolbar">
        <span className="editor-title">{state?.meta.title ?? contentId}</span>
        <div className="editor-status-badges">
          <span className={`badge badge-${state?.meta.status ?? 'draft'}`}>{state?.meta.status ?? 'draft'}</span>
          <span className={`badge badge-${state?.meta.visibility ?? 'private'}`}>{state?.meta.visibility ?? 'private'}</span>
        </div>
        {isDirty && <span className="dirty-indicator">Unsaved changes</span>}
      </div>

      {state && 'has_conflict' in state && state.has_conflict && (
        <div className="conflict-banner">
          <strong>Conflict:</strong> {state.conflict_candidates.length} concurrent revisions.
          {state.revisions.filter((r) => state.conflict_candidates.includes(r.rev_id)).map((r) => (
            <button key={r.rev_id} onClick={() => resolveConflict(r.rev_id)} className="btn btn-sm">
              Keep {r.rev_id} ({r.summary || 'no summary'})
            </button>
          ))}
        </div>
      )}

      {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>×</button></div>}

      <div className="editor-split">
        <div className="editor-pane">
          <textarea
            className="markdown-textarea"
            value={editorContent}
            onChange={(e) => { setEditorContent(e.target.value); setIsDirty(true); }}
            placeholder="Write markdown…"
            spellCheck
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
              disabled={!isDirty || saving || !creds || !roomId}
            >
              {saving ? 'Saving…' : 'Save revision'}
            </button>
          </div>
        </div>

        <div className="preview-pane">
          <div className="preview-label">Preview</div>
          <div
            className="preview-body"
            dangerouslySetInnerHTML={{ __html: simpleMarkdown(editorContent) }}
          />
        </div>
      </div>

      {state && state.revisions.length > 0 && (
        <section className="revision-list">
          <h3>Revisions ({state.revisions.length})</h3>
          <ol reversed>
            {state.revisions.slice().reverse().map((r) => (
              <li key={r.rev_id} className="rev-item">
                <span className="rev-id">{r.rev_id}</span>
                <span className="rev-ts">{new Date(r.ts).toLocaleString()}</span>
                <span className="rev-summary">{r.summary || '—'}</span>
                <button
                  className="btn btn-xs"
                  onClick={() => { setEditorContent(r.content); setIsDirty(true); }}
                >
                  Restore
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function simpleMarkdown(md: string): string {
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^#{4}\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^#{3}\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^#{2}\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^#{1}\s+(.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<)(.+)/m, '<p>$1') + '</p>';
}
