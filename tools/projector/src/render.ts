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

// ──────────────────────────────────────────────────────────────────────────────
// State JSON files
// ──────────────────────────────────────────────────────────────────────────────

export function renderStateFiles(index: SiteIndex, contents: ProjectedContent[], cfg: BuildConfig): void {
  write(join(cfg.out_dir, 'state', 'index.json'), JSON.stringify(index, null, 2));
  for (const proj of contents) {
    write(
      join(cfg.out_dir, 'state', 'content', `${proj.meta.content_id.replace(':', '-')}.json`),
      JSON.stringify(proj, null, 2)
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
      : proj.content_type;

    let excerpt = '';
    if (proj.content_type === 'wiki' && (proj as ProjectedWiki).current_revision) {
      excerpt = (proj as ProjectedWiki).current_revision!.content.slice(0, 200);
    } else if (proj.content_type === 'blog' && (proj as ProjectedBlog).current_revision) {
      excerpt = (proj as ProjectedBlog).current_revision!.content.slice(0, 200);
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
