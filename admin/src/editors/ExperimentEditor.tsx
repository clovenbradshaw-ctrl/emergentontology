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
  fetchCurrentRecord,
  addRecord,
  upsertCurrentRecord,
  eventToPayload,
  type XanoCurrentRecord,
} from '../xano/client';
import { insExpEntry, nulExpEntry } from '../eo/events';
import type { ExperimentEntry } from '../eo/types';

const KINDS: ExperimentEntry['kind'][] = ['note', 'dataset', 'result', 'chart', 'link', 'decision'];
const KIND_ICONS: Record<string, string> = {
  note: '📝', dataset: '📊', result: '✅', chart: '📈', link: '🔗', decision: '⚖️',
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
  const currentRecordRef = useRef<XanoCurrentRecord | null>(null);

  const [kind, setKind] = useState<ExperimentEntry['kind']>('note');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  // ── Load ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      let expState: ExpState | null = null;

      // 1. Try Xano current record
      try {
        const rec = await fetchCurrentRecord(contentId);
        if (rec) {
          currentRecordRef.current = rec;
          expState = JSON.parse(rec.values) as ExpState;
        }
      } catch (err) {
        console.warn('[ExperimentEditor] Could not fetch Xano current record:', err);
      }

      // 2. Fall back to static snapshot
      if (!expState) {
        try {
          const fileName = contentId.replace(':', '-') + '.json';
          const resp = await fetch(`${siteBase}/generated/state/content/${fileName}`);
          if (resp.ok) {
            const snap = await resp.json() as { entries?: ExperimentEntry[]; meta?: Record<string, unknown> };
            expState = { entries: snap.entries ?? [], meta: snap.meta ?? {} };
          }
        } catch { /* no snapshot */ }
      }

      if (!cancelled) {
        setState(expState);
        setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [contentId, siteBase]);

  // ── Add entry ─────────────────────────────────────────────────────────────

  async function addEntry() {
    if (!isAuthenticated || !text.trim()) return;
    setSaving(true);
    setError(null);

    const entryId = `e_${Date.now()}`;
    const ts = new Date().toISOString();
    const entry: Omit<ExperimentEntry, 'deleted' | '_event_id'> = {
      entry_id: entryId,
      kind,
      data: { text: text.trim() },
      ts,
    };
    const event = insExpEntry(contentId, entry, settings.displayName || 'editor');
    const xid = `ins-entry-${entryId}`;
    registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'pending' });

    try {
      await addRecord(eventToPayload(event));
      registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'sent' });

      const newEntry: ExperimentEntry = { ...entry, deleted: false };
      const updatedState: ExpState = {
        meta: state?.meta ?? {},
        entries: [...(state?.entries ?? []), newEntry],
      };
      const updated = await upsertCurrentRecord(contentId, updatedState, 'editor', currentRecordRef.current);
      currentRecordRef.current = updated;
      setState(updatedState);
      setText('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'error', error: msg });
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  // ── Delete entry ──────────────────────────────────────────────────────────

  async function deleteEntry(entryId: string) {
    if (!isAuthenticated) return;
    const event = nulExpEntry(contentId, entryId, settings.displayName || 'editor');
    registerEvent({ id: `nul-${entryId}`, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'pending' });
    try {
      await addRecord(eventToPayload(event));
      registerEvent({ id: `nul-${entryId}`, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'sent' });

      const updatedState: ExpState = {
        meta: state?.meta ?? {},
        entries: (state?.entries ?? []).filter((e) => e.entry_id !== entryId),
      };
      const updated = await upsertCurrentRecord(contentId, updatedState, 'editor', currentRecordRef.current);
      currentRecordRef.current = updated;
      setState(updatedState);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (loading) return <div className="editor-loading">Loading experiment…</div>;

  return (
    <div className="exp-editor">
      {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>×</button></div>}

      <div className="exp-entry-form">
        <select value={kind} onChange={(e) => setKind(e.target.value as ExperimentEntry['kind'])} className="kind-select">
          {KINDS.map((k) => <option key={k} value={k}>{KIND_ICONS[k]} {k}</option>)}
        </select>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write a note, observation, result…"
          rows={4}
          className="entry-textarea"
        />
        <button
          className="btn btn-primary"
          onClick={addEntry}
          disabled={!text.trim() || saving || !isAuthenticated}
        >
          {saving ? 'Adding…' : '+ Add entry'}
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
              <p>{String(entry.data.text ?? '')}</p>
              <span className="entry-meta">{new Date(entry.ts).toLocaleString()} · {entry.kind}</span>
            </div>
            <button className="btn-icon" onClick={() => deleteEntry(entry.entry_id)} title="Delete entry">×</button>
          </li>
        ))}
      </ol>
    </div>
  );
}
