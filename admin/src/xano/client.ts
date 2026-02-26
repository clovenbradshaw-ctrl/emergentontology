/**
 * xano/client.ts — Thin Xano API wrapper for the EOwiki event log.
 *
 * Reads:  GET  /eowiki  → array of all EOwiki records (public, no auth)
 * Writes: POST /eowiki  → append one EO event record  (requires password)
 *
 * Auth is password-only; the correct password is hashed client-side with
 * SHA-256 and compared against a hardcoded digest.  A simple session flag
 * is kept in sessionStorage (cleared when the browser tab closes).
 *
 * EOwiki record shape (mirrors the Xano table):
 *   id          – auto-generated integer
 *   created_at  – epoch ms (set server-side to "now")
 *   op          – EO operation code (INS | DES | ALT | NUL | SYN …)
 *   subject     – EOEvent.target  (e.g. "wiki:operators/rev:r_123")
 *   predicate   – always "eo.op" (marks this as an EO event record)
 *   value       – JSON-stringified EOEvent.operand
 *   context     – JSON-stringified EOEvent.ctx  {agent, ts, txn?}
 */

import type { EOEvent, EORawEvent } from '../eo/types';

const XANO_BASE = 'https://xvkq-pq7i-idtl.n7d.xano.io/api:GGzWIVAW';

// SHA-256 of "Brethren0-Happiest6-Dynamite5-Hammock9-Sharply0"
const PWD_HASH = 'e89ade35085fc8736d6b4755af45e842c6eec0c5978d318156aff6351f0fa950';

const SESSION_KEY = 'eo_xano_auth';

// ── Types ────────────────────────────────────────────────────────────────────

export interface XanoRecord {
  id: number;
  created_at: number;   // epoch ms
  op: string;
  subject: string;
  predicate: string;
  value: string;        // JSON-stringified operand
  context: string;      // JSON-stringified ctx
}

// ── Password auth ─────────────────────────────────────────────────────────────

async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyPassword(password: string): Promise<boolean> {
  const hash = await sha256hex(password);
  return hash === PWD_HASH;
}

// ── Session (sessionStorage — clears on tab close) ────────────────────────────

export function saveSession(): void {
  sessionStorage.setItem(SESSION_KEY, '1');
}

export function loadSession(): boolean {
  return sessionStorage.getItem(SESSION_KEY) === '1';
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

// ── API calls ────────────────────────────────────────────────────────────────

/** Fetch all EOwiki records (no auth required). */
export async function fetchAllRecords(): Promise<XanoRecord[]> {
  const resp = await fetch(`${XANO_BASE}/eowiki`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`Xano fetch failed: HTTP ${resp.status}`);
  return (await resp.json()) as XanoRecord[];
}

/** Append one EO event record to the EOwiki table. */
export async function addRecord(payload: {
  op: string;
  subject: string;
  predicate: string;
  value: string;
  context: string;
}): Promise<XanoRecord> {
  const resp = await fetch(`${XANO_BASE}/eowiki`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `Xano write failed: HTTP ${resp.status}`);
  }
  return (await resp.json()) as XanoRecord;
}

// ── eowikicurrent — current-state table ───────────────────────────────────────

/**
 * eowikicurrent keeps one row per content entity (identified by record_id).
 * It is the fast-read path: no event replay needed for the admin editor.
 * Each record carries a client-generated UUID for deduplication.
 *
 * record_id    – content identifier  e.g. "wiki:operators", "site:index"
 * displayName  – human-readable label for this record
 * values       – JSON-stringified current state snapshot
 * context      – JSON metadata  {agent, ts}
 * uuid         – client-generated UUID (v4) for deduplication
 * lastModified – ISO timestamp of most recent update
 */
export interface XanoCurrentRecord {
  id: number;
  created_at: string;     // ISO timestamp
  record_id: string;
  displayName: string;
  values: string;         // JSON-stringified state snapshot
  context: Record<string, unknown>;
  uuid: string;
  lastModified: string;   // ISO timestamp
}

/** Fetch all current-state records. */
export async function fetchAllCurrentRecords(): Promise<XanoCurrentRecord[]> {
  const resp = await fetch(`${XANO_BASE}/eowikicurrent`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`Xano current fetch failed: HTTP ${resp.status}`);
  return (await resp.json()) as XanoCurrentRecord[];
}

/** Fetch a single current-state record by record_id (filter client-side). */
export async function fetchCurrentRecord(recordId: string): Promise<XanoCurrentRecord | null> {
  const all = await fetchAllCurrentRecords();
  return all.find((r) => r.record_id === recordId) ?? null;
}

/** Create a new current-state record (first write for this record_id). */
export async function createCurrentRecord(payload: {
  record_id: string;
  displayName: string;
  values: string;
  context: Record<string, unknown>;
  uuid: string;
  lastModified: string;
}): Promise<XanoCurrentRecord> {
  const resp = await fetch(`${XANO_BASE}/eowikicurrent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `Xano current create failed: HTTP ${resp.status}`);
  }
  return (await resp.json()) as XanoCurrentRecord;
}

/** Update an existing current-state record by its Xano row id. */
export async function patchCurrentRecord(id: number, payload: {
  values: string;
  context: Record<string, unknown>;
  lastModified: string;
}): Promise<XanoCurrentRecord> {
  const resp = await fetch(`${XANO_BASE}/eowikicurrent/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `Xano current patch failed: HTTP ${resp.status}`);
  }
  return (await resp.json()) as XanoCurrentRecord;
}

/**
 * Upsert helper: creates or patches the current-state record for a record_id.
 * Pass `existing` (from a prior fetchCurrentRecord call) to avoid an extra GET.
 * Generates a UUID (v4) on create for deduplication.
 */
export async function upsertCurrentRecord(
  recordId: string,
  stateSnapshot: unknown,
  agent: string,
  existing?: XanoCurrentRecord | null,
): Promise<XanoCurrentRecord> {
  const ctx = { agent, ts: new Date().toISOString() };
  const values = JSON.stringify(stateSnapshot);
  const lastModified = new Date().toISOString();

  if (existing) {
    return patchCurrentRecord(existing.id, { values, context: ctx, lastModified });
  }
  return createCurrentRecord({
    record_id: recordId,
    displayName: recordId,
    values,
    context: ctx,
    uuid: crypto.randomUUID(),
    lastModified,
  });
}

// ── EOEvent → eowiki payload helper ───────────────────────────────────────────

export function eventToPayload(event: EOEvent): Parameters<typeof addRecord>[0] {
  return {
    op: event.op,
    subject: event.target,
    predicate: 'eo.op',
    value: JSON.stringify(event.operand),
    context: JSON.stringify(event.ctx),
  };
}

// ── Xano record → EORawEvent adapter (for replay engine) ─────────────────────

export function xanoToRaw(record: XanoRecord): EORawEvent {
  let operand: Record<string, unknown> = {};
  let ctx: Record<string, unknown> = {};
  try { operand = JSON.parse(record.value) as Record<string, unknown>; } catch { /* ignore */ }
  try { ctx = JSON.parse(record.context) as Record<string, unknown>; } catch { /* ignore */ }

  return {
    event_id: String(record.id),
    type: 'eo.op',
    sender: String(ctx.agent ?? 'unknown'),
    origin_server_ts: record.created_at,
    content: {
      op: record.op,
      target: record.subject,
      operand,
      ctx,
    },
  };
}
