/**
 * replay.ts
 *
 * The core replay / projection engine.
 *
 * Processes a chronologically ordered list of Matrix events and produces
 * a deterministic derived state object.  No network calls; pure function.
 *
 * Normal form:  op(target, operand)
 *   op      – one of INS | DES | ALT | SEG | CON | SYN | SUP | REC | NUL
 *   target  – stable address  "wiki:operators/rev:r_10"
 *   operand – op-specific payload
 *   ctx     – provenance (agent, ts, txn, parent, role)
 */

import type {
  MatrixEvent,
  EOEvent,
  EOOp,
  ContentMeta,
  Block,
  WikiRevision,
  BlogRevision,
  ExperimentEntry,
  IndexEntry,
  ProjectedPage,
  ProjectedWiki,
  ProjectedBlog,
  ProjectedExperiment,
  ProjectedContent,
  SiteIndex,
} from './types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────────────────────

function parseTarget(target: string): { rootId: string; childType?: string; childId?: string } {
  // target format: "rootType:rootSlug" or "rootType:rootSlug/childType:childId"
  const [root, child] = target.split('/');
  if (!child) return { rootId: root };
  const [childType, childId] = child.split(':');
  return { rootId: root, childType, childId };
}

function applyJsonPatch(obj: Record<string, unknown>, patch: Array<{ op: string; path: string; value?: unknown }>): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  for (const op of patch) {
    const parts = op.path.replace(/^\//, '').split('/');
    if (op.op === 'replace' || op.op === 'add') {
      let cur: Record<string, unknown> = result;
      for (let i = 0; i < parts.length - 1; i++) {
        cur = (cur[parts[i]] ?? {}) as Record<string, unknown>;
      }
      cur[parts[parts.length - 1]] = op.value;
    } else if (op.op === 'remove') {
      let cur: Record<string, unknown> = result;
      for (let i = 0; i < parts.length - 1; i++) {
        cur = (cur[parts[i]] ?? {}) as Record<string, unknown>;
      }
      delete cur[parts[parts.length - 1]];
    }
  }
  return result;
}

