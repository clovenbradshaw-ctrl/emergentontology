/**
 * ContentManager — create new content entries and manage publish/draft status.
 *
 * Data flow:
 *   Load  →  GET /eowikicurrent where record_id = "site:index" → content list
 *            Fall back to static /generated/state/index.json if no Xano record.
 *   Create → POST /eowiki (INS index event)
 *            UPSERT /eowikicurrent record_id="site:index" with updated list
 *            POST /eowikicurrent record_id=<contentId> (empty initial state)
 *   Toggle → POST /eowiki (DES status/visibility event)
 *            PATCH /eowikicurrent record_id="site:index" with updated status/visibility
 */

import React, { useEffect, useState, useRef } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useSettings } from '../settings/SettingsContext';
import { useXRay } from '../components/XRayOverlay';
import {
  addRecord,
  upsertCurrentRecord,
  eventToPayload,
  type XanoCurrentRecord,
} from '../xano/client';
import { loadState, fetchCurrentRecordCached } from '../xano/stateCache';
import { insIndexEntry, desContentMeta, desIndexEntry } from '../eo/events';
import type { ContentType, ContentStatus, Visibility } from '../eo/types';

interface IndexEntry {
  content_id: string;
  slug: string;
  title: string;
  content_type: ContentType;
  status: ContentStatus;
  visibility: Visibility;
  tags: string[];
  /** ISO timestamp when this content was first DES'd as public */
  first_public_at?: string;
  /** Whether this page appears in site navigation (pages only) */
  show_in_nav?: boolean;
  /** Parent page content_id for nesting (pages only) */
  parent_page?: string;
}

/** Build a full site:index payload with derived nav and slug_map. */
function buildIndexPayload(entries: IndexEntry[]) {
  const nav = entries.filter(e => e.status === 'published' && e.visibility === 'public');
  const slug_map = Object.fromEntries(entries.map(e => [e.slug, e.content_id]));
  return { entries, nav, slug_map, built_at: new Date().toISOString() };
}

interface Props {
  siteBase: string;
  onOpen: (contentId: string, type: ContentType) => void;
}

const TYPE_LABELS: Partial<Record<ContentType, string>> = {
  page: 'Page',
  wiki: 'Wiki Page',
  blog: 'Blog Post',
  experiment: 'Experiment',
};

