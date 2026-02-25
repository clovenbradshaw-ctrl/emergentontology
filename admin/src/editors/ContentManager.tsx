/**
 * ContentManager — create new content rooms and manage publish/draft status.
 * Also handles the "multiple editors" use case: shows who has recently edited.
 */

import React, { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useXRay } from '../components/XRayOverlay';
import {
  createRoom,
  sendEOEvent,
  setStateEvent,
  resolveAlias,
} from '../matrix/client';
import { insIndexEntry, desContentMeta, desIndexEntry } from '../eo/events';
import type { SiteIndex, ContentType, ContentStatus, Visibility } from '../eo/types';

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
  const { creds } = useAuth();
  const { registerEvent } = useXRay();

  const [index, setIndex] = useState<SiteIndex | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New content form state
  const [newType, setNewType] = useState<ContentType>('wiki');
  const [newSlug, setNewSlug] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newVisibility, setNewVisibility] = useState<Visibility>('public');

  useEffect(() => {
    fetch(`${siteBase}/generated/state/index.json`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { setIndex(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [siteBase]);

  async function create() {
    if (!creds || !newSlug.trim() || !newTitle.trim()) return;
    setCreating(true);
    setError(null);

    const serverName = new URL(creds.homeserver).hostname;
    const contentId = `${newType}:${newSlug.trim()}`;
    const alias = `${newType}-${newSlug.trim().replace(/\//g, '-')}`;

    try {
      // Create the Matrix room
      const roomId = await createRoom(creds, {
        name: newTitle,
        alias,
        topic: `EO ${TYPE_LABELS[newType]}: ${newSlug}`,
        preset: newVisibility === 'public' ? 'public_chat' : 'private_chat',
      });

      // Write content.meta state event
      await setStateEvent(creds, roomId, 'com.eo.content.meta', '', {
        content_id: contentId,
        content_type: newType,
        slug: newSlug,
        title: newTitle,
        status: 'draft',
        visibility: newVisibility,
        tags: [],
        updated_at: new Date().toISOString(),
      });

      // Emit DES event for the content meta
      const desEvent = desContentMeta(contentId, {
        content_id: contentId,
        content_type: newType,
        slug: newSlug,
        title: newTitle,
        status: 'draft',
        visibility: newVisibility,
        tags: [],
        updated_at: new Date().toISOString(),
      }, creds.user_id);
      const xid = `des-${contentId}`;
      registerEvent({ id: xid, op: desEvent.op, target: desEvent.target, operand: desEvent.operand, ts: desEvent.ctx.ts, agent: desEvent.ctx.agent, status: 'pending' });
      await sendEOEvent(creds, roomId, desEvent as unknown as Record<string, unknown>);
      registerEvent({ id: xid, op: desEvent.op, target: desEvent.target, operand: desEvent.operand, ts: desEvent.ctx.ts, agent: desEvent.ctx.agent, status: 'sent' });

      // Emit INS to site:index room
      const indexAlias = `#site:index:${serverName}`;
      try {
        const indexRoomId = await resolveAlias(creds.homeserver, indexAlias);
        const insEvent = insIndexEntry(contentId, {
          slug: newSlug,
          title: newTitle,
          content_type: newType,
          status: 'draft',
          visibility: newVisibility,
          tags: [],
        }, creds.user_id);
        const xid2 = `ins-index-${contentId}`;
        registerEvent({ id: xid2, op: insEvent.op, target: insEvent.target, operand: insEvent.operand, ts: insEvent.ctx.ts, agent: insEvent.ctx.agent, status: 'pending' });
        await sendEOEvent(creds, indexRoomId, insEvent as unknown as Record<string, unknown>);
        registerEvent({ id: xid2, op: insEvent.op, target: insEvent.target, operand: insEvent.operand, ts: insEvent.ctx.ts, agent: insEvent.ctx.agent, status: 'sent' });
      } catch {
        console.warn('[ContentManager] Could not write to site:index room — room may not exist yet');
      }

      // Refresh local index
      setIndex((prev) => {
        if (!prev) return prev;
        const newEntry = { content_id: contentId, slug: newSlug, title: newTitle, content_type: newType, status: 'draft' as ContentStatus, visibility: newVisibility, tags: [] };
        return { ...prev, entries: [...prev.entries, newEntry] };
      });

      setNewSlug('');
      setNewTitle('');
      onOpen(contentId, newType);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function togglePublish(contentId: string, currentStatus: ContentStatus) {
    if (!creds) return;
    const newStatus: ContentStatus = currentStatus === 'published' ? 'draft' : 'published';
    const serverName = new URL(creds.homeserver).hostname;

    try {
      // Update site:index
      const indexAlias = `#site:index:${serverName}`;
      const indexRoomId = await resolveAlias(creds.homeserver, indexAlias);
      const desEvent = desIndexEntry(contentId, { status: newStatus }, creds.user_id);
      registerEvent({ id: `des-status-${contentId}`, op: desEvent.op, target: desEvent.target, operand: desEvent.operand, ts: desEvent.ctx.ts, agent: desEvent.ctx.agent, status: 'pending' });
      await sendEOEvent(creds, indexRoomId, desEvent as unknown as Record<string, unknown>);
      registerEvent({ id: `des-status-${contentId}`, op: desEvent.op, target: desEvent.target, operand: desEvent.operand, ts: desEvent.ctx.ts, agent: desEvent.ctx.agent, status: 'sent' });

      setIndex((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          entries: prev.entries.map((e) => e.content_id === contentId ? { ...e, status: newStatus } : e),
        };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (loading) return <div className="editor-loading">Loading content list…</div>;

  const allEntries = index?.entries ?? [];

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
            disabled={creating || !creds || !newSlug || !newTitle}
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </section>

      {/* Content list */}
      <section className="content-list-section">
        <h2>All Content ({allEntries.length})</h2>
        {allEntries.length === 0
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
                {allEntries.map((entry) => (
                  <tr key={entry.content_id}>
                    <td><span className={`type-badge type-${entry.content_type}`}>{entry.content_type}</span></td>
                    <td>{entry.title}</td>
                    <td className="slug-cell">{entry.slug}</td>
                    <td>
                      <button
                        className={`status-toggle status-${entry.status}`}
                        onClick={() => togglePublish(entry.content_id, entry.status)}
                        disabled={!creds}
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
