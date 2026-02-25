/**
 * fetch_matrix.ts
 *
 * Fetches events from a Matrix homeserver.
 * Uses only public-readable endpoints unless an access_token is supplied.
 *
 * Matrix APIs used:
 *   GET /_matrix/client/v3/rooms/{roomId}/messages   – paginated event history
 *   GET /_matrix/client/v3/rooms/{roomId}/state      – state events (meta)
 *   GET /_matrix/client/v3/directory/room/{alias}    – alias → room ID
 *   GET /_matrix/client/v3/publicRooms               – discover public rooms
 */

import type { MatrixEvent, BuildConfig } from './types.js';

const MATRIX_TIMEOUT = 30_000;

interface FetchRoomMessagesResponse {
  chunk: MatrixEvent[];
  start: string;
  end?: string;
}

interface RoomAliasResponse {
  room_id: string;
}

interface PublicRoomsResponse {
  chunk: Array<{ room_id: string; name?: string; canonical_alias?: string; topic?: string }>;
  next_batch?: string;
}

function makeHeaders(cfg: BuildConfig): HeadersInit {
  const h: HeadersInit = { 'Content-Type': 'application/json' };
  if (cfg.access_token) {
    (h as Record<string, string>)['Authorization'] = `Bearer ${cfg.access_token}`;
  }
  return h;
}

async function fetchWithRetry(url: string, headers: HeadersInit, retries = 4): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(MATRIX_TIMEOUT),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${body}`);
      }
      return resp;
    } catch (err) {
      lastErr = err;
      const wait = Math.pow(2, i) * 1000;
      console.warn(`[fetch_matrix] Retrying ${url} in ${wait}ms (attempt ${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * Resolve a Matrix room alias like `#site:example.com` to a room ID.
 */
export async function resolveAlias(alias: string, cfg: BuildConfig): Promise<string> {
  const encoded = encodeURIComponent(alias);
  const url = `${cfg.homeserver}/_matrix/client/v3/directory/room/${encoded}`;
  const resp = await fetchWithRetry(url, makeHeaders(cfg));
  const data = (await resp.json()) as RoomAliasResponse;
  return data.room_id;
}

/**
 * Fetch all message events from a room, paginating until done.
 * Returns events in chronological order (oldest first).
 */
export async function fetchRoomEvents(roomId: string, cfg: BuildConfig): Promise<MatrixEvent[]> {
  const headers = makeHeaders(cfg);
  const all: MatrixEvent[] = [];
  let from: string | undefined;

  // We paginate backwards from the end (most recent → oldest), then reverse.
  // The Matrix /messages API with dir=b goes backwards; dir=f from the start goes forwards.
  // For full history we use dir=b and paginate until chunk is empty.
  do {
    const params = new URLSearchParams({
      dir: 'b',
      limit: '100',
      filter: JSON.stringify({ types: ['eo.op', 'com.eo.content.meta', 'com.eo.site.index'] }),
    });
    if (from) params.set('from', from);

    const url = `${cfg.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${params}`;
    const resp = await fetchWithRetry(url, headers);
    const data = (await resp.json()) as FetchRoomMessagesResponse;

    all.push(...data.chunk);
    from = data.end;

    if (!data.end || data.chunk.length === 0) break;
  } while (true);

  // Reverse to chronological order
  all.reverse();
  return all;
}

/**
 * Fetch state events for a room (returns current state snapshot).
 * Useful for quickly reading `com.eo.content.meta`.
 */
export async function fetchRoomState(roomId: string, cfg: BuildConfig): Promise<MatrixEvent[]> {
  const url = `${cfg.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`;
  const resp = await fetchWithRetry(url, makeHeaders(cfg));
  return (await resp.json()) as MatrixEvent[];
}

/**
 * Discover all public rooms that match our naming convention.
 * Room names/topics are expected to start with one of:
 *   site:  page:  blog:  wiki:  exp:
 */
export async function discoverContentRooms(
  cfg: BuildConfig
): Promise<Array<{ room_id: string; content_id: string }>> {
  const headers = makeHeaders(cfg);
  const results: Array<{ room_id: string; content_id: string }> = [];
  let since: string | undefined;

  do {
    const body: Record<string, unknown> = { limit: 100 };
    if (since) body.since = since;

    const url = `${cfg.homeserver}/_matrix/client/v3/publicRooms`;
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MATRIX_TIMEOUT),
    });
    if (!resp.ok) break;

    const data = (await resp.json()) as PublicRoomsResponse;

    for (const room of data.chunk) {
      const alias = room.canonical_alias ?? '';
      // Match aliases like #page:about:example.com or topic/name fields
      const match = alias.match(/^#((?:page|blog|wiki|exp|site):[^:]+):/);
      if (match) {
        results.push({ room_id: room.room_id, content_id: match[1] });
      }
    }

    since = data.next_batch;
    if (!since || data.chunk.length === 0) break;
  } while (true);

  return results;
}

/**
 * Fetch the site:index room events.
 * First tries to resolve the alias `#site:index:<server>`.
 * Falls back to publicRooms discovery.
 */
export async function fetchSiteIndex(
  cfg: BuildConfig,
  serverName: string
): Promise<MatrixEvent[]> {
  const alias = `#site:index:${serverName}`;
  try {
    const roomId = await resolveAlias(alias, cfg);
    return fetchRoomEvents(roomId, cfg);
  } catch {
    console.warn('[fetch_matrix] Could not resolve site:index alias, falling back to discovery');
    return [];
  }
}
