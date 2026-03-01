/**
 * matrix/client.ts — Thin Matrix API wrapper for the admin app.
 *
 * Uses the native fetch API for basic REST operations (room messages, state,
 * etc.) for simplicity.  The full matrix-js-sdk (loaded via ./sdk.ts) is
 * initialised alongside login so it's available for E2EE and /sync.
 *
 * Auth is via Matrix password login; tokens are stored in localStorage
 * (persists across browser sessions).
 *
 * Multiple editor support: each editor logs in separately; the room power level
 * controls who can write.  Writes are attributed to the Matrix user.
 */

import { createSDKClient, destroySDKClient } from './sdk';

export interface MatrixCredentials {
  access_token: string;
  user_id: string;
  device_id: string;
  homeserver: string;
}

const STORAGE_KEY = 'eo_matrix_credentials';

// ── Persistence (localStorage — persists across browser sessions) ────────────

export function saveCredentials(creds: MatrixCredentials): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
}

export function loadCredentials(): MatrixCredentials | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const creds = JSON.parse(raw) as MatrixCredentials;
    // Restore the SDK client for the persisted session
    createSDKClient({
      homeserver: creds.homeserver,
      accessToken: creds.access_token,
      userId: creds.user_id,
      deviceId: creds.device_id,
    });
    return creds;
  } catch { return null; }
}

export function clearCredentials(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function login(
  homeserver: string,
  username: string,
  password: string
): Promise<MatrixCredentials> {
  let resp: Response;
  try {
    resp = await fetch(`${homeserver}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: username },
        password,
        initial_device_display_name: 'EO Admin Editor',
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (fetchErr) {
    if (fetchErr instanceof Error && fetchErr.name === 'TimeoutError') {
      throw new Error('Could not reach the homeserver — request timed out. Check your connection.');
    }
    throw fetchErr;
  }
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { errcode?: string; error?: string };
    throw new Error(err.error || `Login failed: HTTP ${resp.status}`);
  }
  const data = await resp.json() as { access_token: string; user_id: string; device_id: string };
  const creds: MatrixCredentials = { ...data, homeserver };
  saveCredentials(creds);

  // Initialise the full SDK client so E2EE / sync features are available
  createSDKClient({
    homeserver,
    accessToken: creds.access_token,
    userId: creds.user_id,
    deviceId: creds.device_id,
  });

  return creds;
}

export async function logout(creds: MatrixCredentials): Promise<void> {
  await fetch(`${creds.homeserver}/_matrix/client/v3/logout`, {
    method: 'POST',
    headers: authHeaders(creds),
  }).catch(() => {});
  clearCredentials();
  destroySDKClient();
}

function authHeaders(creds: MatrixCredentials): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${creds.access_token}`,
  };
}

// ── Room resolution ───────────────────────────────────────────────────────────

export async function resolveAlias(homeserver: string, alias: string): Promise<string> {
  const resp = await fetch(`${homeserver}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`);
  if (!resp.ok) throw new Error(`Could not resolve alias ${alias}`);
  const data = await resp.json() as { room_id: string };
  return data.room_id;
}

export async function createRoom(creds: MatrixCredentials, opts: {
  name: string;
  alias: string;
  topic?: string;
  preset?: 'public_chat' | 'private_chat';
}): Promise<string> {
  const resp = await fetch(`${creds.homeserver}/_matrix/client/v3/createRoom`, {
    method: 'POST',
    headers: authHeaders(creds),
    body: JSON.stringify({
      name: opts.name,
      room_alias_name: opts.alias.replace(/^#/, '').split(':')[0],
      topic: opts.topic,
      preset: opts.preset ?? 'public_chat',
      initial_state: [],
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `createRoom failed: HTTP ${resp.status}`);
  }
  const data = await resp.json() as { room_id: string };
  return data.room_id;
}

// ── Events ────────────────────────────────────────────────────────────────────

/** Send a single eo.op event to a room. */
export async function sendEOEvent(
  creds: MatrixCredentials,
  roomId: string,
  content: Record<string, unknown>,
  txnId?: string
): Promise<string> {
  const txn = txnId ?? `eo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const resp = await fetch(
    `${creds.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/eo.op/${encodeURIComponent(txn)}`,
    {
      method: 'PUT',
      headers: authHeaders(creds),
      body: JSON.stringify(content),
    }
  );
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `sendEvent failed: HTTP ${resp.status}`);
  }
  const data = await resp.json() as { event_id: string };
  return data.event_id;
}

/** Set a Matrix state event (for com.eo.content.meta). */
export async function setStateEvent(
  creds: MatrixCredentials,
  roomId: string,
  eventType: string,
  stateKey: string,
  content: Record<string, unknown>
): Promise<void> {
  const resp = await fetch(
    `${creds.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}/${encodeURIComponent(stateKey)}`,
    {
      method: 'PUT',
      headers: authHeaders(creds),
      body: JSON.stringify(content),
    }
  );
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `setStateEvent failed: HTTP ${resp.status}`);
  }
}

/**
 * Fetch room events since a given `from` token (for delta sync).
 * Pass `from = undefined` for all events (full history).
 * Returns events in chronological order and the new `end` token.
 */
export async function fetchRoomDelta(
  homeserver: string,
  roomId: string,
  from?: string,
  accessToken?: string
): Promise<{ events: Array<{ event_id: string; type: string; sender: string; origin_server_ts: number; content: Record<string, unknown> }>; end: string | undefined }> {
  const params = new URLSearchParams({ dir: 'f', limit: '100', filter: JSON.stringify({ types: ['eo.op'] }) });
  if (from) params.set('from', from);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const resp = await fetch(
    `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${params}`,
    { headers }
  );
  if (!resp.ok) return { events: [], end: undefined };

  const data = await resp.json() as { chunk: Array<{ event_id: string; type: string; sender: string; origin_server_ts: number; content: Record<string, unknown> }>; end?: string };
  return { events: data.chunk ?? [], end: data.end };
}

/** Fetch the current state of a room (state events). */
export async function fetchRoomState(
  creds: MatrixCredentials,
  roomId: string
): Promise<Array<{ type: string; state_key: string; content: Record<string, unknown> }>> {
  const resp = await fetch(
    `${creds.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`,
    { headers: authHeaders(creds) }
  );
  if (!resp.ok) return [];
  return (await resp.json()) as Array<{ type: string; state_key: string; content: Record<string, unknown> }>;
}

/**
 * Check whether the current user has enough power to send `eo.op` events
 * in a given room.  Returns the user's power level and the required threshold.
 *
 * The server enforces power levels — this check is purely for UX (show a
 * clear "you don't have write access" message before the user even tries).
 */
export async function checkWriteAccess(
  creds: MatrixCredentials,
  roomId: string
): Promise<{ canWrite: boolean; userLevel: number; required: number }> {
  try {
    const resp = await fetch(
      `${creds.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels/`,
      { headers: authHeaders(creds) }
    );
    if (!resp.ok) {
      // Can't read power levels (likely not a member) — assume no access
      return { canWrite: false, userLevel: 0, required: 50 };
    }

    const pl = await resp.json() as {
      events?: Record<string, number>;
      events_default?: number;
      users?: Record<string, number>;
      users_default?: number;
    };

    // Required level: specific override for eo.op, else events_default, else 0
    const required = pl.events?.['eo.op'] ?? pl.events_default ?? 0;

    // User's level: specific override, else users_default, else 0
    const userLevel = pl.users?.[creds.user_id] ?? pl.users_default ?? 0;

    return { canWrite: userLevel >= required, userLevel, required };
  } catch {
    return { canWrite: false, userLevel: 0, required: 50 };
  }
}
