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

/** Build the private endpoint URL, optionally with query parameters. */
function buildUrl(endpoint: string, params?: Record<string, string>): string {
  const url = `${XANO_BASE}/${endpoint}`;
  if (!params || Object.keys(params).length === 0) return url;
  const qs = new URLSearchParams(params).toString();
  return `${url}?${qs}`;
}

export async function fetchAllCurrentRecords(): Promise<XanoCurrentRecord[]> {
  const endpoint = getEndpoint();
  const resp = await fetch(buildUrl(endpoint), {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Xano fetch failed: HTTP ${resp.status} — ${body}`);
  }
  return resp.json() as Promise<XanoCurrentRecord[]>;
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
  const records: XanoCurrentRecord[] = Array.isArray(data) ? data : [data];
  return records[0] ?? null;
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
  return Array.isArray(data) ? data : [data];
}

function getEndpoint(): string {
  const password = process.env.EO_PASSWORD;
  if (!password) {
    throw new Error('EO_PASSWORD environment variable is required to decrypt the private endpoint.');
  }
  return decryptEndpoint(password);
}
