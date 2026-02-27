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

export async function fetchAllCurrentRecords(): Promise<XanoCurrentRecord[]> {
  const password = process.env.EO_PASSWORD;
  if (!password) {
    throw new Error('EO_PASSWORD environment variable is required to decrypt the private endpoint.');
  }
  const endpoint = decryptEndpoint(password);
  const url = `${XANO_BASE}/${endpoint}`;
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Xano fetch failed: HTTP ${resp.status} — ${body}`);
  }
  return resp.json() as Promise<XanoCurrentRecord[]>;
}
