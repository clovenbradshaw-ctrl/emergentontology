/**
 * index.ts — Projector entry point
 *
 * Usage:
 *   node dist/index.js
 *
 * Environment variables:
 *   MATRIX_HOMESERVER   required  e.g. https://matrix.example.com
 *   MATRIX_ACCESS_TOKEN optional  include private/draft rooms
 *   MATRIX_SERVER_NAME  optional  e.g. example.com  (defaults to hostname in MATRIX_HOMESERVER)
 *   INCLUDE_DRAFTS      optional  "true" to include draft content (requires access token)
 *   OUT_DIR             optional  default: "../../site/public/generated"
 *   SITE_BASE_URL       optional  default: ""  (relative, works for any gh-pages path)
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import type { BuildConfig } from './types.js';
import { fetchRoomEvents, fetchSiteIndex, discoverContentRooms } from './fetch_matrix.ts';
import { replayRoom, replaySiteIndex } from './replay.js';
import {
  renderHome,
  renderContentPage,
  renderStyles,
  renderSearchIndex,
  renderSearchScript,
  renderStateFiles,
} from './render.js';

async function main() {
  const homeserver = process.env.MATRIX_HOMESERVER;
  if (!homeserver) {
    // No homeserver configured: write placeholder files so the site builds cleanly.
    console.warn('[projector] MATRIX_HOMESERVER not set — writing placeholder output');
    writePlaceholders();
    return;
  }

  const serverName =
    process.env.MATRIX_SERVER_NAME ?? new URL(homeserver).hostname;

  const cfg: BuildConfig = {
    homeserver,
    access_token: process.env.MATRIX_ACCESS_TOKEN,
    out_dir: process.env.OUT_DIR ?? join(import.meta.dirname, '..', '..', '..', 'site', 'public', 'generated'),
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

  // ── 4. Render ───────────────────────────────────────────────────────────────
  console.log('[projector] Rendering static files…');
  renderStyles(cfg);
  renderSearchScript(cfg);
  renderStateFiles(siteIndex, projectedContents, cfg);
  renderHome(siteIndex, cfg);

  for (const proj of projectedContents) {
    renderContentPage(proj, siteIndex, cfg);
  }

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

/**
 * When no Matrix homeserver is configured, write minimal placeholder files
 * so the static site builds and deploys without errors.
 */
function writePlaceholders() {
  const outDir = process.env.OUT_DIR ?? join(import.meta.dirname, '..', '..', '..', 'site', 'public', 'generated');
  mkdirSync(join(outDir, 'state', 'content'), { recursive: true });
  mkdirSync(join(outDir, 'styles'), { recursive: true });
  mkdirSync(join(outDir, 'js'), { recursive: true });

  writeFileSync(join(outDir, 'state', 'index.json'), JSON.stringify({
    entries: [],
    nav: [],
    slug_map: {},
    built_at: new Date().toISOString(),
  }, null, 2));

  writeFileSync(join(outDir, 'search_index.json'), '[]');
  writeFileSync(join(outDir, 'build-manifest.json'), JSON.stringify({
    built_at: new Date().toISOString(),
    content_count: 0,
    note: 'No MATRIX_HOMESERVER configured',
  }, null, 2));

  // Write empty placeholder CSS / JS so page references don't 404
  writeFileSync(join(outDir, 'styles', 'main.css'), '/* placeholder — run projector with MATRIX_HOMESERVER set */');
  writeFileSync(join(outDir, 'js', 'search.js'), '/* placeholder */');
}

main().catch((err) => {
  console.error('[projector] Fatal error:', err);
  process.exit(1);
});
