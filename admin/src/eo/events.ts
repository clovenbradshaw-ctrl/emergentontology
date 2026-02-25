/**
 * events.ts — EO event constructors.
 * Every edit emits one of these; they are sent to Matrix as `eo.op` events.
 */

import type { EOEvent, EOOp, ContentMeta, Block, WikiRevision, ExperimentEntry } from './types';

function makeCtx(agent: string, txn?: string): EOEvent['ctx'] {
  return { agent, ts: new Date().toISOString(), txn };
}

// ── Content metadata ─────────────────────────────────────────────────────────

export function desContentMeta(contentId: string, fields: Partial<ContentMeta>, agent: string): EOEvent {
  return {
    op: 'DES',
    target: contentId,
    operand: { set: fields },
    ctx: makeCtx(agent, `des-meta-${contentId}-${Date.now()}`),
  };
}

// ── Site index ────────────────────────────────────────────────────────────────

export function insIndexEntry(
  contentId: string,
  fields: { slug: string; title: string; content_type: string; status: string; visibility: string; tags: string[] },
  agent: string
): EOEvent {
  return {
    op: 'INS',
    target: `site:index/index:${contentId}`,
    operand: { ...fields, content_id: contentId },
    ctx: makeCtx(agent, `ins-index-${contentId}`),
  };
}

export function desIndexEntry(
  contentId: string,
  fields: Partial<{ title: string; status: string; visibility: string; tags: string[] }>,
  agent: string
): EOEvent {
  return {
    op: 'DES',
    target: `site:index/index:${contentId}`,
    operand: { set: fields },
    ctx: makeCtx(agent),
  };
}

// ── Page blocks ───────────────────────────────────────────────────────────────

export function insBlock(
  pageId: string,
  block: Omit<Block, 'deleted' | '_event_id'>,
  agent: string
): EOEvent {
  return {
    op: 'INS',
    target: `${pageId}/block:${block.block_id}`,
    operand: {
      block_type: block.block_type,
      data: block.data,
      after: block.after,
    },
    ctx: makeCtx(agent, `ins-block-${block.block_id}`),
  };
}

export function altBlock(
  pageId: string,
  blockId: string,
  patch: Array<{ op: string; path: string; value?: unknown }>,
  agent: string,
  after?: string | null
): EOEvent {
  return {
    op: 'ALT',
    target: `${pageId}/block:${blockId}`,
    operand: { patch, ...(after !== undefined ? { after } : {}) },
    ctx: makeCtx(agent, `alt-block-${blockId}-${Date.now()}`),
  };
}

export function nulBlock(pageId: string, blockId: string, agent: string): EOEvent {
  return {
    op: 'NUL',
    target: `${pageId}/block:${blockId}`,
    operand: { reason: 'user_deleted' },
    ctx: makeCtx(agent),
  };
}

// ── Wiki / Blog revisions ─────────────────────────────────────────────────────

export function insRevision(
  contentId: string,
  rev: Omit<WikiRevision, '_event_id'>,
  agent: string
): EOEvent {
  return {
    op: 'INS',
    target: `${contentId}/rev:${rev.rev_id}`,
    operand: {
      format: rev.format,
      content: rev.content,
      summary: rev.summary,
    },
    ctx: makeCtx(agent, `ins-rev-${rev.rev_id}`),
  };
}

export function synRevision(
  contentId: string,
  chosenRevId: string,
  candidates: string[],
  agent: string
): EOEvent {
  return {
    op: 'SYN',
    target: contentId,
    operand: { mode: 'most_recent', chosen: chosenRevId, inputs: candidates },
    ctx: makeCtx(agent, `syn-${contentId}-${Date.now()}`),
  };
}

// ── Experiment entries ────────────────────────────────────────────────────────

export function insExpEntry(
  expId: string,
  entry: Omit<ExperimentEntry, 'deleted' | '_event_id'>,
  agent: string
): EOEvent {
  return {
    op: 'INS',
    target: `${expId}/entry:${entry.entry_id}`,
    operand: {
      kind: entry.kind,
      data: entry.data,
    },
    ctx: makeCtx(agent, `ins-entry-${entry.entry_id}`),
  };
}

export function altExpEntry(
  expId: string,
  entryId: string,
  patch: Array<{ op: string; path: string; value?: unknown }>,
  agent: string
): EOEvent {
  return {
    op: 'ALT',
    target: `${expId}/entry:${entryId}`,
    operand: { patch },
    ctx: makeCtx(agent),
  };
}

export function nulExpEntry(expId: string, entryId: string, agent: string): EOEvent {
  return {
    op: 'NUL',
    target: `${expId}/entry:${entryId}`,
    operand: { reason: 'user_deleted' },
    ctx: makeCtx(agent),
  };
}
