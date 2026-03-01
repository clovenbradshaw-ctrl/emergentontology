/**
 * MetadataBar — shared metadata panel for all editors.
 * Displays and allows editing of: title, tags, status, visibility.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useSettings } from '../settings/SettingsContext';
import { useXRay } from './XRayOverlay';
import {
  addRecord,
  upsertCurrentRecord,
  eventToPayload,
  type XanoCurrentRecord,
} from '../xano/client';
import { fetchCurrentRecordCached } from '../xano/stateCache';
import { desIndexEntry, desContentMeta } from '../eo/events';
import type { ContentStatus, Visibility } from '../eo/types';

interface IndexEntry {
  content_id: string;
  slug: string;
  title: string;
  content_type: string;
  status: ContentStatus;
  visibility: Visibility;
  tags: string[];
  pinned?: boolean;
}

interface Props {
  contentId: string;
  onTitleChange?: (newTitle: string) => void;
}

export default function MetadataBar({ contentId, onTitleChange }: Props) {
  const { isAuthenticated } = useAuth();
  const { settings } = useSettings();
  const { registerEvent } = useXRay();

  const [entry, setEntry] = useState<IndexEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState('');
  const [editingSlug, setEditingSlug] = useState(false);
  const [slugValue, setSlugValue] = useState('');
  const [slugError, setSlugError] = useState('');
  const [tagInput, setTagInput] = useState('');
  const indexRecordRef = useRef<XanoCurrentRecord | null>(null);
  const allEntriesRef = useRef<IndexEntry[]>([]);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const rec = await fetchCurrentRecordCached('site:index');
        if (rec) {
          indexRecordRef.current = rec;
          const parsed = JSON.parse(rec.values) as { entries: IndexEntry[] };
          allEntriesRef.current = parsed.entries ?? [];
          const found = allEntriesRef.current.find(e => e.content_id === contentId);
          if (found) {
            setEntry(found);
            setTitleValue(found.title);
          }
        }
      } catch { /* index not available */ }
      setLoading(false);
    }
    load();
  }, [contentId]);

  async function updateField(fields: Partial<{ slug: string; title: string; tags: string[]; status: string; visibility: string; pinned: boolean }>) {
    if (!isAuthenticated || !entry) return;
    const agent = settings.displayName || 'editor';

    try {
      const desEvent = desIndexEntry(contentId, fields, agent);
      const xid = `des-meta-${contentId}-${Date.now()}`;
      registerEvent({ id: xid, op: desEvent.op, target: desEvent.target, operand: desEvent.operand, ts: desEvent.ctx.ts, agent: desEvent.ctx.agent, status: 'pending' });
      await addRecord(eventToPayload(desEvent));
      registerEvent({ id: xid, op: desEvent.op, target: desEvent.target, operand: desEvent.operand, ts: desEvent.ctx.ts, agent: desEvent.ctx.agent, status: 'sent' });

      const updatedEntry = { ...entry, ...fields } as IndexEntry;
      setEntry(updatedEntry);
      allEntriesRef.current = allEntriesRef.current.map(e =>
        e.content_id === contentId ? updatedEntry : e
      );

      function buildPayload(entries: IndexEntry[]) {
        const nav = entries.filter(e => e.status === 'published' && e.visibility === 'public');
        const slug_map = Object.fromEntries(entries.map(e => [e.slug, e.content_id]));
        return { entries, nav, slug_map, built_at: new Date().toISOString() };
      }

      const updated = await upsertCurrentRecord(
        'site:index',
        buildPayload(allEntriesRef.current),
        agent,
        indexRecordRef.current,
      );
      indexRecordRef.current = updated;

      // Best-effort update content's own meta
      const metaEvent = desContentMeta(contentId, {
        ...fields,
        updated_at: desEvent.ctx.ts,
      } as any, agent);
      await addRecord(eventToPayload(metaEvent));
      try {
        const contentRec = await fetchCurrentRecordCached(contentId);
        if (contentRec) {
          const contentState = JSON.parse(contentRec.values);
          contentState.meta = { ...contentState.meta, ...fields, updated_at: desEvent.ctx.ts };
          await upsertCurrentRecord(contentId, contentState, agent, contentRec);
        }
      } catch { /* best-effort */ }

      if (fields.title && onTitleChange) onTitleChange(fields.title);
    } catch (err) {
      console.error('[MetadataBar] Failed to update:', err);
    }
  }

  function saveTitle() {
    const trimmed = titleValue.trim();
    if (trimmed && trimmed !== entry?.title) {
      updateField({ title: trimmed });
    }
    setEditingTitle(false);
  }

  function saveSlug() {
    const normalized = slugValue.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '').replace(/^-|-$/g, '');
    if (!normalized) {
      setSlugError('Slug cannot be empty');
      return;
    }
    // Check for duplicate slugs
    const duplicate = allEntriesRef.current.find(e => e.slug === normalized && e.content_id !== contentId);
    if (duplicate) {
      setSlugError(`Slug "${normalized}" is already used by ${duplicate.content_id}`);
      return;
    }
    if (normalized !== entry?.slug) {
      updateField({ slug: normalized });
    }
    setSlugError('');
    setEditingSlug(false);
  }

  function addTag() {
    const tag = tagInput.trim().toLowerCase();
    if (!tag || !entry) return;
    if (entry.tags.includes(tag)) { setTagInput(''); return; }
    updateField({ tags: [...entry.tags, tag] });
    setTagInput('');
  }

  function removeTag(tag: string) {
    if (!entry) return;
    updateField({ tags: entry.tags.filter(t => t !== tag) });
  }

  if (loading || !entry) return null;

  return (
    <div className="metadata-bar">
      <div className="metadata-bar-main">
        <div className="metadata-title-row">
          {editingTitle ? (
            <input
              className="metadata-title-input"
              value={titleValue}
              onChange={(e) => setTitleValue(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveTitle();
                if (e.key === 'Escape') { setTitleValue(entry.title); setEditingTitle(false); }
              }}
              autoFocus
            />
          ) : (
            <h2
              className="metadata-title"
              onClick={() => { setEditingTitle(true); setTitleValue(entry.title); }}
              title="Click to edit title"
            >
              {entry.title}
            </h2>
          )}
          <span className="metadata-content-id">{contentId}</span>
        </div>

        <div className="metadata-quick-actions">
          <button
            className={`status-toggle status-${entry.status}`}
            onClick={() => updateField({ status: entry.status === 'published' ? 'draft' : 'published' })}
            disabled={!isAuthenticated}
          >
            {entry.status}
          </button>
          <button
            className={`visibility-toggle vis-${entry.visibility}`}
            onClick={() => updateField({ visibility: entry.visibility === 'public' ? 'private' : 'public' })}
            disabled={!isAuthenticated}
          >
            {entry.visibility}
          </button>
          <button
            className={`pin-toggle ${entry.pinned ? 'pinned' : ''}`}
            onClick={() => updateField({ pinned: !entry.pinned })}
            disabled={!isAuthenticated}
            title={entry.pinned ? 'Unpin from top of list' : 'Pin to top of list'}
          >
            {entry.pinned ? '\uD83D\uDCCC pinned' : 'pin'}
          </button>
          <button
            className="metadata-details-toggle"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Hide details' : 'Details'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="metadata-details">
          <div className="metadata-field">
            <label>Slug</label>
            {editingSlug ? (
              <div className="metadata-slug-edit">
                <input
                  className="metadata-slug-input"
                  value={slugValue}
                  onChange={(e) => {
                    setSlugValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, ''));
                    setSlugError('');
                  }}
                  onBlur={saveSlug}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveSlug();
                    if (e.key === 'Escape') { setSlugValue(entry.slug); setSlugError(''); setEditingSlug(false); }
                  }}
                  autoFocus
                />
                {slugError && <span className="metadata-slug-error">{slugError}</span>}
              </div>
            ) : (
              <code
                className="metadata-slug editable"
                onClick={() => { setEditingSlug(true); setSlugValue(entry.slug); setSlugError(''); }}
                title="Click to edit slug"
              >
                {entry.slug}
              </code>
            )}
          </div>
          <div className="metadata-field">
            <label>Tags</label>
            <div className="inline-tags">
              {entry.tags.map((tag) => (
                <span key={tag} className="tag-pill">
                  {tag}
                  <button
                    className="tag-remove"
                    onClick={() => removeTag(tag)}
                    disabled={!isAuthenticated}
                  >{'\u00D7'}</button>
                </span>
              ))}
              <input
                className="tag-add-input"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); }
                }}
                onBlur={() => { if (tagInput.trim()) addTag(); }}
                placeholder="add tag\u2026"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
