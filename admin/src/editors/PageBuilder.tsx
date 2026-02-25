/**
 * PageBuilder — drag/drop block-based page editor.
 *
 * Uses @dnd-kit for sortable blocks.
 * Every edit emits eo.op events immediately (append-only).
 * Reorder → emits ALT to update each block's `after` pointer.
 */

import React, { useEffect, useState } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
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
import { useXRay } from '../components/XRayOverlay';
import { fetchRoomDelta, sendEOEvent, resolveAlias } from '../matrix/client';
import { insBlock, altBlock, nulBlock } from '../eo/events';
import { applyDelta } from '../eo/replay';
import type { ProjectedPage, Block } from '../eo/types';

const BLOCK_TYPES: Array<{ type: Block['block_type']; label: string; icon: string }> = [
  { type: 'text', label: 'Text', icon: '¶' },
  { type: 'callout', label: 'Callout', icon: '!' },
  { type: 'quote', label: 'Quote', icon: '"' },
  { type: 'image', label: 'Image', icon: '🖼' },
  { type: 'divider', label: 'Divider', icon: '—' },
  { type: 'embed', label: 'Embed', icon: '□' },
  { type: 'toc', label: 'TOC', icon: '≡' },
  { type: 'wiki-embed', label: 'Wiki Embed', icon: '⊂' },
  { type: 'experiment-embed', label: 'Exp Embed', icon: '⊗' },
];

interface Props {
  contentId: string;  // e.g. "page:about"
  siteBase: string;
}

export default function PageBuilder({ contentId, siteBase }: Props) {
  const { creds } = useAuth();
  const { registerEvent } = useXRay();

  const [state, setState] = useState<ProjectedPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // ── Load snapshot + delta ──────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const fileName = contentId.replace(':', '-') + '.json';
      let snapshot: ProjectedPage | null = null;

      try {
        const resp = await fetch(`${siteBase}/generated/state/content/${fileName}`);
        if (resp.ok) snapshot = await resp.json() as ProjectedPage;
      } catch { /* no snapshot */ }

      if (!cancelled && creds && snapshot) {
        try {
          const serverName = new URL(creds.homeserver).hostname;
          const rid = await resolveAlias(creds.homeserver, `#${contentId}:${serverName}`);
          setRoomId(rid);
          const { events } = await fetchRoomDelta(creds.homeserver, rid, undefined, creds.access_token);
          if (events.length > 0) {
            snapshot = applyDelta(snapshot, events as Parameters<typeof applyDelta>[1]) as ProjectedPage;
          }
        } catch { /* delta failed, use snapshot */ }
      }

      if (!cancelled) {
        setState(snapshot);
        setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [contentId, creds, siteBase]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function emit(event: ReturnType<typeof insBlock>, txn?: string) {
    if (!creds || !roomId) return;
    const xid = `${event.op}-${Date.now()}`;
    registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'pending' });
    try {
      await sendEOEvent(creds, roomId, event as unknown as Record<string, unknown>, txn);
      registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'sent' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'error', error: msg });
      setError(msg);
    }
  }

  // ── Add block ──────────────────────────────────────────────────────────────

  function addBlock(type: Block['block_type']) {
    if (!state || !creds) return;
    const blockId = `b_${Date.now()}`;
    const lastId = state.block_order.at(-1) ?? null;
    const newBlock: Block = { block_id: blockId, block_type: type, data: defaultData(type), after: lastId, deleted: false };
    const event = insBlock(contentId, newBlock, creds.user_id);

    setState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        blocks: [...prev.blocks, newBlock],
        block_order: [...prev.block_order, blockId],
      };
    });
    emit(event);
    setSelectedBlockId(blockId);
  }

  // ── Update block ───────────────────────────────────────────────────────────

  function updateBlock(blockId: string, newData: Record<string, unknown>) {
    if (!state || !creds) return;
    setState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        blocks: prev.blocks.map((b) => b.block_id === blockId ? { ...b, data: newData } : b),
      };
    });
    const patch = Object.entries(newData).map(([k, v]) => ({ op: 'replace', path: `/data/${k}`, value: v }));
    const event = altBlock(contentId, blockId, patch, creds.user_id);
    emit(event);
  }

  // ── Delete block ───────────────────────────────────────────────────────────

  function deleteBlock(blockId: string) {
    if (!state || !creds) return;
    setState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        blocks: prev.blocks.map((b) => b.block_id === blockId ? { ...b, deleted: true } : b),
        block_order: prev.block_order.filter((id) => id !== blockId),
      };
    });
    const event = nulBlock(contentId, blockId, creds.user_id);
    emit(event);
    if (selectedBlockId === blockId) setSelectedBlockId(null);
  }

  // ── Reorder (drag/drop) ────────────────────────────────────────────────────

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || !state || !creds) return;

    const oldIndex = state.block_order.indexOf(String(active.id));
    const newIndex = state.block_order.indexOf(String(over.id));
    const newOrder = arrayMove(state.block_order, oldIndex, newIndex);

    // Recompute `after` pointers for the moved block
    const movedIdx = newOrder.indexOf(String(active.id));
    const newAfter = movedIdx === 0 ? null : newOrder[movedIdx - 1];

    setState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        blocks: prev.blocks.map((b) => b.block_id === String(active.id) ? { ...b, after: newAfter } : b),
        block_order: newOrder,
      };
    });

    // Emit ALT with updated `after`
    const altEvent = altBlock(contentId, String(active.id), [], creds.user_id, newAfter);
    emit(altEvent);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) return <div className="editor-loading">Loading page builder…</div>;
  if (!state) return <div className="editor-empty">Create this page first from the content list.</div>;

  const selectedBlock = state.blocks.find((b) => b.block_id === selectedBlockId);

  return (
    <div className="page-builder">
      {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>×</button></div>}

      <div className="builder-layout">
        {/* Block palette */}
        <aside className="block-palette">
          <div className="palette-title">Blocks</div>
          {BLOCK_TYPES.map((bt) => (
            <button key={bt.type} className="palette-btn" onClick={() => addBlock(bt.type)}>
              <span className="palette-icon">{bt.icon}</span>
              <span>{bt.label}</span>
            </button>
          ))}
        </aside>

        {/* Canvas */}
        <main className="builder-canvas">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={state.block_order} strategy={verticalListSortingStrategy}>
              {state.block_order.map((id) => {
                const block = state.blocks.find((b) => b.block_id === id);
                if (!block || block.deleted) return null;
                return (
                  <SortableBlock
                    key={id}
                    block={block}
                    selected={selectedBlockId === id}
                    onSelect={() => setSelectedBlockId(id)}
                    onDelete={() => deleteBlock(id)}
                    onUpdate={(data) => updateBlock(id, data)}
                  />
                );
              })}
            </SortableContext>
          </DndContext>
          {state.block_order.length === 0 && (
            <div className="canvas-empty">← Add a block from the palette</div>
          )}
        </main>

        {/* Properties inspector */}
        <aside className="block-inspector">
          <div className="inspector-title">Properties</div>
          {selectedBlock
            ? <BlockInspector block={selectedBlock} onUpdate={(data) => updateBlock(selectedBlock.block_id, data)} />
            : <div className="inspector-empty">Select a block to edit properties</div>
          }
        </aside>
      </div>
    </div>
  );
}

