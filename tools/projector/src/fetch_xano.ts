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

// Password for server-side API filtering bypass (build tool — needs all records)
const EO_API_PASSWORD = 'Brethren0-Happiest6-Dynamite5-Hammock9-Sharply0';

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
  const url = `${XANO_BASE}/get_eowiki_current?X_EO_Password=${encodeURIComponent(EO_API_PASSWORD)}`;
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Xano fetch failed: HTTP ${resp.status} — ${body}`);
  }
  return resp.json() as Promise<XanoCurrentRecord[]>;
}
