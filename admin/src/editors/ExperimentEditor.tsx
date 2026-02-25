import React, { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useXRay } from '../components/XRayOverlay';
import { fetchRoomDelta, sendEOEvent, resolveAlias } from '../matrix/client';
import { insExpEntry, nulExpEntry } from '../eo/events';
import { applyDelta } from '../eo/replay';
import type { ProjectedExperiment, ExperimentEntry } from '../eo/types';

const KINDS: ExperimentEntry['kind'][] = ['note', 'dataset', 'result', 'chart', 'link', 'decision'];
const KIND_ICONS: Record<string, string> = {
  note: '📝', dataset: '📊', result: '✅', chart: '📈', link: '🔗', decision: '⚖️',
};

interface Props {
  contentId: string;
  siteBase: string;
}

export default function ExperimentEditor({ contentId, siteBase }: Props) {
  const { creds } = useAuth();
  const { registerEvent } = useXRay();

  const [state, setState] = useState<ProjectedExperiment | null>(null);
  const [loading, setLoading] = useState(true);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [kind, setKind] = useState<ExperimentEntry['kind']>('note');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const fileName = contentId.replace(':', '-') + '.json';
      let snapshot: ProjectedExperiment | null = null;

      try {
        const resp = await fetch(`${siteBase}/generated/state/content/${fileName}`);
        if (resp.ok) snapshot = await resp.json() as ProjectedExperiment;
      } catch { /* no snapshot */ }

      if (!cancelled && creds && snapshot) {
        try {
          const serverName = new URL(creds.homeserver).hostname;
          const rid = await resolveAlias(creds.homeserver, `#${contentId}:${serverName}`);
          setRoomId(rid);
          const { events } = await fetchRoomDelta(creds.homeserver, rid, undefined, creds.access_token);
          if (events.length) snapshot = applyDelta(snapshot, events as Parameters<typeof applyDelta>[1]) as ProjectedExperiment;
        } catch { /* use snapshot */ }
      }

      if (!cancelled) {
        setState(snapshot);
        setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [contentId, creds, siteBase]);

  async function addEntry() {
    if (!creds || !roomId || !text.trim()) return;
    setSaving(true);
    setError(null);

    const entryId = `e_${Date.now()}`;
    const entry: Omit<ExperimentEntry, 'deleted' | '_event_id'> = {
      entry_id: entryId,
      kind,
      data: { text: text.trim() },
      ts: new Date().toISOString(),
    };
    const event = insExpEntry(contentId, entry, creds.user_id);
    const xid = `ins-entry-${entryId}`;
    registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'pending' });

    try {
      await sendEOEvent(creds, roomId, event as unknown as Record<string, unknown>, event.ctx.txn);
      registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'sent' });
      setState((prev) => prev ? { ...prev, entries: [...prev.entries, { ...entry, deleted: false }] } : prev);
      setText('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'error', error: msg });
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  async function deleteEntry(entryId: string) {
    if (!creds || !roomId) return;
    const event = nulExpEntry(contentId, entryId, creds.user_id);
    registerEvent({ id: `nul-${entryId}`, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'pending' });
    try {
      await sendEOEvent(creds, roomId, event as unknown as Record<string, unknown>);
      registerEvent({ id: `nul-${entryId}`, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'sent' });
      setState((prev) => prev ? { ...prev, entries: prev.entries.filter((e) => e.entry_id !== entryId) } : prev);
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
          disabled={!text.trim() || saving || !creds || !roomId}
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
