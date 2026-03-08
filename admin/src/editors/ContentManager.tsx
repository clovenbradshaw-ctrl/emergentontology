/**
 * ContentManager — create new content entries and manage publish/draft status.
 *
 * Data flow:
 *   Load  →  GET /eowikicurrent where record_id = "site:index" → content list
 *            Fall back to static /generated/state/index.json if no Xano record.
 *   Create → POST /eowiki (INS index event)
 *            UPSERT /eowikicurrent record_id="site:index" with updated list
 *            POST /eowikicurrent record_id=<contentId> (empty initial state)
 *   Toggle → POST /eowiki (SIG status/visibility event)
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
import { loadState, fetchCurrentRecordCached, fetchAllCurrentRecordsCached } from '../xano/stateCache';
import { insIndexEntry, desContentMeta, desIndexEntry, nulIndexEntry } from '../eo/events';
import type { ContentType, ContentStatus, Visibility, ProjectedWiki, ProjectedBlog, ProjectedPage, ProjectedExperiment, Block, ExperimentEntry } from '../eo/types';
import { htmlToMd } from '../eo/markdown';
import { SPECIAL_PAGES } from '../eo/constants';

interface IndexEntry {
  content_id: string;
  slug: string;
  title: string;
  content_type: ContentType;
  status: ContentStatus;
  visibility: Visibility;
  tags: string[];
  keywords: string[];
  /** ISO timestamp when this content was first SIG'd as public */
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
  const [sortField, setSortField] = useState<'title' | 'type' | 'status' | 'slug' | 'tags' | 'keywords' | 'visibility' | 'nav'>('title');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Inline editing (Issues 3 & 4)
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [editTitleValue, setEditTitleValue] = useState('');
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editSlugValue, setEditSlugValue] = useState('');
  const [editSlugError, setEditSlugError] = useState('');
  const [editingTags, setEditingTags] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [editingKeywords, setEditingKeywords] = useState<string | null>(null);
  const [keywordInput, setKeywordInput] = useState('');
  const [suggestedKeywords, setSuggestedKeywords] = useState<Record<string, string[]>>({});
  const [detectingKeywords, setDetectingKeywords] = useState<string | null>(null);

  // Special page creation (Issues 1 & 2)
  const [creatingSpecial, setCreatingSpecial] = useState<string | null>(null);

  // Bulk download
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState('');

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
      let indexEntries = result.state?.entries ?? [];

      // Discover orphan records in Xano that aren't in site:index
      try {
        const allRecords = await fetchAllCurrentRecordsCached();
        const CONTENT_PREFIXES = ['wiki:', 'blog:', 'experiment:', 'page:'];
        const knownIds = new Set(indexEntries.map(e => e.content_id));

        for (const rec of allRecords) {
          const rid = rec.record_id;
          if (knownIds.has(rid)) continue;
          if (!CONTENT_PREFIXES.some(p => rid.startsWith(p))) continue;

          // Parse the record to extract meta
          let parsed: Record<string, unknown> | null = null;
          try { parsed = JSON.parse(rec.values); } catch { continue; }
          if (!parsed) continue;

          const meta = (parsed.meta ?? {}) as Record<string, unknown>;
          const parts = rid.split(':');
          const prefix = parts[0];
          const slug = String(meta.slug ?? parts.slice(1).join(':'));
          const contentType = String(meta.content_type ?? prefix) as ContentType;

          indexEntries = [...indexEntries, {
            content_id: rid,
            slug,
            title: String(meta.title ?? slug),
            content_type: contentType,
            status: (meta.status as ContentStatus) ?? 'draft',
            visibility: (meta.visibility as Visibility) ?? 'public',
            tags: (meta.tags as string[]) ?? [],
            keywords: (meta.keywords as string[]) ?? [],
          }];
          knownIds.add(rid);
        }
      } catch (err) {
        console.warn('[ContentManager] Orphan record discovery failed:', err);
      }

      setEntries(indexEntries);
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

      // 2. Emit SIG content meta event
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
        keywords: [],
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
      // 1. Emit SIG index event
      const desEvent = desIndexEntry(contentId, { status: newStatus }, agent);
      const xid = `sig-status-${contentId}`;
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
      } catch (err) { console.warn('[ContentManager] state sync failed:', err); }
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
      // 1. Emit SIG index event
      const desEvent = desIndexEntry(contentId, { visibility: newVisibility }, agent);
      const xid = `sig-visibility-${contentId}`;
      registerEvent({ id: xid, op: desEvent.op, target: desEvent.target, operand: desEvent.operand, ts: desEvent.ctx.ts, agent: desEvent.ctx.agent, status: 'pending' });
      await addRecord(eventToPayload(desEvent));
      registerEvent({ id: xid, op: desEvent.op, target: desEvent.target, operand: desEvent.operand, ts: desEvent.ctx.ts, agent: desEvent.ctx.agent, status: 'sent' });

      // 2. Update site:index current state — track first_public_at on initial SIG as public
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
        } catch (err) { console.warn('[ContentManager] state sync failed:', err); }
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

      // 2. Emit SIG event to set content meta status to 'archived'
      const metaEvent = desContentMeta(contentId, {
        status: 'archived' as ContentStatus,
        updated_at: ts,
      } as Partial<import('../eo/types').ContentMeta>, agent);
      await addRecord(eventToPayload(metaEvent));

      // 3. Update site:index current state — remove the entry entirely
      const updatedEntries = entries.filter((e) => e.content_id !== contentId);
      const updated = await upsertCurrentRecord(
        'site:index',
        buildIndexPayload(updatedEntries),
        agent,
        indexRecordRef.current,
      );
      indexRecordRef.current = updated;
      setEntries(updatedEntries);

      // 4. Update content's own current state to archived
      try {
        const contentRec = await fetchCurrentRecordCached(contentId);
        if (contentRec) {
          const contentState = JSON.parse(contentRec.values);
          contentState.meta = { ...contentState.meta, status: 'archived', updated_at: ts };
          await upsertCurrentRecord(contentId, contentState, agent, contentRec);
        }
      } catch (err) { console.warn('[ContentManager] state sync failed:', err); }
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
      // 1. Emit SIG index event to set status back to 'draft'
      const desEvent = desIndexEntry(contentId, { status: 'draft' }, agent);
      const xid = `sig-restore-${contentId}`;
      registerEvent({ id: xid, op: desEvent.op, target: desEvent.target, operand: desEvent.operand, ts: desEvent.ctx.ts, agent: desEvent.ctx.agent, status: 'pending' });
      await addRecord(eventToPayload(desEvent));
      registerEvent({ id: xid, op: desEvent.op, target: desEvent.target, operand: desEvent.operand, ts: desEvent.ctx.ts, agent: desEvent.ctx.agent, status: 'sent' });

      // 2. Emit SIG content meta event
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
      } catch (err) { console.warn('[ContentManager] state sync failed:', err); }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // ── Update index entry fields (shared utility for title, tags, etc.) ─────

  async function updateIndexField(contentId: string, fields: Partial<{ slug: string; title: string; tags: string[]; keywords: string[] }>) {
    if (!isAuthenticated) return;
    const agent = settings.displayName || 'editor';

    try {
      // 1. Emit SIG index event
      const desEvent = desIndexEntry(contentId, fields, agent);
      const xid = `sig-field-${contentId}-${Date.now()}`;
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
      } catch (err) { console.warn('[ContentManager] state sync failed:', err); }
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
        keywords: [],
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

  // ── Inline slug save ───────────────────────────────────────────────

  function saveSlug(contentId: string) {
    const normalized = editSlugValue.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '').replace(/^-|-$/g, '');
    if (!normalized) {
      setEditSlugError('Slug cannot be empty');
      return;
    }
    const duplicate = entries.find(e => e.slug === normalized && e.content_id !== contentId);
    if (duplicate) {
      setEditSlugError(`Slug "${normalized}" already in use`);
      return;
    }
    if (normalized !== entries.find(e => e.content_id === contentId)?.slug) {
      updateIndexField(contentId, { slug: normalized });
    }
    setEditSlugError('');
    setEditingSlug(null);
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

  // ── Inline keyword operations ──────────────────────────────────────────

  function addKeyword(contentId: string) {
    const kw = keywordInput.trim().toLowerCase();
    if (!kw) return;
    const entry = entries.find(e => e.content_id === contentId);
    if (!entry || (entry.keywords || []).includes(kw)) { setKeywordInput(''); return; }
    updateIndexField(contentId, { keywords: [...(entry.keywords || []), kw] });
    setKeywordInput('');
  }

  function removeKeyword(contentId: string, kw: string) {
    const entry = entries.find(e => e.content_id === contentId);
    if (!entry) return;
    updateIndexField(contentId, { keywords: (entry.keywords || []).filter(k => k !== kw) });
  }

  function approveKeyword(contentId: string, kw: string) {
    const entry = entries.find(e => e.content_id === contentId);
    if (!entry || (entry.keywords || []).includes(kw)) return;
    updateIndexField(contentId, { keywords: [...(entry.keywords || []), kw] });
    // Remove from suggestions
    setSuggestedKeywords(prev => ({
      ...prev,
      [contentId]: (prev[contentId] || []).filter(k => k !== kw),
    }));
  }

  function dismissKeyword(contentId: string, kw: string) {
    setSuggestedKeywords(prev => ({
      ...prev,
      [contentId]: (prev[contentId] || []).filter(k => k !== kw),
    }));
  }

  /** Extract keywords from the content body text by loading the content state. */
  async function detectKeywords(contentId: string) {
    setDetectingKeywords(contentId);
    try {
      const result = await loadState<{ meta?: Record<string, unknown>; current_revision?: { content?: string }; blocks?: Array<{ data?: Record<string, unknown> }> }>(
        contentId,
        siteBase,
        `/generated/state/content/${contentId.replace(':', '/')}.json`,
      );
      const state = result.state;
      if (!state) { setDetectingKeywords(null); return; }

      // Extract text from content body
      let bodyText = '';

      // Wiki/Blog: use current_revision content (markdown/html)
      if (state.current_revision?.content) {
        bodyText = state.current_revision.content
          .replace(/<[^>]+>/g, ' ')  // strip HTML tags
          .replace(/[#*_`~\[\]()>|\\-]/g, ' ');  // strip markdown syntax
      }

      // Page: concatenate text from blocks
      if (state.blocks && Array.isArray(state.blocks)) {
        for (const block of state.blocks) {
          if (block.data) {
            const text = block.data.text || block.data.content || block.data.html || '';
            if (typeof text === 'string') {
              bodyText += ' ' + text.replace(/<[^>]+>/g, ' ');
            }
          }
        }
      }

      if (!bodyText.trim()) { setDetectingKeywords(null); return; }

      // Simple keyword extraction: find frequently occurring meaningful words
      const stopWords = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
        'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
        'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
        'could', 'should', 'may', 'might', 'shall', 'can', 'need', 'must',
        'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she',
        'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his',
        'our', 'their', 'not', 'no', 'nor', 'as', 'if', 'then', 'than',
        'when', 'where', 'how', 'what', 'which', 'who', 'whom', 'so', 'up',
        'out', 'about', 'into', 'over', 'after', 'also', 'just', 'more',
        'some', 'such', 'all', 'each', 'every', 'both', 'few', 'most', 'other',
        'new', 'old', 'one', 'two', 'first', 'last', 'long', 'great', 'same',
        'own', 'still', 'back', 'even', 'here', 'there', 'way', 'many', 'very',
        'make', 'like', 'well', 'only', 'much', 'get', 'see', 'know', 'take',
        'come', 'think', 'say', 'use', 'find', 'give', 'tell', 'work', 'call',
        'try', 'ask', 'seem', 'feel', 'leave', 'keep', 'let', 'begin', 'show',
        'hear', 'play', 'run', 'move', 'live', 'believe', 'happen', 'include',
        'while', 'through', 'between', 'before', 'since', 'because', 'nbsp',
      ]);

      const words = bodyText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const freq: Record<string, number> = {};
      for (const word of words) {
        const clean = word.replace(/[^a-z0-9-]/g, '');
        if (clean.length < 3 || stopWords.has(clean)) continue;
        freq[clean] = (freq[clean] || 0) + 1;
      }

      // Also extract two-word phrases
      for (let i = 0; i < words.length - 1; i++) {
        const w1 = words[i].replace(/[^a-z0-9-]/g, '');
        const w2 = words[i + 1].replace(/[^a-z0-9-]/g, '');
        if (w1.length < 3 || w2.length < 3 || stopWords.has(w1) || stopWords.has(w2)) continue;
        const phrase = `${w1} ${w2}`;
        freq[phrase] = (freq[phrase] || 0) + 1;
      }

      const entry = entries.find(e => e.content_id === contentId);
      const existing = new Set([...(entry?.keywords || []), ...(entry?.tags || [])]);

      const candidates = Object.entries(freq)
        .filter(([kw, count]) => count >= 2 && !existing.has(kw))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([kw]) => kw);

      setSuggestedKeywords(prev => ({ ...prev, [contentId]: candidates }));
    } catch (err) {
      console.warn('[ContentManager] keyword detection failed:', err);
    }
    setDetectingKeywords(null);
  }

  // ── Bulk download all articles as single .md ─────────────────────────────

  function blockToMd(block: Block): string {
    const d = block.data as Record<string, unknown>;
    switch (block.block_type) {
      case 'heading': {
        const level = Math.min(Math.max(Number(d.level) || 2, 1), 6);
        const text = String(d.text || d.md || '');
        return '#'.repeat(level) + ' ' + text;
      }
      case 'text':
        if (d.md) return String(d.md);
        if (d.html) return htmlToMd(String(d.html));
        return '';
      case 'image':
        return `![${String(d.alt || '')}](${String(d.img_url || d.url || '')})`;
      case 'code':
        return '```' + String(d.language || '') + '\n' + String(d.code || '') + '\n```';
      case 'quote':
      case 'callout':
        return String(d.text || d.md || d.html ? htmlToMd(String(d.html || '')) : '').split('\n').map(l => `> ${l}`).join('\n');
      case 'divider':
        return '---';
      case 'embed':
      case 'video':
        return `[${block.block_type}](${String(d.url || '')})`;
      case 'button':
        return `[${String(d.label || d.text || 'button')}](${String(d.url || '')})`;
      case 'html':
        return htmlToMd(String(d.html || ''));
      default:
        return '';
    }
  }

  function experimentEntryToMd(entry: ExperimentEntry): string {
    const d = entry.data as Record<string, unknown>;
    switch (entry.kind) {
      case 'note':
        return String(d.md || d.text || (d.html ? htmlToMd(String(d.html)) : ''));
      case 'decision':
        return `**Decision:** ${String(d.text || d.md || '')}`;
      case 'link':
        return `[${String(d.label || d.title || 'link')}](${String(d.url || '')})`;
      case 'html':
        return htmlToMd(String(d.html || ''));
      default:
        return String(d.text || d.md || d.summary || JSON.stringify(d));
    }
  }

  async function downloadAllAsMd() {
    setDownloading(true);
    setDownloadProgress('Loading content\u2026');
    try {
      // Pre-warm: single bulk API call loads all records into cache
      await fetchAllCurrentRecordsCached();

      const sections: string[] = [];
      const nonArchived = entries.filter(e => e.status !== 'archived');

      for (let i = 0; i < nonArchived.length; i++) {
        const entry = nonArchived[i];
        setDownloadProgress(`Processing ${i + 1} of ${nonArchived.length}: ${entry.title}`);

        // Frontmatter
        const frontmatter = [
          '---',
          `title: ${entry.title}`,
          `slug: ${entry.slug}`,
          `type: ${entry.content_type}`,
          `status: ${entry.status}`,
          `visibility: ${entry.visibility}`,
          ...(entry.tags.length ? [`tags: [${entry.tags.join(', ')}]`] : []),
          '---',
        ].join('\n');

        let body = '';

        try {
          const result = await loadState<ProjectedWiki | ProjectedBlog | ProjectedPage | ProjectedExperiment>(
            entry.content_id, siteBase,
          );
          const state = result.state;

          if (!state) {
            body = '*No content available.*';
          } else if (state.content_type === 'wiki' || state.content_type === 'blog') {
            const wikiState = state as ProjectedWiki | ProjectedBlog;
            const rev = wikiState.current_revision;
            if (rev) {
              body = rev.format === 'html' ? htmlToMd(rev.content) : rev.content;
            } else {
              body = '*No revision.*';
            }
          } else if (state.content_type === 'page') {
            const pageState = state as ProjectedPage;
            const blocks = pageState.blocks.filter(b => !b.deleted);
            // Order blocks by block_order if available
            const ordered = pageState.block_order?.length
              ? pageState.block_order.map(id => blocks.find(b => b.block_id === id)).filter(Boolean) as Block[]
              : blocks;
            body = ordered.map(b => blockToMd(b)).filter(Boolean).join('\n\n');
          } else if (state.content_type === 'experiment') {
            const expState = state as ProjectedExperiment;
            const parts: string[] = [];
            if (expState.current_revision) {
              const rev = expState.current_revision;
              parts.push(rev.format === 'html' ? htmlToMd(rev.content) : rev.content);
            }
            const activeEntries = expState.entries?.filter(e => !e.deleted) ?? [];
            for (const e of activeEntries) {
              parts.push(experimentEntryToMd(e));
            }
            body = parts.filter(Boolean).join('\n\n');
          }
        } catch (err) {
          console.warn(`[downloadAllAsMd] Failed to load ${entry.content_id}:`, err);
          body = '*Failed to load content.*';
        }

        sections.push(`${frontmatter}\n\n# ${entry.title}\n\n${body}`);
      }

      const fullMd = sections.join('\n\n---\n\n');
      const blob = new Blob([fullMd], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `all-articles-${new Date().toISOString().slice(0, 10)}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setDownloading(false);
    setDownloadProgress('');
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
      case 'tags': cmp = (a.tags.join(',')).localeCompare(b.tags.join(',')); break;
      case 'keywords': cmp = ((a.keywords || []).join(',')).localeCompare((b.keywords || []).join(',')); break;
      case 'visibility': cmp = a.visibility.localeCompare(b.visibility); break;
      case 'nav': {
        const aNav = a.content_type === 'page' ? (a.show_in_nav ? 'in nav' : 'hidden') : '';
        const bNav = b.content_type === 'page' ? (b.show_in_nav ? 'in nav' : 'hidden') : '';
        cmp = aNav.localeCompare(bNav);
        break;
      }
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

        {/* Search, filter & actions bar */}
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
          <button
            className="btn btn-download"
            onClick={downloadAllAsMd}
            disabled={downloading || entries.length === 0}
            title="Download all articles as a single Markdown file"
          >
            {downloading ? (downloadProgress || 'Downloading…') : '\u2193 Download All .md'}
          </button>
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
                  <th className="sortable-th" onClick={() => handleSort('tags')}>Tags{sortIndicator('tags')}</th>
                  <th className="sortable-th" onClick={() => handleSort('keywords')}>Keywords{sortIndicator('keywords')}</th>
                  <th className="sortable-th" onClick={() => handleSort('status')}>Status{sortIndicator('status')}</th>
                  <th className="sortable-th" onClick={() => handleSort('visibility')}>Visibility{sortIndicator('visibility')}</th>
                  <th className="sortable-th" onClick={() => handleSort('nav')}>Nav{sortIndicator('nav')}</th>
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
                    <td className="slug-cell">
                      {editingSlug === entry.content_id ? (
                        <div className="inline-slug-edit">
                          <input
                            className="inline-slug-input"
                            value={editSlugValue}
                            onChange={(e) => {
                              setEditSlugValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, ''));
                              setEditSlugError('');
                            }}
                            onBlur={() => saveSlug(entry.content_id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveSlug(entry.content_id);
                              if (e.key === 'Escape') { setEditSlugError(''); setEditingSlug(null); }
                            }}
                            autoFocus
                          />
                          {editSlugError && <span className="inline-slug-error">{editSlugError}</span>}
                        </div>
                      ) : (
                        <span
                          className="editable-slug"
                          onClick={() => { setEditingSlug(entry.content_id); setEditSlugValue(entry.slug); setEditSlugError(''); }}
                          title="Click to edit slug"
                        >
                          {entry.slug}
                        </span>
                      )}
                    </td>
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
                    <td className="keywords-cell">
                      <div className="inline-tags">
                        {(entry.keywords || []).map((kw) => (
                          <span key={kw} className="keyword-pill">
                            {kw}
                            <button
                              className="tag-remove"
                              onClick={() => removeKeyword(entry.content_id, kw)}
                              disabled={!isAuthenticated}
                              title="Remove keyword"
                            >{'\u00D7'}</button>
                          </span>
                        ))}
                        {(suggestedKeywords[entry.content_id] || []).map((kw) => (
                          <span key={`s-${kw}`} className="keyword-pill keyword-suggested">
                            {kw}
                            <button
                              className="keyword-approve"
                              onClick={() => approveKeyword(entry.content_id, kw)}
                              title="Approve keyword"
                            >{'\u2713'}</button>
                            <button
                              className="tag-remove"
                              onClick={() => dismissKeyword(entry.content_id, kw)}
                              title="Dismiss"
                            >{'\u00D7'}</button>
                          </span>
                        ))}
                        {editingKeywords === entry.content_id ? (
                          <input
                            className="tag-add-input"
                            value={keywordInput}
                            onChange={(e) => setKeywordInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addKeyword(entry.content_id); }
                              if (e.key === 'Escape') { setEditingKeywords(null); setKeywordInput(''); }
                            }}
                            onBlur={() => { if (keywordInput.trim()) addKeyword(entry.content_id); setEditingKeywords(null); setKeywordInput(''); }}
                            placeholder="add keyword…"
                            autoFocus
                          />
                        ) : (
                          <span style={{ display: 'inline-flex', gap: '.2rem' }}>
                            <button
                              className="tag-add-btn"
                              onClick={() => { setEditingKeywords(entry.content_id); setKeywordInput(''); }}
                              disabled={!isAuthenticated}
                              title="Add keyword"
                            >+</button>
                            <button
                              className="keyword-detect-btn"
                              onClick={() => detectKeywords(entry.content_id)}
                              disabled={!isAuthenticated || detectingKeywords === entry.content_id}
                              title="Auto-detect keywords from content"
                            >{detectingKeywords === entry.content_id ? '…' : '\u2728'}</button>
                          </span>
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
