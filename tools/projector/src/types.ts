/**
 * Core EO types: operator(target, operand) normal form
 *
 * One canonical event type for all operations.
 * Target encodes the entity address; op encodes the semantic;
 * operand carries the data; ctx carries provenance.
 */

// ──────────────────────────────────────────────────────────────────────────────
// EO Operators
// ──────────────────────────────────────────────────────────────────────────────

export type EOOp =
  | 'INS' // Insert / create a new entity
  | 'DES' // Describe / set metadata fields  (replaces separate "publish" events)
  | 'ALT' // Alter / apply a JSON-Patch to existing entity
  | 'SEG' // Segment / establish a reference/embed relationship
  | 'CON' // Connect / navigation / routing relation
  | 'SYN' // Synthesize / resolve a conflict with a chosen mode
  | 'SUP' // Superpose / record concurrent conflicting values
  | 'REC' // Recombine / derive a projection/view
  | 'NUL'; // Nullify / tombstone (never deletes, just marks inactive)

// ──────────────────────────────────────────────────────────────────────────────
// EO Event (the single canonical shape stored in Matrix as `eo.op`)
// ──────────────────────────────────────────────────────────────────────────────

export interface EOEvent {
  op: EOOp;
  /** Stable address: e.g. "page:about/block:b_123", "wiki:operators/rev:r_10" */
  target: string;
  /** Operator-specific arguments */
  operand: Record<string, unknown>;
  /** Provenance metadata */
  ctx: {
    agent: string;    // Matrix user ID who performed the action
    ts: string;       // ISO 8601 timestamp
    txn?: string;     // Optional idempotency key
    parent?: string;  // Matrix event ID this builds on (for history threading)
    role?: string;    // e.g. "editor" | "admin" | "viewer" — for access-level auditing
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Matrix raw event wrapper
// ──────────────────────────────────────────────────────────────────────────────

export interface MatrixEvent {
  event_id: string;
  type: string;
  sender: string;
  origin_server_ts: number;
  content: EOEvent | Record<string, unknown>;
  state_key?: string;
  unsigned?: Record<string, unknown>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Content metadata state event  (`com.eo.content.meta`)
// Stored as a Matrix *state event* so it's quickly retrievable without replay.
// Only used for discovery; canonical truth lives in the eo.op event stream.
// ──────────────────────────────────────────────────────────────────────────────

export type ContentType = 'page' | 'blog' | 'wiki' | 'experiment';
export type ContentStatus = 'draft' | 'published' | 'archived';

export interface ContentMeta {
  content_id: string;          // e.g. "page:about"
  content_type: ContentType;
  slug: string;
  title: string;
  status: ContentStatus;
  tags: string[];
  updated_at: string;          // ISO 8601
  /** Only content with status="published" is included in the public build. */
  visibility: 'public' | 'private';
}

// ──────────────────────────────────────────────────────────────────────────────
// Derived (projected) state types
// ──────────────────────────────────────────────────────────────────────────────

export interface Block {
  block_id: string;
  block_type: 'text' | 'image' | 'embed' | 'callout' | 'quote' | 'divider' | 'toc' | 'wiki-embed' | 'experiment-embed';
  data: Record<string, unknown>;
  /** null = at beginning; block_id = insert after this block */
  after: string | null;
  deleted: boolean;
  event_id: string;   // last event that touched this block
}

export interface WikiRevision {
  rev_id: string;
  format: 'markdown';
  content: string;
  summary: string;
  ts: string;
  event_id: string;
}

export interface BlogRevision {
  rev_id: string;
  format: 'markdown';
  content: string;
  summary: string;
  ts: string;
  event_id: string;
}

export interface ExperimentEntry {
  entry_id: string;
  kind: 'note' | 'dataset' | 'result' | 'chart' | 'link' | 'decision';
  data: Record<string, unknown>;
  ts: string;
  deleted: boolean;
  event_id: string;
}

export interface IndexEntry {
  content_id: string;
  slug: string;
  title: string;
  content_type: ContentType;
  status: ContentStatus;
  visibility: 'public' | 'private';
  tags: string[];
  event_id: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Projected content objects (output of replay)
// ──────────────────────────────────────────────────────────────────────────────

interface BaseProjected {
  content_id: string;
  meta: ContentMeta;
  history: Array<{ event_id: string; op: EOOp; ts: string; agent: string; summary?: string }>;
}

export interface ProjectedPage extends BaseProjected {
  content_type: 'page';
  blocks: Block[];
  /** Ordered block IDs (deleted blocks excluded) */
  block_order: string[];
}

export interface ProjectedWiki extends BaseProjected {
  content_type: 'wiki';
  current_revision: WikiRevision | null;
  revisions: WikiRevision[];
  has_conflict: boolean;
  conflict_candidates: string[];
}

export interface ProjectedBlog extends BaseProjected {
  content_type: 'blog';
  current_revision: BlogRevision | null;
  revisions: BlogRevision[];
  has_conflict: boolean;
  conflict_candidates: string[];
}

export interface ProjectedExperiment extends BaseProjected {
  content_type: 'experiment';
  entries: ExperimentEntry[];
}

export type ProjectedContent =
  | ProjectedPage
  | ProjectedWiki
  | ProjectedBlog
  | ProjectedExperiment;

// ──────────────────────────────────────────────────────────────────────────────
// Site index (output of projecting site:index room)
// ──────────────────────────────────────────────────────────────────────────────

export interface SiteIndex {
  entries: IndexEntry[];
  nav: IndexEntry[];          // published, public items
  /** slug → content_id map for routing */
  slug_map: Record<string, string>;
  built_at: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Build config  (loaded from env / CI secrets)
// ──────────────────────────────────────────────────────────────────────────────

export interface BuildConfig {
  homeserver: string;       // e.g. "https://matrix.example.com"
  /** If provided, private/draft rooms are included in the build */
  access_token?: string;
  /** Output directory for static files */
  out_dir: string;
  /** Include draft content? (requires access_token) */
  include_drafts: boolean;
  site_base_url: string;    // e.g. "https://username.github.io/repo"
}
