/**
 * replay.ts — Client-side replay engine.
 *
 * Used in the admin editor to apply delta events on top of a loaded snapshot.
 * Same logic as the projector, but runs in the browser.
 *
 * Strategy: load snapshot → fetch delta → apply delta → show current state.
 */

import type {
  EOEvent,
  EORawEvent,
  ProjectedContent,
  ProjectedPage,
  ProjectedWiki,
  ProjectedBlog,
  ProjectedExperiment,
  Block,
  WikiRevision,
  ExperimentEntry,
} from './types';

function isEOEvent(c: unknown): c is EOEvent {
  return typeof c === 'object' && c !== null && 'op' in c && 'target' in c && 'operand' in c && 'ctx' in c;
}

function parseTarget(target: string): { rootId: string; childType?: string; childId?: string } {
  const [root, child] = target.split('/');
  if (!child) return { rootId: root };
  const colonIdx = child.indexOf(':');
  if (colonIdx === -1) return { rootId: root, childType: child };
  return { rootId: root, childType: child.slice(0, colonIdx), childId: child.slice(colonIdx + 1) };
}

function applyPatch(obj: Record<string, unknown>, patch: Array<{ op: string; path: string; value?: unknown }>): Record<string, unknown> {
  const result: Record<string, unknown> = JSON.parse(JSON.stringify(obj));
  for (const p of patch) {
    const parts = p.path.replace(/^\//, '').split('/');
    let cur: Record<string, unknown> = result;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = (cur[parts[i]] ??= {}) as Record<string, unknown>;
    }
    const last = parts[parts.length - 1];
    if (p.op === 'replace' || p.op === 'add') cur[last] = p.value;
    else if (p.op === 'remove') delete cur[last];
  }
  return result;
}

function orderBlocks(blocks: Map<string, Block>): string[] {
  const afterMap = new Map<string | null, string>();
  for (const [id, b] of blocks) {
    if (!b.deleted) afterMap.set(b.after, id);
  }
  const ordered: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < blocks.size + 1; i++) {
    const next = afterMap.get(cur);
    if (!next) break;
    ordered.push(next);
    cur = next;
  }
  return ordered;
}

/**
 * Apply a list of raw EO events (delta) on top of an existing projected state.
 * Returns a new projected state object (immutable — original not modified).
 */
export function applyDelta(snapshot: ProjectedContent, deltaEvents: EORawEvent[]): ProjectedContent {
  if (!deltaEvents.length) return snapshot;

  switch (snapshot.content_type) {
    case 'page': return applyPageDelta(snapshot, deltaEvents);
    case 'wiki': return applyWikiDelta(snapshot, deltaEvents);
    case 'blog': return applyBlogDelta(snapshot as unknown as ProjectedBlog, deltaEvents) as unknown as ProjectedContent;
    case 'experiment': return applyExpDelta(snapshot, deltaEvents);
    default: return snapshot;
  }
}

function applyPageDelta(snap: ProjectedPage, events: EORawEvent[]): ProjectedPage {
  const blocks = new Map(snap.blocks.map((b) => [b.block_id, { ...b }]));
  const history = [...snap.history];

  for (const raw of events) {
    if (raw.type !== 'eo.op') continue;
    const e = raw.content as unknown as EOEvent;
    if (!isEOEvent(e)) continue;
    const { childType, childId } = parseTarget(e.target);
    if (childType !== 'block' || !childId) continue;

    history.push({ event_id: raw.event_id, op: e.op, ts: e.ctx.ts, agent: e.ctx.agent });

    if (e.op === 'INS') {
      const o = e.operand as { block_type: Block['block_type']; data: Record<string, unknown>; after?: string };
      blocks.set(childId, { block_id: childId, block_type: o.block_type, data: o.data ?? {}, after: o.after ?? null, deleted: false, _event_id: raw.event_id });
    } else if (e.op === 'ALT') {
      const existing = blocks.get(childId);
      if (!existing) continue;
      const o = e.operand as { patch: Array<{ op: string; path: string; value?: unknown }>; after?: string };
      blocks.set(childId, { ...existing, data: applyPatch(existing.data, o.patch ?? []), after: o.after ?? existing.after, _event_id: raw.event_id });
    } else if (e.op === 'NUL') {
      const existing = blocks.get(childId);
      if (existing) blocks.set(childId, { ...existing, deleted: true });
    }
  }

  return { ...snap, blocks: Array.from(blocks.values()), block_order: orderBlocks(blocks), history };
}

function applyWikiDelta(snap: ProjectedWiki, events: EORawEvent[]): ProjectedWiki {
  const revisions = new Map(snap.revisions.map((r) => [r.rev_id, { ...r }]));
  const history = [...snap.history];

  for (const raw of events) {
    if (raw.type !== 'eo.op') continue;
    const e = raw.content as unknown as EOEvent;
    if (!isEOEvent(e)) continue;
    const { childType, childId } = parseTarget(e.target);
    if (childType !== 'rev' || !childId) continue;

    history.push({ event_id: raw.event_id, op: e.op, ts: e.ctx.ts, agent: e.ctx.agent });

    if (e.op === 'INS') {
      const o = e.operand as { format: 'markdown'; content: string; summary: string };
      revisions.set(childId, { rev_id: childId, format: o.format ?? 'markdown', content: o.content ?? '', summary: o.summary ?? '', ts: e.ctx.ts, _event_id: raw.event_id });
    }
  }

  const sorted = Array.from(revisions.values()).sort((a, b) => a.ts.localeCompare(b.ts));
  return { ...snap, revisions: sorted, current_revision: sorted.at(-1) ?? null, history };
}

function applyBlogDelta(snap: ProjectedBlog, events: EORawEvent[]): ProjectedBlog {
  return applyWikiDelta(snap as unknown as ProjectedWiki, events) as unknown as ProjectedBlog;
}

function applyExpDelta(snap: ProjectedExperiment, events: EORawEvent[]): ProjectedExperiment {
  const entries = new Map(snap.entries.map((e) => [e.entry_id, { ...e }]));
  const history = [...snap.history];

  for (const raw of events) {
    if (raw.type !== 'eo.op') continue;
    const e = raw.content as unknown as EOEvent;
    if (!isEOEvent(e)) continue;
    const { childType, childId } = parseTarget(e.target);
    if (childType !== 'entry' || !childId) continue;

    history.push({ event_id: raw.event_id, op: e.op, ts: e.ctx.ts, agent: e.ctx.agent });

    if (e.op === 'INS') {
      const o = e.operand as { kind: ExperimentEntry['kind']; data: Record<string, unknown> };
      entries.set(childId, { entry_id: childId, kind: o.kind ?? 'note', data: o.data ?? {}, ts: e.ctx.ts, deleted: false, _event_id: raw.event_id });
    } else if (e.op === 'ALT') {
      const existing = entries.get(childId);
      if (!existing) continue;
      const o = e.operand as { patch: Array<{ op: string; path: string; value?: unknown }> };
      entries.set(childId, { ...existing, data: applyPatch(existing.data, o.patch ?? []) });
    } else if (e.op === 'NUL') {
      const existing = entries.get(childId);
      if (existing) entries.set(childId, { ...existing, deleted: true });
    }
  }

  return { ...snap, entries: Array.from(entries.values()).filter((e) => !e.deleted), history };
}
