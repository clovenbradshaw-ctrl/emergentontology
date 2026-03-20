/**
 * stateCache.ts — In-memory cache + unified state loader.
 *
 * Architecture (current-state-first):
 *   Primary:    eowikicurrent (authoritative snapshots) — cached in memory with TTL
 *   Fallback:   static /generated/state/ files  — pre-built at deploy time
 *   Secondary:  eowiki event log — change tracking only, never overrides current state
 *
 * The current-state table is fully self-contained: if the event log were
 * deleted, the site and admin editor would continue to work normally.
 *
 * The cache eliminates the N+1 problem where every fetchCurrentRecord() call
 * re-fetched ALL records from the API. Now records are fetched once and shared
 * across all editors until the cache expires or is explicitly invalidated.
 */

import type { XanoCurrentRecord, CurrentRecordFilters } from './client';
import {
  fetchAllCurrentRecords,
  fetchCurrentRecordByRecordId,
  fetchFilteredCurrentRecords,
  fetchAllRecords,
  xanoToRaw,
  upsertCurrentRecord,
  _registerCacheHook,
  _registerCacheLookup,
} from './client';
import type { ProjectedContent, EORawEvent } from '../eo/types';

// ── Cache configuration ─────────────────────────────────────────────────────

const CACHE_TTL = 30_000; // 30 seconds

let cachedRecords: XanoCurrentRecord[] | null = null;
let cacheTimestamp = 0;

// Per-record cache for single lookups when the full cache is cold.
// Avoids downloading all records just to get one.
const singleRecordCache = new Map<string, { record: XanoCurrentRecord | null; ts: number }>();

// ── Cached fetchers ─────────────────────────────────────────────────────────

/** Fetch all current-state records, using the in-memory cache when fresh. */
export async function fetchAllCurrentRecordsCached(): Promise<XanoCurrentRecord[]> {
  const now = Date.now();
  if (cachedRecords && now - cacheTimestamp < CACHE_TTL) {
    return cachedRecords;
  }
  try {
    cachedRecords = await fetchAllCurrentRecords();
    cacheTimestamp = now;
    return cachedRecords;
  } catch (err) {
    console.error('[stateCache] Failed to fetch current records from Xano:', err);
    // Return stale cache if available, otherwise return empty array so callers
    // can fall back to static snapshots instead of crashing.
    return cachedRecords ?? [];
  }
}

/**
 * Fetch a single current-state record by record_id (cache-backed).
 *
 * When the full cache is warm, serves from it (no API call).
 * When the cache is cold, uses the server-side ?record_id= filter to fetch
 * only the requested record instead of downloading everything.
 */
export async function fetchCurrentRecordCached(
  recordId: string,
): Promise<XanoCurrentRecord | null> {
  const now = Date.now();

  // If full cache is warm, serve from it — no API call needed
  if (cachedRecords && now - cacheTimestamp < CACHE_TTL) {
    return findBestMatch(cachedRecords, recordId);
  }

  // Check per-record cache
  const cached = singleRecordCache.get(recordId);
  if (cached && now - cached.ts < CACHE_TTL) {
    return cached.record;
  }

  // Cache is cold — fetch just this one record from the server
  try {
    const record = await fetchCurrentRecordByRecordId(recordId);
    if (record) {
      singleRecordCache.set(recordId, { record, ts: now });
      // Also insert into the full cache if it's warm (keeps it consistent)
      if (cachedRecords) {
        const idx = cachedRecords.findIndex((r) => r.record_id === recordId);
        if (idx >= 0) cachedRecords[idx] = record;
        else cachedRecords.push(record);
      }
      return record;
    }
    // Single-record filter returned nothing — fall back to full fetch
    console.warn(`[stateCache] Single-record fetch returned null for ${recordId}, trying full fetch`);
    const all = await fetchAllCurrentRecordsCached();
    const match = findBestMatch(all, recordId);
    singleRecordCache.set(recordId, { record: match, ts: now });
    return match;
  } catch (err) {
    console.warn(`[stateCache] Single-record fetch failed for ${recordId}, falling back to full fetch:`, err);
    // Fallback: fetch all (original behavior)
    const all = await fetchAllCurrentRecordsCached();
    return findBestMatch(all, recordId);
  }
}

