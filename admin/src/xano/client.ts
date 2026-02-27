/**
 * xano/client.ts — Thin Xano API wrapper for the EOwiki.
 *
 * Two endpoints:
 *   Public:  GET /get_public_eowiki    → public records (no auth)
 *   Private: GET /<encrypted-path>     → all records (unlocked by password)
 *
 * The private endpoint path is AES-256-GCM encrypted in the source using the
 * admin password as key.  On login the password decrypts the path; the
 * decrypted value is cached in sessionStorage for the browser session.
 */

import type { EOEvent, EORawEvent } from '../eo/types';

// Late-bound cache hooks — set by stateCache.ts to avoid circular imports.
// When a write to eowikicurrent succeeds, we update the cache in-place so
// other editors immediately see the new data without waiting for a refetch.
let _onRecordWritten: ((record: XanoCurrentRecord) => void) | null = null;

/** Called by stateCache.ts to register its cache-update callback. */
export function _registerCacheHook(hook: (record: XanoCurrentRecord) => void): void {
  _onRecordWritten = hook;
}

const XANO_BASE = 'https://xvkq-pq7i-idtl.n7d.xano.io/api:GGzWIVAW';

// Public endpoint — no authentication required.
const PUBLIC_ENDPOINT = 'get_public_eowiki';

// Private endpoint path, encrypted with AES-256-GCM (key = SHA-256 of password).
// The plaintext endpoint name never appears in the source, so it can't be found
// by searching the codebase.  Decrypted at runtime when the user logs in.
//
// To regenerate after a password change:
//   node -e "const c=require('crypto'),pw='NEW_PASSWORD',pt='ENDPOINT_NAME',
//   k=c.createHash('sha256').update(pw).digest(),iv=c.randomBytes(12),
//   ci=c.createCipheriv('aes-256-gcm',k,iv),e=Buffer.concat([ci.update(pt,'utf8'),
//   ci.final()]),t=ci.getAuthTag();console.log(Buffer.concat([iv,e,t]).toString('base64'))"
const ENCRYPTED_PRIVATE_ENDPOINT = 'T9q5Wmenm2sCBX3XD+vFxJdfU9aoZV/SxV47TfzR7rLu9SGrVFvOFBtBDzAJ';

const SESSION_KEY = 'eo_xano_auth';
const ENDPOINT_KEY = 'eo_xano_ep';

// Module-level cache: decrypted private endpoint path (set on login).
let _privateEndpoint: string | null = null;

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

// ── Password auth (decrypt-based) ─────────────────────────────────────────────

/** Derive an AES-256 key from a password via SHA-256. */
async function deriveKey(password: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
}

/** Base64 → Uint8Array. */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Try to decrypt the private endpoint using the given password.
 * Returns the plaintext endpoint path on success, or null on failure
 * (wrong password → AES-GCM auth tag mismatch).
 */
async function decryptEndpoint(password: string): Promise<string | null> {
  try {
    const data = b64ToBytes(ENCRYPTED_PRIVATE_ENDPOINT);
    const iv = data.slice(0, 12);
    const ctAndTag = data.slice(12);
    const key = await deriveKey(password);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ctAndTag);
    return new TextDecoder().decode(plain);
  } catch {
    return null; // wrong password or corrupted blob
  }
}

/**
 * Verify a password by attempting to decrypt the private endpoint.
 * On success the decrypted endpoint is cached in memory + localStorage
 * so the session persists across browser restarts.
 */
export async function verifyPassword(password: string): Promise<boolean> {
  const ep = await decryptEndpoint(password);
  if (!ep) return false;
  _privateEndpoint = ep;
  try { localStorage.setItem(ENDPOINT_KEY, ep); } catch { /* SSR / test */ }
  return true;
}

/** Restore the private endpoint from localStorage (called on page load). */
export function restoreEndpoint(): boolean {
  try {
    const ep = localStorage.getItem(ENDPOINT_KEY);
    if (ep) { _privateEndpoint = ep; return true; }
  } catch { /* SSR / test */ }
  return false;
}

// ── Session (localStorage — persists across browser restarts) ─────────────────

export function saveSession(): void {
  localStorage.setItem(SESSION_KEY, '1');
}

export function loadSession(): boolean {
  if (localStorage.getItem(SESSION_KEY) !== '1') return false;
  if (!restoreEndpoint()) {
    localStorage.removeItem(SESSION_KEY);
    return false;
  }
  return true;
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(ENDPOINT_KEY);
  _privateEndpoint = null;
}

// ── API calls ────────────────────────────────────────────────────────────────

/** Fetch all EOwiki records (public endpoint, no auth required). */
export async function fetchAllRecords(): Promise<XanoRecord[]> {
  const resp = await fetch(`${XANO_BASE}/${PUBLIC_ENDPOINT}`, {
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

/** Fetch all current-state records via the private (decrypted) endpoint. */
export async function fetchAllCurrentRecords(): Promise<XanoCurrentRecord[]> {
  if (!_privateEndpoint) {
    throw new Error('Private endpoint not unlocked — please log in first.');
  }
  const resp = await fetch(`${XANO_BASE}/${_privateEndpoint}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Xano current fetch failed: HTTP ${resp.status} — ${body}`);
  }
  return (await resp.json()) as XanoCurrentRecord[];
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
 * Pass `existing` (from a prior load) to avoid an extra GET.
 * Generates a UUID (v4) on create for deduplication.
 */
export async function upsertCurrentRecord(
  recordId: string,
  stateSnapshot: unknown,
  agent: string,
  existing?: XanoCurrentRecord | null,
): Promise<XanoCurrentRecord> {
  // Extract metadata from snapshot so Xano server-side filter can work
  const snap = stateSnapshot as Record<string, unknown> | null;
  const meta = (snap?.meta ?? {}) as Record<string, unknown>;
  const isIndex = recordId === 'site:index';

  const ctx: Record<string, unknown> = {
    agent,
    ts: new Date().toISOString(),
    object_type: isIndex || meta.visibility === 'public' ? 'public' : 'private',
    meta: {
      status: isIndex ? 'published' : (meta.status ?? 'draft'),
      visibility: isIndex || meta.visibility === 'public' ? 'public' : 'private',
    },
  };

  const values = JSON.stringify(stateSnapshot);
  const lastModified = new Date().toISOString();

  let result: XanoCurrentRecord;
  if (existing) {
    result = await patchCurrentRecord(existing.id, { values, context: ctx, lastModified });
  } else {
    result = await createCurrentRecord({
      record_id: recordId,
      displayName: recordId,
      values,
      context: ctx,
      uuid: crypto.randomUUID(),
      lastModified,
    });
  }

  // Keep the in-memory cache in sync so other editors see this write immediately
  _onRecordWritten?.(result);
  return result;
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
