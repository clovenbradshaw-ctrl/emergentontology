/**
 * live-sync.js — Optional client-side live content update.
 *
 * Load strategy (snapshot-first, then delta):
 *   1. The page already rendered from the static snapshot (fast, no Matrix calls needed).
 *   2. This script loads the snapshot's `built_at` timestamp.
 *   3. Fetches only events *newer* than `built_at` from Matrix.
 *   4. Applies delta events on top of the snapshot (mini replay).
 *   5. Updates the DOM if anything changed.
 *
 * This prevents snapshot spam: the snapshot is loaded once and cached;
 * only the lightweight delta is fetched from Matrix on each visit.
 *
 * Opt-in: add  data-live-sync="content_id"  to any content article element,
 * and set  data-homeserver="https://matrix.example.com"  on the body.
 */
(async function () {
  const body = document.body;
  const homeserver = body.dataset.homeserver;
  const article = document.querySelector('[data-live-sync]');
  if (!homeserver || !article) return;

  const contentId = article.dataset.liveSync;
  const base = document.querySelector('link[rel="alternate"]')
    ?.getAttribute('href')?.replace('/generated/state/index.json', '') ?? '';

  // ── 1. Load the pre-built snapshot ────────────────────────────────────────
  let snapshot;
  try {
    const fileName = contentId.replace(':', '-') + '.json';
    const resp = await fetch(`${base}/generated/state/content/${fileName}`);
    if (!resp.ok) return;
    snapshot = await resp.json();
  } catch { return; }

  const snapshotTs = snapshot?.meta?.updated_at ?? snapshot?.built_at;
  if (!snapshotTs) return;

  // ── 2. Determine the Matrix room ID from the index ─────────────────────────
  let roomId;
  try {
    const indexResp = await fetch(`${base}/generated/state/index.json`);
    const index = await indexResp.json();
    const entry = index.entries?.find((e) => e.content_id === contentId);
    if (!entry) return;
    // Room ID resolution: try alias #<content_type>:<slug>:<server>
    const serverName = new URL(homeserver).hostname;
    const alias = encodeURIComponent(`#${contentId}:${serverName}`);
    const aliasResp = await fetch(`${homeserver}/_matrix/client/v3/directory/room/${alias}`);
    if (!aliasResp.ok) return;
    roomId = (await aliasResp.json()).room_id;
  } catch { return; }

  // ── 3. Fetch delta events (since snapshot built_at) ────────────────────────
  let deltaEvents = [];
  try {
    const since = encodeURIComponent(snapshotTs);
    const filter = encodeURIComponent(JSON.stringify({ types: ['eo.op'] }));
    const url = `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=f&limit=100&filter=${filter}`;
    const resp = await fetch(url);
    if (!resp.ok) return;
    const data = await resp.json();
    // Filter to only events *after* the snapshot timestamp
    deltaEvents = (data.chunk ?? []).filter((e) =>
      e.origin_server_ts > new Date(snapshotTs).getTime()
    );
  } catch { return; }

  if (!deltaEvents.length) return; // snapshot is already current

  // ── 4. Apply delta events ──────────────────────────────────────────────────
  // For simplicity, a delta that includes a DES with status change or a new
  // wiki/blog rev triggers a page reload with a cache-bust so the user gets
  // the freshest content without a full event replay client-side.
  const hasMeaningfulChange = deltaEvents.some((e) => {
    const c = e.content;
    return c && (c.op === 'INS' || c.op === 'ALT' || c.op === 'DES');
  });

  if (hasMeaningfulChange) {
    // Auto-reload to show the latest content
    location.reload();
  }
})();
