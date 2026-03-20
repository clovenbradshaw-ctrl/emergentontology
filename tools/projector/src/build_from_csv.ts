/**
 * build_from_csv.ts — Generate static site files from CSV export
 *
 * Reads the Xano CSV export and produces the same output as the normal
 * projector pipeline, without needing API access.
 *
 * Usage: npx tsx src/build_from_csv.ts [path-to-csv]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { renderSearchIndex, renderStateFiles, renderApiFiles } from './render.js';
import type {
  BuildConfig,
  ContentMeta,
  ContentType,
  ProjectedContent,
  ProjectedWiki,
  ProjectedBlog,
  ProjectedPage,
  ProjectedExperiment,
  ProjectedDocument,
  DocumentAsset,
  SiteIndex,
  WikiRevision,
  Block,
  ExperimentEntry,
} from './types.js';

const OUT_DIR = join(import.meta.dirname, '..', '..', '..', 'site', 'generated');
const DEFAULT_CSV = join(import.meta.dirname, '..', '..', '..', 'dbo-eowikicurrent-145-live.1773976700.csv');

// ── CSV parsing ─────────────────────────────────────────────────────────────

interface CsvRecord {
  record_id: string;
  displayName: string;
  values: string;
}

function parseCsv(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  const lines = text.split('\n');
  if (lines.length < 2) return records;

  // Skip header
  let i = 1;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }

    // Each line: record_id,displayName,"{ json }"
    // The JSON values field is quoted and may span multiple lines
    const firstComma = line.indexOf(',');
    if (firstComma < 0) { i++; continue; }
    const record_id = line.slice(0, firstComma);
    const rest = line.slice(firstComma + 1);
    const secondComma = rest.indexOf(',');
    if (secondComma < 0) { i++; continue; }
    const displayName = rest.slice(0, secondComma);

    // Values field starts after second comma — may be quoted JSON
    let valuesRaw = rest.slice(secondComma + 1);

    // If it starts with a quote, we need to handle CSV quoting (doubled quotes, multiline)
    if (valuesRaw.startsWith('"')) {
      // Collect until we find the closing quote
      let fullValue = valuesRaw;
      while (!isClosedCsvField(fullValue) && i + 1 < lines.length) {
        i++;
        fullValue += '\n' + lines[i];
      }
      // Remove outer quotes and unescape doubled quotes
      fullValue = fullValue.slice(1); // remove leading "
      const lastQuote = fullValue.lastIndexOf('"');
      if (lastQuote >= 0) fullValue = fullValue.slice(0, lastQuote);
      fullValue = fullValue.replace(/""/g, '"');
      valuesRaw = fullValue;
    }

    records.push({ record_id, displayName, values: valuesRaw });
    i++;
  }

  return records;
}

function isClosedCsvField(s: string): boolean {
  // A quoted CSV field is closed when we see an unescaped closing quote
  // Count quotes: the field starts with ", so after removing leading ",
  // we need an odd total number of quotes for it to be closed
  let count = 0;
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '"') count++;
  }
  // First quote is opening, pairs of "" are escapes, final odd quote is closing
  return count >= 2 && count % 2 === 0;
}

// ── Build helpers (same as index.ts) ────────────────────────────────────────

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function buildMeta(
  entry: { content_id: string; content_type: ContentType; slug: string; title: string; status: string; visibility: string; tags: string[] },
  snapshot: { meta?: Partial<ContentMeta> },
): ContentMeta {
  return {
    content_id: entry.content_id,
    content_type: entry.content_type,
    slug: entry.slug,
    title: entry.title,
    status: entry.status as 'draft' | 'published' | 'archived',
    visibility: entry.visibility as 'public' | 'private',
    tags: entry.tags ?? [],
    updated_at: snapshot.meta?.updated_at ?? new Date().toISOString(),
  };
}

function buildWiki(entry: any, snap: any): ProjectedWiki {
  const cur = snap.current_revision;
  const current_revision: WikiRevision | null = cur
    ? { rev_id: cur.rev_id ?? '', format: cur.format ?? 'markdown', content: cur.content ?? '', summary: cur.summary ?? '', ts: cur.ts ?? '', event_id: cur.event_id ?? cur.rev_id ?? '' }
    : null;
  return { content_type: 'wiki', content_id: entry.content_id, meta: buildMeta(entry, snap), current_revision, revisions: [], has_conflict: false, conflict_candidates: [], history: [] };
}

function buildBlog(entry: any, snap: any): ProjectedBlog {
  const cur = snap.current_revision;
  const current_revision: WikiRevision | null = cur
    ? { rev_id: cur.rev_id ?? '', format: cur.format ?? 'markdown', content: cur.content ?? '', summary: cur.summary ?? '', ts: cur.ts ?? '', event_id: cur.event_id ?? cur.rev_id ?? '' }
    : null;
  return { content_type: 'blog', content_id: entry.content_id, meta: buildMeta(entry, snap), current_revision, revisions: [], has_conflict: false, conflict_candidates: [], history: [] };
}

function buildPage(entry: any, snap: any): ProjectedPage {
  const blocks: Block[] = (snap.blocks ?? []).map((b: any) => ({
    block_id: b.block_id ?? '', block_type: b.block_type ?? 'text', data: b.data ?? {}, after: b.after ?? null, deleted: b.deleted ?? false, event_id: b.event_id ?? b.block_id ?? '',
  }));
  return { content_type: 'page', content_id: entry.content_id, meta: buildMeta(entry, snap), blocks, block_order: snap.block_order ?? [], history: [] };
}

function buildExperiment(entry: any, snap: any): ProjectedExperiment {
  const expEntries: ExperimentEntry[] = (snap.entries ?? [])
    .map((e: any) => ({ entry_id: e.entry_id ?? '', kind: e.kind ?? 'note', data: e.data ?? {}, ts: e.ts ?? '', deleted: e.deleted ?? false, event_id: e.event_id ?? e.entry_id ?? '' }))
    .filter((e: any) => !e.deleted);
  const cur = snap.current_revision;
  const current_revision = cur
    ? { rev_id: String(cur.rev_id ?? ''), format: (cur.format ?? 'html') as 'markdown' | 'html', content: String(cur.content ?? ''), summary: String(cur.summary ?? ''), ts: String(cur.ts ?? ''), event_id: String(cur.event_id ?? cur.rev_id ?? '') }
    : null;
  return { content_type: 'experiment', content_id: entry.content_id, meta: buildMeta(entry, snap), entries: expEntries, current_revision, revisions: [], history: [] };
}

function buildDocument(entry: any, snap: any): ProjectedDocument {
  const assets: DocumentAsset[] = (snap.assets ?? [])
    .map((a: any) => ({ asset_id: a.asset_id ?? '', title: a.title ?? '', url: a.url ?? '', file_type: a.file_type ?? 'other', description: a.description ?? '', ts: a.ts ?? '', deleted: a.deleted ?? false, event_id: a.event_id ?? a.asset_id ?? '' }))
    .filter((a: any) => !a.deleted);
  const cur = snap.current_revision;
  const current_revision: WikiRevision | null = cur
    ? { rev_id: cur.rev_id ?? '', format: cur.format ?? 'html', content: cur.content ?? '', summary: cur.summary ?? '', ts: cur.ts ?? '', event_id: cur.event_id ?? cur.rev_id ?? '' }
    : null;
  return { content_type: 'document', content_id: entry.content_id, meta: buildMeta(entry, snap), assets, current_revision, revisions: [], history: [] };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const csvPath = process.argv[2] || DEFAULT_CSV;
  const cfg: BuildConfig = {
    homeserver: '',
    out_dir: process.env.OUT_DIR ?? OUT_DIR,
    include_drafts: process.env.INCLUDE_DRAFTS === 'true',
    site_base_url: process.env.SITE_BASE_URL ?? '',
  };

  mkdirSync(cfg.out_dir, { recursive: true });
  console.log(`[csv-build] Reading CSV: ${csvPath}`);
  console.log(`[csv-build] Output:      ${cfg.out_dir}`);

  const csvText = readFileSync(csvPath, 'utf-8');
  const records = parseCsv(csvText);
  console.log(`[csv-build] Parsed ${records.length} records from CSV`);

  // Parse site:index
  const indexRecord = records.find(r => r.record_id === 'site:index');
  const indexSnap = indexRecord
    ? parseJson<{ entries: any[] }>(indexRecord.values, { entries: [] })
    : { entries: [] };

  const recordMap = new Map(records.map(r => [r.record_id, r]));

  const allEntries = (indexSnap.entries ?? []).map((e: any) => {
    const contentRecord = recordMap.get(e.content_id);
    let updated_at = '';
    if (contentRecord) {
      try { const snap = JSON.parse(contentRecord.values); updated_at = snap?.meta?.updated_at ?? ''; } catch {}
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

  const nav = allEntries.filter((e: any) => e.status === 'published' && e.visibility === 'public');
  const activeEntries = allEntries.filter((e: any) => e.status !== 'archived');

  const siteIndex: SiteIndex = {
    entries: activeEntries,
    nav,
    slug_map: Object.fromEntries(activeEntries.map((e: any) => [e.slug, e.content_id])),
    built_at: new Date().toISOString(),
  };

  const publicEntries = allEntries.filter((e: any) => e.visibility === 'public');
  console.log(`[csv-build] Index: ${allEntries.length} total, ${publicEntries.length} public (${nav.length} in nav)`);

  // Build projected content
  const entriesToProcess = cfg.include_drafts
    ? allEntries.filter((e: any) => e.status !== 'archived')
    : allEntries.filter((e: any) => e.visibility === 'public' && e.status !== 'archived');

  const projectedContents: ProjectedContent[] = [];

  for (const entry of entriesToProcess) {
    const record = recordMap.get(entry.content_id);
    if (!record) {
      console.warn(`[csv-build] No snapshot for ${entry.content_id} — skipping`);
      continue;
    }

    try {
      let proj: ProjectedContent | null = null;
      if (entry.content_type === 'wiki') {
        proj = buildWiki(entry, parseJson(record.values, { meta: {}, current_revision: null }));
      } else if (entry.content_type === 'blog') {
        proj = buildBlog(entry, parseJson(record.values, { meta: {}, current_revision: null }));
      } else if (entry.content_type === 'page') {
        proj = buildPage(entry, parseJson(record.values, { meta: {}, blocks: [], block_order: [] }));
      } else if (entry.content_type === 'experiment') {
        proj = buildExperiment(entry, parseJson(record.values, { meta: {}, entries: [] }));
      } else if (entry.content_type === 'document') {
        proj = buildDocument(entry, parseJson(record.values, { meta: {}, assets: [], current_revision: null }));
      }
      if (proj) {
        projectedContents.push(proj);
        console.log(`  [ok] ${entry.content_id}`);
      }
    } catch (err) {
      console.error(`[csv-build] Error building ${entry.content_id}:`, err);
    }
  }

  // Write state files
  console.log(`[csv-build] Writing ${projectedContents.length} content files…`);
  renderStateFiles(siteIndex, projectedContents, cfg);
  renderSearchIndex(projectedContents, cfg);

  // Write home config
  try {
    const homeYamlPath = join(import.meta.dirname, '..', '..', '..', 'home.yaml');
    const homeConfig = yaml.load(readFileSync(homeYamlPath, 'utf-8'));
    writeFileSync(join(cfg.out_dir, 'home.json'), JSON.stringify(homeConfig, null, 2), 'utf-8');
    console.log(`[csv-build] Wrote home.json`);
    renderApiFiles(siteIndex, projectedContents, cfg, homeConfig);
  } catch (err) {
    console.warn('[csv-build] Could not read home.yaml:', err);
    renderApiFiles(siteIndex, projectedContents, cfg, null);
  }

  writeFileSync(
    join(cfg.out_dir, 'build-manifest.json'),
    JSON.stringify({ built_at: new Date().toISOString(), source: 'csv', content_count: projectedContents.length, include_drafts: cfg.include_drafts }, null, 2),
    'utf-8',
  );

  console.log(`[csv-build] Done — ${projectedContents.length} pages written`);
}

main().catch(err => { console.error('[csv-build] Fatal:', err); process.exit(1); });
