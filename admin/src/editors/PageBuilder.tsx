/**
 * PageBuilder — drag/drop block-based page editor with live preview.
 *
 * Data flow:
 *   Load  →  GET /eowikicurrent (record_id = contentId) → current page state
 *            Fall back to static snapshot if no Xano record.
 *   Ops   →  POST /eowiki (append event)
 *            PATCH /eowikicurrent (update current state snapshot)
 */

import React, { useEffect, useRef, useState, useMemo } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { useAuth } from '../auth/AuthContext';
import { useSettings } from '../settings/SettingsContext';
import { useXRay } from '../components/XRayOverlay';
import {
  fetchCurrentRecord,
  addRecord,
  upsertCurrentRecord,
  eventToPayload,
  type XanoCurrentRecord,
} from '../xano/client';
import { insBlock, altBlock, nulBlock } from '../eo/events';
import type { Block } from '../eo/types';

// ── Sub-block types for columns ──────────────────────────────────────────────

interface SubBlock {
  block_id: string;
  block_type: Block['block_type'];
  data: Record<string, unknown>;
}

interface ColumnData {
  blocks: SubBlock[];
  block_order: string[];
}

/** Migrate old columns format (string[]) to new format (ColumnData[]). */
function migrateColumns(data: Record<string, unknown>): ColumnData[] {
  const raw = data.columns;
  if (!Array.isArray(raw)) return [{ blocks: [], block_order: [] }, { blocks: [], block_order: [] }];

  // Already new format: array of objects with blocks
  if (raw.length > 0 && typeof raw[0] === 'object' && raw[0] !== null && 'blocks' in (raw[0] as Record<string, unknown>)) {
    return raw as ColumnData[];
  }

  // Old format: array of markdown strings → convert each to a text sub-block
  return (raw as string[]).map((md) => {
    if (!md) return { blocks: [], block_order: [] };
    const id = `sb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    return {
      blocks: [{ block_id: id, block_type: 'text' as const, data: { md } }],
      block_order: [id],
    };
  });
}

function genSubBlockId(): string {
  return `sb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── Block palette definitions ─────────────────────────────────────────────────

const BLOCK_TYPES: Array<{ type: Block['block_type']; label: string; icon: string; group: string }> = [
  // Content
  { type: 'text', label: 'Text', icon: '¶', group: 'Content' },
  { type: 'heading', label: 'Heading', icon: 'H', group: 'Content' },
  { type: 'callout', label: 'Callout', icon: '!', group: 'Content' },
  { type: 'quote', label: 'Quote', icon: '"', group: 'Content' },
  { type: 'code', label: 'Code Block', icon: '</>', group: 'Content' },
  // Media
  { type: 'image', label: 'Image', icon: '🖼', group: 'Media' },
  { type: 'video', label: 'Video', icon: '▶', group: 'Media' },
  { type: 'embed', label: 'Embed', icon: '□', group: 'Media' },
  // Layout
  { type: 'columns', label: 'Columns', icon: '▥', group: 'Layout' },
  { type: 'divider', label: 'Divider', icon: '—', group: 'Layout' },
  { type: 'spacer', label: 'Spacer', icon: '↕', group: 'Layout' },
  { type: 'button', label: 'Button', icon: '⊞', group: 'Layout' },
  // Dynamic
  { type: 'content-feed', label: 'Content Feed', icon: '▤', group: 'Dynamic' },
  { type: 'operator-grid', label: 'Operator Grid', icon: '⊞', group: 'Dynamic' },
  // Advanced
  { type: 'toc', label: 'TOC', icon: '≡', group: 'Advanced' },
  { type: 'wiki-embed', label: 'Wiki Embed', icon: '⊂', group: 'Advanced' },
  { type: 'experiment-embed', label: 'Exp Embed', icon: '⊗', group: 'Advanced' },
  { type: 'html', label: 'HTML', icon: '<>', group: 'Advanced' },
];

/** Block types allowed inside columns (everything except columns — no nesting). */
const COLUMN_BLOCK_TYPES = BLOCK_TYPES.filter((bt) => bt.type !== 'columns');

interface PageState {
  blocks: Block[];
  block_order: string[];
  meta: Record<string, unknown>;
}

interface Props {
  contentId: string;
  siteBase: string;
}

export default function PageBuilder({ contentId, siteBase }: Props) {
  const { isAuthenticated } = useAuth();
  const { settings } = useSettings();
  const { registerEvent } = useXRay();

  const [state, setState] = useState<PageState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const currentRecordRef = useRef<XanoCurrentRecord | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // ── Load ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      let pageState: PageState | null = null;

      // 1. Try Xano current record
      try {
        const rec = await fetchCurrentRecord(contentId);
        if (rec) {
          currentRecordRef.current = rec;
          pageState = JSON.parse(rec.values) as PageState;
        }
      } catch (err) {
        console.warn('[PageBuilder] Could not fetch Xano current record:', err);
      }

      // 2. Fall back to static snapshot
      if (!pageState) {
        try {
          const fileName = contentId.replace(':', '-') + '.json';
          const resp = await fetch(`${siteBase}/generated/state/content/${fileName}`);
          if (resp.ok) {
            const snap = await resp.json() as PageState;
            pageState = { blocks: snap.blocks ?? [], block_order: snap.block_order ?? [], meta: snap.meta ?? {} };
          }
        } catch { /* no snapshot */ }
      }

      if (!cancelled) {
        setState(pageState);
        setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [contentId, siteBase]);

  // ── Emit helper ───────────────────────────────────────────────────────────

  async function emit(event: ReturnType<typeof insBlock>, updatedState: PageState) {
    if (!isAuthenticated) return;
    const xid = `${event.op}-${Date.now()}`;
    registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'pending' });
    try {
      await addRecord(eventToPayload(event));
      registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'sent' });

      const updated = await upsertCurrentRecord(contentId, updatedState, event.ctx.agent, currentRecordRef.current);
      currentRecordRef.current = updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'error', error: msg });
      setError(msg);
    }
  }

  const agent = settings.displayName || 'editor';

  // ── Add block ─────────────────────────────────────────────────────────────

  function addBlock(type: Block['block_type']) {
    if (!state || !isAuthenticated) return;
    const blockId = `b_${Date.now()}`;
    const lastId = state.block_order.at(-1) ?? null;
    const newBlock: Block = { block_id: blockId, block_type: type, data: defaultData(type), after: lastId, deleted: false };
    const event = insBlock(contentId, newBlock, agent);

    const updatedState: PageState = {
      ...state,
      blocks: [...state.blocks, newBlock],
      block_order: [...state.block_order, blockId],
    };
    setState(updatedState);
    emit(event, updatedState);
    setSelectedBlockId(blockId);
  }

  // ── Duplicate block ───────────────────────────────────────────────────────

  function duplicateBlock(blockId: string) {
    if (!state || !isAuthenticated) return;
    const original = state.blocks.find((b) => b.block_id === blockId);
    if (!original) return;
    const newId = `b_${Date.now()}`;
    const newBlock: Block = { block_id: newId, block_type: original.block_type, data: { ...original.data }, after: blockId, deleted: false };
    const event = insBlock(contentId, newBlock, agent);
    const idx = state.block_order.indexOf(blockId);
    const newOrder = [...state.block_order];
    newOrder.splice(idx + 1, 0, newId);
    const updatedState: PageState = {
      ...state,
      blocks: [...state.blocks, newBlock],
      block_order: newOrder,
    };
    setState(updatedState);
    emit(event, updatedState);
    setSelectedBlockId(newId);
  }

  // ── Update block ──────────────────────────────────────────────────────────

  function updateBlock(blockId: string, newData: Record<string, unknown>) {
    if (!state || !isAuthenticated) return;
    const updatedState: PageState = {
      ...state,
      blocks: state.blocks.map((b) => b.block_id === blockId ? { ...b, data: newData } : b),
    };
    setState(updatedState);
    const patch = Object.entries(newData).map(([k, v]) => ({ op: 'replace', path: `/data/${k}`, value: v }));
    const event = altBlock(contentId, blockId, patch, agent);
    emit(event, updatedState);
  }

  // ── Delete block ──────────────────────────────────────────────────────────

  function deleteBlock(blockId: string) {
    if (!state || !isAuthenticated) return;
    const updatedState: PageState = {
      ...state,
      blocks: state.blocks.map((b) => b.block_id === blockId ? { ...b, deleted: true } : b),
      block_order: state.block_order.filter((id) => id !== blockId),
    };
    setState(updatedState);
    const event = nulBlock(contentId, blockId, agent);
    emit(event, updatedState);
    if (selectedBlockId === blockId) setSelectedBlockId(null);
  }

  // ── Column helper: update columns data on a columns block ─────────────────

  function updateColumnsData(columnsBlockId: string, updater: (cols: ColumnData[]) => ColumnData[]) {
    if (!state || !isAuthenticated) return;
    const columnsBlock = state.blocks.find((b) => b.block_id === columnsBlockId);
    if (!columnsBlock) return;

    const cols = migrateColumns(columnsBlock.data);
    const newCols = updater(cols);
    const newData = { ...columnsBlock.data, columns: newCols };

    const updatedState: PageState = {
      ...state,
      blocks: state.blocks.map((b) => b.block_id === columnsBlockId ? { ...b, data: newData } : b),
    };
    setState(updatedState);

    const patch = [{ op: 'replace', path: '/data/columns', value: newCols }];
    const event = altBlock(contentId, columnsBlockId, patch, agent);
    emit(event, updatedState);
  }

  // ── Sub-block operations ──────────────────────────────────────────────────

  function addSubBlock(columnsBlockId: string, colIndex: number, type: Block['block_type']) {
    const id = genSubBlockId();
    const sub: SubBlock = { block_id: id, block_type: type, data: defaultData(type) };
    updateColumnsData(columnsBlockId, (cols) =>
      cols.map((c, i) => i === colIndex
        ? { blocks: [...c.blocks, sub], block_order: [...c.block_order, id] }
        : c
      )
    );
    setSelectedBlockId(id);
  }

  function deleteSubBlock(columnsBlockId: string, colIndex: number, subBlockId: string) {
    updateColumnsData(columnsBlockId, (cols) =>
      cols.map((c, i) => i === colIndex
        ? { blocks: c.blocks.filter((b) => b.block_id !== subBlockId), block_order: c.block_order.filter((id) => id !== subBlockId) }
        : c
      )
    );
    if (selectedBlockId === subBlockId) setSelectedBlockId(null);
  }

  function updateSubBlock(columnsBlockId: string, colIndex: number, subBlockId: string, newData: Record<string, unknown>) {
    updateColumnsData(columnsBlockId, (cols) =>
      cols.map((c, i) => i === colIndex
        ? { ...c, blocks: c.blocks.map((b) => b.block_id === subBlockId ? { ...b, data: newData } : b) }
        : c
      )
    );
  }

  function moveSubBlock(columnsBlockId: string, colIndex: number, subBlockId: string, direction: -1 | 1) {
    updateColumnsData(columnsBlockId, (cols) =>
      cols.map((c, i) => {
        if (i !== colIndex) return c;
        const idx = c.block_order.indexOf(subBlockId);
        const newIdx = idx + direction;
        if (newIdx < 0 || newIdx >= c.block_order.length) return c;
        const newOrder = [...c.block_order];
        [newOrder[idx], newOrder[newIdx]] = [newOrder[newIdx], newOrder[idx]];
        return { ...c, block_order: newOrder };
      })
    );
  }

  function moveSubBlockToCanvas(columnsBlockId: string, colIndex: number, subBlockId: string) {
    if (!state || !isAuthenticated) return;
    const columnsBlock = state.blocks.find((b) => b.block_id === columnsBlockId);
    if (!columnsBlock) return;
    const cols = migrateColumns(columnsBlock.data);
    const col = cols[colIndex];
    const sub = col.blocks.find((b) => b.block_id === subBlockId);
    if (!sub) return;

    // Create a new top-level block from the sub-block
    const newBlockId = `b_${Date.now()}`;
    const lastId = state.block_order.at(-1) ?? null;
    const newBlock: Block = { block_id: newBlockId, block_type: sub.block_type, data: { ...sub.data }, after: lastId, deleted: false };

    // Remove sub-block from column
    const newCols = cols.map((c, i) => i === colIndex
      ? { blocks: c.blocks.filter((b) => b.block_id !== subBlockId), block_order: c.block_order.filter((id) => id !== subBlockId) }
      : c
    );
    const newColData = { ...columnsBlock.data, columns: newCols };

    const updatedState: PageState = {
      ...state,
      blocks: [
        ...state.blocks.map((b) => b.block_id === columnsBlockId ? { ...b, data: newColData } : b),
        newBlock,
      ],
      block_order: [...state.block_order, newBlockId],
    };
    setState(updatedState);
    setSelectedBlockId(newBlockId);

    // Emit events: ALT on columns block + INS for new top-level block
    const colPatch = [{ op: 'replace', path: '/data/columns', value: newCols }];
    const altEvent = altBlock(contentId, columnsBlockId, colPatch, agent);
    emit(altEvent, updatedState);
    const insEvent = insBlock(contentId, newBlock, agent);
    emit(insEvent, updatedState);
  }

  // ── Move top-level block into a column ─────────────────────────────────────

  function moveBlockToColumn(blockId: string, columnsBlockId: string, colIndex: number) {
    if (!state || !isAuthenticated) return;
    const block = state.blocks.find((b) => b.block_id === blockId);
    if (!block || block.block_type === 'columns') return; // prevent nesting

    const columnsBlock = state.blocks.find((b) => b.block_id === columnsBlockId);
    if (!columnsBlock) return;

    // Create sub-block from top-level block
    const subId = genSubBlockId();
    const sub: SubBlock = { block_id: subId, block_type: block.block_type, data: { ...block.data } };

    const cols = migrateColumns(columnsBlock.data);
    const newCols = cols.map((c, i) => i === colIndex
      ? { blocks: [...c.blocks, sub], block_order: [...c.block_order, subId] }
      : c
    );
    const newColData = { ...columnsBlock.data, columns: newCols };

    const updatedState: PageState = {
      ...state,
      blocks: state.blocks
        .map((b) => b.block_id === blockId ? { ...b, deleted: true } : b)
        .map((b) => b.block_id === columnsBlockId ? { ...b, data: newColData } : b),
      block_order: state.block_order.filter((id) => id !== blockId),
    };
    setState(updatedState);
    setSelectedBlockId(subId);

    // Emit events
    const nulEvent = nulBlock(contentId, blockId, agent);
    emit(nulEvent, updatedState);
    const colPatch = [{ op: 'replace', path: '/data/columns', value: newCols }];
    const altEvent = altBlock(contentId, columnsBlockId, colPatch, agent);
    emit(altEvent, updatedState);
  }

  // ── Find selected block info (top-level or sub-block) ─────────────────────

  function findSelectedInfo(): { block: Block | SubBlock; isSubBlock: boolean; parentId?: string; colIndex?: number } | null {
    if (!state || !selectedBlockId) return null;

    // Check top-level
    const topBlock = state.blocks.find((b) => b.block_id === selectedBlockId && !b.deleted);
    if (topBlock) return { block: topBlock, isSubBlock: false };

    // Check sub-blocks in columns
    for (const b of state.blocks) {
      if (b.block_type !== 'columns' || b.deleted) continue;
      const cols = migrateColumns(b.data);
      for (let i = 0; i < cols.length; i++) {
        const sub = cols[i].blocks.find((sb) => sb.block_id === selectedBlockId);
        if (sub) return { block: sub, isSubBlock: true, parentId: b.block_id, colIndex: i };
      }
    }
    return null;
  }

  // ── Reorder (drag/drop) ───────────────────────────────────────────────────

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || !state || !isAuthenticated) return;

    const activeId = String(active.id);
    const overId = String(over.id);

    // Check if dropped on a column drop zone
    if (overId.startsWith('col:')) {
      const parts = overId.split(':');
      const columnsBlockId = parts[1];
      const colIndex = parseInt(parts[2], 10);

      // Only move top-level blocks into columns (not sub-blocks, not columns themselves)
      if (!state.block_order.includes(activeId)) return;
      const activeBlock = state.blocks.find((b) => b.block_id === activeId);
      if (!activeBlock || activeBlock.block_type === 'columns') return;

      moveBlockToColumn(activeId, columnsBlockId, colIndex);
      return;
    }

    // Normal canvas reorder
    if (activeId === overId) return;
    if (!state.block_order.includes(activeId) || !state.block_order.includes(overId)) return;

    const oldIndex = state.block_order.indexOf(activeId);
    const newIndex = state.block_order.indexOf(overId);
    const newOrder = arrayMove(state.block_order, oldIndex, newIndex);

    const movedIdx = newOrder.indexOf(activeId);
    const newAfter = movedIdx === 0 ? null : newOrder[movedIdx - 1];

    const updatedState: PageState = {
      ...state,
      blocks: state.blocks.map((b) => b.block_id === activeId ? { ...b, after: newAfter } : b),
      block_order: newOrder,
    };
    setState(updatedState);
    const altEvent = altBlock(contentId, activeId, [], 'editor', newAfter);
    emit(altEvent, updatedState);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return <div className="editor-loading">Loading page builder…</div>;
  if (!state) return <div className="editor-empty">Create this page first from the content list.</div>;

  const selectedInfo = findSelectedInfo();

  // Group palette items
  const groups = BLOCK_TYPES.reduce<Record<string, typeof BLOCK_TYPES>>((acc, bt) => {
    (acc[bt.group] ??= []).push(bt);
    return acc;
  }, {});

  return (
    <div className="page-builder">
      {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>×</button></div>}

      <div className="builder-toolbar">
        <button
          className={`btn btn-sm ${showPreview ? 'btn-primary' : ''}`}
          onClick={() => setShowPreview(!showPreview)}
        >
          {showPreview ? 'Hide Preview' : 'Live Preview'}
        </button>
        <span className="builder-block-count">{state.block_order.length} blocks</span>
      </div>

      {showPreview && (
        <LivePreview state={state} />
      )}

      <div className="builder-layout">
        <aside className="block-palette">
          {Object.entries(groups).map(([group, items]) => (
            <div key={group} className="palette-group">
              <div className="palette-title">{group}</div>
              {items.map((bt) => (
                <button key={bt.type} className="palette-btn" onClick={() => addBlock(bt.type)}>
                  <span className="palette-icon">{bt.icon}</span>
                  <span>{bt.label}</span>
                </button>
              ))}
            </div>
          ))}
        </aside>

        <main className="builder-canvas">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={state.block_order} strategy={verticalListSortingStrategy}>
              {state.block_order.map((id) => {
                const block = state.blocks.find((b) => b.block_id === id);
                if (!block || block.deleted) return null;

                if (block.block_type === 'columns') {
                  return (
                    <SortableColumnsBlock
                      key={id}
                      block={block}
                      selected={selectedBlockId === id}
                      selectedSubBlockId={selectedBlockId}
                      onSelect={() => setSelectedBlockId(id)}
                      onSelectSubBlock={(subId) => setSelectedBlockId(subId)}
                      onDelete={() => deleteBlock(id)}
                      onDuplicate={() => duplicateBlock(id)}
                      onAddSubBlock={(colIdx, type) => addSubBlock(id, colIdx, type)}
                      onDeleteSubBlock={(colIdx, subId) => deleteSubBlock(id, colIdx, subId)}
                      onMoveSubBlock={(colIdx, subId, dir) => moveSubBlock(id, colIdx, subId, dir)}
                      onMoveSubBlockToCanvas={(colIdx, subId) => moveSubBlockToCanvas(id, colIdx, subId)}
                    />
                  );
                }

                return (
                  <SortableBlock
                    key={id}
                    block={block}
                    selected={selectedBlockId === id}
                    onSelect={() => setSelectedBlockId(id)}
                    onDelete={() => deleteBlock(id)}
                    onDuplicate={() => duplicateBlock(id)}
                  />
                );
              })}
            </SortableContext>
          </DndContext>
          {state.block_order.length === 0 && (
            <div className="canvas-empty">← Add a block from the palette</div>
          )}
        </main>

        <aside className="block-inspector">
          <div className="inspector-title">Properties</div>
          {selectedInfo
            ? selectedInfo.isSubBlock
              ? <BlockInspector
                  block={selectedInfo.block as Block}
                  onUpdate={(data) => updateSubBlock(selectedInfo.parentId!, selectedInfo.colIndex!, selectedInfo.block.block_id, data)}
                />
              : <BlockInspector
                  block={selectedInfo.block as Block}
                  onUpdate={(data) => updateBlock(selectedInfo.block.block_id, data)}
                />
            : <div className="inspector-empty">Select a block to edit properties</div>
          }
        </aside>
      </div>
    </div>
  );
}

