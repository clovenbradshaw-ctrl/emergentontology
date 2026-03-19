/**
 * fetch_xano.ts — Read projected state from Xano eowikicurrent table.
 *
 * The eowikicurrent table stores one row per content entity:
 *   record_id = "site:index"  → site index (entries list)
 *   record_id = "wiki:home"   → WikiState snapshot
 *   record_id = "blog:post-1" → BlogState snapshot
 *   etc.
 *
 * The private endpoint path is AES-256-GCM encrypted in source.
 * At build time the EO_PASSWORD env var decrypts it.
 */

import { createHash, createDecipheriv } from 'crypto';

const XANO_BASE = 'https://xvkq-pq7i-idtl.n7d.xano.io/api:GGzWIVAW';
const TIMEOUT_MS = 30_000;

// Same encrypted blob as admin/src/xano/client.ts — see that file for
// regeneration instructions.
const ENCRYPTED_PRIVATE_ENDPOINT = 'T9q5Wmenm2sCBX3XD+vFxJdfU9aoZV/SxV47TfzR7rLu9SGrVFvOFBtBDzAJ';

function decryptEndpoint(password: string): string {
  const key = createHash('sha256').update(password).digest();
  const data = Buffer.from(ENCRYPTED_PRIVATE_ENDPOINT, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(data.length - 16);
  const ct = data.subarray(12, data.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct, undefined, 'utf8') + decipher.final('utf8');
}

export interface XanoCurrentRecord {
  id: number;
  created_at: string;    // ISO timestamp
  record_id: string;     // e.g. "wiki:home", "site:index"
  displayName: string;
  values: string;        // JSON-stringified state snapshot
  context: Record<string, unknown>;
  uuid: string;
  lastModified: string;  // ISO timestamp
}

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

/**
 * Normalise a Xano response that may be a flat array or a paginated wrapper.
 */
function unwrapResponse(data: unknown): XanoCurrentRecord[] {
  if (Array.isArray(data)) return data as XanoCurrentRecord[];
  if (data && typeof data === 'object' && 'items' in data) {
    return (data as PaginatedResponse<XanoCurrentRecord>).items;
  }
  return data ? [data as XanoCurrentRecord] : [];
}

/** Build the private endpoint URL, optionally with query and pagination parameters. */
function buildUrl(endpoint: string, params?: Record<string, string>, pagination?: PaginationParams): string {
  const url = `${XANO_BASE}/${endpoint}`;
  const allParams: Record<string, string> = { ...params };
  if (pagination?.page != null) allParams.page = String(pagination.page);
  if (pagination?.per_page != null) allParams.per_page = String(pagination.per_page);
  if (Object.keys(allParams).length === 0) return url;
  const qs = new URLSearchParams(allParams).toString();
  return `${url}?${qs}`;
}

/** Fetch a single page of current-state records. */
async function fetchPage(endpoint: string, pagination?: PaginationParams): Promise<PaginatedResponse<XanoCurrentRecord>> {
  const resp = await fetch(buildUrl(endpoint, undefined, pagination), {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Xano fetch failed: HTTP ${resp.status} — ${body}`);
  }
  const data = await resp.json();
  if (data && typeof data === 'object' && 'items' in data) {
    return data as PaginatedResponse<XanoCurrentRecord>;
  }
  const items = Array.isArray(data) ? data : [data];
  return { items, curPage: 1, nextPage: null, prevPage: null, itemsReceived: items.length, itemsTotal: items.length };
}

export async function fetchAllCurrentRecords(): Promise<XanoCurrentRecord[]> {
  const endpoint = getEndpoint();
  const first = await fetchPage(endpoint, { page: 1, per_page: 200 });
  const all: XanoCurrentRecord[] = [...first.items];

  if (first.itemsTotal > first.itemsReceived) {
    const totalPages = Math.ceil(first.itemsTotal / (first.items.length || 200));
    const pagePromises: Promise<PaginatedResponse<XanoCurrentRecord>>[] = [];
    for (let p = 2; p <= totalPages; p++) {
      pagePromises.push(fetchPage(endpoint, { page: p, per_page: 200 }));
    }
    const pages = await Promise.all(pagePromises);
    for (const page of pages) {
      all.push(...page.items);
    }
  }

  return all;
}

/** Fetch a single current-state record by record_id. */
export async function fetchCurrentRecordByRecordId(
  recordId: string,
): Promise<XanoCurrentRecord | null> {
  const endpoint = getEndpoint();
  const resp = await fetch(buildUrl(endpoint, { record_id: recordId }), {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Xano single-record fetch failed: HTTP ${resp.status} — ${body}`);
  }
  const data = await resp.json();
  const records: XanoCurrentRecord[] = unwrapResponse(data);
  // Filter to only records matching the requested record_id — in case
  // the server-side filter is ignored and all records are returned.
  const matching = records.filter((r) => r && r.record_id === recordId);
  if (matching.length === 0) return null;
  if (matching.length === 1) return matching[0];
  return matching.reduce((best, r) => {
    const bestTime = new Date(best.lastModified).getTime() || 0;
    const rTime = new Date(r.lastModified).getTime() || 0;
    return rTime > bestTime ? r : best;
  });
}

/** Query filters for the eowikicurrent endpoint. */
export interface CurrentRecordFilters {
  record_id?: string;
  content_type?: string;
  status?: string;
  visibility?: string;
}

/** Fetch current-state records with server-side filters. */
export async function fetchFilteredCurrentRecords(
  filters: CurrentRecordFilters,
): Promise<XanoCurrentRecord[]> {
  const endpoint = getEndpoint();
  const params: Record<string, string> = {};
  if (filters.content_type) params.content_type = filters.content_type;
  if (filters.status) params.status = filters.status;
  if (filters.visibility) params.visibility = filters.visibility;
  if (filters.record_id) params.record_id = filters.record_id;

  const resp = await fetch(buildUrl(endpoint, params), {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Xano filtered fetch failed: HTTP ${resp.status} — ${body}`);
  }
  const data = await resp.json();
  return unwrapResponse(data);
}

function getEndpoint(): string {
  const password = process.env.EO_PASSWORD;
  if (!password) {
    throw new Error('EO_PASSWORD environment variable is required to decrypt the private endpoint.');
  }
  return decryptEndpoint(password);
}