function isEOEvent(content: unknown): content is EOEvent {
  return (
    typeof content === 'object' &&
    content !== null &&
    'op' in content &&
    'target' in content &&
    'operand' in content &&
    'ctx' in content
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Block ordering helper
// Blocks form a linked list via `after`.  We reconstruct the ordered list.
// ──────────────────────────────────────────────────────────────────────────────

function orderBlocks(blocks: Map<string, Block>): string[] {
  // Build a map: after → blockId
  const afterMap = new Map<string | null, string>();
  for (const [id, block] of blocks) {
    if (!block.deleted) {
      afterMap.set(block.after, id);
    }
  }

  const ordered: string[] = [];
  let current: string | null = null;

  // Traverse the linked list starting from the "head" (after=null)
  for (let i = 0; i < blocks.size + 1; i++) {
    const next = afterMap.get(current);
    if (!next) break;
    ordered.push(next);
    current = next;
  }

  return ordered;
}

// ──────────────────────────────────────────────────────────────────────────────
// Page replay
// ──────────────────────────────────────────────────────────────────────────────

function replayPage(contentId: string, meta: ContentMeta, events: MatrixEvent[]): ProjectedPage {
  const blocks = new Map<string, Block>();
  const history: ProjectedPage['history'] = [];

  for (const mxEvent of events) {
    if (mxEvent.type !== 'eo.op') continue;
    const e = mxEvent.content as EOEvent;
    if (!isEOEvent(e)) continue;

    const { childType, childId } = parseTarget(e.target);
    if (childType !== 'block' || !childId) continue;

    history.push({
      event_id: mxEvent.event_id,
      op: e.op,
      ts: e.ctx.ts,
      agent: e.ctx.agent,
    });

    switch (e.op as EOOp) {
      case 'INS': {
        const o = e.operand as { block_type: Block['block_type']; data: Record<string, unknown>; after?: string };
        blocks.set(childId, {
          block_id: childId,
          block_type: o.block_type,
          data: o.data ?? {},
          after: o.after ?? null,
          deleted: false,
          event_id: mxEvent.event_id,
        });
        break;
      }
      case 'ALT': {
        const existing = blocks.get(childId);
        if (!existing) break;
        const o = e.operand as { patch: Array<{ op: string; path: string; value?: unknown }>; after?: string };
        const patched = applyJsonPatch(existing.data, o.patch ?? []);
        blocks.set(childId, {
          ...existing,
          data: patched,
          after: o.after ?? existing.after,
          event_id: mxEvent.event_id,
        });
        break;
      }
      case 'NUL': {
        const existing = blocks.get(childId);
        if (!existing) break;
        blocks.set(childId, { ...existing, deleted: true, event_id: mxEvent.event_id });
        break;
      }
      default:
        break;
    }
  }

  return {
    content_type: 'page',
    content_id: contentId,
    meta,
    blocks: Array.from(blocks.values()),
    block_order: orderBlocks(blocks),
    history,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Wiki replay
// ──────────────────────────────────────────────────────────────────────────────

function replayWiki(contentId: string, meta: ContentMeta, events: MatrixEvent[]): ProjectedWiki {
  const revisions = new Map<string, WikiRevision>();
  const history: ProjectedWiki['history'] = [];

  for (const mxEvent of events) {
    if (mxEvent.type !== 'eo.op') continue;
    const e = mxEvent.content as EOEvent;
    if (!isEOEvent(e)) continue;

    const { childType, childId } = parseTarget(e.target);
    if (childType !== 'rev' || !childId) continue;

    history.push({
      event_id: mxEvent.event_id,
      op: e.op,
      ts: e.ctx.ts,
      agent: e.ctx.agent,
    });

    if (e.op === 'INS') {
      const o = e.operand as { format: 'markdown'; content: string; summary: string };
      revisions.set(childId, {
        rev_id: childId,
        format: o.format ?? 'markdown',
        content: o.content ?? '',
        summary: o.summary ?? '',
        ts: e.ctx.ts,
        event_id: mxEvent.event_id,
      });
    }
  }

  const sorted = Array.from(revisions.values()).sort((a, b) => a.ts.localeCompare(b.ts));
  const current = sorted.at(-1) ?? null;

  // Detect conflict: two revisions with timestamps within 60 seconds with no SYN between them
  let hasSyn = false;
  for (const mxEvent of events) {
    if (mxEvent.type !== 'eo.op') continue;
    const e = mxEvent.content as EOEvent;
    if (isEOEvent(e) && e.op === 'SYN') hasSyn = true;
  }

  const conflictCandidates: string[] = [];
  let hasConflict = false;
  if (!hasSyn && sorted.length >= 2) {
    const last = sorted.at(-1)!;
    const prev = sorted.at(-2)!;
    const diff = Math.abs(new Date(last.ts).getTime() - new Date(prev.ts).getTime());
    if (diff < 60_000) {
      hasConflict = true;
      conflictCandidates.push(prev.rev_id, last.rev_id);
    }
  }

  return {
    content_type: 'wiki',
    content_id: contentId,
    meta,
    current_revision: current,
    revisions: sorted,
    has_conflict: hasConflict,
    conflict_candidates: conflictCandidates,
    history,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Blog replay  (same pattern as wiki)
// ──────────────────────────────────────────────────────────────────────────────

function replayBlog(contentId: string, meta: ContentMeta, events: MatrixEvent[]): ProjectedBlog {
  const revisions = new Map<string, BlogRevision>();
  const history: ProjectedBlog['history'] = [];

  for (const mxEvent of events) {
    if (mxEvent.type !== 'eo.op') continue;
    const e = mxEvent.content as EOEvent;
    if (!isEOEvent(e)) continue;

    const { childType, childId } = parseTarget(e.target);
    if (childType !== 'rev' || !childId) continue;

    history.push({ event_id: mxEvent.event_id, op: e.op, ts: e.ctx.ts, agent: e.ctx.agent });

    if (e.op === 'INS') {
      const o = e.operand as { format: 'markdown'; content: string; summary: string };
      revisions.set(childId, {
        rev_id: childId,
        format: o.format ?? 'markdown',
        content: o.content ?? '',
        summary: o.summary ?? '',
        ts: e.ctx.ts,
        event_id: mxEvent.event_id,
      });
    }
  }

  const sorted = Array.from(revisions.values()).sort((a, b) => a.ts.localeCompare(b.ts));

  return {
    content_type: 'blog',
    content_id: contentId,
    meta,
    current_revision: sorted.at(-1) ?? null,
    revisions: sorted,
    has_conflict: false,
    conflict_candidates: [],
    history,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Experiment replay
// ──────────────────────────────────────────────────────────────────────────────

function replayExperiment(contentId: string, meta: ContentMeta, events: MatrixEvent[]): ProjectedExperiment {
  const entries = new Map<string, ExperimentEntry>();
  const history: ProjectedExperiment['history'] = [];

  for (const mxEvent of events) {
    if (mxEvent.type !== 'eo.op') continue;
    const e = mxEvent.content as EOEvent;
    if (!isEOEvent(e)) continue;

    const { childType, childId } = parseTarget(e.target);
    if (childType !== 'entry' || !childId) continue;

    history.push({ event_id: mxEvent.event_id, op: e.op, ts: e.ctx.ts, agent: e.ctx.agent });

    switch (e.op as EOOp) {
      case 'INS': {
        const o = e.operand as { kind: ExperimentEntry['kind']; data: Record<string, unknown> };
        entries.set(childId, {
          entry_id: childId,
          kind: o.kind ?? 'note',
          data: o.data ?? {},
          ts: e.ctx.ts,
          deleted: false,
          event_id: mxEvent.event_id,
        });
        break;
      }
      case 'ALT': {
        const existing = entries.get(childId);
        if (!existing) break;
        const o = e.operand as { patch: Array<{ op: string; path: string; value?: unknown }> };
        entries.set(childId, {
          ...existing,
          data: applyJsonPatch(existing.data, o.patch ?? []),
          event_id: mxEvent.event_id,
        });
        break;
      }
      case 'NUL': {
        const existing = entries.get(childId);
        if (!existing) break;
        entries.set(childId, { ...existing, deleted: true, event_id: mxEvent.event_id });
        break;
      }
    }
  }

  return {
    content_type: 'experiment',
    content_id: contentId,
    meta,
    entries: Array.from(entries.values()).filter((e) => !e.deleted),
    history,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Metadata extraction from state events and DES operations
// ──────────────────────────────────────────────────────────────────────────────

function extractMeta(contentId: string, events: MatrixEvent[]): ContentMeta {
  // Start with a default meta and override with DES operations + state events
  let meta: ContentMeta = {
    content_id: contentId,
    content_type: contentId.startsWith('page:') ? 'page'
      : contentId.startsWith('blog:') ? 'blog'
      : contentId.startsWith('wiki:') ? 'wiki'
      : 'experiment',
    slug: contentId.split(':')[1] ?? contentId,
    title: contentId.split(':')[1] ?? contentId,
    status: 'draft',
    tags: [],
    updated_at: new Date().toISOString(),
    visibility: 'private',
  };

  for (const mxEvent of events) {
    // Matrix state event
    if (mxEvent.type === 'com.eo.content.meta') {
      const c = mxEvent.content as Partial<ContentMeta>;
      meta = { ...meta, ...c };
      continue;
    }

    // DES operation: describe / set metadata fields
    if (mxEvent.type === 'eo.op') {
      const e = mxEvent.content as EOEvent;
      if (!isEOEvent(e)) continue;
      if (e.op === 'DES') {
        const o = e.operand as { set: Partial<ContentMeta> };
        if (o.set) meta = { ...meta, ...o.set, updated_at: e.ctx.ts };
      }
    }
  }

  return meta;
}

// ──────────────────────────────────────────────────────────────────────────────
// Site index replay
// ──────────────────────────────────────────────────────────────────────────────

export function replaySiteIndex(events: MatrixEvent[]): SiteIndex {
  const entries = new Map<string, IndexEntry>();
  const slugMap: Record<string, string> = {};

  for (const mxEvent of events) {
    if (mxEvent.type !== 'eo.op') continue;
    const e = mxEvent.content as EOEvent;
    if (!isEOEvent(e)) continue;

    // target for index entries: "index:content_id"
    const { childType, childId } = parseTarget(e.target);
    if (childType !== 'index' || !childId) continue;

    switch (e.op as EOOp) {
      case 'INS':
      case 'DES': {
        const o = e.operand as Omit<IndexEntry, 'event_id'>;
        const entry: IndexEntry = {
          content_id: childId,
          slug: o.slug ?? childId.split(':')[1] ?? childId,
          title: o.title ?? childId,
          content_type: o.content_type ?? 'page',
          status: o.status ?? 'draft',
          visibility: o.visibility ?? 'private',
          tags: o.tags ?? [],
          event_id: mxEvent.event_id,
        };
        entries.set(childId, entry);
        slugMap[entry.slug] = childId;
        break;
      }
      case 'NUL': {
        const existing = entries.get(childId);
        if (existing) entries.set(childId, { ...existing, status: 'archived' });
        break;
      }
    }
  }

  const all = Array.from(entries.values());
  const nav = all.filter((e) => e.status === 'published' && e.visibility === 'public');

  return {
    entries: all,
    nav,
    slug_map: slugMap,
    built_at: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Main replay entry point
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Replay all events in a content room and return the projected state.
 *
 * @param contentId  The canonical content ID (e.g. "page:about")
 * @param events     All events from the room, in chronological order
 * @param includeDrafts  If false, returns null for draft/private content
 */
export function replayRoom(
  contentId: string,
  events: MatrixEvent[],
  includeDrafts = false
): ProjectedContent | null {
  const meta = extractMeta(contentId, events);

  // Access control: exclude private drafts and archived content from public build
  if (!includeDrafts && (meta.status === 'draft' || meta.status === 'archived' || meta.visibility === 'private')) {
    return null;
  }

  if (contentId.startsWith('page:')) return replayPage(contentId, meta, events);
  if (contentId.startsWith('blog:')) return replayBlog(contentId, meta, events);
  if (contentId.startsWith('wiki:')) return replayWiki(contentId, meta, events);
  if (contentId.startsWith('exp:')) return replayExperiment(contentId, meta, events);

  return null;
}