// ── Sortable block wrapper ────────────────────────────────────────────────────

function SortableBlock({ block, selected, onSelect, onDelete, onUpdate }: {
  block: Block;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onUpdate: (data: Record<string, unknown>) => void;
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
      <button className="block-delete" onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete block">×</button>
    </div>
  );
}

function BlockPreview({ block }: { block: Block }) {
  const { data, block_type } = block;
  switch (block_type) {
    case 'text': return <p style={{ margin: 0, color: '#ccc', fontSize: '14px' }}>{String(data.md ?? data.text ?? '').slice(0, 100) || <em>Empty text block</em>}</p>;
    case 'callout': return <div style={{ borderLeft: '3px solid #7c6fcd', paddingLeft: '8px', color: '#ccc', fontSize: '14px' }}>{String(data.text ?? '').slice(0, 80) || <em>Callout</em>}</div>;
    case 'quote': return <blockquote style={{ borderLeft: '3px solid #888', paddingLeft: '8px', fontStyle: 'italic', color: '#aaa', fontSize: '14px', margin: 0 }}>{String(data.text ?? '').slice(0, 80) || <em>Quote</em>}</blockquote>;
    case 'image': return <div style={{ color: '#888', fontSize: '13px' }}>🖼 {String(data.src ?? 'No src set')}</div>;
    case 'divider': return <hr style={{ border: 'none', borderTop: '1px solid #444', margin: '4px 0' }} />;
    case 'embed': return <div style={{ color: '#888', fontSize: '13px' }}>□ {String(data.src ?? 'No src set')}</div>;
    case 'toc': return <div style={{ color: '#888', fontSize: '13px' }}>≡ Table of Contents</div>;
    case 'wiki-embed': return <div style={{ color: '#888', fontSize: '13px' }}>⊂ Wiki: {String(data.slug ?? data.wiki_id ?? '?')}</div>;
    case 'experiment-embed': return <div style={{ color: '#888', fontSize: '13px' }}>⊗ Exp: {String(data.exp_id ?? '?')}</div>;
    default: return <div style={{ color: '#888' }}>[{block_type}]</div>;
  }
}

function BlockInspector({ block, onUpdate }: { block: Block; onUpdate: (data: Record<string, unknown>) => void }) {
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
      {block.block_type === 'embed' && (
        <>
          <label className="field"><span>URL</span><input value={String(local.src ?? '')} onChange={(e) => set('src', e.target.value)} /></label>
          <label className="field"><span>Title</span><input value={String(local.title ?? '')} onChange={(e) => set('title', e.target.value)} /></label>
        </>
      )}
      {block.block_type === 'wiki-embed' && (
        <label className="field"><span>Wiki slug</span><input value={String(local.slug ?? local.wiki_id ?? '')} onChange={(e) => set('slug', e.target.value)} /></label>
      )}
      {block.block_type === 'experiment-embed' && (
        <label className="field"><span>Experiment ID</span><input value={String(local.exp_id ?? '')} onChange={(e) => set('exp_id', e.target.value)} /></label>
      )}
    </div>
  );
}

function defaultData(type: Block['block_type']): Record<string, unknown> {
  switch (type) {
    case 'text': return { md: '' };
    case 'callout': return { text: '', kind: 'info' };
    case 'quote': return { text: '', attribution: '' };
    case 'image': return { src: '', alt: '', caption: '' };
    case 'embed': return { src: '', title: '' };
    case 'wiki-embed': return { slug: '', title: '' };
    case 'experiment-embed': return { exp_id: '' };
    default: return {};
  }
}