/** Pick the most recently modified record for a given record_id. */
function findBestMatch(
  records: XanoCurrentRecord[],
  recordId: string,
): XanoCurrentRecord | null {
  const matches = records.filter((r) => r.record_id === recordId);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  return matches.reduce((best, r) => {
    const bestTime = typeof best.lastModified === 'string'
      ? new Date(best.lastModified).getTime() : Number(best.lastModified);
    const rTime = typeof r.lastModified === 'string'
      ? new Date(r.lastModified).getTime() : Number(r.lastModified);
    return rTime > bestTime ? r : best;
  });
}

/** Invalidate the cache (call after any write to eowikicurrent). */
export function invalidateCurrentCache(): void {
  cachedRecords = null;
  cacheTimestamp = 0;
  singleRecordCache.clear();
  filteredCache.clear();
}

/**
 * Update a record in the local cache without a full refetch.
 * Called after successful upserts so other editors see the new data immediately.
 */
export function updateCachedRecord(record: XanoCurrentRecord): void {
  // Update per-record cache
  singleRecordCache.set(record.record_id, { record, ts: Date.now() });

  // Update full cache if it's warm
  if (!cachedRecords) return;
  const idx = cachedRecords.findIndex((r) => r.record_id === record.record_id);
  if (idx >= 0) {
    cachedRecords[idx] = record;
  } else {
    cachedRecords.push(record);
  }
}

// ── Filtered fetcher ──────────────────────────────────────────────────────────

/**
 * Fetch current-state records with server-side filters (content_type, status,
 * visibility).  Uses a separate cache keyed by the filter combination so
 * repeated calls with the same filters don't hit the API.
 */
const filteredCache = new Map<string, { records: XanoCurrentRecord[]; ts: number }>();

function filterCacheKey(filters: CurrentRecordFilters): string {
  return [
    filters.id, filters.created_at, filters.record_id, filters.displayName,
    filters.values, filters.context ? JSON.stringify(filters.context) : undefined,
    filters.uuid, filters.lastModified,
    filters.content_type, filters.status, filters.visibility,
  ].join('|');
}

export async function fetchFilteredRecordsCached(
  filters: CurrentRecordFilters,
): Promise<XanoCurrentRecord[]> {
  const key = filterCacheKey(filters);
  const now = Date.now();
  const cached = filteredCache.get(key);
  if (cached && now - cached.ts < CACHE_TTL) {
    return cached.records;
  }
  try {
    const records = await fetchFilteredCurrentRecords(filters);
    filteredCache.set(key, { records, ts: now });
    return records;
  } catch (err) {
    console.warn('[stateCache] Filtered fetch failed, falling back to full fetch:', err);
    // Fallback: fetch all and filter client-side
    const all = await fetchAllCurrentRecordsCached();
    return all.filter((r) => {
      const ctx = r.context as Record<string, unknown>;
      const meta = (ctx?.meta ?? {}) as Record<string, unknown>;
      if (filters.content_type) {
        const recType = (r.record_id.split(':')[0]) || '';
        if (recType !== filters.content_type) return false;
      }
      // Check both flat context fields (new format) and nested meta (old format)
      if (filters.status) {
        const status = ctx?.status ?? meta.status;
        if (status !== filters.status) return false;
      }
      if (filters.visibility) {
        const visibility = ctx?.visibility ?? meta.visibility;
        if (visibility !== filters.visibility) return false;
      }
      return true;
    });
  }
}

// ── Unified state loader ────────────────────────────────────────────────────

export type StateSource = 'current' | 'static' | 'none';

export interface LoadedState<T = unknown> {
  /** Parsed state snapshot (null if nothing found). */
  state: T | null;
  /** The Xano current-state record (null if loaded from static/none). */
  record: XanoCurrentRecord | null;
  /** Where the state was loaded from. */
  source: StateSource;
}

/**
 * Load state for a content entity.
 *
 * 1. Try eowikicurrent (cached) — the fast path.
 * 2. Fall back to a static /generated/state/ snapshot.
 * 3. Return { state: null } if neither source has data.
 */
