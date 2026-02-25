/**
 * PageBuilder — drag/drop block-based page editor.
 *
 * Data flow:
 *   Load  →  GET /eowikicurrent (record_id = contentId) → current page state
 *            Fall back to static snapshot if no Xano record.
 *   Ops   →  POST /eowiki (append event)
 *            PATCH /eowikicurrent (update current state snapshot)
 */

import React, { useEffect, useRef, useState } from 'react';
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
import {
  fetchCurrentRecord,
  addRecord,
  upsertCurrentRecord,
  eventToPayload,
  type XanoCurrentRecord,
} from '../xano/client';
import { insBlock, altBlock, nulBlock } from '../eo/events';
import type { Block } from '../eo/types';

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
  { type: 'code', label: 'Code Block', icon: '</>' },
];

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
  const { registerEvent } = useXRay();

  const [state, setState] = useState<PageState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
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
          pageState = JSON.parse(rec.value) as PageState;
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

      const updated = await upsertCurrentRecord(contentId, event.op, updatedState, event.ctx.agent, currentRecordRef.current);
      currentRecordRef.current = updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'error', error: msg });
      setError(msg);
    }
  }

  // ── Add block ─────────────────────────────────────────────────────────────

  function addBlock(type: Block['block_type']) {
    if (!state || !isAuthenticated) return;
    const blockId = `b_${Date.now()}`;
    const lastId = state.block_order.at(-1) ?? null;
    const newBlock: Block = { block_id: blockId, block_type: type, data: defaultData(type), after: lastId, deleted: false };
    const event = insBlock(contentId, newBlock, 'editor');

    const updatedState: PageState = {
      ...state,
      blocks: [...state.blocks, newBlock],
      block_order: [...state.block_order, blockId],
    };
    setState(updatedState);
    emit(event, updatedState);
    setSelectedBlockId(blockId);
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
    const event = altBlock(contentId, blockId, patch, 'editor');
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
    const event = nulBlock(contentId, blockId, 'editor');
    emit(event, updatedState);
    if (selectedBlockId === blockId) setSelectedBlockId(null);
  }

  // ── Reorder (drag/drop) ───────────────────────────────────────────────────

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || !state || !isAuthenticated) return;

    const oldIndex = state.block_order.indexOf(String(active.id));
    const newIndex = state.block_order.indexOf(String(over.id));
    const newOrder = arrayMove(state.block_order, oldIndex, newIndex);

    const movedIdx = newOrder.indexOf(String(active.id));
    const newAfter = movedIdx === 0 ? null : newOrder[movedIdx - 1];

    const updatedState: PageState = {
      ...state,
      blocks: state.blocks.map((b) => b.block_id === String(active.id) ? { ...b, after: newAfter } : b),
      block_order: newOrder,
    };
    setState(updatedState);
    const altEvent = altBlock(contentId, String(active.id), [], 'editor', newAfter);
    emit(altEvent, updatedState);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return <div className="editor-loading">Loading page builder…</div>;
  if (!state) return <div className="editor-empty">Create this page first from the content list.</div>;

  const selectedBlock = state.blocks.find((b) => b.block_id === selectedBlockId);

  return (
    <div className="page-builder">
      {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>×</button></div>}

      <div className="builder-layout">
        <aside className="block-palette">
          <div className="palette-title">Blocks</div>
          {BLOCK_TYPES.map((bt) => (
            <button key={bt.type} className="palette-btn" onClick={() => addBlock(bt.type)}>
              <span className="palette-icon">{bt.icon}</span>
              <span>{bt.label}</span>
            </button>
          ))}
        </aside>

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
    case 'code': return <pre style={{ margin: 0, background: '#1a1a2e', color: '#a8ff78', fontSize: '12px', padding: '6px 8px', borderRadius: '4px', overflow: 'hidden', maxHeight: '60px' }}>{String(data.code ?? '').slice(0, 200) || <em style={{ color: '#555' }}>Empty code block</em>}</pre>;
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
    case 'code': return { lang: '', code: '' };
    default: return {};
  }
}
