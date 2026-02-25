/**
 * ContentManager — create new content entries and manage publish/draft status.
 *
 * Data flow:
 *   Load  →  GET /eowikicurrent where record_id = "site:index" → content list
 *            Fall back to static /generated/state/index.json if no Xano record.
 *   Create → POST /eowiki (INS index event)
 *            UPSERT /eowikicurrent record_id="site:index" with updated list
 *            POST /eowikicurrent record_id=<contentId> (empty initial state)
 *   Toggle → POST /eowiki (DES status event)
 *            PATCH /eowikicurrent record_id="site:index" with updated status
 */

import React, { useEffect, useState, useRef } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useXRay } from '../components/XRayOverlay';
import {
  fetchCurrentRecord,
  addRecord,
  upsertCurrentRecord,
  eventToPayload,
  type XanoCurrentRecord,
} from '../xano/client';
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
}

interface Props {
  siteBase: string;
  onOpen: (contentId: string, type: ContentType) => void;
}

const TYPE_LABELS: Record<ContentType, string> = {
  page: 'Page',
  blog: 'Blog Post',
  wiki: 'Wiki Page',
  experiment: 'Experiment',
};

export default function ContentManager({ siteBase, onOpen }: Props) {
  const { isAuthenticated } = useAuth();
  const { registerEvent } = useXRay();

  const [entries, setEntries] = useState<IndexEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const indexRecordRef = useRef<XanoCurrentRecord | null>(null);

  const [newType, setNewType] = useState<ContentType>('wiki');
  const [newSlug, setNewSlug] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newVisibility, setNewVisibility] = useState<Visibility>('public');

  // ── Load index ─────────────────────────────────────────────────────────────

  useEffect(() => {
    async function load() {
      setLoading(true);

      // 1. Try Xano current state for site:index
      try {
        const rec = await fetchCurrentRecord('site:index');
        if (rec) {
          indexRecordRef.current = rec;
          const parsed = JSON.parse(rec.value) as { entries: IndexEntry[] };
          setEntries(parsed.entries ?? []);
          setLoading(false);
          return;
        }
      } catch (err) {
        console.warn('[ContentManager] Could not fetch Xano index:', err);
      }

      // 2. Fall back to static index.json
      try {
        const resp = await fetch(`${siteBase}/generated/state/index.json`);
        if (resp.ok) {
          const data = await resp.json() as { entries?: IndexEntry[] };
          setEntries(data.entries ?? []);
        }
      } catch { /* no static index */ }

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
    const agent = 'editor';
    const ts = new Date().toISOString();

    try {
      // 1. Emit INS index event to eowiki log
      const insEvent = insIndexEntry(contentId, {
        slug: newSlug.trim(),
        title: newTitle.trim(),
        content_type: newType,
        status: 'draft',
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
        status: 'draft',
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
        status: 'draft',
        visibility: newVisibility,
        tags: [],
      };
      const updatedEntries = [...entries, newEntry];
      const updated = await upsertCurrentRecord(
        'site:index',
        insEvent.op,
        { entries: updatedEntries },
        agent,
        indexRecordRef.current,
      );
      indexRecordRef.current = updated;

      // 4. Create initial current state for the new content
      await upsertCurrentRecord(contentId, desEvent.op, {
        meta: {
          content_id: contentId,
          content_type: newType,
          slug: newSlug.trim(),
          title: newTitle.trim(),
          status: 'draft',
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
    const agent = 'editor';

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
        desEvent.op,
        { entries: updatedEntries },
        agent,
        indexRecordRef.current,
      );
      indexRecordRef.current = updated;
      setEntries(updatedEntries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (loading) return <div className="editor-loading">Loading content list…</div>;

  return (
    <div className="content-manager">
      {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>×</button></div>}

      {/* Create new content */}
      <section className="create-section">
        <h2>New Content</h2>
        <div className="create-form">
          <select value={newType} onChange={(e) => setNewType(e.target.value as ContentType)}>
            {(Object.entries(TYPE_LABELS) as Array<[ContentType, string]>).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
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
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.content_id}>
                    <td><span className={`type-badge type-${entry.content_type}`}>{entry.content_type}</span></td>
                    <td>{entry.title}</td>
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
                    <td><span className={`visibility-badge vis-${entry.visibility}`}>{entry.visibility}</span></td>
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
