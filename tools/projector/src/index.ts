/**
 * index.ts — Projector entry point
 *
 * Usage:
 *   node dist/index.js
 *
 * Environment variables (all optional — defaults to hyphae.social):
 *   MATRIX_HOMESERVER   default: https://hyphae.social
 *   MATRIX_ACCESS_TOKEN optional  include private/draft rooms in builds
 *   MATRIX_SERVER_NAME  optional  default: hyphae.social
 *   INCLUDE_DRAFTS      optional  "true" to include draft content (requires access token)
 *   OUT_DIR             optional  default: "../../site/public/generated"
 *   SITE_BASE_URL       optional  default: ""  (relative, works for any gh-pages path)
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import type { BuildConfig } from './types.js';
import { fetchRoomEvents, fetchSiteIndex, discoverContentRooms } from './fetch_matrix.ts';
import { replayRoom, replaySiteIndex } from './replay.js';
import {
  renderSearchIndex,
  renderStateFiles,
} from './render.js';

const DEFAULT_HOMESERVER = 'https://hyphae.social';
const DEFAULT_SERVER_NAME = 'hyphae.social';

async function main() {
  const homeserver = process.env.MATRIX_HOMESERVER ?? DEFAULT_HOMESERVER;
  const serverName = process.env.MATRIX_SERVER_NAME ?? DEFAULT_SERVER_NAME;

  const cfg: BuildConfig = {
    homeserver,
    access_token: process.env.MATRIX_ACCESS_TOKEN,
    out_dir: process.env.OUT_DIR ?? join(import.meta.dirname, '..', '..', '..', 'site', 'public', 'generated'),
    // Drafts only included when an access token is explicitly provided
    include_drafts: process.env.INCLUDE_DRAFTS === 'true' && !!process.env.MATRIX_ACCESS_TOKEN,
    site_base_url: process.env.SITE_BASE_URL ?? '',
  };

  mkdirSync(cfg.out_dir, { recursive: true });

  console.log(`[projector] Homeserver: ${cfg.homeserver}`);
  console.log(`[projector] Output:     ${cfg.out_dir}`);
  console.log(`[projector] Drafts:     ${cfg.include_drafts}`);

  // ── 1. Fetch site:index room ────────────────────────────────────────────────
  console.log('[projector] Fetching site:index…');
  const indexEvents = await fetchSiteIndex(cfg, serverName);
  const siteIndex = replaySiteIndex(indexEvents);

  // ── 2. Discover all content rooms ──────────────────────────────────────────
  console.log('[projector] Discovering content rooms…');
  const discovered = await discoverContentRooms(cfg);

  // Merge with index entries (index is authoritative for slugs/titles)
  const allContentIds = new Set([
    ...siteIndex.entries.map((e) => e.content_id),
    ...discovered.map((d) => d.content_id),
  ]);

  // ── 3. Replay each room ────────────────────────────────────────────────────
  console.log(`[projector] Replaying ${allContentIds.size} rooms…`);
  const projectedContents = [];

  for (const contentId of allContentIds) {
    const roomInfo = discovered.find((d) => d.content_id === contentId);
    if (!roomInfo) {
      console.warn(`  [skip] ${contentId} — no room found`);
      continue;
    }

    try {
      console.log(`  [replay] ${contentId}`);
      const events = await fetchRoomEvents(roomInfo.room_id, cfg);
      const projected = replayRoom(contentId, events, cfg.include_drafts);
      if (projected) {
        projectedContents.push(projected);
      }
    } catch (err) {
      console.error(`  [error] ${contentId}:`, err);
    }
  }

  // ── 4. Write JSON state (Astro reads these to generate the static site) ────
  console.log('[projector] Writing state files…');
  renderStateFiles(siteIndex, projectedContents, cfg);
  renderSearchIndex(projectedContents, cfg);

  // Write build manifest
  writeFileSync(
    join(cfg.out_dir, 'build-manifest.json'),
    JSON.stringify({
      built_at: new Date().toISOString(),
      content_count: projectedContents.length,
      site_index_events: indexEvents.length,
      include_drafts: cfg.include_drafts,
    }, null, 2),
    'utf-8'
  );

  console.log(`[projector] Done — ${projectedContents.length} pages rendered`);
}

main().catch((err) => {
  console.error('[projector] Fatal error:', err);
  process.exit(1);
});