export default function ContentManager({ siteBase, onOpen }: Props) {
  const { isAuthenticated } = useAuth();
  const { settings } = useSettings();
  const { registerEvent } = useXRay();

  const [entries, setEntries] = useState<IndexEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const indexRecordRef = useRef<XanoCurrentRecord | null>(null);

  const [newType, setNewType] = useState<ContentType>('wiki');
  const [newSlug, setNewSlug] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newVisibility, setNewVisibility] = useState<Visibility>(settings.defaultVisibility);

  // ── Load index ─────────────────────────────────────────────────────────────

  useEffect(() => {
    async function load() {
      setLoading(true);

      // Unified load: current state (cached) → static fallback
      const result = await loadState<{ entries: IndexEntry[] }>(
        'site:index',
        siteBase,
        '/generated/state/index.json',
      );

      if (result.record) indexRecordRef.current = result.record;
      if (result.state) setEntries(result.state.entries ?? []);
      setLoading(false);
    }

    load();
  }, [siteBase]);

  // ── Create content ─────────────────────────────────────────────────────────

  async function create() {
    if (!isAuthenticated || !newSlug.trim() || !newTitle.trim()) return;
    setCreating(true);
    setError(null);

    const contentId = `${newType}:${newSlug.trim()}`;
    const agent = settings.displayName || 'editor';
    const ts = new Date().toISOString();

    try {
      // 1. Emit INS index event to eowiki log
      const insEvent = insIndexEntry(contentId, {
        slug: newSlug.trim(),
        title: newTitle.trim(),
        content_type: newType,
        status: settings.defaultStatus,
        visibility: newVisibility,
        tags: [],
      }, agent);
      const xid = `ins-index-${contentId}`;
      registerEvent({ id: xid, op: insEvent.op, target: insEvent.target, operand: insEvent.operand, ts: insEvent.ctx.ts, agent: insEvent.ctx.agent, status: 'pending' });
      await addRecord(eventToPayload(insEvent));
      registerEvent({ id: xid, op: insEvent.op, target: insEvent.target, operand: insEvent.operand, ts: insEvent.ctx.ts, agent: insEvent.ctx.agent, status: 'sent' });

      // 2. Emit DES content meta event
      const desEvent = desContentMeta(contentId, {
        content_id: contentId,
        content_type: newType,
        slug: newSlug.trim(),
        title: newTitle.trim(),
        status: settings.defaultStatus,
        visibility: newVisibility,
        tags: [],
        updated_at: ts,
      }, agent);
      await addRecord(eventToPayload(desEvent));

      // 3. Update site:index current state
      const newEntry: IndexEntry = {
        content_id: contentId,
        slug: newSlug.trim(),
        title: newTitle.trim(),
        content_type: newType,
        status: settings.defaultStatus,
        visibility: newVisibility,
        tags: [],
        ...(newVisibility === 'public' ? { first_public_at: ts } : {}),
      };
      const updatedEntries = [...entries, newEntry];
      const updated = await upsertCurrentRecord(
        'site:index',
        buildIndexPayload(updatedEntries),
        agent,
        indexRecordRef.current,
      );
      indexRecordRef.current = updated;

      // 4. Create initial current state for the new content
      await upsertCurrentRecord(contentId, {
        meta: {
          content_id: contentId,
          content_type: newType,
          slug: newSlug.trim(),
          title: newTitle.trim(),
          status: settings.defaultStatus,
          visibility: newVisibility,
          tags: [],
          updated_at: ts,
        },
        current_revision: null,
        revisions: [],
        blocks: [],
        block_order: [],
        entries: [],
      }, agent, null);

      setEntries(updatedEntries);
      setNewSlug('');
      setNewTitle('');
      onOpen(contentId, newType);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  // ── Toggle publish ─────────────────────────────────────────────────────────

  async function togglePublish(contentId: string, currentStatus: ContentStatus) {
    if (!isAuthenticated) return;
    const newStatus: ContentStatus = currentStatus === 'published' ? 'draft' : 'published';
    const agent = settings.displayName || 'editor';

    try {
      // 1. Emit DES index event
      const desEvent = desIndexEntry(contentId, { status: newStatus }, agent);
      const xid = `des-status-${contentId}`;
      registerEvent({ id: xid, op: desEvent.op, target: desEvent.target, operand: desEvent.operand, ts: desEvent.ctx.ts, agent: desEvent.ctx.agent, status: 'pending' });
      await addRecord(eventToPayload(desEvent));
      registerEvent({ id: xid, op: desEvent.op, target: desEvent.target, operand: desEvent.operand, ts: desEvent.ctx.ts, agent: desEvent.ctx.agent, status: 'sent' });

      // 2. Update site:index current state
      const updatedEntries = entries.map((e) => e.content_id === contentId ? { ...e, status: newStatus } : e);
      const updated = await upsertCurrentRecord(
        'site:index',
        buildIndexPayload(updatedEntries),
        agent,
        indexRecordRef.current,
      );
      indexRecordRef.current = updated;
      setEntries(updatedEntries);

      // 3. Also update content's own meta with new status
      const metaEvent = desContentMeta(contentId, {
        status: newStatus,
        updated_at: desEvent.ctx.ts,
      } as Partial<import('../eo/types').ContentMeta>, agent);
      await addRecord(eventToPayload(metaEvent));
      try {
        const contentRec = await fetchCurrentRecordCached(contentId);
        if (contentRec) {
          const contentState = JSON.parse(contentRec.values);
          contentState.meta = { ...contentState.meta, status: newStatus, updated_at: desEvent.ctx.ts };
          await upsertCurrentRecord(contentId, contentState, agent, contentRec);
        }
      } catch { /* best-effort update */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // ── Toggle visibility ──────────────────────────────────────────────────────

  async function toggleVisibility(contentId: string, currentVisibility: Visibility) {
    if (!isAuthenticated) return;
    const newVisibility: Visibility = currentVisibility === 'public' ? 'private' : 'public';
    const agent = settings.displayName || 'editor';

    try {
      // 1. Emit DES index event
      const desEvent = desIndexEntry(contentId, { visibility: newVisibility }, agent);
      const xid = `des-visibility-${contentId}`;
      registerEvent({ id: xid, op: desEvent.op, target: desEvent.target, operand: desEvent.operand, ts: desEvent.ctx.ts, agent: desEvent.ctx.agent, status: 'pending' });
      await addRecord(eventToPayload(desEvent));
      registerEvent({ id: xid, op: desEvent.op, target: desEvent.target, operand: desEvent.operand, ts: desEvent.ctx.ts, agent: desEvent.ctx.agent, status: 'sent' });

      // 2. Update site:index current state — track first_public_at on initial DES as public
      const entry = entries.find((e) => e.content_id === contentId);
      const isFirstPublic = newVisibility === 'public' && entry && !entry.first_public_at;
      const firstPublicTs = isFirstPublic ? desEvent.ctx.ts : undefined;

      const updatedEntries = entries.map((e) => {
        if (e.content_id !== contentId) return e;
        const patch: Partial<IndexEntry> = { visibility: newVisibility };
        if (firstPublicTs) patch.first_public_at = firstPublicTs;
        return { ...e, ...patch };
      });
      const updated = await upsertCurrentRecord(
        'site:index',
        buildIndexPayload(updatedEntries),
        agent,
        indexRecordRef.current,
      );
      indexRecordRef.current = updated;
      setEntries(updatedEntries);

      // 3. Also update content's own meta with first_public_at so editors can see it
      if (firstPublicTs) {
        const metaEvent = desContentMeta(contentId, {
          visibility: newVisibility,
          first_public_at: firstPublicTs,
          updated_at: desEvent.ctx.ts,
        } as Partial<import('../eo/types').ContentMeta>, agent);
        await addRecord(eventToPayload(metaEvent));
        try {
          const contentRec = await fetchCurrentRecordCached(contentId);
          if (contentRec) {
            const contentState = JSON.parse(contentRec.values);
            contentState.meta = { ...contentState.meta, visibility: newVisibility, first_public_at: firstPublicTs };
            await upsertCurrentRecord(contentId, contentState, agent, contentRec);
          }
        } catch { /* best-effort update */ }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // ── Toggle show_in_nav (pages only) ──────────────────────────────────────

  async function toggleNavVisibility(contentId: string, current: boolean) {
    if (!isAuthenticated) return;
    const agent = settings.displayName || 'editor';
    try {
      const updatedEntries = entries.map((e) =>
        e.content_id === contentId ? { ...e, show_in_nav: !current } : e
      );
      const updated = await upsertCurrentRecord(
        'site:index',
        buildIndexPayload(updatedEntries),
        agent,
        indexRecordRef.current,
      );
      indexRecordRef.current = updated;
      setEntries(updatedEntries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // ── Set parent page ─────────────────────────────────────────────────────

  async function setParentPage(contentId: string, parentId: string) {
    if (!isAuthenticated) return;
    const agent = settings.displayName || 'editor';
    try {
      const updatedEntries = entries.map((e) =>
        e.content_id === contentId ? { ...e, parent_page: parentId || undefined } : e
      );
      const updated = await upsertCurrentRecord(
        'site:index',
        buildIndexPayload(updatedEntries),
        agent,
        indexRecordRef.current,
      );
      indexRecordRef.current = updated;
      setEntries(updatedEntries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const pageEntries = entries.filter(e => e.content_type === 'page');

  if (loading) return <div className="editor-loading">Loading content list…</div>;

  return (
    <div className="content-manager">
      {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>×</button></div>}

      {/* Create new content */}
      <section className="create-section">
        <h2>New Content</h2>
        <div className="create-form">
          <select value={newType} onChange={(e) => setNewType(e.target.value as ContentType)}>
            {(Object.entries(TYPE_LABELS) as Array<[string, string]>).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input value={newSlug} onChange={(e) => setNewSlug(e.target.value.toLowerCase().replace(/\s+/g, '-'))} placeholder="slug (e.g. getting-started)" />
          <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Title" />
          <select value={newVisibility} onChange={(e) => setNewVisibility(e.target.value as Visibility)}>
            <option value="public">Public</option>
            <option value="private">Private (login required)</option>
          </select>
          <button
            className="btn btn-primary"
            onClick={create}
            disabled={creating || !isAuthenticated || !newSlug || !newTitle}
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </section>

      {/* Content list */}
      <section className="content-list-section">
        <h2>All Content ({entries.length})</h2>
        {entries.length === 0
          ? <p className="empty-msg">No content yet. Create something above.</p>
          : (
            <table className="content-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Title</th>
                  <th>Slug</th>
                  <th>Status</th>
                  <th>Visibility</th>
                  <th>Nav</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.content_id}>
                    <td><span className={`type-badge type-${entry.content_type}`}>{entry.content_type}</span></td>
                    <td>
                      {entry.parent_page && <span style={{ color: 'var(--text-dim)', fontSize: '.75rem', marginRight: '.3rem' }}>↳</span>}
                      {entry.title}
                    </td>
                    <td className="slug-cell">{entry.slug}</td>
                    <td>
                      <button
                        className={`status-toggle status-${entry.status}`}
                        onClick={() => togglePublish(entry.content_id, entry.status)}
                        disabled={!isAuthenticated}
                        title="Toggle draft/published"
                      >
                        {entry.status}
                      </button>
                    </td>
                    <td>
                      <button
                        className={`visibility-toggle vis-${entry.visibility}`}
                        onClick={() => toggleVisibility(entry.content_id, entry.visibility)}
                        disabled={!isAuthenticated}
                        title="Toggle public/private"
                      >
                        {entry.visibility}
                      </button>
                    </td>
                    <td>
                      {entry.content_type === 'page' ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                          <button
                            className={`status-toggle ${entry.show_in_nav ? 'status-published' : 'status-draft'}`}
                            onClick={() => toggleNavVisibility(entry.content_id, !!entry.show_in_nav)}
                            disabled={!isAuthenticated}
                            title="Toggle show in navigation"
                            style={{ fontSize: '.75rem' }}
                          >
                            {entry.show_in_nav ? 'in nav' : 'hidden'}
                          </button>
                          <select
                            value={entry.parent_page ?? ''}
                            onChange={(e) => setParentPage(entry.content_id, e.target.value)}
                            disabled={!isAuthenticated}
                            style={{ fontSize: '.72rem', padding: '1px 2px', background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '3px' }}
                            title="Parent page"
                          >
                            <option value="">(top level)</option>
                            {pageEntries
                              .filter(p => p.content_id !== entry.content_id)
                              .map(p => <option key={p.content_id} value={p.content_id}>{p.title}</option>)
                            }
                          </select>
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-dim)', fontSize: '.8rem' }}>—</span>
                      )}
                    </td>
                    <td>
                      <button className="btn btn-sm" onClick={() => onOpen(entry.content_id, entry.content_type)}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </section>
    </div>
  );
}
