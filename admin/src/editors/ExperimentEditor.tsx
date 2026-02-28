/**
 * ExperimentEditor — log-style editor for experiment entries.
 *
 * Data flow:
 *   Load  →  GET /eowikicurrent (record_id = contentId) → current entries
 *            Fall back to static snapshot if no Xano record.
 *   Add   →  POST /eowiki (INS entry event)
 *            UPSERT /eowikicurrent (update current state)
 *   Delete→  POST /eowiki (NUL entry event)
 *            UPSERT /eowikicurrent (update current state)
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
import { insExpEntry, nulExpEntry } from '../eo/events';
import type { ExperimentEntry } from '../eo/types';
import MetadataBar from '../components/MetadataBar';

const KINDS: ExperimentEntry['kind'][] = ['note', 'dataset', 'result', 'chart', 'link', 'decision', 'html'];
const KIND_ICONS: Record<string, string> = {
  note: '📝', dataset: '📊', result: '✅', chart: '📈', link: '🔗', decision: '⚖️', html: '🌐',
};

interface ExpState {
  entries: ExperimentEntry[];
  meta: Record<string, unknown>;
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

  const [kind, setKind] = useState<ExperimentEntry['kind']>('note');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

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

      // Normalize: ensure entries/meta exist
      if (expState) {
        expState = { entries: expState.entries ?? [], meta: expState.meta ?? {} };
      }

      setState(expState);
      savedStateRef.current = expState;
      setIsDirty(false);
      setLoading(false);

      // 2. Background freshness check: apply any newer events from the log
      if (expState && result.record && (expState.meta as Record<string, unknown>)?.content_type) {
        applyFreshnessUpdate(contentId, expState as unknown as import('../eo/types').ProjectedContent, result.record, {
          persist: true,
          agent: settings.displayName || 'editor',
        }).then(({ updated, hadUpdates }) => {
          if (cancelled || !hadUpdates) return;
          const freshState = updated as unknown as ExpState;
          const normalized = { entries: freshState.entries ?? [], meta: freshState.meta ?? {} };
          setState(normalized);
          savedStateRef.current = normalized;
        }).catch((err) => { console.warn('[ExperimentEditor] freshness check failed:', err); });
      }
    }
    load();
    return () => { cancelled = true; };
  }, [contentId, siteBase, settings.displayName]);

  // ── Warn on unload with unsaved changes ──────────────────────────────────

  useEffect(() => {
    function handler(e: BeforeUnloadEvent) {
      if (isDirty) { e.preventDefault(); e.returnValue = ''; }
    }
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

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

    try {
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

      // Upsert current state snapshot
      const updated = await upsertCurrentRecord(contentId, state, agent, currentRecordRef.current);
      currentRecordRef.current = updated;

      savedStateRef.current = state;
      setIsDirty(false);
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
      {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>×</button></div>}

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
            <span className="entry-kind-icon" title={entry.kind}>{KIND_ICONS[entry.kind] ?? '•'}</span>
            <div className="entry-content">
              <p>{String(entry.kind === 'html' ? (entry.data.html ?? '') : (entry.data.text ?? ''))}</p>
              <span className="entry-meta">{new Date(entry.ts).toLocaleString()} · {entry.kind}</span>
            </div>
            <button className="btn-icon" onClick={() => deleteEntry(entry.entry_id)} title="Delete entry">×</button>
          </li>
        ))}
      </ol>
    </div>
  );
}
