/**
 * state.ts — Load projected state from the build-generated JSON files.
 *
 * At build time, the projector writes files into public/generated/.
 * Astro reads those files during SSG to produce the static pages.
 *
 * If the generated files don't exist yet (first run, no homeserver configured),
 * this returns sensible empty defaults so the site builds cleanly.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Path to the directory where the projector wrote its output.
const GEN_DIR = join(process.cwd(), 'public', 'generated');

function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Types (minimal — matches projector output)
// ──────────────────────────────────────────────────────────────────────────────

export type ContentType = 'page' | 'blog' | 'wiki' | 'experiment';
export type ContentStatus = 'draft' | 'published' | 'archived';

export interface NavEntry {
  content_id: string;
  slug: string;
  title: string;
  content_type: ContentType;
  status: ContentStatus;
  visibility: 'public' | 'private';
  tags: string[];
}

export interface SiteIndex {
  entries: NavEntry[];
  nav: NavEntry[];
  slug_map: Record<string, string>;
  built_at: string;
}

export interface ContentMeta {
  content_id: string;
  content_type: ContentType;
  slug: string;
  title: string;
  status: ContentStatus;
  tags: string[];
  updated_at: string;
  visibility: 'public' | 'private';
}

export interface Block {
  block_id: string;
  block_type: string;
  data: Record<string, unknown>;
  after: string | null;
  deleted: boolean;
}

export interface WikiRevision {
  rev_id: string;
  format: 'markdown';
  content: string;
  summary: string;
  ts: string;
}

export interface BlogRevision extends WikiRevision {}

export interface ExperimentEntry {
  entry_id: string;
  kind: 'note' | 'dataset' | 'result' | 'chart' | 'link' | 'decision';
  data: Record<string, unknown>;
  ts: string;
  deleted: boolean;
}

export interface ProjectedPage {
  content_type: 'page';
  content_id: string;
  meta: ContentMeta;
  blocks: Block[];
  block_order: string[];
}

export interface ProjectedWiki {
  content_type: 'wiki';
  content_id: string;
  meta: ContentMeta;
  current_revision: WikiRevision | null;
  revisions: WikiRevision[];
  has_conflict: boolean;
  conflict_candidates: string[];
}

export interface ProjectedBlog {
  content_type: 'blog';
  content_id: string;
  meta: ContentMeta;
  current_revision: BlogRevision | null;
  revisions: BlogRevision[];
}

export interface ProjectedExperiment {
  content_type: 'experiment';
  content_id: string;
  meta: ContentMeta;
  entries: ExperimentEntry[];
}

export type ProjectedContent = ProjectedPage | ProjectedWiki | ProjectedBlog | ProjectedExperiment;

// ──────────────────────────────────────────────────────────────────────────────
// Loaders
// ──────────────────────────────────────────────────────────────────────────────

const EMPTY_INDEX: SiteIndex = {
  entries: [],
  nav: [],
  slug_map: {},
  built_at: new Date().toISOString(),
};

export function loadSiteIndex(): SiteIndex {
  return readJson(join(GEN_DIR, 'state', 'index.json'), EMPTY_INDEX);
}

export function loadContent(contentId: string): ProjectedContent | null {
  const fileName = contentId.replace(':', '-') + '.json';
  const data = readJson<ProjectedContent | null>(join(GEN_DIR, 'state', 'content', fileName), null);
  return data;
}

export function loadAllContent(type?: ContentType): ProjectedContent[] {
  const index = loadSiteIndex();
  const entries = type ? index.entries.filter((e) => e.content_type === type) : index.entries;
  return entries
    .map((e) => loadContent(e.content_id))
    .filter((c): c is ProjectedContent => c !== null);
}

/** Returns projected content for published+public entries only. Use for public listing pages. */
export function loadPublishedContent(type?: ContentType): ProjectedContent[] {
  const index = loadSiteIndex();
  const entries = type ? index.nav.filter((e) => e.content_type === type) : index.nav;
  return entries
    .map((e) => loadContent(e.content_id))
    .filter((c): c is ProjectedContent => c !== null);
}

/** Returns all published+public nav entries, suitable for site navigation. */
export function loadNav(): NavEntry[] {
  return loadSiteIndex().nav;
}
