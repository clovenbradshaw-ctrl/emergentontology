/**
 * ExperimentEditor — rich HTML body + log-style entries for experiments.
 *
 * Experiments have two content layers:
 *   1. A revision-based HTML body (like wiki/blog) for full experiment write-ups.
 *   2. A log of typed entries (note, dataset, result, chart, link, decision, html).
 *
 * Data flow:
 *   Load  →  GET /eowikicurrent (record_id = contentId) → current state
 *            Fall back to static snapshot if no Xano record.
 *   Save  →  POST /eowiki (INS rev event for body, INS/NUL entry events for log)
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
import { loadState, applyFreshnessUpdate } from '../xano/stateCache';
import { insExpEntry, nulExpEntry, insRevision } from '../eo/events';
import type { ExperimentEntry, WikiRevision, ContentMeta } from '../eo/types';
import { mdToHtml } from '../eo/markdown';
import RichTextEditor from './RichTextEditor';
import MetadataBar from '../components/MetadataBar';

const KINDS: ExperimentEntry['kind'][] = ['note', 'dataset', 'result', 'chart', 'link', 'decision', 'html'];
const KIND_ICONS: Record<string, string> = {
  note: '\uD83D\uDCDD', dataset: '\uD83D\uDCC1', result: '\u2705', chart: '\uD83D\uDCC8', link: '\uD83D\uDD17', decision: '\u2696\uFE0F', html: '\uD83C\uDF10',
};

interface ExpState {
  entries: ExperimentEntry[];
  meta: Record<string, unknown>;
  current_revision: WikiRevision | null;
  revisions: WikiRevision[];
}

interface ContentEntry {
  content_id: string;
  slug: string;
  title: string;
  content_type: string;
}

interface Props {
  contentId: string;
  siteBase: string;
}

export default function ExperimentEditor({ contentId, siteBase }: Props) {
  const { isAuthenticated } = useAuth();
  const { settings } = useSettings();
  const { registerEvent } = useXRay();

  const [state, setState] = useState<ExpState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const currentRecordRef = useRef<XanoCurrentRecord | null>(null);
  const savedStateRef = useRef<ExpState | null>(null);

  // Entry log state
  const [kind, setKind] = useState<ExperimentEntry['kind']>('note');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  // Rich body state
  const [editorContent, setEditorContent] = useState('');
  const [summary, setSummary] = useState('');
  const savedContentRef = useRef('');
  const [contentEntries, setContentEntries] = useState<ContentEntry[]>([]);

  // ── Load ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);

      // 1. Primary: current state (cached) → static fallback
      const result = await loadState<ExpState>(contentId, siteBase);

      if (cancelled) return;
      if (result.record) currentRecordRef.current = result.record;

      let expState = result.state;

      // Normalize: ensure entries/meta/revisions exist
      if (expState) {
        expState = {
          entries: expState.entries ?? [],
          meta: expState.meta ?? {},
          current_revision: expState.current_revision ?? null,
          revisions: expState.revisions ?? [],
        };
      }

      setState(expState);
      savedStateRef.current = expState;
      setIsDirty(false);

      // Initialize body editor from current revision
      if (expState?.current_revision) {
        const rev = expState.current_revision;
        const html = rev.format === 'markdown' ? mdToHtml(rev.content) : rev.content;
        setEditorContent(html);
        savedContentRef.current = html;
      }

      setLoading(false);

      // 2. Background freshness check: apply any newer events from the log
      if (expState && result.record && (expState.meta as Record<string, unknown>)?.content_type) {
        applyFreshnessUpdate(contentId, expState as unknown as import('../eo/types').ProjectedContent, result.record, {
          persist: true,
          agent: settings.displayName || 'editor',
        }).then(({ updated, hadUpdates }) => {
          if (cancelled || !hadUpdates) return;
          const freshState = updated as unknown as ExpState;
          const normalized: ExpState = {
            entries: freshState.entries ?? [],
            meta: freshState.meta ?? {},
            current_revision: freshState.current_revision ?? null,
            revisions: freshState.revisions ?? [],
          };
          setState(normalized);
          savedStateRef.current = normalized;
          if (normalized.current_revision) {
            const rev = normalized.current_revision;
            const html = rev.format === 'markdown' ? mdToHtml(rev.content) : rev.content;
            setEditorContent(html);
            savedContentRef.current = html;
          }
        }).catch((err) => { console.warn('[ExperimentEditor] freshness check failed:', err); });
      }
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

  // ── Handle body content change ────────────────────────────────────────────

  function handleContentChange(html: string) {
    setEditorContent(html);
    setIsDirty(true);
  }

  // ── Add entry (local only — not saved until "Save") ─────────────────────

  function addEntry() {
    if (!isAuthenticated || !text.trim()) return;
    const entryId = `e_${Date.now()}`;
    const ts = new Date().toISOString();
    const newEntry: ExperimentEntry = {
      entry_id: entryId,
      kind,
      data: kind === 'html' ? { html: text.trim() } : { text: text.trim() },
      ts,
      deleted: false,
    };
    const updatedState: ExpState = {
      meta: state?.meta ?? {},
      entries: [...(state?.entries ?? []), newEntry],
      current_revision: state?.current_revision ?? null,
      revisions: state?.revisions ?? [],
    };
    setState(updatedState);
    setIsDirty(true);
    setText('');
  }

  // ── Delete entry (local only — not saved until "Save") ──────────────────

  function deleteEntry(entryId: string) {
    if (!isAuthenticated) return;
    const updatedState: ExpState = {
      meta: state?.meta ?? {},
      entries: (state?.entries ?? []).filter((e) => e.entry_id !== entryId),
      current_revision: state?.current_revision ?? null,
      revisions: state?.revisions ?? [],
    };
    setState(updatedState);
    setIsDirty(true);
  }

  // ── Save — flush all pending changes to the append-only log ─────────────

  async function save() {
    if (!isAuthenticated || !isDirty || !state) return;
    const saved = savedStateRef.current;
    setSaving(true);
    setError(null);

    const agent = settings.displayName || 'editor';
    const savedEntryIds = new Set((saved?.entries ?? []).map(e => e.entry_id));
    const currentEntryIds = new Set(state.entries.map(e => e.entry_id));

    let newRev: WikiRevision | null = null;

    try {
      // ── Body revision (if content changed) ──────────────────────────────
      const bodyChanged = editorContent !== savedContentRef.current;
      if (bodyChanged) {
        const revId = `r_${Date.now()}`;
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
        await addRecord(eventToPayload(event));
        registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'sent' });

        newRev = { rev_id: revId, format: 'html' as WikiRevision['format'], content: editorContent, summary: summary || 'Edit', ts };
      }

      // ── Entry log events ────────────────────────────────────────────────

      // Emit INS events for new entries
      for (const entry of state.entries) {
        if (savedEntryIds.has(entry.entry_id)) continue;
        const event = insExpEntry(contentId, entry, agent);
        const xid = `ins-entry-${entry.entry_id}`;
        registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'pending' });
        await addRecord(eventToPayload(event));
        registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'sent' });
      }

      // Emit NUL events for deleted entries
      for (const entry of (saved?.entries ?? [])) {
        if (currentEntryIds.has(entry.entry_id)) continue;
        const event = nulExpEntry(contentId, entry.entry_id, agent);
        const xid = `nul-${entry.entry_id}`;
        registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'pending' });
        await addRecord(eventToPayload(event));
        registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'sent' });
      }

      // ── Build updated state snapshot ────────────────────────────────────

      const updatedState: ExpState = {
        meta: state.meta,
        entries: state.entries,
        revisions: newRev ? [...(state.revisions ?? []), newRev] : (state.revisions ?? []),
        current_revision: newRev ?? state.current_revision,
      };

      // Upsert current state snapshot
      const updated = await upsertCurrentRecord(contentId, updatedState, agent, currentRecordRef.current);
      currentRecordRef.current = updated;

      setState(updatedState);
      savedStateRef.current = updatedState;
      savedContentRef.current = editorContent;
      setIsDirty(false);
      setSummary('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="editor-loading">Loading experiment…</div>;

  return (
    <div className="exp-editor">
      <MetadataBar contentId={contentId} />
      <div className="editor-toolbar">
        {isDirty && <span className="dirty-indicator">Unsaved changes</span>}
        <button
          className="btn btn-primary btn-sm"
          onClick={save}
          disabled={!isDirty || saving || !isAuthenticated}
        >
          {saving ? 'Saving\u2026' : 'Save experiment'}
        </button>
      </div>
      {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>&times;</button></div>}

      <section className="exp-body-section">
        <h3>Experiment content</h3>
        <RichTextEditor
          content={editorContent}
          onChange={handleContentChange}
          placeholder="Write up the experiment\u2026"
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
        </div>
      </section>

      <section className="exp-log-section">
        <h3>Experiment log</h3>
        <div className="exp-entry-form">
          <select value={kind} onChange={(e) => setKind(e.target.value as ExperimentEntry['kind'])} className="kind-select">
            {KINDS.map((k) => <option key={k} value={k}>{KIND_ICONS[k]} {k}</option>)}
          </select>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={kind === 'html' ? 'Enter HTML content...' : 'Write a note, observation, result\u2026'}
            rows={4}
            className="entry-textarea"
          />
          <button
            className="btn btn-sm"
            onClick={addEntry}
            disabled={!text.trim() || !isAuthenticated}
          >
            + Add entry
          </button>
        </div>

        <ol className="exp-log">
          {(state?.entries ?? []).length === 0 && (
            <li className="exp-empty">No entries yet. Add one above.</li>
          )}
          {(state?.entries ?? []).map((entry) => (
            <li key={entry.entry_id} className={`exp-log-entry exp-log-${entry.kind}`}>
              <span className="entry-kind-icon" title={entry.kind}>{KIND_ICONS[entry.kind] ?? '\u2022'}</span>
              <div className="entry-content">
                {entry.kind === 'html' ? (
                  <div dangerouslySetInnerHTML={{ __html: String(entry.data.html ?? '') }} />
                ) : (
                  <p>{String(entry.data.text ?? '')}</p>
                )}
                <span className="entry-meta">{new Date(entry.ts).toLocaleString()} &middot; {entry.kind}</span>
              </div>
              <button className="btn-icon" onClick={() => deleteEntry(entry.entry_id)} title="Delete entry">&times;</button>
            </li>
          ))}
        </ol>
      </section>

      {(state?.revisions ?? []).length > 0 && (
        <section className="revision-list">
          <h3>Revisions ({state!.revisions.length})</h3>
          <ol reversed>
            {state!.revisions.slice().reverse().map((r) => (
              <li key={r.rev_id} className="rev-item">
                <span className="rev-id">{r.rev_id}</span>
                <span className="rev-ts">{new Date(r.ts).toLocaleString()}</span>
                <span className="rev-summary">{r.summary || '\u2014'}</span>
                <span className="rev-format-badge">{r.format}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
