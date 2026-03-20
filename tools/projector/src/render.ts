/**
 * render.ts
 *
 * Writes projected state to JSON files consumed by the Astro static site builder.
 *
 * Output layout:
 *   {out_dir}/state/index.json              ← site index
 *   {out_dir}/state/content/<content_id>.json
 *   {out_dir}/search_index.json             ← Fuse.js-compatible search index
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type {
  ProjectedContent,
  ProjectedWiki,
  ProjectedBlog,
  ProjectedPage,
  ProjectedDocument,
  SiteIndex,
  BuildConfig,
} from './types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function write(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

/**
 * Strip `revisions` and `history` arrays from a projected content object
 * before writing to static files. Revision history belongs in the event log,
 * not in static snapshots. Only `current_revision` is kept.
 */
function stripRevisionHistory(proj: ProjectedContent): Record<string, unknown> {
  const obj = { ...proj } as Record<string, unknown>;
  delete obj.revisions;
  delete obj.history;
  return obj;
}

// ──────────────────────────────────────────────────────────────────────────────
// State JSON files
// ──────────────────────────────────────────────────────────────────────────────

export function renderStateFiles(index: SiteIndex, contents: ProjectedContent[], cfg: BuildConfig): void {
  write(join(cfg.out_dir, 'state', 'index.json'), JSON.stringify(index, null, 2));
  for (const proj of contents) {
    write(
      join(cfg.out_dir, 'state', 'content', `${proj.meta.content_id.replace(':', '-')}.json`),
      JSON.stringify(stripRevisionHistory(proj), null, 2)
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Search index
// ──────────────────────────────────────────────────────────────────────────────

export function renderSearchIndex(contents: ProjectedContent[], cfg: BuildConfig): void {
  const items = contents.map((proj) => {
    const typeDir = proj.content_type === 'page' ? 'page'
      : proj.content_type === 'experiment' ? 'exp'
      : proj.content_type === 'document' ? 'doc'
      : proj.content_type;

    let excerpt = '';
    if (proj.content_type === 'wiki' && (proj as ProjectedWiki).current_revision) {
      excerpt = (proj as ProjectedWiki).current_revision!.content.slice(0, 200);
    } else if (proj.content_type === 'blog' && (proj as ProjectedBlog).current_revision) {
      excerpt = (proj as ProjectedBlog).current_revision!.content.slice(0, 200);
    } else if (proj.content_type === 'document' && (proj as ProjectedDocument).current_revision) {
      excerpt = (proj as ProjectedDocument).current_revision!.content.slice(0, 200);
    } else if (proj.content_type === 'page' && (proj as ProjectedPage).blocks.length > 0) {
      const first = (proj as ProjectedPage).blocks.find((b) => b.block_type === 'text' && !b.deleted);
      if (first) excerpt = String(first.data.md ?? first.data.text ?? '').slice(0, 200);
    }

    return {
      id: proj.content_id,
      title: proj.meta.title,
      tags: proj.meta.tags,
      type: proj.content_type,
      slug: proj.meta.slug,
      url: `${cfg.site_base_url}/${typeDir}/${proj.meta.slug}/`,
      excerpt,
    };
  });

  write(join(cfg.out_dir, 'search_index.json'), JSON.stringify(items, null, 2));
}

// ──────────────────────────────────────────────────────────────────────────────
// API JSON files — bot/AI-friendly endpoints
// ──────────────────────────────────────────────────────────────────────────────

function getExcerpt(proj: ProjectedContent, maxLen = 300): string {
  let raw = '';
  if (
    (proj.content_type === 'wiki' || proj.content_type === 'blog' || proj.content_type === 'document') &&
    (proj as ProjectedWiki).current_revision
  ) {
    raw = (proj as ProjectedWiki).current_revision!.content;
  } else if (proj.content_type === 'page' && (proj as ProjectedPage).blocks.length > 0) {
    const first = (proj as ProjectedPage).blocks.find((b) => b.block_type === 'text' && !b.deleted);
    if (first) raw = String(first.data.md ?? first.data.text ?? '');
  } else if (proj.content_type === 'experiment') {
    const entries = (proj as any).entries ?? [];
    if (entries.length > 0) raw = String(entries[0].data?.text ?? entries[0].data?.content ?? '');
  }
  // Strip HTML tags for plain-text excerpt
  raw = raw.replace(/<[^>]+>/g, '').trim();
  return raw.length > maxLen ? raw.slice(0, maxLen) + '…' : raw;
}

function contentUrl(proj: ProjectedContent, basePath: string): string {
  const typeDir = proj.content_type === 'page' ? 'page'
    : proj.content_type === 'experiment' ? 'exp'
    : proj.content_type === 'document' ? 'doc'
    : proj.content_type;
  return `${basePath}/${typeDir}/${proj.meta.slug}/`;
}

export function renderApiFiles(
  index: SiteIndex,
  contents: ProjectedContent[],
  cfg: BuildConfig,
  homeConfig: unknown,
): void {
  const apiDir = join(cfg.out_dir, '..', 'api');
  const now = new Date().toISOString();

  // 1. API index — mirrors site index but at /api/index.json
  write(join(apiDir, 'index.json'), JSON.stringify(index, null, 2));

  // 2. Content list with summaries
  const published = contents.filter(
    (c) => c.meta.status === 'published' && c.meta.visibility === 'public',
  );
  const contentList = {
    items: published.map((proj) => ({
      content_id: proj.content_id,
      content_type: proj.content_type,
      slug: proj.meta.slug,
      title: proj.meta.title,
      description: (proj.meta as any).description ?? '',
      tags: proj.meta.tags,
      updated_at: proj.meta.updated_at,
      excerpt: getExcerpt(proj),
      url: contentUrl(proj, cfg.site_base_url),
      api_url: `/api/content/${proj.meta.content_id.replace(':', '-')}.json`,
    })),
    total: published.length,
    generated_at: now,
  };
  write(join(apiDir, 'content.json'), JSON.stringify(contentList, null, 2));

  // 3. Individual content files (mirror of state/content/)
  for (const proj of contents) {
    write(
      join(apiDir, 'content', `${proj.meta.content_id.replace(':', '-')}.json`),
      JSON.stringify(stripRevisionHistory(proj), null, 2),
    );
  }

  // 4. Home config
  if (homeConfig) {
    write(join(apiDir, 'home.json'), JSON.stringify(homeConfig, null, 2));
  }

  // 5. Sitemap
  const sitemap = {
    urls: [
      { url: '/', title: 'Home', type: 'page', updated_at: now },
      ...published.map((proj) => ({
        url: contentUrl(proj, cfg.site_base_url),
        title: proj.meta.title,
        type: proj.content_type,
        updated_at: proj.meta.updated_at,
      })),
      { url: '/api/manifest.json', title: 'API Manifest', type: 'api', updated_at: now },
      { url: '/llms.txt', title: 'LLMs.txt', type: 'meta', updated_at: now },
      { url: '/docs/technicalmanual.txt', title: 'Technical Manual', type: 'docs', updated_at: now },
    ],
    generated_at: now,
  };
  write(join(apiDir, 'sitemap.json'), JSON.stringify(sitemap, null, 2));

  console.log(`[projector] Wrote API files: index, content (${published.length}), sitemap`);
}