export async function loadState<T = unknown>(
  recordId: string,
  siteBase: string,
  staticPath?: string,
): Promise<LoadedState<T>> {
  // 1. Primary: cached current state
  try {
    const rec = await fetchCurrentRecordCached(recordId);
    if (rec) {
      return {
        state: JSON.parse(rec.values) as T,
        record: rec,
        source: 'current',
      };
    }
  } catch (err) {
    console.warn(`[stateCache] Could not fetch current record for ${recordId}:`, err);
  }

  // 2. Fallback: static snapshot
  const path = staticPath ?? defaultStaticPath(recordId);
  try {
    const resp = await fetch(`${siteBase}${path}`);
    if (resp.ok) {
      return {
        state: (await resp.json()) as T,
        record: null,
        source: 'static',
      };
    }
  } catch { /* no static file */ }

  return { state: null, record: null, source: 'none' };
}

// ── Freshness check (event-log delta) ───────────────────────────────────────
//
// The event log is for change-tracking only.  The current-state table
// (eowikicurrent) is the authoritative source of truth.  These functions
// are kept for diagnostic/observability purposes but no longer override
// the loaded state — if newer events exist they are logged to the console
// so admins can investigate, but the current-state snapshot is trusted.

/**
 * Check the event log for events newer than a given snapshot timestamp.
 * Returns raw events scoped to the given contentId that happened after
 * the snapshot was last modified.
 *
 * Used for observability only — results do NOT override current state.
 */
export async function fetchNewerEvents(
  contentId: string,
  snapshotLastModified: string,
): Promise<EORawEvent[]> {
  try {
    const allRecords = await fetchAllRecords();
    const cutoff = new Date(snapshotLastModified).getTime();

    return allRecords
      .filter((r) => {
        const rootId = r.subject.split('/')[0];
        return rootId === contentId && r.created_at > cutoff;
      })
      .map(xanoToRaw);
  } catch {
    return [];
  }
}

/**
 * Check the event log for events newer than the loaded snapshot.
 *
 * This is an observability-only check: the current-state table is
 * authoritative, so newer events are logged to the console but never
 * applied on top of the snapshot.  The returned `hadUpdates` flag is
 * always false — callers should not replace their state.
 *
 * @deprecated Kept for backward compatibility.  Callers can safely
 * remove their applyFreshnessUpdate calls — the current-state table
 * is the single source of truth.
 */
export async function applyFreshnessUpdate<T extends ProjectedContent>(
  contentId: string,
  currentState: T,
  snapshotRecord: XanoCurrentRecord | null,
  _opts?: { persist?: boolean; agent?: string },
): Promise<{ updated: T; hadUpdates: boolean }> {
  if (!snapshotRecord) {
    return { updated: currentState, hadUpdates: false };
  }

  // Fire-and-forget: check for newer events for observability
  fetchNewerEvents(contentId, snapshotRecord.lastModified)
    .then((events) => {
      if (events.length > 0) {
        console.info(
          `[stateCache] ${events.length} newer event(s) found in log for ${contentId} — ` +
          `current-state snapshot is authoritative, events are for tracking only.`,
        );
      }
    })
    .catch(() => { /* non-fatal */ });

  // Always return the current state unchanged — it is the source of truth
  return { updated: currentState, hadUpdates: false };
}

// ── Auto-register cache hooks ───────────────────────────────────────────────
// When client.ts writes a record, keep our cache in sync automatically.
_registerCacheHook(updateCachedRecord);
// Let client.ts look up existing records from cache before creating new rows.
_registerCacheLookup((recordId: string) => {
  if (!cachedRecords) return null;
  const matches = cachedRecords.filter((r) => r.record_id === recordId);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  return matches.reduce((best, r) => {
    const bestTime = typeof best.lastModified === 'string'
      ? new Date(best.lastModified).getTime() : Number(best.lastModified);
    const rTime = typeof r.lastModified === 'string'
      ? new Date(r.lastModified).getTime() : Number(r.lastModified);
    return rTime > bestTime ? r : best;
  });
});

// ── Revision history loader (from eowiki event log) ─────────────────────────

import type { WikiRevision } from '../eo/types';

/** Cache for revision history loaded from the event log. */
const revisionHistoryCache = new Map<string, { revisions: WikiRevision[]; ts: number }>();

