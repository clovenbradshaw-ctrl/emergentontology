/**
 * EO core types for the admin editor.
 * Single canonical event shape: op(target, operand, ctx)
 */

export type EOOp = 'INS' | 'DES' | 'ALT' | 'SEG' | 'CON' | 'SYN' | 'SUP' | 'REC' | 'NUL';

export interface EOEvent {
  op: EOOp;
  /** e.g. "page:about/block:b_123", "wiki:operators/rev:r_10" */
  target: string;
  operand: Record<string, unknown>;
  ctx: {
    agent: string;
    ts: string;
    txn?: string;
    parent?: string;
    role?: string;
  };
}

export type ContentType = 'page' | 'blog' | 'wiki' | 'experiment';
export type ContentStatus = 'draft' | 'published' | 'archived';
export type Visibility = 'public' | 'private';

export interface ContentMeta {
  content_id: string;
  content_type: ContentType;
  slug: string;
  title: string;
  status: ContentStatus;
  visibility: Visibility;
  tags: string[];
  updated_at: string;
  /** ISO timestamp when this content was first DES'd as public (visibility='public') */
  first_public_at?: string;
}

export interface Block {
  block_id: string;
  block_type: 'text' | 'image' | 'embed' | 'callout' | 'quote' | 'divider' | 'toc' | 'wiki-embed' | 'experiment-embed' | 'code' | 'heading' | 'button' | 'columns' | 'spacer' | 'video' | 'html' | 'content-feed' | 'operator-grid';
  data: Record<string, unknown>;
  after: string | null;
  deleted: boolean;
  _event_id?: string;
}

export interface WikiRevision {
  rev_id: string;
  format: 'markdown' | 'html';
  content: string;
  summary: string;
  ts: string;
  _event_id?: string;
}

export interface ExperimentEntry {
  entry_id: string;
  kind: 'note' | 'dataset' | 'result' | 'chart' | 'link' | 'decision' | 'html';
  data: Record<string, unknown>;
  ts: string;
  deleted: boolean;
  _event_id?: string;
}

export interface EORawEvent {
  event_id: string;
  type: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
}

// ── State snapshot (loaded from /generated/state/content/<id>.json) ──────────

export interface ProjectedPage {
  content_type: 'page';
  content_id: string;
  meta: ContentMeta;
  blocks: Block[];
  block_order: string[];
  history: HistoryEntry[];
}

export interface ProjectedWiki {
  content_type: 'wiki';
  content_id: string;
  meta: ContentMeta;
  current_revision: WikiRevision | null;
  revisions: WikiRevision[];
  has_conflict: boolean;
  conflict_candidates: string[];
  history: HistoryEntry[];
}

export interface ProjectedBlog {
  content_type: 'blog';
  content_id: string;
  meta: ContentMeta;
  current_revision: WikiRevision | null;
  revisions: WikiRevision[];
  has_conflict: boolean;
  conflict_candidates: string[];
  history: HistoryEntry[];
}

export interface ProjectedExperiment {
  content_type: 'experiment';
  content_id: string;
  meta: ContentMeta;
  entries: ExperimentEntry[];
  current_revision: WikiRevision | null;
  revisions: WikiRevision[];
  history: HistoryEntry[];
}

export type ProjectedContent = ProjectedPage | ProjectedWiki | ProjectedBlog | ProjectedExperiment;

export interface HistoryEntry {
  event_id: string;
  op: EOOp;
  target?: string;
  ts: string;
  agent: string;
  summary?: string;
}

export interface SiteIndex {
  entries: Array<{
    content_id: string;
    slug: string;
    title: string;
    content_type: ContentType;
    status: ContentStatus;
    visibility: Visibility;
    tags: string[];
  }>;
  nav: Array<{
    content_id: string;
    slug: string;
    title: string;
    content_type: ContentType;
  }>;
  slug_map: Record<string, string>;
  built_at: string;
}
