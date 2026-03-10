/**
 * BatchPost — Paste JSON payloads and execute them against the Xano API.
 *
 * Supports two payload types:
 *   1. Event log entries (POST /eowiki) — appends EO events
 *   2. Current-state upserts — updates state snapshots via upsertCurrentRecord
 *
 * Payload format (array of operations):
 * [
 *   {
 *     "type": "event",
 *     "op": "INS|SIG|ALT|...",
 *     "target": "wiki:operators/rev:r_123",
 *     "operand": { ... }
 *   },
 *   {
 *     "type": "upsert",
 *     "record_id": "wiki:operators",
 *     "snapshot": { ... }
 *   },
 *   {
 *     "type": "raw",
 *     "method": "POST",
 *     "endpoint": "eowiki",
 *     "body": { "op": "INS", "subject": "...", "predicate": "eo.op", "value": "...", "context": "..." }
 *   }
 * ]
 */

import React, { useState, useCallback, useRef } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useSettings } from '../settings/SettingsContext';
import {
  addRecord,
  upsertCurrentRecord,
  eventToPayload,
  patchCurrentRecord,
  createCurrentRecord,
} from '../xano/client';
import { fetchCurrentRecordCached, invalidateCurrentCache } from '../xano/stateCache';
import type { EOEvent } from '../eo/types';

// ── Types ──────────────────────────────────────────────────────────────────

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
  /** For PATCH /eowikicurrent/:id — the Xano row id */
  id?: number;
}

type BatchOp = EventOp | UpsertOp | RawOp;

interface OpResult {
  index: number;
  op: BatchOp;
  success: boolean;
  response?: unknown;
  error?: string;
}

// ── Component ──────────────────────────────────────────────────────────────

interface Props {
  siteBase: string;
}