// ── Live Preview ──────────────────────────────────────────────────────────────

function LivePreview({ state }: { state: PageState }) {
  const html = useMemo(() => {
    const blockMap = new Map(state.blocks.map((b) => [b.block_id, b]));
    const parts: string[] = [];
    for (const id of state.block_order) {
      const block = blockMap.get(id);
      if (!block || block.deleted) continue;
      parts.push(renderBlockHtml(block, state));
    }
    return parts.join('\n');
  }, [state]);

  return (
    <div className="live-preview">
      <div className="live-preview-header">
        <span className="live-preview-label">Live Preview</span>
      </div>
      <div className="live-preview-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderMd(md: string): string {
  return md
    .replace(/^#{4}\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^#{3}\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^#{2}\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^#{1}\s+(.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<)(.+)/m, '<p>$1')
    .trimEnd() + '</p>';
}

/** Render a sub-block to HTML (reuses the same logic as top-level blocks). */
function renderSubBlockHtml(sub: SubBlock): string {
  const { block_type, data } = sub;
  switch (block_type) {
    case 'text': return renderMd(String(data.md ?? data.text ?? ''));
    case 'heading': {
      const text = String(data.text ?? '');
      const level = Math.min(Math.max(Number(data.level ?? 2), 1), 6);
      const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      return `<h${level} id="${slug}">${escHtml(text)}</h${level}>`;
    }
    case 'callout': return `<aside class="block block-callout callout-${data.kind ?? 'info'}"><div>${renderMd(String(data.text ?? ''))}</div></aside>`;
    case 'quote': return `<blockquote class="block block-quote"><p>${escHtml(String(data.text ?? ''))}</p>${data.attribution ? `<cite>— ${escHtml(String(data.attribution))}</cite>` : ''}</blockquote>`;
    case 'divider': return '<hr class="block block-divider" />';
    case 'spacer': return `<div class="block block-spacer" style="height:${escHtml(String(data.height ?? '2rem'))}"></div>`;
    case 'image': return `<figure class="block block-image"><img src="${escHtml(String(data.src ?? ''))}" alt="${escHtml(String(data.alt ?? ''))}" loading="lazy" />${data.caption ? `<figcaption>${escHtml(String(data.caption))}</figcaption>` : ''}</figure>`;
    case 'code': return `<div class="block block-code"><pre><code${data.lang ? ` class="language-${escHtml(String(data.lang))}"` : ''}>${escHtml(String(data.code ?? ''))}</code></pre></div>`;
    case 'button': return `<div class="block block-button"><a class="btn btn-${escHtml(String(data.style ?? 'primary'))}" href="#">${escHtml(String(data.text ?? 'Click here'))}</a></div>`;
    case 'embed': return `<figure class="block block-embed"><iframe src="${escHtml(String(data.src ?? ''))}" title="${escHtml(String(data.title ?? ''))}" loading="lazy" allowfullscreen frameborder="0"></iframe></figure>`;
    case 'video': {
      const src = String(data.src ?? '');
      let embedSrc = src;
      const ytMatch = src.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
      if (ytMatch) embedSrc = `https://www.youtube.com/embed/${ytMatch[1]}`;
      return `<figure class="block block-video"><iframe src="${escHtml(embedSrc)}" loading="lazy" allowfullscreen frameborder="0"></iframe></figure>`;
    }
    case 'html': return `<div class="block block-html">${String(data.html ?? '')}</div>`;
    default: return `<div class="block">[${block_type}]</div>`;
  }
}

function renderBlockHtml(block: Block, state: PageState): string {
  const { block_type, data } = block;
  switch (block_type) {
    case 'text':
      return renderMd(String(data.md ?? data.text ?? ''));
    case 'heading': {
      const text = String(data.text ?? '');
      const level = Math.min(Math.max(Number(data.level ?? 2), 1), 6);
      const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      return `<h${level} id="${slug}" class="block block-heading">${escHtml(text)}</h${level}>`;
    }
    case 'callout':
      return `<aside class="block block-callout callout-${data.kind ?? 'info'}"><div>${renderMd(String(data.text ?? ''))}</div></aside>`;
    case 'quote':
      return `<blockquote class="block block-quote"><p>${escHtml(String(data.text ?? ''))}</p>${data.attribution ? `<cite>— ${escHtml(String(data.attribution))}</cite>` : ''}</blockquote>`;
    case 'divider':
      return '<hr class="block block-divider" />';
    case 'spacer':
      return `<div class="block block-spacer" style="height:${escHtml(String(data.height ?? '2rem'))}"></div>`;
    case 'image':
      return `<figure class="block block-image"><img src="${escHtml(String(data.src ?? ''))}" alt="${escHtml(String(data.alt ?? ''))}" loading="lazy" />${data.caption ? `<figcaption>${escHtml(String(data.caption))}</figcaption>` : ''}</figure>`;
    case 'video': {
      const src = String(data.src ?? '');
      let embedSrc = src;
      const ytMatch = src.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
      if (ytMatch) embedSrc = `https://www.youtube.com/embed/${ytMatch[1]}`;
      const vimeoMatch = src.match(/vimeo\.com\/(\d+)/);
      if (vimeoMatch) embedSrc = `https://player.vimeo.com/video/${vimeoMatch[1]}`;
      const caption = String(data.caption ?? '');
      return `<figure class="block block-video"><iframe src="${escHtml(embedSrc)}" title="${escHtml(caption || 'Video')}" loading="lazy" allowfullscreen frameborder="0"></iframe>${caption ? `<figcaption>${escHtml(caption)}</figcaption>` : ''}</figure>`;
    }
    case 'embed': {
      const src = String(data.src ?? '');
      const title = String(data.title ?? '');
      return `<figure class="block block-embed"><iframe src="${escHtml(src)}" title="${escHtml(title)}" loading="lazy" allowfullscreen frameborder="0"></iframe>${title ? `<figcaption>${escHtml(title)}</figcaption>` : ''}</figure>`;
    }
    case 'code':
      return `<div class="block block-code"><pre><code${data.lang ? ` class="language-${escHtml(String(data.lang))}"` : ''}>${escHtml(String(data.code ?? ''))}</code></pre></div>`;
    case 'button': {
      const text = String(data.text ?? 'Click here');
      const style = String(data.style ?? 'primary');
      return `<div class="block block-button"><a class="btn btn-${escHtml(style)}" href="#">${escHtml(text)}</a></div>`;
    }
    case 'columns': {
      const cols = migrateColumns(data);
      const layout = data.layout ? ` style="grid-template-columns:${escHtml(String(data.layout))}"` : '';
      const rendered = cols.map((col) => {
        const inner = col.block_order
          .map((id) => col.blocks.find((b) => b.block_id === id))
          .filter(Boolean)
          .map((sub) => renderSubBlockHtml(sub!))
          .join('\n');
        return `<div class="column">${inner || '&nbsp;'}</div>`;
      }).join('');
      return `<div class="block block-columns block-columns-${cols.length}"${layout}>${rendered}</div>`;
    }
    case 'toc': {
      const headings: string[] = [];
      const blockMap = new Map(state.blocks.map((b) => [b.block_id, b]));
      for (const id of state.block_order) {
        const b = blockMap.get(id);
        if (!b || b.deleted) continue;
        if (b.block_type === 'text') {
          const md = String(b.data.md ?? b.data.text ?? '');
          for (const line of md.split('\n')) {
            const m = line.match(/^(#{1,4})\s+(.+)$/);
            if (m) {
              const level = m[1].length;
              const text = m[2];
              headings.push(`<li class="toc-level-${level}"><a href="#">${escHtml(text)}</a></li>`);
            }
          }
        }
        if (b.block_type === 'heading') {
          const text = String(b.data.text ?? '');
          const level = Number(b.data.level ?? 2);
          headings.push(`<li class="toc-level-${level}"><a href="#">${escHtml(text)}</a></li>`);
        }
      }
      if (headings.length === 0) return '<nav class="block block-toc"><div class="toc-title">Contents</div><p style="color:#888;font-size:.85rem">No headings found</p></nav>';
      return `<nav class="block block-toc"><div class="toc-title">Contents</div><ol>${headings.join('')}</ol></nav>`;
    }
    case 'wiki-embed':
      return `<div class="block block-wiki-embed"><a class="wiki-embed-link">Wiki: ${escHtml(String(data.slug ?? data.wiki_id ?? '?'))}</a></div>`;
    case 'experiment-embed':
      return `<div class="block block-experiment-embed"><a class="exp-embed-link">Experiment: ${escHtml(String(data.exp_id ?? '?'))}</a></div>`;
    case 'html':
      return `<div class="block block-html">${String(data.html ?? '')}</div>`;
    case 'content-feed':
      return `<div class="block block-content-feed" style="border:1px dashed #555;padding:1rem;border-radius:6px;color:#888;text-align:center">▤ ${escHtml(String(data.content_type ?? 'wiki'))} feed — rendered at build time</div>`;
    case 'operator-grid':
      return `<div class="block block-operator-grid" style="border:1px dashed #555;padding:1rem;border-radius:6px;color:#888;text-align:center">⊞ 3×3 Operator Grid — rendered at build time</div>`;
    default:
      return `<div class="block">[${block_type}]</div>`;
  }
}

// ── Sortable block wrapper ────────────────────────────────────────────────────

function SortableBlock({ block, selected, onSelect, onDelete, onDuplicate }: {
  block: Block;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.block_id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className={`builder-block ${selected ? 'selected' : ''}`}
      onClick={onSelect}
    >
      <div className="block-drag-handle" {...attributes} {...listeners}>⠿</div>
      <div className="block-content">
        <BlockPreview block={block} />
      </div>
      <div className="block-actions">
        <button className="block-action-btn" onClick={(e) => { e.stopPropagation(); onDuplicate(); }} title="Duplicate block">⧉</button>
        <button className="block-action-btn block-action-delete" onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete block">×</button>
      </div>
    </div>
  );
}

// ── Sortable columns block (expands to show column contents) ─────────────────

function SortableColumnsBlock({ block, selected, selectedSubBlockId, onSelect, onSelectSubBlock, onDelete, onDuplicate, onAddSubBlock, onDeleteSubBlock, onMoveSubBlock, onMoveSubBlockToCanvas }: {
  block: Block;
  selected: boolean;
  selectedSubBlockId: string | null;
  onSelect: () => void;
  onSelectSubBlock: (id: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onAddSubBlock: (colIdx: number, type: Block['block_type']) => void;
  onDeleteSubBlock: (colIdx: number, subId: string) => void;
  onMoveSubBlock: (colIdx: number, subId: string, dir: -1 | 1) => void;
  onMoveSubBlockToCanvas: (colIdx: number, subId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.block_id });
  const cols = migrateColumns(block.data);
  const layout = String(block.data.layout ?? `repeat(${cols.length}, 1fr)`);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className={`builder-block builder-block-columns ${selected ? 'selected' : ''}`}
      onClick={(e) => { if ((e.target as HTMLElement).closest('.col-drop-zone')) return; onSelect(); }}
    >
      <div className="block-drag-handle" {...attributes} {...listeners}>⠿</div>
      <div className="block-content">
        <div style={{ color: '#888', fontSize: '13px', marginBottom: '6px' }}>▥ {cols.length}-column layout</div>
        <div style={{ display: 'grid', gridTemplateColumns: layout, gap: '6px' }}>
          {cols.map((col, i) => (
            <ColumnDropZone
              key={i}
              containerId={`col:${block.block_id}:${i}`}
              column={col}
              colIndex={i}
              selectedSubBlockId={selectedSubBlockId}
              onSelectSubBlock={onSelectSubBlock}
              onAddSubBlock={(type) => onAddSubBlock(i, type)}
              onDeleteSubBlock={(subId) => onDeleteSubBlock(i, subId)}
              onMoveSubBlock={(subId, dir) => onMoveSubBlock(i, subId, dir)}
              onMoveSubBlockToCanvas={(subId) => onMoveSubBlockToCanvas(i, subId)}
            />
          ))}
        </div>
      </div>
      <div className="block-actions">
        <button className="block-action-btn" onClick={(e) => { e.stopPropagation(); onDuplicate(); }} title="Duplicate block">⧉</button>
        <button className="block-action-btn block-action-delete" onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete block">×</button>
      </div>
    </div>
  );
}

// ── Column drop zone ─────────────────────────────────────────────────────────

function ColumnDropZone({ containerId, column, colIndex, selectedSubBlockId, onSelectSubBlock, onAddSubBlock, onDeleteSubBlock, onMoveSubBlock, onMoveSubBlockToCanvas }: {
  containerId: string;
  column: ColumnData;
  colIndex: number;
  selectedSubBlockId: string | null;
  onSelectSubBlock: (id: string) => void;
  onAddSubBlock: (type: Block['block_type']) => void;
  onDeleteSubBlock: (subId: string) => void;
  onMoveSubBlock: (subId: string, dir: -1 | 1) => void;
  onMoveSubBlockToCanvas: (subId: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: containerId });
  const [showAddMenu, setShowAddMenu] = useState(false);

  return (
    <div
      ref={setNodeRef}
      className={`col-drop-zone ${isOver ? 'col-drop-over' : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ color: '#666', fontSize: '10px', marginBottom: '3px' }}>Col {colIndex + 1}</div>
      {column.block_order.map((subId, idx) => {
        const sub = column.blocks.find((b) => b.block_id === subId);
        if (!sub) return null;
        return (
          <div
            key={subId}
            className={`col-sub-block ${selectedSubBlockId === subId ? 'selected' : ''}`}
            onClick={(e) => { e.stopPropagation(); onSelectSubBlock(subId); }}
          >
            <div className="col-sub-preview">
              <SubBlockPreview sub={sub} />
            </div>
            <div className="col-sub-actions">
              {idx > 0 && <button onClick={(e) => { e.stopPropagation(); onMoveSubBlock(subId, -1); }} title="Move up">↑</button>}
              {idx < column.block_order.length - 1 && <button onClick={(e) => { e.stopPropagation(); onMoveSubBlock(subId, 1); }} title="Move down">↓</button>}
              <button onClick={(e) => { e.stopPropagation(); onMoveSubBlockToCanvas(subId); }} title="Move to canvas">↗</button>
              <button onClick={(e) => { e.stopPropagation(); onDeleteSubBlock(subId); }} title="Delete" className="col-sub-delete">×</button>
            </div>
          </div>
        );
      })}
      {column.block_order.length === 0 && !isOver && (
        <div style={{ color: '#555', fontSize: '11px', textAlign: 'center', padding: '8px 0' }}>
          Drop blocks here
        </div>
      )}
      {isOver && (
        <div style={{ color: 'var(--accent)', fontSize: '11px', textAlign: 'center', padding: '8px 0', borderTop: '2px solid var(--accent)' }}>
          Drop here
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <button
          className="col-add-btn"
          onClick={(e) => { e.stopPropagation(); setShowAddMenu(!showAddMenu); }}
        >
          + Add block
        </button>
        {showAddMenu && (
          <div className="col-add-menu">
            {COLUMN_BLOCK_TYPES.map((bt) => (
              <button
                key={bt.type}
                onClick={(e) => { e.stopPropagation(); onAddSubBlock(bt.type); setShowAddMenu(false); }}
              >
                <span>{bt.icon}</span> {bt.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-block preview ────────────────────────────────────────────────────────

function SubBlockPreview({ sub }: { sub: SubBlock }) {
  const { data, block_type } = sub;
  switch (block_type) {
    case 'text': return <span>{String(data.md ?? data.text ?? '').slice(0, 40) || 'Empty text'}</span>;
    case 'heading': return <span style={{ fontWeight: 600 }}>{String(data.text ?? '').slice(0, 30) || 'Heading'}</span>;
    case 'callout': return <span>! {String(data.text ?? '').slice(0, 30) || 'Callout'}</span>;
    case 'quote': return <span>" {String(data.text ?? '').slice(0, 30) || 'Quote'}</span>;
    case 'image': return <span>🖼 {String(data.src ?? 'Image')}</span>;
    case 'video': return <span>▶ Video</span>;
    case 'divider': return <span>— Divider</span>;
    case 'spacer': return <span>↕ Spacer</span>;
    case 'code': return <span>{'</>'} Code</span>;
    case 'button': return <span>⊞ {String(data.text ?? 'Button')}</span>;
    case 'embed': return <span>□ Embed</span>;
    case 'html': return <span>{'<>'} HTML</span>;
    default: return <span>[{block_type}]</span>;
  }
}

// ── Block preview ────────────────────────────────────────────────────────────

function BlockPreview({ block }: { block: Block }) {
  const { data, block_type } = block;
  switch (block_type) {
    case 'text': return <p style={{ margin: 0, color: '#ccc', fontSize: '14px' }}>{String(data.md ?? data.text ?? '').slice(0, 100) || <em>Empty text block</em>}</p>;
    case 'heading': {
      const level = Number(data.level ?? 2);
      const text = String(data.text ?? '');
      return <div style={{ margin: 0, color: '#ddd', fontSize: `${Math.max(20 - level * 2, 12)}px`, fontWeight: 600 }}>{text || <em style={{ color: '#555' }}>Empty heading</em>}</div>;
    }
    case 'callout': return <div style={{ borderLeft: '3px solid #7c6fcd', paddingLeft: '8px', color: '#ccc', fontSize: '14px' }}>{String(data.text ?? '').slice(0, 80) || <em>Callout</em>}</div>;
    case 'quote': return <blockquote style={{ borderLeft: '3px solid #888', paddingLeft: '8px', fontStyle: 'italic', color: '#aaa', fontSize: '14px', margin: 0 }}>{String(data.text ?? '').slice(0, 80) || <em>Quote</em>}</blockquote>;
    case 'image': return <div style={{ color: '#888', fontSize: '13px' }}>🖼 {String(data.src ?? 'No src set')}</div>;
    case 'video': return <div style={{ color: '#888', fontSize: '13px' }}>▶ {String(data.src ?? 'No URL set')}</div>;
    case 'divider': return <hr style={{ border: 'none', borderTop: '1px solid #444', margin: '4px 0' }} />;
    case 'spacer': return <div style={{ color: '#888', fontSize: '13px' }}>↕ Spacer ({String(data.height ?? '2rem')})</div>;
    case 'embed': return <div style={{ color: '#888', fontSize: '13px' }}>□ {String(data.src ?? 'No src set')}</div>;
    case 'toc': return <div style={{ color: '#888', fontSize: '13px' }}>≡ Table of Contents</div>;
    case 'wiki-embed': return <div style={{ color: '#888', fontSize: '13px' }}>⊂ Wiki: {String(data.slug ?? data.wiki_id ?? '?')}</div>;
    case 'experiment-embed': return <div style={{ color: '#888', fontSize: '13px' }}>⊗ Exp: {String(data.exp_id ?? '?')}</div>;
    case 'code': return <pre style={{ margin: 0, background: '#1a1a2e', color: '#a8ff78', fontSize: '12px', padding: '6px 8px', borderRadius: '4px', overflow: 'hidden', maxHeight: '60px' }}>{String(data.code ?? '').slice(0, 200) || <em style={{ color: '#555' }}>Empty code block</em>}</pre>;
    case 'button': return <div style={{ color: '#888', fontSize: '13px' }}>⊞ Button: "{String(data.text ?? 'Click here')}"</div>;
    case 'html': return <div style={{ color: '#888', fontSize: '13px' }}>{'<>'} HTML block ({String(data.html ?? '').length} chars)</div>;
    case 'content-feed': return <div style={{ color: '#888', fontSize: '13px' }}>▤ {String(data.content_type ?? 'wiki')} feed ({String(data.layout ?? 'grid')}, max {String(data.max_items ?? 6)})</div>;
    case 'operator-grid': return <div style={{ color: '#888', fontSize: '13px' }}>⊞ Operator Grid (3x3 with ALT cycling)</div>;
    default: return <div style={{ color: '#888' }}>[{block_type}]</div>;
  }
}

function BlockInspector({ block, onUpdate }: { block: Block | SubBlock; onUpdate: (data: Record<string, unknown>) => void }) {
  const [local, setLocal] = useState(block.data);

  useEffect(() => { setLocal(block.data); }, [block.block_id]);

  function set(key: string, value: unknown) {
    const updated = { ...local, [key]: value };
    setLocal(updated);
    onUpdate(updated);
  }

  return (
    <div className="inspector-form">
      <div className="inspector-type">{block.block_type}</div>
      {block.block_type === 'text' && (
        <label className="field">
          <span>Markdown</span>
          <textarea value={String(local.md ?? local.text ?? '')} onChange={(e) => set('md', e.target.value)} rows={8} />
        </label>
      )}
      {block.block_type === 'heading' && (
        <>
          <label className="field"><span>Text</span><input value={String(local.text ?? '')} onChange={(e) => set('text', e.target.value)} placeholder="Heading text" /></label>
          <label className="field">
            <span>Level</span>
            <select value={String(local.level ?? '2')} onChange={(e) => set('level', Number(e.target.value))}>
              {[1, 2, 3, 4, 5, 6].map((l) => <option key={l} value={l}>H{l}</option>)}
            </select>
          </label>
        </>
      )}
      {block.block_type === 'callout' && (
        <>
          <label className="field"><span>Text</span><textarea value={String(local.text ?? '')} onChange={(e) => set('text', e.target.value)} rows={4} /></label>
          <label className="field">
            <span>Kind</span>
            <select value={String(local.kind ?? 'info')} onChange={(e) => set('kind', e.target.value)}>
              {['info', 'warn', 'danger', 'tip'].map((k) => <option key={k}>{k}</option>)}
            </select>
          </label>
        </>
      )}
      {block.block_type === 'quote' && (
        <>
          <label className="field"><span>Text</span><textarea value={String(local.text ?? '')} onChange={(e) => set('text', e.target.value)} rows={4} /></label>
          <label className="field"><span>Attribution</span><input value={String(local.attribution ?? '')} onChange={(e) => set('attribution', e.target.value)} /></label>
        </>
      )}
      {block.block_type === 'image' && (
        <>
          <label className="field"><span>URL</span><input value={String(local.src ?? '')} onChange={(e) => set('src', e.target.value)} /></label>
          <label className="field"><span>Alt text</span><input value={String(local.alt ?? '')} onChange={(e) => set('alt', e.target.value)} /></label>
          <label className="field"><span>Caption</span><input value={String(local.caption ?? '')} onChange={(e) => set('caption', e.target.value)} /></label>
        </>
      )}
      {block.block_type === 'video' && (
        <>
          <label className="field"><span>Video URL</span><input value={String(local.src ?? '')} onChange={(e) => set('src', e.target.value)} placeholder="YouTube, Vimeo, or direct URL" /></label>
          <label className="field"><span>Caption</span><input value={String(local.caption ?? '')} onChange={(e) => set('caption', e.target.value)} /></label>
        </>
      )}
      {block.block_type === 'embed' && (
        <>
          <label className="field"><span>URL</span><input value={String(local.src ?? '')} onChange={(e) => set('src', e.target.value)} /></label>
          <label className="field"><span>Title</span><input value={String(local.title ?? '')} onChange={(e) => set('title', e.target.value)} /></label>
        </>
      )}
      {block.block_type === 'button' && (
        <>
          <label className="field"><span>Text</span><input value={String(local.text ?? '')} onChange={(e) => set('text', e.target.value)} placeholder="Click here" /></label>
          <label className="field"><span>URL</span><input value={String(local.url ?? '')} onChange={(e) => set('url', e.target.value)} placeholder="https://..." /></label>
          <label className="field">
            <span>Style</span>
            <select value={String(local.style ?? 'primary')} onChange={(e) => set('style', e.target.value)}>
              {['primary', 'outline', 'edit'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </>
      )}
      {block.block_type === 'columns' && (
        <ColumnsInspector local={local} set={set} />
      )}
      {block.block_type === 'spacer' && (
        <label className="field">
          <span>Height</span>
          <select value={String(local.height ?? '2rem')} onChange={(e) => set('height', e.target.value)}>
            {['1rem', '2rem', '3rem', '4rem', '6rem', '8rem'].map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
        </label>
      )}
      {block.block_type === 'wiki-embed' && (
        <label className="field"><span>Wiki slug</span><input value={String(local.slug ?? local.wiki_id ?? '')} onChange={(e) => set('slug', e.target.value)} /></label>
      )}
      {block.block_type === 'experiment-embed' && (
        <label className="field"><span>Experiment ID</span><input value={String(local.exp_id ?? '')} onChange={(e) => set('exp_id', e.target.value)} /></label>
      )}
      {block.block_type === 'code' && (
        <>
          <label className="field">
            <span>Language</span>
            <input value={String(local.lang ?? '')} onChange={(e) => set('lang', e.target.value)} placeholder="js, python, bash, …" />
          </label>
          <label className="field">
            <span>Code</span>
            <textarea value={String(local.code ?? '')} onChange={(e) => set('code', e.target.value)} rows={10} style={{ fontFamily: 'monospace', fontSize: '13px' }} placeholder="Paste your code here…" />
          </label>
        </>
      )}
      {block.block_type === 'html' && (
        <label className="field">
          <span>HTML</span>
          <textarea value={String(local.html ?? '')} onChange={(e) => set('html', e.target.value)} rows={10} style={{ fontFamily: 'monospace', fontSize: '13px' }} placeholder="<div>Your HTML here</div>" />
        </label>
      )}
      {block.block_type === 'content-feed' && (
        <>
          <label className="field">
            <span>Content type</span>
            <div className="custom-select-group">
              {['wiki', 'blog', 'experiment', 'page'].map((t) => (
                <button
                  key={t}
                  className={`custom-select-btn ${String(local.content_type ?? 'wiki') === t ? 'active' : ''}`}
                  onClick={() => set('content_type', t)}
                >{t}</button>
              ))}
            </div>
          </label>
          <label className="field">
            <span>Max items</span>
            <input type="number" min={1} max={20} value={String(local.max_items ?? 6)} onChange={(e) => set('max_items', Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Layout</span>
            <div className="custom-select-group">
              {['grid', 'list'].map((l) => (
                <button
                  key={l}
                  className={`custom-select-btn ${String(local.layout ?? 'grid') === l ? 'active' : ''}`}
                  onClick={() => set('layout', l)}
                >{l}</button>
              ))}
            </div>
          </label>
        </>
      )}
      {block.block_type === 'operator-grid' && (
        <div style={{ color: 'var(--text-dim)', fontSize: '.85rem', padding: '.5rem 0' }}>
          The 3x3 operator grid with ALT cycling is automatically configured. No settings needed.
        </div>
      )}
    </div>
  );
}

// ── Columns Inspector (layout controls only — content is managed in canvas) ──

const COLUMN_LAYOUTS: Array<{ label: string; value: string; cols: number }> = [
  { label: '2 equal', value: '1fr 1fr', cols: 2 },
  { label: '2 — wide left', value: '2fr 1fr', cols: 2 },
  { label: '2 — wide right', value: '1fr 2fr', cols: 2 },
  { label: '3 equal', value: '1fr 1fr 1fr', cols: 3 },
  { label: '3 — wide center', value: '1fr 2fr 1fr', cols: 3 },
  { label: '4 equal', value: '1fr 1fr 1fr 1fr', cols: 4 },
  { label: '5 equal', value: 'repeat(5, 1fr)', cols: 5 },
  { label: '6 equal', value: 'repeat(6, 1fr)', cols: 6 },
];

function ColumnsInspector({ local, set }: { local: Record<string, unknown>; set: (k: string, v: unknown) => void }) {
  const cols = migrateColumns(local);
  const layout = String(local.layout ?? '');

  function addCol() {
    if (cols.length >= 6) return;
    set('columns', [...cols, { blocks: [], block_order: [] }]);
  }

  function removeCol() {
    if (cols.length <= 2) return;
    set('columns', cols.slice(0, -1));
  }

  function applyLayout(preset: typeof COLUMN_LAYOUTS[number]) {
    const current = [...cols];
    while (current.length < preset.cols) current.push({ blocks: [], block_order: [] });
    while (current.length > preset.cols) current.pop();
    set('columns', current);
    set('layout', preset.value);
  }

  const totalBlocks = cols.reduce((sum, c) => sum + c.block_order.length, 0);

  return (
    <>
      <label className="field">
        <span>Layout preset</span>
        <select
          value={layout || `repeat(${cols.length}, 1fr)`}
          onChange={(e) => {
            const preset = COLUMN_LAYOUTS.find((l) => l.value === e.target.value);
            if (preset) applyLayout(preset);
          }}
        >
          {COLUMN_LAYOUTS.map((l) => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
        </select>
      </label>
      <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', marginBottom: '.5rem' }}>
        <span style={{ fontSize: '.82rem', color: '#888' }}>{cols.length} columns · {totalBlocks} blocks</span>
        <button className="btn btn-xs" onClick={addCol} disabled={cols.length >= 6}>+</button>
        <button className="btn btn-xs" onClick={removeCol} disabled={cols.length <= 2}>−</button>
      </div>
      {layout && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: layout,
          gap: '4px',
          marginBottom: '.5rem',
        }}>
          {cols.map((col, i) => (
            <div key={i} style={{
              height: '8px',
              background: 'var(--accent)',
              borderRadius: '2px',
              opacity: 0.5,
            }} />
          ))}
        </div>
      )}
      <div style={{ fontSize: '.82rem', color: '#888' }}>
        Add or edit blocks directly in the column zones above.
      </div>
    </>
  );
}

function defaultData(type: Block['block_type']): Record<string, unknown> {
  switch (type) {
    case 'text': return { md: '' };
    case 'heading': return { text: '', level: 2 };
    case 'callout': return { text: '', kind: 'info' };
    case 'quote': return { text: '', attribution: '' };
    case 'image': return { src: '', alt: '', caption: '' };
    case 'video': return { src: '', caption: '' };
    case 'embed': return { src: '', title: '' };
    case 'button': return { text: 'Click here', url: '', style: 'primary' };
    case 'columns': return { columns: [{ blocks: [], block_order: [] }, { blocks: [], block_order: [] }], layout: '1fr 1fr' };
    case 'spacer': return { height: '2rem' };
    case 'wiki-embed': return { slug: '', title: '' };
    case 'experiment-embed': return { exp_id: '' };
    case 'code': return { lang: '', code: '' };
    case 'html': return { html: '' };
    case 'content-feed': return { content_type: 'wiki', max_items: 6, layout: 'grid' };
    case 'operator-grid': return {};
    default: return {};
  }
}
