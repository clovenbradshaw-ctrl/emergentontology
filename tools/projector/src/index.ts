/**
 * index.ts — Projector entry point
 *
 * Reads current-state snapshots from Xano eowikicurrent table,
 * builds projected JSON files consumed by the static site.
 *
 * Environment variables:
 *   INCLUDE_DRAFTS   "true" to include draft/private content
 *   OUT_DIR          default: "../../site/generated"
 *   SITE_BASE_URL    default: "" (relative, works for any gh-pages path)
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import type {
  BuildConfig,
  ContentMeta,
  ContentType,
  ProjectedContent,
  ProjectedWiki,
  ProjectedBlog,
  ProjectedPage,
  ProjectedExperiment,
  SiteIndex,
  WikiRevision,
  BlogRevision,
  Block,
  ExperimentEntry,
} from './types.js';
import { fetchAllCurrentRecords, type XanoCurrentRecord } from './fetch_xano.js';
import { renderSearchIndex, renderStateFiles } from './render.js';

const OUT_DEFAULT = join(
  import.meta.dirname,
  '..', '..', '..', 'site', 'generated',
);

// ──────────────────────────────────────────────────────────────────────────────
// Snapshot shapes stored in Xano eowikicurrent.values
// ──────────────────────────────────────────────────────────────────────────────

interface IndexSnapshot {
  entries: Array<{
    content_id: string;
    slug: string;
    title: string;
    content_type: ContentType;
    status: 'draft' | 'published' | 'archived';
    visibility: 'public' | 'private';
    tags: string[];
  }>;
}

interface WikiSnapshot {
  meta: Partial<ContentMeta>;
  current_revision: Partial<WikiRevision> | null;
  revisions: Array<Partial<WikiRevision>>;
}

interface BlogSnapshot {
  meta: Partial<ContentMeta>;
  current_revision: Partial<BlogRevision> | null;
  revisions: Array<Partial<BlogRevision>>;
}

interface PageSnapshot {
  meta: Partial<ContentMeta>;
  blocks: Array<Partial<Block>>;
  block_order: string[];
}

interface ExpSnapshot {
  meta: Partial<ContentMeta>;
  entries: Array<Partial<ExperimentEntry>>;
}

// ──────────────────────────────────────────────────────────────────────────────

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function buildMeta(
  entry: IndexSnapshot['entries'][number],
  snapshot: { meta?: Partial<ContentMeta> },
): ContentMeta {
  return {
    content_id: entry.content_id,
    content_type: entry.content_type,
    slug: entry.slug,
    title: entry.title,
    status: entry.status,
    visibility: entry.visibility,
    tags: entry.tags ?? [],
    updated_at: snapshot.meta?.updated_at ?? new Date().toISOString(),
  };
}

function buildWiki(
  entry: IndexSnapshot['entries'][number],
  snap: WikiSnapshot,
): ProjectedWiki {
  const revisions: WikiRevision[] = (snap.revisions ?? []).map((r) => ({
    rev_id: r.rev_id ?? '',
    format: r.format ?? 'markdown',
    content: r.content ?? '',
    summary: r.summary ?? '',
    ts: r.ts ?? '',
    event_id: r.event_id ?? r.rev_id ?? '',
  }));
  const cur = snap.current_revision;
  const current_revision: WikiRevision | null = cur
    ? {
        rev_id: cur.rev_id ?? '',
        format: cur.format ?? 'markdown',
        content: cur.content ?? '',
        summary: cur.summary ?? '',
        ts: cur.ts ?? '',
        event_id: cur.event_id ?? cur.rev_id ?? '',
      }
    : null;
  return {
    content_type: 'wiki',
    content_id: entry.content_id,
    meta: buildMeta(entry, snap),
    current_revision,
    revisions,
    has_conflict: false,
    conflict_candidates: [],
    history: [],
  };
}

function buildBlog(
  entry: IndexSnapshot['entries'][number],
  snap: BlogSnapshot,
): ProjectedBlog {
  const revisions: BlogRevision[] = (snap.revisions ?? []).map((r) => ({
    rev_id: r.rev_id ?? '',
    format: r.format ?? 'markdown',
    content: r.content ?? '',
    summary: r.summary ?? '',
    ts: r.ts ?? '',
    event_id: r.event_id ?? r.rev_id ?? '',
  }));
  return {
    content_type: 'blog',
    content_id: entry.content_id,
    meta: buildMeta(entry, snap),
    current_revision: revisions.at(-1) ?? null,
    revisions,
    has_conflict: false,
    conflict_candidates: [],
    history: [],
  };
}

function buildPage(
  entry: IndexSnapshot['entries'][number],
  snap: PageSnapshot,
): ProjectedPage {
  const blocks: Block[] = (snap.blocks ?? []).map((b) => ({
    block_id: b.block_id ?? '',
    block_type: b.block_type ?? 'text',
    data: b.data ?? {},
    after: b.after ?? null,
    deleted: b.deleted ?? false,
    event_id: b.event_id ?? b.block_id ?? '',
  }));
  return {
    content_type: 'page',
    content_id: entry.content_id,
    meta: buildMeta(entry, snap),
    blocks,
    block_order: snap.block_order ?? [],
    history: [],
  };
}

function buildExperiment(
  entry: IndexSnapshot['entries'][number],
  snap: ExpSnapshot,
): ProjectedExperiment {
  const expEntries: ExperimentEntry[] = (snap.entries ?? [])
    .map((e) => ({
      entry_id: e.entry_id ?? '',
      kind: e.kind ?? 'note',
      data: e.data ?? {},
      ts: e.ts ?? '',
      deleted: e.deleted ?? false,
      event_id: e.event_id ?? e.entry_id ?? '',
    }))
    .filter((e) => !e.deleted);
  return {
    content_type: 'experiment',
    content_id: entry.content_id,
    meta: buildMeta(entry, snap),
    entries: expEntries,
    history: [],
  };
}

// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  const cfg: BuildConfig = {
    homeserver: '',   // unused — reads from Xano, not Matrix
    out_dir: process.env.OUT_DIR ?? OUT_DEFAULT,
    include_drafts: process.env.INCLUDE_DRAFTS === 'true',
    site_base_url: process.env.SITE_BASE_URL ?? '',
  };

  mkdirSync(cfg.out_dir, { recursive: true });
  console.log(`[projector] Source:  Xano eowikicurrent`);
  console.log(`[projector] Output:  ${cfg.out_dir}`);
  console.log(`[projector] Drafts:  ${cfg.include_drafts}`);

  // ── 1. Fetch all current-state records from Xano ──────────────────────────
  let records: XanoCurrentRecord[] = [];
  try {
    records = await fetchAllCurrentRecords();
    console.log(`[projector] Fetched ${records.length} records from Xano`);
  } catch (err) {
    console.error('[projector] Xano fetch failed:', err);
    console.warn('[projector] Writing empty state — site will show no content');
  }

  // ── 2. Parse site:index ───────────────────────────────────────────────────
  const indexRecord = records.find((r) => r.record_id === 'site:index');
  const indexSnap = indexRecord
    ? parseJson<IndexSnapshot>(indexRecord.values, { entries: [] })
    : { entries: [] };

  const allEntries = (indexSnap.entries ?? []).map((e) => {
    // Pull updated_at from the content snapshot's meta if available
    const contentRecord = records.find((r) => r.record_id === e.content_id);
    let updated_at = '';
    if (contentRecord) {
      try {
        const snap = JSON.parse(contentRecord.values);
        updated_at = snap?.meta?.updated_at ?? '';
      } catch { /* ignore */ }
    }
    return {
      content_id: e.content_id,
      slug: e.slug,
      title: e.title,
      content_type: (e.content_type ?? 'wiki') as ContentType,
      status: (e.status ?? 'draft') as 'draft' | 'published' | 'archived',
      visibility: (e.visibility ?? 'private') as 'public' | 'private',
      tags: e.tags ?? [],
      updated_at,
      event_id: '',
    };
  });

  const nav = allEntries.filter(
    (e) => e.status === 'published' && e.visibility === 'public',
  );

  // Exclude archived entries from the public site index
  const activeEntries = allEntries.filter((e) => e.status !== 'archived');

  const siteIndex: SiteIndex = {
    entries: activeEntries,
    nav,
    slug_map: Object.fromEntries(activeEntries.map((e) => [e.slug, e.content_id])),
    built_at: new Date().toISOString(),
  };

  const publicEntries = allEntries.filter((e) => e.visibility === 'public');
  console.log(
    `[projector] Index: ${allEntries.length} total, ${publicEntries.length} public (${nav.length} published+public in nav)`,
  );

  // ── 3. Build ProjectedContent for each entry ─────────────────────────────
  // Always write content files for all public-visibility entries so that
  // draft pages are accessible via URL (e.g. /wiki/home) even before
  // publishing. Navigation (nav) already filters to published+public only,
  // so drafts won't appear in the site header/index—just at their direct URL.
  // INCLUDE_DRAFTS=true additionally includes private-visibility content.
  const entriesToProcess = cfg.include_drafts
    ? allEntries.filter((e) => e.status !== 'archived')
    : allEntries.filter((e) => e.visibility === 'public' && e.status !== 'archived');
  const recordMap = new Map(records.map((r) => [r.record_id, r]));
  const projectedContents: ProjectedContent[] = [];

  for (const entry of entriesToProcess) {
    const record = recordMap.get(entry.content_id);
    if (!record) {
      console.warn(`[projector] No snapshot for ${entry.content_id} — skipping`);
      continue;
    }

    try {
      let proj: ProjectedContent | null = null;

      if (entry.content_type === 'wiki') {
        const snap = parseJson<WikiSnapshot>(record.values, { meta: {}, current_revision: null, revisions: [] });
        proj = buildWiki(entry, snap);
      } else if (entry.content_type === 'blog') {
        const snap = parseJson<BlogSnapshot>(record.values, { meta: {}, current_revision: null, revisions: [] });
        proj = buildBlog(entry, snap);
      } else if (entry.content_type === 'page') {
        const snap = parseJson<PageSnapshot>(record.values, { meta: {}, blocks: [], block_order: [] });
        proj = buildPage(entry, snap);
      } else if (entry.content_type === 'experiment') {
        const snap = parseJson<ExpSnapshot>(record.values, { meta: {}, entries: [] });
        proj = buildExperiment(entry, snap);
      }

      if (proj) {
        projectedContents.push(proj);
        console.log(`  [ok] ${entry.content_id}`);
      }
    } catch (err) {
      console.error(`[projector] Error building ${entry.content_id}:`, err);
    }
  }

  // ── 4. Write state files ──────────────────────────────────────────────────
  console.log(`[projector] Writing ${projectedContents.length} content files…`);
  renderStateFiles(siteIndex, projectedContents, cfg);
  renderSearchIndex(projectedContents, cfg);

  writeFileSync(
    join(cfg.out_dir, 'build-manifest.json'),
    JSON.stringify(
      {
        built_at: new Date().toISOString(),
        source: 'xano',
        content_count: projectedContents.length,
        include_drafts: cfg.include_drafts,
      },
      null,
      2,
    ),
    'utf-8',
  );

  console.log(`[projector] Done — ${projectedContents.length} pages`);
}

main().catch((err) => {
  console.error('[projector] Fatal error:', err);
  process.exit(1);
});