export default function BatchPost({ siteBase }: Props) {
  const { isAuthenticated } = useAuth();
  const { settings } = useSettings();

  const [input, setInput] = useState('');
  const [parsed, setParsed] = useState<BatchOp[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  const [results, setResults] = useState<OpResult[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const abortRef = useRef(false);

  // ── Parse ──────────────────────────────────────────────────────────────

  const doParse = useCallback(() => {
    setParseError(null);
    setParsed(null);
    setResults([]);

    if (!input.trim()) {
      setParseError('Paste a JSON payload first.');
      return;
    }

    try {
      const data = JSON.parse(input);
      const ops: BatchOp[] = Array.isArray(data) ? data : [data];

      // Validate each op
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        if (!op || typeof op !== 'object') {
          throw new Error(`Operation ${i}: not an object`);
        }
        if (!('type' in op)) {
          throw new Error(`Operation ${i}: missing "type" field (must be "event", "upsert", or "raw")`);
        }
        if (op.type === 'event') {
          if (!op.op) throw new Error(`Operation ${i}: event missing "op"`);
          if (!op.target) throw new Error(`Operation ${i}: event missing "target"`);
          if (!op.operand || typeof op.operand !== 'object') throw new Error(`Operation ${i}: event missing "operand"`);
        } else if (op.type === 'upsert') {
          if (!op.record_id) throw new Error(`Operation ${i}: upsert missing "record_id"`);
          if (op.snapshot === undefined) throw new Error(`Operation ${i}: upsert missing "snapshot"`);
        } else if (op.type === 'raw') {
          if (!op.method) throw new Error(`Operation ${i}: raw missing "method"`);
          if (!op.endpoint) throw new Error(`Operation ${i}: raw missing "endpoint"`);
          if (!op.body || typeof op.body !== 'object') throw new Error(`Operation ${i}: raw missing "body"`);
        } else {
          throw new Error(`Operation ${i}: unknown type "${(op as { type: string }).type}"`);
        }
      }

      setParsed(ops);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    }
  }, [input]);

  // ── Execute ────────────────────────────────────────────────────────────

  const doExecute = useCallback(async () => {
    if (!parsed || parsed.length === 0) return;

    setExecuting(true);
    setResults([]);
    abortRef.current = false;
    setProgress({ done: 0, total: parsed.length });

    const agent = settings.displayName || 'batch-post';
    const allResults: OpResult[] = [];

    for (let i = 0; i < parsed.length; i++) {
      if (abortRef.current) {
        allResults.push({ index: i, op: parsed[i], success: false, error: 'Aborted' });
        continue;
      }

      const op = parsed[i];
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
              txn: op.txn || `batch-${Date.now()}-${i}`,
            },
          };
          response = await addRecord(eventToPayload(event));
        } else if (op.type === 'upsert') {
          const existing = await fetchCurrentRecordCached(op.record_id);
          response = await upsertCurrentRecord(
            op.record_id,
            op.snapshot,
            op.agent || agent,
            existing,
          );
        } else if (op.type === 'raw') {
          // Direct raw API call — constructed by the caller
          const XANO_BASE = 'https://xvkq-pq7i-idtl.n7d.xano.io/api:GGzWIVAW';
          const url = op.id
            ? `${XANO_BASE}/${op.endpoint}/${op.id}`
            : `${XANO_BASE}/${op.endpoint}`;
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
        }

        allResults.push({ index: i, op, success: true, response });
      } catch (err) {
        allResults.push({
          index: i,
          op,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      setProgress({ done: i + 1, total: parsed.length });
      setResults([...allResults]);
    }

    invalidateCurrentCache();
    setExecuting(false);
  }, [parsed, settings.displayName]);

  const doAbort = useCallback(() => {
    abortRef.current = true;
  }, []);

  // ── Template helpers ───────────────────────────────────────────────────

  const insertTemplate = useCallback((template: string) => {
    setInput(template);
    setParsed(null);
    setParseError(null);
    setResults([]);
  }, []);

  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="batch-post">
      <div className="batch-post-header">
        <h2>Batch Post</h2>
        <p className="batch-post-desc">
          Paste JSON payloads to execute against the Xano API. Supports event log
          entries, current-state upserts, and raw POST/PATCH requests.
        </p>
      </div>

      {/* Templates */}
      <div className="batch-post-templates">
        <span className="batch-post-templates-label">Templates:</span>
        <button
          className="btn btn-xs"
          onClick={() => insertTemplate(JSON.stringify([{
            type: 'event',
            op: 'INS',
            target: 'wiki:example/rev:r_' + Date.now(),
            operand: {
              format: 'html',
              content: '<p>New revision content</p>',
              summary: 'Batch edit',
            },
          }], null, 2))}
        >
          Event (INS revision)
        </button>
        <button
          className="btn btn-xs"
          onClick={() => insertTemplate(JSON.stringify([{
            type: 'event',
            op: 'SIG',
            target: 'wiki:example',
            operand: { set: { title: 'New Title' } },
          }], null, 2))}
        >
          Event (SIG metadata)
        </button>
        <button
          className="btn btn-xs"
          onClick={() => insertTemplate(JSON.stringify([{
            type: 'upsert',
            record_id: 'wiki:example',
            snapshot: {
              meta: { title: 'Example', status: 'published', visibility: 'public' },
              current_revision: { rev_id: 'r_1', format: 'html', content: '<p>Content</p>', summary: '', ts: new Date().toISOString() },
              revisions: [],
            },
          }], null, 2))}
        >
          Upsert (state snapshot)
        </button>
        <button
          className="btn btn-xs"
          onClick={() => insertTemplate(JSON.stringify([{
            type: 'raw',
            method: 'POST',
            endpoint: 'eowiki',
            body: {
              op: 'INS',
              subject: 'wiki:example/rev:r_' + Date.now(),
              predicate: 'eo.op',
              value: JSON.stringify({ format: 'html', content: '<p>Raw post</p>', summary: 'Raw batch' }),
              context: JSON.stringify({ agent: 'batch-post', ts: new Date().toISOString() }),
            },
          }], null, 2))}
        >
          Raw POST
        </button>
      </div>

      {/* Input area */}
      <div className="batch-post-input">
        <label className="field">
          <span>JSON Payload</span>
          <textarea
            className="batch-post-textarea"
            value={input}
            onChange={e => {
              setInput(e.target.value);
              setParsed(null);
              setParseError(null);
            }}
            placeholder='Paste a JSON array of operations here...'
            spellCheck={false}
          />
        </label>
        <div className="batch-post-input-actions">
          <button
            className="btn btn-primary"
            onClick={doParse}
            disabled={!input.trim()}
          >
            Validate &amp; Preview
          </button>
          <button
            className="btn btn-sm"
            onClick={() => { setInput(''); setParsed(null); setParseError(null); setResults([]); }}
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

      {/* Parsed preview */}
      {parsed && (
        <div className="batch-post-preview">
          <div className="batch-post-preview-header">
            <h3>{parsed.length} operation{parsed.length !== 1 ? 's' : ''} ready</h3>
            <div className="batch-post-preview-actions">
              <button
                className="btn btn-primary btn-danger-confirm"
                onClick={doExecute}
                disabled={executing || !isAuthenticated}
                title={!isAuthenticated ? 'Login required' : undefined}
              >
                {executing
                  ? `Executing… (${progress.done}/${progress.total})`
                  : `Execute ${parsed.length} operation${parsed.length !== 1 ? 's' : ''}`
                }
              </button>
              {executing && (
                <button className="btn btn-sm" onClick={doAbort}>Abort</button>
              )}
              {!isAuthenticated && (
                <span className="gsr-auth-warn">Login required</span>
              )}
            </div>
          </div>

          <div className="batch-post-op-list">
            {parsed.map((op, i) => (
              <div key={i} className={`batch-post-op ${results[i] ? (results[i].success ? 'batch-post-op-ok' : 'batch-post-op-err') : ''}`}>
                <div className="batch-post-op-header">
                  <span className="batch-post-op-index">#{i}</span>
                  <span className={`gsr-badge gsr-badge-${op.type}`}>{op.type}</span>
                  {op.type === 'event' && (
                    <>
                      <span className="batch-post-op-detail">{op.op}</span>
                      <span className="batch-post-op-target">{op.target}</span>
                    </>
                  )}
                  {op.type === 'upsert' && (
                    <span className="batch-post-op-target">{op.record_id}</span>
                  )}
                  {op.type === 'raw' && (
                    <>
                      <span className="batch-post-op-detail">{op.method}</span>
                      <span className="batch-post-op-target">{op.endpoint}{op.id ? `/${op.id}` : ''}</span>
                    </>
                  )}
                  {results[i] && (
                    <span className={results[i].success ? 'gsr-status-ok' : 'gsr-status-err'}>
                      {results[i].success ? 'OK' : 'ERR'}
                    </span>
                  )}
                </div>
                {results[i] && !results[i].success && results[i].error && (
                  <div className="batch-post-op-error">{results[i].error}</div>
                )}
                <details className="batch-post-op-details">
                  <summary>Payload</summary>
                  <pre><code>{JSON.stringify(op, null, 2)}</code></pre>
                </details>
                {results[i]?.response && (
                  <details className="batch-post-op-details">
                    <summary>Response</summary>
                    <pre><code>{JSON.stringify(results[i].response, null, 2)}</code></pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Summary */}
      {results.length > 0 && !executing && (
        <div className="batch-post-summary">
          <span className="gsr-status-ok">{successCount} succeeded</span>
          {failCount > 0 && <span className="gsr-status-err">{failCount} failed</span>}
        </div>
      )}

      {/* Progress bar */}
      {executing && progress.total > 0 && (
        <div className="batch-post-progress">
          <div
            className="batch-post-progress-bar"
            style={{ width: `${(progress.done / progress.total) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}
