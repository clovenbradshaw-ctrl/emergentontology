/**
 * fetch_xano.ts — Read projected state from Xano eowikicurrent table.
 *
 * The eowikicurrent table stores one row per content entity:
 *   record_id = "site:index"  → site index (entries list)
 *   record_id = "wiki:home"   → WikiState snapshot
 *   record_id = "blog:post-1" → BlogState snapshot
 *   etc.
 *
 * GET /eowikicurrent — public endpoint, no auth required.
 */

const XANO_BASE = 'https://xvkq-pq7i-idtl.n7d.xano.io/api:GGzWIVAW';
const TIMEOUT_MS = 30_000;

export interface XanoCurrentRecord {
  id: number;
  created_at: number;   // epoch ms
  record_id: string;    // e.g. "wiki:home", "site:index"
  op: string;
  subject: string;
  predicate: string;
  value: string;        // JSON-stringified state snapshot
  context: unknown;
}

export async function fetchAllCurrentRecords(): Promise<XanoCurrentRecord[]> {
  const resp = await fetch(`${XANO_BASE}/eowikicurrent`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Xano fetch failed: HTTP ${resp.status} — ${body}`);
  }
  return resp.json() as Promise<XanoCurrentRecord[]>;
}
