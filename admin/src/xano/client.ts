/**
 * xano/client.ts — Thin Xano API wrapper for the EOwiki.
 *
 * Architecture (current-state-first):
 *   Primary:   eowikicurrent  — one row per content entity (the source of truth)
 *   Secondary: eowiki         — append-only event log (change tracking only)
 *
 * Reads and writes go through eowikicurrent first.  The event log is written
 * fire-and-forget via logEvent(); if events were deleted the current state
 * still exists and is fully self-contained.
 *
 * Endpoints:
 *   Public:  GET /get_public_eowiki    → event log records (no auth)
 *   Private: GET /<encrypted-path>     → all current-state records (unlocked by password)
 *   Auth'd:  POST /eowiki              → changelog writes (auth header required)
 *   Auth'd:  POST /eowikicurrent       → current-state creates (auth header required)
 *   Auth'd:  PATCH /eowikicurrent/{id} → current-state updates (auth header required)
 *
 * Write endpoints require the admin password hash as a Bearer token.
 * The hash is derived from the decrypted private endpoint path (SHA-256),
 * so only a logged-in admin who knows the password can write.
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
// Look up an existing record by record_id from the cache (used by upsert to
// prevent creating duplicate rows when the caller doesn't pass `existing`).
let _findCachedRecord: ((recordId: string) => XanoCurrentRecord | null) | null = null;

/** Called by stateCache.ts to register its cache-update callback. */
export function _registerCacheHook(hook: (record: XanoCurrentRecord) => void): void {
  _onRecordWritten = hook;
}

/** Called by stateCache.ts to register its cache-lookup callback. */
export function _registerCacheLookup(hook: (recordId: string) => XanoCurrentRecord | null): void {
  _findCachedRecord = hook;
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
// Cached SHA-256 hash of the private endpoint, used as Bearer token for writes.
let _authHash: string | null = null;

/**
 * Derive a SHA-256 hex hash of the private endpoint path.
 * This hash is sent as a Bearer token on write requests so the Xano backend
 * can validate the caller is an authenticated admin without exposing the
 * raw endpoint path.
 */
async function deriveAuthHash(endpoint: string): Promise<string> {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(raw)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build headers for authenticated write requests.
 * Includes the admin auth hash as a Bearer token.
 */
function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ..._authHash ? { 'Authorization': `Bearer ${_authHash}` } : {},
  };
}

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
  _authHash = await deriveAuthHash(ep);
  try { localStorage.setItem(ENDPOINT_KEY, ep); } catch { /* SSR / test */ }
  return true;
}

