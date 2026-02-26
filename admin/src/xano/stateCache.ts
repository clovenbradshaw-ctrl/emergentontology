/**
 * stateCache.ts — In-memory cache + unified state loader.
 *
 * Architecture:
 *   Primary:  eowikicurrent (fast snapshots) — cached in memory with TTL
 *   Fallback: static /generated/state/ files  — pre-built at deploy time
 *   Freshness: eowiki event log — checked after load to apply unseen deltas
 *
 * The cache eliminates the N+1 problem where every fetchCurrentRecord() call
 * re-fetched ALL records from the API. Now records are fetched once and shared
 * across all editors until the cache expires or is explicitly invalidated.
 */

import type { XanoCurrentRecord } from './client';
import {
  fetchAllCurrentRecords,
  fetchAllRecords,
  xanoToRaw,
  upsertCurrentRecord,
  _registerCacheHook,
} from './client';
import { applyDelta } from '../eo/replay';
import type { ProjectedContent, EORawEvent } from '../eo/types';

// ── Cache configuration ─────────────────────────────────────────────────────

const CACHE_TTL = 30_000; // 30 seconds

let cachedRecords: XanoCurrentRecord[] | null = null;
let cacheTimestamp = 0;

// ── Cached fetchers ─────────────────────────────────────────────────────────

/** Fetch all current-state records, using the in-memory cache when fresh. */
export async function fetchAllCurrentRecordsCached(): Promise<XanoCurrentRecord[]> {
  const now = Date.now();
  if (cachedRecords && now - cacheTimestamp < CACHE_TTL) {
    return cachedRecords;
  }
  cachedRecords = await fetchAllCurrentRecords();
  cacheTimestamp = now;
  return cachedRecords;
}

/** Fetch a single current-state record by record_id (cache-backed). */
export async function fetchCurrentRecordCached(
  recordId: string,
): Promise<XanoCurrentRecord | null> {
  const all = await fetchAllCurrentRecordsCached();
  return all.find((r) => r.record_id === recordId) ?? null;
}

/** Invalidate the cache (call after any write to eowikicurrent). */
export function invalidateCurrentCache(): void {
  cachedRecords = null;
  cacheTimestamp = 0;
}

/**
 * Update a record in the local cache without a full refetch.
 * Called after successful upserts so other editors see the new data immediately.
 */
export function updateCachedRecord(record: XanoCurrentRecord): void {
  if (!cachedRecords) return;
  const idx = cachedRecords.findIndex((r) => r.record_id === record.record_id);
  if (idx >= 0) {
    cachedRecords[idx] = record;
  } else {
    cachedRecords.push(record);
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

/**
 * Check the event log for events newer than a given snapshot timestamp.
 * Returns raw events scoped to the given contentId that happened after
 * the snapshot was last modified.
 *
 * This is intentionally a separate call so editors can fire it in the
 * background after the initial (fast) load from current state.
 */
export async function fetchNewerEvents(
  contentId: string,
  snapshotLastModified: string,
): Promise<EORawEvent[]> {
  try {
    const allRecords = await fetchAllRecords();
    const cutoff = new Date(snapshotLastModified).getTime();

    // Filter to events targeting this content that are newer than the snapshot
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
 * After an initial load from current state, check the event log for
 * any events that happened after the snapshot and apply them as deltas.
 *
 * Returns the updated state if deltas were applied, or null if no updates found.
 * Optionally persists the updated snapshot back to eowikicurrent.
 */
export async function applyFreshnessUpdate<T extends ProjectedContent>(
  contentId: string,
  currentState: T,
  snapshotRecord: XanoCurrentRecord | null,
  opts?: { persist?: boolean; agent?: string },
): Promise<{ updated: T; hadUpdates: boolean }> {
  if (!snapshotRecord) {
    return { updated: currentState, hadUpdates: false };
  }

  const newerEvents = await fetchNewerEvents(contentId, snapshotRecord.lastModified);

  if (newerEvents.length === 0) {
    return { updated: currentState, hadUpdates: false };
  }

  // Apply the delta events on top of the current snapshot
  const updated = applyDelta(currentState, newerEvents) as T;

  // Optionally persist the updated state back to eowikicurrent
  if (opts?.persist !== false && opts?.agent) {
    try {
      const updatedRecord = await upsertCurrentRecord(
        contentId,
        updated,
        opts.agent,
        snapshotRecord,
      );
      updateCachedRecord(updatedRecord);
    } catch (err) {
      console.warn(`[stateCache] Could not persist freshness update for ${contentId}:`, err);
    }
  }

  return { updated, hadUpdates: true };
}

// ── Auto-register cache hook ────────────────────────────────────────────────
// When client.ts writes a record, keep our cache in sync automatically.
_registerCacheHook(updateCachedRecord);

// ── Helpers ─────────────────────────────────────────────────────────────────

function defaultStaticPath(recordId: string): string {
  if (recordId === 'site:index') {
    return '/generated/state/index.json';
  }
  const fileName = recordId.replace(':', '-') + '.json';
  return `/generated/state/content/${fileName}`;
}
