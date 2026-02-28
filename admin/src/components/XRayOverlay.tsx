/**
 * XRayOverlay — Transparency mode.
 *
 * When enabled, attaches a floating panel that shows:
 *   - The raw EO event stream (op, target, operand)
 *   - Component/module topology (which room → which blocks/revs)
 *   - Highlights each DOM element with its operator annotation
 *
 * Activated by clicking the "⊡ X-Ray" button in the header,
 * or pressing Ctrl+Shift+X / Cmd+Shift+X.
 */

import { useState, useEffect, createContext, useContext } from 'react';
import type { HistoryEntry, EOOp } from '../eo/types';

// ── Context ───────────────────────────────────────────────────────────────────

interface XRayState {
  enabled: boolean;
  toggle: () => void;
  registerEvent: (e: XRayEvent) => void;
  events: XRayEvent[];
}

export interface XRayEvent {
  id: string;
  op: EOOp;
  target: string;
  operand: Record<string, unknown>;
  ts: string;
  agent: string;
  status: 'pending' | 'sent' | 'error';
  error?: string;
}

const XRayContext = createContext<XRayState>({
  enabled: false,
  toggle: () => {},
  registerEvent: () => {},
  events: [],
});

export function XRayProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(false);
  const [events, setEvents] = useState<XRayEvent[]>([]);

  function toggle() { setEnabled((v) => !v); }

  function registerEvent(e: XRayEvent) {
    setEvents((prev) => [e, ...prev].slice(0, 200)); // cap at 200 entries
  }

  // Keyboard shortcut: Ctrl/Cmd + Shift + X
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'X') {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <XRayContext.Provider value={{ enabled, toggle, registerEvent, events }}>
      {children}
    </XRayContext.Provider>
  );
}

export function useXRay() {
  return useContext(XRayContext);
}

// ── Relative timestamp ───────────────────────────────────────────────────────

function timeAgo(ts: string): string {
  const seconds = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  if (days < 7) return days + 'd ago';
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return weeks + 'w ago';
  const months = Math.floor(days / 30);
  if (months < 12) return months + 'mo ago';
  return Math.floor(days / 365) + 'y ago';
}

// ── Panel UI ──────────────────────────────────────────────────────────────────

const OP_COLORS: Record<EOOp | string, string> = {
  INS: '#4ade80',
  DES: '#60a5fa',
  ALT: '#fbbf24',
  SEG: '#c084fc',
  CON: '#34d399',
  SYN: '#818cf8',
  SUP: '#f472b6',
  REC: '#fb923c',
  NUL: '#9ca3af',
};

const OP_SYMBOLS: Record<EOOp | string, string> = {
  INS: '△',
  DES: '⊡',
  ALT: '∿',
  SEG: '｜',
  CON: '⋈',
  SYN: '∨',
  SUP: '⊕',
  REC: '⟳',
  NUL: '∅',
};

export function XRayPanel({ history }: { history?: HistoryEntry[] }) {
  const { enabled, events } = useXRay();
  const [tab, setTab] = useState<'live' | 'history'>('live');
  const [filter, setFilter] = useState('');

  if (!enabled) return null;

  const displayHistory = history ?? [];
  const filterLower = filter.toLowerCase();

  const filteredEvents = events.filter(
    (e) => !filter || e.target.toLowerCase().includes(filterLower) || e.op.toLowerCase().includes(filterLower)
  );
  const filteredHistory = displayHistory.filter(
    (h) => !filter || h.target?.toLowerCase().includes(filterLower) || h.op.toLowerCase().includes(filterLower)
  );

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      right: 0,
      width: '460px',
      height: '380px',
      background: '#0a0a0a',
      border: '1px solid #333',
      borderRadius: '8px 0 0 0',
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'monospace',
      fontSize: '12px',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', borderBottom: '1px solid #333', background: '#111' }}>
        <span style={{ color: '#7c6fcd', fontWeight: 700 }}>⊡ X-Ray</span>
        <button
          style={{ marginLeft: 'auto', ...tabStyle(tab === 'live') }}
          onClick={() => setTab('live')}
        >Live Events</button>
        <button
          style={{ ...tabStyle(tab === 'history') }}
          onClick={() => setTab('history')}
        >History ({displayHistory.length})</button>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter…"
          style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: '4px', color: '#e8e8e8', padding: '2px 6px', width: '100px', fontSize: '11px' }}
        />
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
        {tab === 'live' && (
          filteredEvents.length === 0
            ? <div style={{ color: '#555', padding: '12px', textAlign: 'center' }}>No events yet. Edit something.</div>
            : filteredEvents.map((e) => <EventRow key={e.id} event={e} />)
        )}
        {tab === 'history' && (
          filteredHistory.length === 0
            ? <div style={{ color: '#555', padding: '12px', textAlign: 'center' }}>No history loaded.</div>
            : filteredHistory.map((h) => <HistoryRow key={h.event_id} entry={h} />)
        )}
      </div>
    </div>
  );
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? '#7c6fcd22' : 'transparent',
    border: `1px solid ${active ? '#7c6fcd' : '#333'}`,
    borderRadius: '4px',
    color: active ? '#9b8fd4' : '#888',
    padding: '2px 8px',
    cursor: 'pointer',
    fontSize: '11px',
  };
}

