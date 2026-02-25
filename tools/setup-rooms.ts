/**
 * setup-rooms.ts
 *
 * One-time script to create and configure Matrix rooms for the EO site.
 *
 * Room security model:
 *   - join_rule: invite          → only invited users can join
 *   - history_visibility: world_readable → projector reads events without a token
 *   - events_default: 50         → only moderator+ can send eo.op events
 *   - state_default: 100         → only admins can change room settings
 *   - invite: 50                 → only moderator+ can invite others
 *   - Your account: power 100 (admin)
 *   - Additional editors: invite them, then set power to 50
 *
 * Usage:
 *   MATRIX_HOMESERVER=https://hyphae.social \
 *   MATRIX_ACCESS_TOKEN=<your_token> \
 *   MATRIX_USER_ID=@you:hyphae.social \
 *   npx tsx tools/setup-rooms.ts
 *
 * Or to create a single room:
 *   ... npx tsx tools/setup-rooms.ts --room wiki:operators --title "Operators"
 */

const HOMESERVER = process.env.MATRIX_HOMESERVER ?? 'https://hyphae.social';
const SERVER_NAME = process.env.MATRIX_SERVER_NAME ?? 'hyphae.social';
const ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN;
const USER_ID = process.env.MATRIX_USER_ID;

if (!ACCESS_TOKEN || !USER_ID) {
  console.error('Error: MATRIX_ACCESS_TOKEN and MATRIX_USER_ID are required.');
  console.error('Get your access token from Element → Settings → Help & About → Access Token.');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${ACCESS_TOKEN}`,
};

async function apiPost(path: string, body: unknown): Promise<Record<string, unknown>> {
  const resp = await fetch(`${HOMESERVER}/_matrix/client/v3${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await resp.json() as Record<string, unknown>;
  if (!resp.ok) throw new Error(`POST ${path} failed: ${data.error ?? resp.status}`);
  return data;
}

async function apiPut(path: string, body: unknown): Promise<Record<string, unknown>> {
  const resp = await fetch(`${HOMESERVER}/_matrix/client/v3${path}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });
  const data = await resp.json() as Record<string, unknown>;
  if (!resp.ok) throw new Error(`PUT ${path} failed: ${data.error ?? resp.status}`);
  return data;
}

async function apiGet(path: string): Promise<Record<string, unknown>> {
  const resp = await fetch(`${HOMESERVER}/_matrix/client/v3${path}`, { headers });
  const data = await resp.json() as Record<string, unknown>;
  if (!resp.ok) throw new Error(`GET ${path} failed: ${data.error ?? resp.status}`);
  return data;
}

// ── Power level configuration ─────────────────────────────────────────────────
//
// events_default: 50  → sending any message event requires moderator level
// state_default:  100 → changing room state requires admin
// invite:          50 → only moderators+ can invite others
// kick/ban:       100 → only admins can kick/ban
// redact:          50 → moderators can redact (tombstone a mistake, rare)
//
// This means: public can READ (world_readable), but only moderator+ can WRITE.

const POWER_LEVELS = {
  ban: 100,
  kick: 100,
  redact: 50,
  invite: 50,
  events_default: 50,   // ← key: blocks random write
  state_default: 100,
  users_default: 0,
  events: {
    'm.room.name': 100,
    'm.room.power_levels': 100,
    'm.room.history_visibility': 100,
    'm.room.canonical_alias': 100,
    'm.room.avatar': 50,
    'm.room.tombstone': 100,
    'm.room.server_acl': 100,
    'm.room.encryption': 100,
    'com.eo.content.meta': 50,
    'eo.op': 50,          // ← eo.op events require power 50
  },
  users: {
    [USER_ID]: 100,       // you are admin
  },
};

// ── Create a single room ──────────────────────────────────────────────────────

async function createContentRoom(opts: {
  contentId: string;    // e.g. "wiki:operators"
  title: string;
  preset?: 'private_chat' | 'trusted_private_chat';
}): Promise<string> {
  const { contentId, title } = opts;
  const [type, slug] = contentId.split(':');
  const aliasLocalpart = `${type}-${slug.replace(/\//g, '-')}`;

  console.log(`  Creating room: ${contentId} (#${aliasLocalpart}:${SERVER_NAME})`);

  const data = await apiPost('/createRoom', {
    name: title,
    room_alias_name: aliasLocalpart,
    topic: `EO ${type}: ${slug}`,
    // Start private — projector reads via world_readable history, not membership
    preset: 'private_chat',
    initial_state: [
      // History readable by everyone (unauthenticated) — projector reads this
      {
        type: 'm.room.history_visibility',
        state_key: '',
        content: { history_visibility: 'world_readable' },
      },
      // Invite-only: random accounts can't join
      {
        type: 'm.room.join_rules',
        state_key: '',
        content: { join_rule: 'invite' },
      },
      // Power levels: only moderator+ can write
      {
        type: 'm.room.power_levels',
        state_key: '',
        content: POWER_LEVELS,
      },
    ],
  }) as { room_id: string };

  console.log(`    room_id: ${data.room_id}`);
  return data.room_id;
}

// ── Invite an editor and set their power level ────────────────────────────────

export async function inviteEditor(roomId: string, editorUserId: string, powerLevel = 50): Promise<void> {
  // Invite
  await apiPost(`/rooms/${encodeURIComponent(roomId)}/invite`, { user_id: editorUserId });
  console.log(`  Invited ${editorUserId} to ${roomId}`);

  // Set power level
  // First fetch current power levels so we don't overwrite others
  const state = await apiGet(`/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`) as {
    users?: Record<string, number>;
    [key: string]: unknown;
  };
  const updatedPowerLevels = {
    ...state,
    users: { ...(state.users ?? {}), [editorUserId]: powerLevel },
  };
  await apiPut(
    `/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels/`,
    updatedPowerLevels
  );
  console.log(`  Set power level ${powerLevel} for ${editorUserId}`);
}

// ── Apply security settings to an existing room ───────────────────────────────
// Use this if you already have rooms and just want to lock them down.

async function secureExistingRoom(roomId: string): Promise<void> {
  console.log(`  Securing existing room: ${roomId}`);

  await apiPut(`/rooms/${encodeURIComponent(roomId)}/state/m.room.history_visibility/`, {
    history_visibility: 'world_readable',
  });

  await apiPut(`/rooms/${encodeURIComponent(roomId)}/state/m.room.join_rules/`, {
    join_rule: 'invite',
  });

  // Fetch existing power levels and merge (preserve existing user levels)
  const existing = await apiGet(`/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`) as Record<string, unknown>;
  const merged = {
    ...existing,
    ...POWER_LEVELS,
    users: { ...(POWER_LEVELS.users), ...((existing.users as Record<string, number>) ?? {}) },
  };
  await apiPut(`/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels/`, merged);

  console.log(`    Done.`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--secure-existing')) {
  // Usage: npx tsx tools/setup-rooms.ts --secure-existing <room_id>
  const idx = args.indexOf('--secure-existing');
  const roomId = args[idx + 1];
  if (!roomId) { console.error('Provide a room_id after --secure-existing'); process.exit(1); }
  secureExistingRoom(roomId).then(() => console.log('Done.')).catch(console.error);

} else if (args.includes('--invite')) {
  // Usage: npx tsx tools/setup-rooms.ts --invite <room_id> <user_id> [power_level]
  const idx = args.indexOf('--invite');
  const [roomId, userId, level] = args.slice(idx + 1);
  if (!roomId || !userId) { console.error('Usage: --invite <room_id> <user_id> [50]'); process.exit(1); }
  inviteEditor(roomId, userId, level ? parseInt(level) : 50)
    .then(() => console.log('Done.'))
    .catch(console.error);

} else if (args.includes('--room')) {
  // Usage: npx tsx tools/setup-rooms.ts --room wiki:operators --title "Operators"
  const rIdx = args.indexOf('--room');
  const tIdx = args.indexOf('--title');
  const contentId = args[rIdx + 1];
  const title = tIdx >= 0 ? args[tIdx + 1] : contentId;
  if (!contentId) { console.error('Usage: --room <content_id> --title <title>'); process.exit(1); }
  createContentRoom({ contentId, title })
    .then((roomId) => {
      console.log(`\nRoom created: ${roomId}`);
      console.log(`Add to site:index room with alias: #${contentId.replace(':', '-')}:${SERVER_NAME}`);
    })
    .catch(console.error);

} else {
  // Default: create the site:index room and show instructions
  console.log('EO Room Setup');
  console.log('=============');
  console.log(`Homeserver:  ${HOMESERVER}`);
  console.log(`Admin user:  ${USER_ID}`);
  console.log('');
  console.log('Creating site:index room…');

  createContentRoom({ contentId: 'site:index', title: 'EO Site Index' })
    .then((roomId) => {
      console.log(`\nsite:index room created: ${roomId}`);
      console.log('');
      console.log('Next steps:');
      console.log(`  Create content rooms:`);
      console.log(`    npx tsx tools/setup-rooms.ts --room wiki:operators --title "Operators"`);
      console.log(`    npx tsx tools/setup-rooms.ts --room blog:intro --title "Introduction"`);
      console.log('');
      console.log('  Invite an editor:');
      console.log(`    npx tsx tools/setup-rooms.ts --invite ${roomId} @editor:hyphae.social 50`);
      console.log('');
      console.log('  Secure an existing room (if you already have rooms):');
      console.log(`    npx tsx tools/setup-rooms.ts --secure-existing !roomid:hyphae.social`);
    })
    .catch(console.error);
}