/**
 * Fetch revision history for a content entity from the eowiki event log.
 * Filters events where `subject` starts with `contentId` and contains `/rev:`,
 * then extracts WikiRevision data from the event operand.
 *
 * Results are cached with the same TTL as other caches.
 */
export async function fetchRevisionHistory(contentId: string): Promise<WikiRevision[]> {
  const now = Date.now();
  const cached = revisionHistoryCache.get(contentId);
  if (cached && now - cached.ts < CACHE_TTL) {
    return cached.revisions;
  }

  try {
    const allRecords = await fetchAllRecords();
    const revisions: WikiRevision[] = [];

    for (const record of allRecords) {
      // Match events like "wiki:operators/rev:r_123"
      if (!record.subject.startsWith(contentId + '/rev:')) continue;
      if (record.op !== 'INS') continue;

      try {
        const operand = JSON.parse(record.value) as Record<string, unknown>;
        const rev: WikiRevision = {
          rev_id: String(operand.rev_id ?? record.subject.split('/rev:')[1] ?? `r_${record.id}`),
          format: (operand.format as WikiRevision['format']) ?? 'html',
          content: String(operand.content ?? ''),
          summary: String(operand.summary ?? ''),
          ts: operand.ts ? String(operand.ts) : new Date(record.created_at).toISOString(),
        };
        revisions.push(rev);
      } catch {
        // Skip malformed events
      }
    }

    // Sort by timestamp ascending
    revisions.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    revisionHistoryCache.set(contentId, { revisions, ts: now });
    return revisions;
  } catch (err) {
    console.warn(`[stateCache] Failed to fetch revision history for ${contentId}:`, err);
    return cached?.revisions ?? [];
  }
}

// ── One-time migration: strip revisions/history from current state ───────────

let _migrationStatus: 'idle' | 'running' | 'done' = 'idle';

/**
 * One-time migration: strip `revisions` and `history` arrays from
 * eowikicurrent records that still contain them.
 *
 * Idempotent: only patches records whose `values` JSON contains
 * a "revisions" or "history" array (empty or non-empty). Skips already-clean
 * records. Runs at most once per session — but only marks itself done on
 * success, so a failed attempt will retry on the next page load.
 */
export async function migrateStripRevisionHistory(
  agent: string,
): Promise<{ migrated: number; skipped: number }> {
  if (_migrationStatus !== 'idle') return { migrated: 0, skipped: 0 };
  _migrationStatus = 'running';

  try {
    const allRecords = await fetchAllCurrentRecordsCached();
    let migrated = 0;
    let skipped = 0;
    const toMigrate: { record: XanoCurrentRecord; parsed: Record<string, unknown> }[] = [];

    for (const record of allRecords) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(record.values);
      } catch {
        skipped++;
        continue;
      }

      const hasRevisions = Array.isArray(parsed.revisions);
      const hasHistory = Array.isArray(parsed.history);

      if (!hasRevisions && !hasHistory) {
        skipped++;
        continue;
      }

      // Strip revisions and history, keep everything else
      delete parsed.revisions;
      delete parsed.history;
      toMigrate.push({ record, parsed });
    }

    // Batch in chunks of 5 to avoid overwhelming the API
    let failures = 0;
    for (let i = 0; i < toMigrate.length; i += 5) {
      const chunk = toMigrate.slice(i, i + 5);
      const results = await Promise.allSettled(
        chunk.map(({ record, parsed }) =>
          upsertCurrentRecord(record.record_id, parsed, agent, record)
        ),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') migrated++;
        else {
          console.warn('[migration] Failed to clean record:', result.reason);
          failures++;
          skipped++;
        }
      }
    }

    // Only mark done if there were no failures — allows retry on next load
    if (failures === 0) {
      _migrationStatus = 'done';
    } else {
      _migrationStatus = 'idle';
    }

    console.info(`[migration] stripRevisionHistory complete: ${migrated} migrated, ${skipped} skipped, ${failures} failed.`);
    return { migrated, skipped };
  } catch (err) {
    // Reset so the migration can retry on next page load
    _migrationStatus = 'idle';
    throw err;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function defaultStaticPath(recordId: string): string {
  if (recordId === 'site:index') {
    return '/generated/state/index.json';
  }
  const fileName = recordId.replace(':', '-') + '.json';
  return `/generated/state/content/${fileName}`;
}