function EventRow({ event }: { event: XRayEvent }) {
  const [open, setOpen] = useState(false);
  const color = OP_COLORS[event.op] ?? '#888';
  const sym = OP_SYMBOLS[event.op] ?? '?';

  return (
    <div
      style={{ padding: '4px 12px', borderBottom: '1px solid #1a1a1a', cursor: 'pointer' }}
      onClick={() => setOpen((v) => !v)}
    >
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <span style={{ color, fontWeight: 700, width: '20px', textAlign: 'center', fontSize: '14px' }}>{sym}</span>
        <span style={{ color, fontWeight: 700, width: '28px' }}>{event.op}</span>
        <span style={{ color: '#aaa', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{event.target}</span>
        <span style={{ color: event.status === 'sent' ? '#4ade80' : event.status === 'error' ? '#f87171' : '#fbbf24', fontSize: '10px' }}>
          {event.status}
        </span>
      </div>
      {open && (
        <div style={{ marginTop: '4px', background: '#111', borderRadius: '4px', padding: '6px', color: '#ccc' }}>
          <div style={{ color: '#888', marginBottom: '4px' }}>operand:</div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '11px' }}>
            {JSON.stringify(event.operand, null, 2)}
          </pre>
          <div style={{ color: '#555', marginTop: '4px', fontSize: '10px' }}>
            {timeAgo(event.ts)} · {event.agent}
          </div>
          {event.error && <div style={{ color: '#f87171', marginTop: '4px' }}>Error: {event.error}</div>}
        </div>
      )}
    </div>
  );
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const [open, setOpen] = useState(false);
  const color = OP_COLORS[entry.op] ?? '#888';
  const sym = OP_SYMBOLS[entry.op] ?? '?';

  return (
    <div
      style={{ padding: '4px 12px', borderBottom: '1px solid #1a1a1a', cursor: 'pointer' }}
      onClick={() => setOpen((v) => !v)}
    >
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <span style={{ color, fontWeight: 700, width: '20px', textAlign: 'center', fontSize: '14px' }}>{sym}</span>
        <span style={{ color, fontWeight: 700, width: '28px' }}>{entry.op}</span>
        <span style={{ color: '#aaa', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.target ?? entry.event_id}
        </span>
        <span style={{ color: '#555', fontSize: '10px' }}>{timeAgo(entry.ts)}</span>
      </div>
      {open && (
        <div style={{ marginTop: '4px', color: '#888', fontSize: '11px' }}>
          <div>event_id: {entry.event_id}</div>
          <div>agent: {entry.agent}</div>
          {entry.summary && <div>summary: {entry.summary}</div>}
        </div>
      )}
    </div>
  );
}

// ── XRay toggle button (for use in app header) ────────────────────────────────

export function XRayToggleButton() {
  const { enabled, toggle } = useXRay();
  return (
    <button
      onClick={toggle}
      title="Toggle X-Ray mode (Ctrl+Shift+X)"
      style={{
        background: enabled ? '#7c6fcd22' : 'transparent',
        border: `1px solid ${enabled ? '#7c6fcd' : '#444'}`,
        borderRadius: '6px',
        color: enabled ? '#9b8fd4' : '#888',
        padding: '4px 10px',
        cursor: 'pointer',
        fontSize: '13px',
        fontFamily: 'monospace',
      }}
    >
      ⊡ {enabled ? 'X-Ray ON' : 'X-Ray'}
    </button>
  );
}