/** Restore the private endpoint from localStorage (called on page load). */
export function restoreEndpoint(): boolean {
  try {
    const ep = localStorage.getItem(ENDPOINT_KEY);
    if (ep) {
      _privateEndpoint = ep;
      // Derive auth hash async — writes will wait until this resolves
      deriveAuthHash(ep).then(h => { _authHash = h; });
      return true;
    }
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
  _authHash = null;
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

/**
 * Append one EO event record to the EOwiki event log table.
 * The event log is used for change tracking only — the current-state table
 * (eowikicurrent) is the authoritative source of truth.
 *
 * Requires admin authentication (private endpoint must be unlocked).
 */
export async function addRecord(payload: {
  op: string;
  subject: string;
  predicate: string;
  value: string;
  context: string;
}): Promise<XanoRecord> {
  if (!_privateEndpoint) {
    throw new Error('Private endpoint not unlocked — please log in first.');
  }
  const resp = await fetch(`${XANO_BASE}/eowiki`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `Xano write failed: HTTP ${resp.status}`);
  }
  return (await resp.json()) as XanoRecord;
}

/**
 * Fire-and-forget: log an event to the change-tracking event log.
 * Never throws — failures are silently logged to the console.
 * The event log is secondary to eowikicurrent; if this fails the
 * current-state snapshot is still the authoritative record.
 */
export function logEvent(payload: Parameters<typeof addRecord>[0]): void {
  if (!_privateEndpoint) {
    console.warn('[logEvent] Skipped — not authenticated.');
    return;
  }
  addRecord(payload).catch((err) => {
    console.warn('[logEvent] Event log write failed (non-fatal):', err);
  });
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

/**
 * Normalise a Xano response that may be a flat array or a paginated wrapper.
 * Returns the array of records either way.
 */
function unwrapResponse(data: unknown): XanoCurrentRecord[] {
  if (Array.isArray(data)) return data as XanoCurrentRecord[];
  if (data && typeof data === 'object' && 'items' in data) {
    return (data as PaginatedResponse<XanoCurrentRecord>).items;
  }
  return data ? [data as XanoCurrentRecord] : [];
}

/**
 * Fetch a single page of current-state records via the private endpoint.
 * Returns both the records and pagination metadata.
 */
export async function fetchCurrentRecordsPage(
  pagination?: PaginationParams,
): Promise<PaginatedResponse<XanoCurrentRecord>> {
  const resp = await fetch(privateUrl(undefined, pagination), {
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Xano current fetch failed: HTTP ${resp.status} — ${body}`);
  }
  const data = await resp.json();
  // Handle both paginated wrapper and flat array responses
  if (data && typeof data === 'object' && 'items' in data) {
    return data as PaginatedResponse<XanoCurrentRecord>;
  }
  // Legacy flat array response — wrap it
  const items = Array.isArray(data) ? data : [data];
  return {
    items,
    curPage: 1,
    nextPage: null,
    prevPage: null,
    itemsReceived: items.length,
    itemsTotal: items.length,
  };
}

/** Fetch all current-state records via the private (decrypted) endpoint. */
export async function fetchAllCurrentRecords(): Promise<XanoCurrentRecord[]> {
  if (!_privateEndpoint) {
    throw new Error('Private endpoint not unlocked — please log in first.');
  }
  // Fetch first page with a large per_page to minimise round-trips
  const first = await fetchCurrentRecordsPage({ page: 1, per_page: 200 });
  const all: XanoCurrentRecord[] = [...first.items];

  // If there are more pages, fetch them in parallel
  if (first.itemsTotal > first.itemsReceived) {
    const totalPages = Math.ceil(first.itemsTotal / (first.items.length || 200));
    const pagePromises: Promise<PaginatedResponse<XanoCurrentRecord>>[] = [];
    for (let p = 2; p <= totalPages; p++) {
      pagePromises.push(fetchCurrentRecordsPage({ page: p, per_page: 200 }));
    }
    const pages = await Promise.all(pagePromises);
    for (const page of pages) {
      all.push(...page.items);
    }
  }

  return all;
}

// ── Filtered fetchers ────────────────────────────────────────────────────────

/** Pagination parameters for paginated Xano endpoints. */
export interface PaginationParams {
  page?: number;
  per_page?: number;
}

/** Paginated response wrapper returned by Xano list endpoints. */
export interface PaginatedResponse<T> {
  items: T[];
  curPage: number;
  nextPage: number | null;
  prevPage: number | null;
  itemsReceived: number;
  itemsTotal: number;
}

/** Query parameters supported by the eowikicurrent endpoint. */
export interface CurrentRecordFilters {
  // Xano-native column filters (server-side WHERE clauses)
  id?: number;
  created_at?: string;        // ISO timestamp
  record_id?: string;
  displayName?: string;
  values?: string;
  context?: Record<string, unknown>;
  uuid?: string;
  lastModified?: string;      // ISO timestamp
  // Derived filters (resolved from context fields)
  content_type?: string;
  status?: string;
  visibility?: string;
}

/**
 * Build a URL for the private endpoint with optional query parameters.
 * Throws if the private endpoint hasn't been unlocked.
 */
function privateUrl(params?: Record<string, string>, pagination?: PaginationParams): string {
  if (!_privateEndpoint) {
    throw new Error('Private endpoint not unlocked — please log in first.');
  }
  const url = `${XANO_BASE}/${_privateEndpoint}`;
  const allParams: Record<string, string> = { ...params };
  if (pagination?.page != null) allParams.page = String(pagination.page);
  if (pagination?.per_page != null) allParams.per_page = String(pagination.per_page);
  if (Object.keys(allParams).length === 0) return url;
  const qs = new URLSearchParams(allParams).toString();
  return `${url}?${qs}`;
}

/**
 * Fetch a single current-state record by record_id.
 * Uses the server-side ?record_id= filter so we don't download every record.
 * Returns null if no record matches.
 */
export async function fetchCurrentRecordByRecordId(
  recordId: string,
): Promise<XanoCurrentRecord | null> {
  const resp = await fetch(privateUrl({ record_id: recordId }), {
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Xano single-record fetch failed: HTTP ${resp.status} — ${body}`);
  }
  const data = await resp.json();

  // Xano may return a paginated wrapper, single object, or an array — normalise
  const allRecords: XanoCurrentRecord[] = unwrapResponse(data);
  // Filter to only records matching the requested record_id — in case
  // the server-side filter is ignored and all records are returned.
  const records = allRecords.filter((r) => r && r.record_id === recordId);
  if (records.length === 0) return null;
  if (records.length === 1) return records[0];

  // Multiple rows for same record_id — pick the most recently modified
  return records.reduce((best, r) => {
    const bestTime = new Date(best.lastModified).getTime() || 0;
    const rTime = new Date(r.lastModified).getTime() || 0;
    return rTime > bestTime ? r : best;
  });
}

/**
 * Fetch current-state records with server-side filters.
 * Any combination of content_type, status, visibility can be passed.
 * Optionally accepts pagination params; defaults to fetching all results.
 * Returns matching records (empty array if none match).
 */
export async function fetchFilteredCurrentRecords(
  filters: CurrentRecordFilters,
  pagination?: PaginationParams,
): Promise<XanoCurrentRecord[]> {
  const params: Record<string, string> = {};
  // Xano-native column filters
  if (filters.id != null) params.id = String(filters.id);
  if (filters.created_at) params.created_at = filters.created_at;
  if (filters.record_id) params.record_id = filters.record_id;
  if (filters.displayName) params.displayName = filters.displayName;
  if (filters.values) params.values = filters.values;
  if (filters.context != null) params.context = JSON.stringify(filters.context);
  if (filters.uuid) params.uuid = filters.uuid;
  if (filters.lastModified) params.lastModified = filters.lastModified;
  // Derived context filters
  if (filters.content_type) params.content_type = filters.content_type;
  if (filters.status) params.status = filters.status;
  if (filters.visibility) params.visibility = filters.visibility;

  const resp = await fetch(privateUrl(params, pagination), {
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Xano filtered fetch failed: HTTP ${resp.status} — ${body}`);
  }
  const data = await resp.json();
  return unwrapResponse(data);
}

/**
 * Create a new current-state record (first write for this record_id).
 * Requires admin authentication (private endpoint must be unlocked).
 */
export async function createCurrentRecord(payload: {
  record_id: string;
  displayName: string;
  values: string;
  context: Record<string, unknown>;
  uuid: string;
  lastModified: string;
}): Promise<XanoCurrentRecord> {
  if (!_privateEndpoint) {
    throw new Error('Private endpoint not unlocked — please log in first.');
  }
  const resp = await fetch(`${XANO_BASE}/eowikicurrent`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `Xano current create failed: HTTP ${resp.status}`);
  }
  return (await resp.json()) as XanoCurrentRecord;
}

/**
 * Update an existing current-state record by its Xano row id.
 * Requires admin authentication (private endpoint must be unlocked).
 */
export async function patchCurrentRecord(id: number, payload: {
  values: string;
  context: Record<string, unknown>;
  lastModified: string;
}): Promise<XanoCurrentRecord> {
  if (!_privateEndpoint) {
    throw new Error('Private endpoint not unlocked — please log in first.');
  }
  const resp = await fetch(`${XANO_BASE}/eowikicurrent/${id}`, {
    method: 'PATCH',
    headers: authHeaders(),
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
 * Remove `revisions` and `history` arrays from a state snapshot before persisting.
 * Current state should only contain `current_revision`, not full history.
 * Revision history belongs in the eowiki event log, not in eowikicurrent.
 */
function stripRevisionHistory(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const obj = { ...(snapshot as Record<string, unknown>) };
  delete obj.revisions;
  delete obj.history;
  return obj;
}

/**
 * Upsert helper: creates or patches the current-state record for a record_id.
 * Pass `existing` (from a prior load) to avoid an extra GET.
 * If `existing` is null/undefined, we look up the record from the cache before
 * creating — this prevents duplicate rows for the same record_id.
 * Generates a UUID (v4) on create for deduplication.
 *
 * Automatically strips `revisions` and `history` arrays — those belong in the
 * eowiki event log, not in the current-state snapshot.
 */
export async function upsertCurrentRecord(
  recordId: string,
  stateSnapshot: unknown,
  agent: string,
  existing?: XanoCurrentRecord | null,
): Promise<XanoCurrentRecord> {
  // Extract metadata from snapshot so Xano server-side filter can work.
  // Flat fields (content_type, status, visibility) must match what the Xano
  // get_public_eowiki query filters on: context.content_type, context.status,
  // context.visibility.
  const snap = stateSnapshot as Record<string, unknown> | null;
  const meta = (snap?.meta ?? {}) as Record<string, unknown>;
  const isIndex = recordId === 'site:index';
  const contentType = isIndex ? 'index' : (recordId.split(':')[0] || 'unknown');
  const status = isIndex ? 'published' : String(meta.status ?? 'draft');
  const visibility = (isIndex || meta.visibility === 'public') ? 'public' : 'private';

  const ctx: Record<string, unknown> = {
    agent,
    ts: new Date().toISOString(),
    // Flat fields for Xano server-side filtering
    content_type: contentType,
    status,
    visibility,
    // Legacy nested fields (kept for backward compat with existing records)
    object_type: visibility,
    meta: { status, visibility },
  };

  const values = JSON.stringify(stripRevisionHistory(stateSnapshot));
  const lastModified = new Date().toISOString();

  // If caller didn't pass an existing record, try to find one in the cache
  // to avoid creating duplicate rows for the same record_id.
  let target = existing ?? null;
  if (!target && _findCachedRecord) {
    target = _findCachedRecord(recordId);
  }

  let result: XanoCurrentRecord;
  if (target) {
    result = await patchCurrentRecord(target.id, { values, context: ctx, lastModified });
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
