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
import { insIndexEntry, desContentMeta, desIndexEntry, nulIndexEntry } from '../eo/events';
import type { ContentType, ContentStatus, Visibility } from '../eo/types';
import { SPECIAL_PAGES } from '../eo/constants';

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
function buildIndexPayload(entries: IndexEntry[], siteSettings?: Record<string, unknown>) {
  const nav = entries.filter(e => e.status === 'published' && e.visibility === 'public');
  const slug_map = Object.fromEntries(entries.map(e => [e.slug, e.content_id]));
  return { entries, nav, slug_map, built_at: new Date().toISOString(), ...(siteSettings ? { site_settings: siteSettings } : {}) };
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
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [newVisibility, setNewVisibility] = useState<Visibility>(settings.defaultVisibility);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);
  const [showArchive, setShowArchive] = useState(false);

  // Search, filter, sort (Issues 5 & 9)
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<ContentType | 'all'>('all');
  const [sortField, setSortField] = useState<'title' | 'type' | 'status' | 'slug'>('title');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Inline editing (Issues 3 & 4)
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [editTitleValue, setEditTitleValue] = useState('');
  const [editingTags, setEditingTags] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');

  // Special page creation (Issues 1 & 2)
  const [creatingSpecial, setCreatingSpecial] = useState<string | null>(null);

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

  // ── Archive (soft-delete) ─────────────────────────────────────────────────

  async function archiveContent(contentId: string) {
    if (!isAuthenticated) return;
    const agent = settings.displayName || 'editor';
    const ts = new Date().toISOString();

    try {
      // 1. Emit NUL index event to the event log
      const nulEvent = nulIndexEntry(contentId, agent);
      const xid = `nul-index-${contentId}`;
      registerEvent({ id: xid, op: nulEvent.op, target: nulEvent.target, operand: nulEvent.operand, ts: nulEvent.ctx.ts, agent: nulEvent.ctx.agent, status: 'pending' });
      await addRecord(eventToPayload(nulEvent));
      registerEvent({ id: xid, op: nulEvent.op, target: nulEvent.target, operand: nulEvent.operand, ts: nulEvent.ctx.ts, agent: nulEvent.ctx.agent, status: 'sent' });

      // 2. Emit DES event to set content meta status to 'archived'
      const metaEvent = desContentMeta(contentId, {
        status: 'archived' as ContentStatus,
        updated_at: ts,
      } as Partial<import('../eo/types').ContentMeta>, agent);
      await addRecord(eventToPayload(metaEvent));

      // 3. Update site:index current state
      const updatedEntries = entries.map((e) =>
        e.content_id === contentId ? { ...e, status: 'archived' as ContentStatus } : e
      );
      const updated = await upsertCurrentRecord(
        'site:index',
        buildIndexPayload(updatedEntries),
        agent,
        indexRecordRef.current,
      );
      indexRecordRef.current = updated;
      setEntries(updatedEntries);

      // 4. Update content's own current state
      try {
        const contentRec = await fetchCurrentRecordCached(contentId);
        if (contentRec) {
          const contentState = JSON.parse(contentRec.values);
          contentState.meta = { ...contentState.meta, status: 'archived', updated_at: ts };
          await upsertCurrentRecord(contentId, contentState, agent, contentRec);
        }
      } catch { /* best-effort update */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // ── Restore from archive ──────────────────────────────────────────────────

  async function restoreContent(contentId: string) {
    if (!isAuthenticated) return;
    const agent = settings.displayName || 'editor';
    const ts = new Date().toISOString();

    try {
      // 1. Emit DES index event to set status back to 'draft'
      const desEvent = desIndexEntry(contentId, { status: 'draft' }, agent);
      const xid = `des-restore-${contentId}`;
      registerEvent({ id: xid, op: desEvent.op, target: desEvent.target, operand: desEvent.operand, ts: desEvent.ctx.ts, agent: desEvent.ctx.agent, status: 'pending' });
      await addRecord(eventToPayload(desEvent));
      registerEvent({ id: xid, op: desEvent.op, target: desEvent.target, operand: desEvent.operand, ts: desEvent.ctx.ts, agent: desEvent.ctx.agent, status: 'sent' });

      // 2. Emit DES content meta event
      const metaEvent = desContentMeta(contentId, {
        status: 'draft' as ContentStatus,
        updated_at: ts,
      } as Partial<import('../eo/types').ContentMeta>, agent);
      await addRecord(eventToPayload(metaEvent));

      // 3. Update site:index current state
      const updatedEntries = entries.map((e) =>
        e.content_id === contentId ? { ...e, status: 'draft' as ContentStatus } : e
      );
      const updated = await upsertCurrentRecord(
        'site:index',
        buildIndexPayload(updatedEntries),
        agent,
        indexRecordRef.current,
      );
      indexRecordRef.current = updated;
      setEntries(updatedEntries);

      // 4. Update content's own current state
      try {
        const contentRec = await fetchCurrentRecordCached(contentId);
        if (contentRec) {
          const contentState = JSON.parse(contentRec.values);
          contentState.meta = { ...contentState.meta, status: 'draft', updated_at: ts };
          await upsertCurrentRecord(contentId, contentState, agent, contentRec);
        }
      } catch { /* best-effort update */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // ── Update index entry fields (shared utility for title, tags, etc.) ─────

  async function updateIndexField(contentId: string, fields: Partial<{ title: string; tags: string[] }>) {
    if (!isAuthenticated) return;
    const agent = settings.displayName || 'editor';

    try {
      // 1. Emit DES index event
      const desEvent = desIndexEntry(contentId, fields, agent);
      const xid = `des-field-${contentId}-${Date.now()}`;
      registerEvent({ id: xid, op: desEvent.op, target: desEvent.target, operand: desEvent.operand, ts: desEvent.ctx.ts, agent: desEvent.ctx.agent, status: 'pending' });
      await addRecord(eventToPayload(desEvent));
      registerEvent({ id: xid, op: desEvent.op, target: desEvent.target, operand: desEvent.operand, ts: desEvent.ctx.ts, agent: desEvent.ctx.agent, status: 'sent' });

      // 2. Update site:index current state
      const updatedEntries = entries.map((e) =>
        e.content_id === contentId ? { ...e, ...fields } : e
      );
      const updated = await upsertCurrentRecord(
        'site:index',
        buildIndexPayload(updatedEntries),
        agent,
        indexRecordRef.current,
      );
      indexRecordRef.current = updated;
      setEntries(updatedEntries);

      // 3. Best-effort update content's own meta
      const metaEvent = desContentMeta(contentId, {
        ...fields,
        updated_at: desEvent.ctx.ts,
      } as Partial<import('../eo/types').ContentMeta>, agent);
      await addRecord(eventToPayload(metaEvent));
      try {
        const contentRec = await fetchCurrentRecordCached(contentId);
        if (contentRec) {
          const contentState = JSON.parse(contentRec.values);
          contentState.meta = { ...contentState.meta, ...fields, updated_at: desEvent.ctx.ts };
          await upsertCurrentRecord(contentId, contentState, agent, contentRec);
        }
      } catch { /* best-effort */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // ── Create a special page (homepage or operator) ────────────────────────

  async function createSpecialPage(sp: typeof SPECIAL_PAGES[number]) {
    if (!isAuthenticated || entries.some(e => e.content_id === sp.content_id)) return;
    setCreatingSpecial(sp.content_id);
    setError(null);

    const agent = settings.displayName || 'editor';
    const ts = new Date().toISOString();

    try {
      const insEvent = insIndexEntry(sp.content_id, {
        slug: sp.slug,
        title: sp.title,
        content_type: sp.content_type,
        status: settings.defaultStatus,
        visibility: 'public',
        tags: [],
      }, agent);
      const xid = `ins-index-${sp.content_id}`;
      registerEvent({ id: xid, op: insEvent.op, target: insEvent.target, operand: insEvent.operand, ts: insEvent.ctx.ts, agent: insEvent.ctx.agent, status: 'pending' });
      await addRecord(eventToPayload(insEvent));
      registerEvent({ id: xid, op: insEvent.op, target: insEvent.target, operand: insEvent.operand, ts: insEvent.ctx.ts, agent: insEvent.ctx.agent, status: 'sent' });

      const desEvent = desContentMeta(sp.content_id, {
        content_id: sp.content_id,
        content_type: sp.content_type,
        slug: sp.slug,
        title: sp.title,
        status: settings.defaultStatus,
        visibility: 'public',
        tags: [],
        updated_at: ts,
      }, agent);
      await addRecord(eventToPayload(desEvent));

      const newEntry: IndexEntry = {
        content_id: sp.content_id,
        slug: sp.slug,
        title: sp.title,
        content_type: sp.content_type,
        status: settings.defaultStatus,
        visibility: 'public',
        tags: [],
        first_public_at: ts,
      };
      const updatedEntries = [...entries, newEntry];
      const updated = await upsertCurrentRecord(
        'site:index',
        buildIndexPayload(updatedEntries),
        agent,
        indexRecordRef.current,
      );
      indexRecordRef.current = updated;

      await upsertCurrentRecord(sp.content_id, {
        meta: {
          content_id: sp.content_id,
          content_type: sp.content_type,
          slug: sp.slug,
          title: sp.title,
          status: settings.defaultStatus,
          visibility: 'public',
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
      onOpen(sp.content_id, sp.content_type);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingSpecial(null);
    }
  }

  // ── Inline title save ──────────────────────────────────────────────────

  function saveTitle(contentId: string) {
    const trimmed = editTitleValue.trim();
    if (trimmed && trimmed !== entries.find(e => e.content_id === contentId)?.title) {
      updateIndexField(contentId, { title: trimmed });
    }
    setEditingTitle(null);
  }

  // ── Inline tag operations ──────────────────────────────────────────────

  function addTag(contentId: string) {
    const tag = tagInput.trim().toLowerCase();
    if (!tag) return;
    const entry = entries.find(e => e.content_id === contentId);
    if (!entry || entry.tags.includes(tag)) { setTagInput(''); return; }
    updateIndexField(contentId, { tags: [...entry.tags, tag] });
    setTagInput('');
  }

  function removeTag(contentId: string, tag: string) {
    const entry = entries.find(e => e.content_id === contentId);
    if (!entry) return;
    updateIndexField(contentId, { tags: entry.tags.filter(t => t !== tag) });
  }

  // ── Derived data ───────────────────────────────────────────────────────

  const activeEntries = entries.filter(e => e.status !== 'archived');
  const archivedEntries = entries.filter(e => e.status === 'archived');
  const pageEntries = activeEntries.filter(e => e.content_type === 'page');

  // Apply search + type filter (Issue 5)
  const filteredEntries = activeEntries.filter(e => {
    if (typeFilter !== 'all' && e.content_type !== typeFilter) return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      return e.title.toLowerCase().includes(q) || e.slug.toLowerCase().includes(q);
    }
    return true;
  });

  // Apply sort (Issue 9)
  const sortedEntries = [...filteredEntries].sort((a, b) => {
    let cmp = 0;
    switch (sortField) {
      case 'title': cmp = a.title.localeCompare(b.title); break;
      case 'type': cmp = a.content_type.localeCompare(b.content_type); break;
      case 'status': cmp = a.status.localeCompare(b.status); break;
      case 'slug': cmp = a.slug.localeCompare(b.slug); break;
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  function handleSort(field: typeof sortField) {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  }

  function sortIndicator(field: typeof sortField) {
    if (sortField !== field) return '';
    return sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
  }

  if (loading) return <div className="editor-loading">Loading content list…</div>;

  return (
    <div className="content-manager">
      {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>×</button></div>}

      {/* Special Pages — Homepage + Operator Grid */}
      <section className="special-pages-section">
        <div className="special-pages-layout">
          {/* Homepage card */}
          {(() => {
            const homeSp = SPECIAL_PAGES.find(sp => sp.content_id === 'page:home')!;
            const homeExists = entries.some(e => e.content_id === 'page:home');
            return (
              <button
                className={`special-home-card ${homeExists ? 'exists' : ''}`}
                onClick={() => homeExists ? onOpen('page:home', 'page') : createSpecialPage(homeSp)}
                disabled={!isAuthenticated && !homeExists}
                title={homeExists ? 'Edit homepage' : 'Create homepage'}
              >
                <span className="special-home-symbol" style={{ color: homeSp.color }}>{homeSp.symbol}</span>
                <span className="special-home-label">Homepage</span>
                <span className="special-home-status">{homeExists ? 'Edit' : '+ Create'}</span>
              </button>
            );
          })()}

          {/* 3×3 Operator grid */}
          <div className="special-ops-grid">
            <div className="special-ops-label">Operators</div>
            <div className="special-ops-cells">
              {SPECIAL_PAGES.filter(sp => sp.code).map((sp) => {
                const exists = entries.some(e => e.content_id === sp.content_id);
                return (
                  <button
                    key={sp.content_id}
                    className={`special-op-cell ${exists ? 'exists' : ''}`}
                    style={{ '--op-color': sp.color } as React.CSSProperties}
                    onClick={() => exists ? onOpen(sp.content_id, sp.content_type) : createSpecialPage(sp)}
                    disabled={(!isAuthenticated && !exists) || creatingSpecial === sp.content_id}
                    title={`${sp.code} — ${sp.title}${exists ? '' : ' (click to create)'}`}
                  >
                    <span className="special-op-symbol">{sp.symbol}</span>
                    <span className="special-op-code">{sp.code}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* Create new content */}
      <section className="create-section">
        <h2>New Content</h2>
        <div className="create-form">
          <select value={newType} onChange={(e) => setNewType(e.target.value as ContentType)}>
            {(Object.entries(TYPE_LABELS) as Array<[string, string]>).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input
            value={newTitle}
            onChange={(e) => {
              setNewTitle(e.target.value);
              if (!slugManuallyEdited) {
                setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
              }
            }}
            placeholder="Title"
          />
          <input
            value={newSlug}
            onChange={(e) => {
              setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, ''));
              setSlugManuallyEdited(true);
            }}
            placeholder="slug (auto-generated)"
            style={{ color: slugManuallyEdited ? 'var(--text)' : 'var(--text-dim)' }}
          />
          <select value={newVisibility} onChange={(e) => setNewVisibility(e.target.value as Visibility)}>
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select>
          <button
            className="btn btn-primary"
            onClick={() => { create(); setSlugManuallyEdited(false); }}
            disabled={creating || !isAuthenticated || !newSlug || !newTitle}
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </section>

      {/* Content list */}
      <section className="content-list-section">
        <h2>All Content ({activeEntries.length})</h2>

        {/* Search & filter bar (Issue 5) */}
        <div className="content-filter-bar">
          <input
            className="content-search"
            type="search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search by title or slug\u2026"
          />
          <div className="content-type-filters">
            {(['all', 'wiki', 'blog', 'page', 'experiment'] as const).map((t) => (
              <button
                key={t}
                className={`type-filter-btn ${typeFilter === t ? 'active' : ''}`}
                onClick={() => setTypeFilter(t)}
              >
                {t === 'all' ? 'All' : t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {sortedEntries.length === 0
          ? <p className="empty-msg">{activeEntries.length === 0 ? 'No content yet. Create something above.' : 'No matching content.'}</p>
          : (
            <table className="content-table">
              <thead>
                <tr>
                  <th className="sortable-th" onClick={() => handleSort('type')}>Type{sortIndicator('type')}</th>
                  <th className="sortable-th" onClick={() => handleSort('title')}>Title{sortIndicator('title')}</th>
                  <th className="sortable-th" onClick={() => handleSort('slug')}>Slug{sortIndicator('slug')}</th>
                  <th>Tags</th>
                  <th className="sortable-th" onClick={() => handleSort('status')}>Status{sortIndicator('status')}</th>
                  <th>Visibility</th>
                  <th>Nav</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedEntries.map((entry) => (
                  <tr key={entry.content_id}>
                    <td><span className={`type-badge type-${entry.content_type}`}>{entry.content_type}</span></td>
                    <td>
                      {entry.parent_page && <span style={{ color: 'var(--text-dim)', fontSize: '.75rem', marginRight: '.3rem' }}>{'\u21B3'}</span>}
                      {editingTitle === entry.content_id ? (
                        <input
                          className="inline-title-input"
                          value={editTitleValue}
                          onChange={(e) => setEditTitleValue(e.target.value)}
                          onBlur={() => saveTitle(entry.content_id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveTitle(entry.content_id);
                            if (e.key === 'Escape') setEditingTitle(null);
                          }}
                          autoFocus
                        />
                      ) : (
                        <span
                          className="editable-title"
                          onClick={() => { setEditingTitle(entry.content_id); setEditTitleValue(entry.title); }}
                          title="Click to edit title"
                        >
                          {entry.title}
                        </span>
                      )}
                    </td>
                    <td className="slug-cell">{entry.slug}</td>
                    <td className="tags-cell">
                      <div className="inline-tags">
                        {entry.tags.map((tag) => (
                          <span key={tag} className="tag-pill">
                            {tag}
                            <button
                              className="tag-remove"
                              onClick={() => removeTag(entry.content_id, tag)}
                              disabled={!isAuthenticated}
                              title="Remove tag"
                            >{'\u00D7'}</button>
                          </span>
                        ))}
                        {editingTags === entry.content_id ? (
                          <input
                            className="tag-add-input"
                            value={tagInput}
                            onChange={(e) => setTagInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(entry.content_id); }
                              if (e.key === 'Escape') { setEditingTags(null); setTagInput(''); }
                            }}
                            onBlur={() => { if (tagInput.trim()) addTag(entry.content_id); setEditingTags(null); setTagInput(''); }}
                            placeholder="add tag\u2026"
                            autoFocus
                          />
                        ) : (
                          <button
                            className="tag-add-btn"
                            onClick={() => { setEditingTags(entry.content_id); setTagInput(''); }}
                            disabled={!isAuthenticated}
                            title="Add tag"
                          >+</button>
                        )}
                      </div>
                    </td>
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
                          <ParentPagePicker
                            currentId={entry.content_id}
                            parentId={entry.parent_page ?? ''}
                            pageEntries={pageEntries}
                            disabled={!isAuthenticated}
                            onChange={(val) => setParentPage(entry.content_id, val)}
                          />
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-dim)', fontSize: '.8rem' }}>{'\u2014'}</span>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: '.35rem', alignItems: 'center' }}>
                        <button className="btn btn-sm" onClick={() => onOpen(entry.content_id, entry.content_type)}>
                          Edit
                        </button>
                        {confirmArchive === entry.content_id ? (
                          <>
                            <button
                              className="btn btn-sm btn-danger"
                              onClick={() => { archiveContent(entry.content_id); setConfirmArchive(null); }}
                            >
                              Confirm
                            </button>
                            <button
                              className="btn btn-sm"
                              onClick={() => setConfirmArchive(null)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            className="btn btn-sm btn-archive"
                            onClick={() => setConfirmArchive(entry.content_id)}
                            disabled={!isAuthenticated}
                            title="Archive (soft-delete)"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </section>

      {/* Archive section */}
      <section className="archive-section">
        <button
          className="archive-toggle"
          onClick={() => setShowArchive(!showArchive)}
        >
          Archive ({archivedEntries.length})
          <span className={`archive-chevron ${showArchive ? 'open' : ''}`}>&#9662;</span>
        </button>

        {showArchive && (
          archivedEntries.length === 0
            ? <p className="empty-msg" style={{ marginTop: '.75rem' }}>No archived content.</p>
            : (
              <table className="content-table archive-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Title</th>
                    <th>Slug</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {archivedEntries.map((entry) => (
                    <tr key={entry.content_id} className="archived-row">
                      <td><span className={`type-badge type-${entry.content_type}`}>{entry.content_type}</span></td>
                      <td className="archived-title">{entry.title}</td>
                      <td className="slug-cell">{entry.slug}</td>
                      <td>
                        <button
                          className="btn btn-sm btn-restore"
                          onClick={() => restoreContent(entry.content_id)}
                          disabled={!isAuthenticated}
                          title="Restore from archive"
                        >
                          Restore
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
        )}
      </section>
    </div>
  );
}

// ── Custom parent-page picker (replaces native <select>) ─────────────────────

function ParentPagePicker({ currentId, parentId, pageEntries, disabled, onChange }: {
  currentId: string;
  parentId: string;
  pageEntries: IndexEntry[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const options = pageEntries.filter(p => p.content_id !== currentId);
  const selected = options.find(p => p.content_id === parentId);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={ref} className="custom-picker" style={{ position: 'relative' }}>
      <button
        className="custom-picker-trigger"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        title="Parent page"
      >
        <span className="custom-picker-label">{selected ? selected.title : 'top level'}</span>
        <span className="custom-picker-arrow">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="custom-picker-dropdown">
          <button
            className={`custom-picker-option ${!parentId ? 'active' : ''}`}
            onClick={() => { onChange(''); setOpen(false); }}
          >
            top level
          </button>
          {options.map(p => (
            <button
              key={p.content_id}
              className={`custom-picker-option ${parentId === p.content_id ? 'active' : ''}`}
              onClick={() => { onChange(p.content_id); setOpen(false); }}
            >
              {p.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
