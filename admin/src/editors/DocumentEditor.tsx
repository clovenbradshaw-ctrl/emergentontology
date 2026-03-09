/**
 * DocumentEditor — markdown body + attachable external asset links.
 *
 * Documents have two content layers:
 *   1. A revision-based markdown/HTML body (like wiki pages).
 *   2. A list of external asset links (title, URL, file type, description).
 *
 * Data flow:
 *   Load  →  GET /eowikicurrent (record_id = contentId) → current state
 *            Fall back to static snapshot if no Xano record.
 *   Save  →  POST /eowiki (INS rev event for body, INS/NUL asset events)
 *            UPSERT /eowikicurrent (update current state snapshot)
 */

import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useSettings } from '../settings/SettingsContext';
import { useXRay } from '../components/XRayOverlay';
import {
  addRecord,
  upsertCurrentRecord,
  eventToPayload,
  type XanoCurrentRecord,
} from '../xano/client';
import { loadState, applyFreshnessUpdate } from '../xano/stateCache';
import { insRevision, insDocAsset, nulDocAsset } from '../eo/events';
import type { DocumentAsset, WikiRevision, ContentMeta } from '../eo/types';
import { mdToHtml } from '../eo/markdown';
import RichTextEditor from './RichTextEditor';
import MetadataBar from '../components/MetadataBar';

const FILE_TYPES = ['pdf', 'spreadsheet', 'image', 'video', 'archive', 'code', 'other'] as const;

const FILE_TYPE_ICONS: Record<string, string> = {
  pdf: '\uD83D\uDCC4',
  spreadsheet: '\uD83D\uDCCA',
  image: '\uD83D\uDDBC\uFE0F',
  video: '\uD83C\uDFA5',
  archive: '\uD83D\uDCE6',
  code: '\uD83D\uDCBB',
  other: '\uD83D\uDCCE',
};

interface DocState {
  assets: DocumentAsset[];
  meta: Partial<ContentMeta>;
  current_revision: WikiRevision | null;
  revisions: WikiRevision[];
}

interface ContentEntry {
  content_id: string;
  slug: string;
  title: string;
  content_type: string;
}

interface Props {
  contentId: string;
  siteBase: string;
}

export default function DocumentEditor({ contentId, siteBase }: Props) {
  const { isAuthenticated } = useAuth();
  const { settings } = useSettings();
  const { registerEvent } = useXRay();

  const [state, setState] = useState<DocState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const currentRecordRef = useRef<XanoCurrentRecord | null>(null);
  const savedStateRef = useRef<DocState | null>(null);

  // Rich body state
  const [editorContent, setEditorContent] = useState('');
  const [summary, setSummary] = useState('');
  const [saving, setSaving] = useState(false);
  const savedContentRef = useRef('');
  const [contentEntries, setContentEntries] = useState<ContentEntry[]>([]);

  // Asset form state
  const [assetTitle, setAssetTitle] = useState('');
  const [assetUrl, setAssetUrl] = useState('');
  const [assetFileType, setAssetFileType] = useState<string>('other');
  const [assetDescription, setAssetDescription] = useState('');
  const [addingAsset, setAddingAsset] = useState(false);

  // ── Load ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      const result = await loadState<DocState>(contentId, siteBase);
      if (cancelled) return;
      if (result.record) currentRecordRef.current = result.record;

      let docState = result.state;

      if (docState && !docState.assets) {
        docState = {
          ...docState,
          assets: [],
          revisions: docState.revisions ?? [],
          current_revision: docState.current_revision ?? null,
        };
      }

      if (docState) {
        setState(docState);
        savedStateRef.current = docState;
        const rev = docState.current_revision;
        if (rev) {
          const html = rev.format === 'markdown' ? mdToHtml(rev.content) : rev.content;
          setEditorContent(html);
          savedContentRef.current = html;
        }

        if (result.record && docState.meta?.content_type) {
          applyFreshnessUpdate(contentId, docState as unknown as import('../eo/types').ProjectedContent, result.record, {
            persist: true,
            agent: settings.displayName || 'editor',
          }).then(({ updated, hadUpdates }) => {
            if (cancelled || !hadUpdates) return;
            const freshState = updated as unknown as DocState;
            setState(freshState);
            savedStateRef.current = freshState;
            const rev = freshState.current_revision;
            if (rev) {
              const html = rev.format === 'markdown' ? mdToHtml(rev.content) : rev.content;
              setEditorContent(html);
              savedContentRef.current = html;
            }
          }).catch((err) => { console.warn('[DocumentEditor] freshness check failed:', err); });
        }
      }
      setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, [contentId, siteBase, settings.displayName]);

  // Load content entries for link picker
  useEffect(() => {
    async function loadEntries() {
      const result = await loadState<{ entries?: ContentEntry[] }>(
        'site:index',
        siteBase,
        '/generated/state/index.json',
      );
      if (result.state) {
        setContentEntries(result.state.entries ?? []);
      }
    }
    loadEntries();
  }, [siteBase]);

  // Warn on unload
  useEffect(() => {
    function handler(e: BeforeUnloadEvent) {
      if (isDirty) { e.preventDefault(); e.returnValue = ''; }
    }
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // ── Save body revision ────────────────────────────────────────────────────

  async function saveBody() {
    if (!isAuthenticated || !isDirty) return;
    if (editorContent === savedContentRef.current) {
      setIsDirty(false);
      return;
    }

    setSaving(true);
    setError(null);

    const revId = `r_${Date.now()}`;
    const agent = settings.displayName || 'editor';
    const ts = new Date().toISOString();
    const event = insRevision(contentId, {
      rev_id: revId,
      format: 'html' as WikiRevision['format'],
      content: editorContent,
      summary: summary || 'Edit',
      ts,
    }, agent);

    const xid = `${event.op}-${revId}`;
    registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'pending' });

    try {
      await addRecord(eventToPayload(event));
      registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'sent' });

      const newRev: WikiRevision = { rev_id: revId, format: 'html', content: editorContent, summary: summary || 'Edit', ts };
      const updatedState: DocState = {
        meta: state?.meta ?? {},
        assets: state?.assets ?? [],
        revisions: [...(state?.revisions ?? []), newRev],
        current_revision: newRev,
      };

      const updated = await upsertCurrentRecord(contentId, updatedState, agent, currentRecordRef.current);
      currentRecordRef.current = updated;

      setState(updatedState);
      savedStateRef.current = updatedState;
      savedContentRef.current = editorContent;
      setIsDirty(false);
      setSummary('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'error', error: msg });
      setError(`Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  // ── Add asset ─────────────────────────────────────────────────────────────

  async function addAsset() {
    if (!isAuthenticated || !assetTitle.trim() || !assetUrl.trim()) return;
    setAddingAsset(true);
    setError(null);

    const assetId = `a_${Date.now()}`;
    const agent = settings.displayName || 'editor';
    const ts = new Date().toISOString();

    const asset: Omit<DocumentAsset, 'deleted' | '_event_id'> = {
      asset_id: assetId,
      title: assetTitle.trim(),
      url: assetUrl.trim(),
      file_type: assetFileType,
      description: assetDescription.trim(),
      ts,
    };

    const event = insDocAsset(contentId, asset, agent);
    const xid = `ins-asset-${assetId}`;
    registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'pending' });

    try {
      await addRecord(eventToPayload(event));
      registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'sent' });

      const newAsset: DocumentAsset = { ...asset, deleted: false };
      const updatedState: DocState = {
        ...state!,
        assets: [...(state?.assets ?? []), newAsset],
      };

      const updated = await upsertCurrentRecord(contentId, updatedState, agent, currentRecordRef.current);
      currentRecordRef.current = updated;

      setState(updatedState);
      savedStateRef.current = updatedState;
      setAssetTitle('');
      setAssetUrl('');
      setAssetFileType('other');
      setAssetDescription('');
    } catch (err) {
      setError(`Add asset failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAddingAsset(false);
    }
  }

  // ── Remove asset ──────────────────────────────────────────────────────────

  async function removeAsset(assetId: string) {
    if (!isAuthenticated) return;
    const agent = settings.displayName || 'editor';

    const event = nulDocAsset(contentId, assetId, agent);
    const xid = `nul-asset-${assetId}`;
    registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'pending' });

    try {
      await addRecord(eventToPayload(event));
      registerEvent({ id: xid, op: event.op, target: event.target, operand: event.operand, ts: event.ctx.ts, agent: event.ctx.agent, status: 'sent' });

      const updatedState: DocState = {
        ...state!,
        assets: (state?.assets ?? []).map(a =>
          a.asset_id === assetId ? { ...a, deleted: true } : a
        ),
      };

      const updated = await upsertCurrentRecord(contentId, updatedState, agent, currentRecordRef.current);
      currentRecordRef.current = updated;

      setState(updatedState);
      savedStateRef.current = updatedState;
    } catch (err) {
      setError(`Remove asset failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Content change handler ────────────────────────────────────────────────

  function handleContentChange(html: string) {
    setEditorContent(html);
    setIsDirty(html !== savedContentRef.current);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return <div className="editor-loading">Loading {contentId}...</div>;

  const activeAssets = (state?.assets ?? []).filter(a => !a.deleted);

  return (
    <div className="document-editor">
      <MetadataBar contentId={contentId} />

      {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>&times;</button></div>}

      {/* ── Assets section ──────────────────────────────────────────────── */}
      <section className="doc-assets-section">
        <h3>Attachments &amp; Links ({activeAssets.length})</h3>

        {activeAssets.length > 0 && (
          <div className="doc-assets-list">
            {activeAssets.map((asset) => (
              <div key={asset.asset_id} className="doc-asset-card">
                <span className="doc-asset-icon">{FILE_TYPE_ICONS[asset.file_type] || FILE_TYPE_ICONS.other}</span>
                <div className="doc-asset-info">
                  <a className="doc-asset-title" href={asset.url} target="_blank" rel="noopener noreferrer">
                    {asset.title}
                  </a>
                  <span className="doc-asset-type">{asset.file_type}</span>
                  {asset.description && <span className="doc-asset-desc">{asset.description}</span>}
                  <span className="doc-asset-url">{asset.url}</span>
                </div>
                <button
                  className="btn btn-xs btn-danger"
                  onClick={() => removeAsset(asset.asset_id)}
                  disabled={!isAuthenticated}
                  title="Remove asset"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="doc-asset-form">
          <input
            value={assetTitle}
            onChange={(e) => setAssetTitle(e.target.value)}
            placeholder="Asset title"
            className="doc-asset-input"
          />
          <input
            value={assetUrl}
            onChange={(e) => setAssetUrl(e.target.value)}
            placeholder="URL (https://...)"
            className="doc-asset-input"
            type="url"
          />
          <select value={assetFileType} onChange={(e) => setAssetFileType(e.target.value)}>
            {FILE_TYPES.map(t => (
              <option key={t} value={t}>{FILE_TYPE_ICONS[t]} {t}</option>
            ))}
          </select>
          <input
            value={assetDescription}
            onChange={(e) => setAssetDescription(e.target.value)}
            placeholder="Description (optional)"
            className="doc-asset-input doc-asset-input-wide"
          />
          <button
            className="btn btn-primary"
            onClick={addAsset}
            disabled={addingAsset || !isAuthenticated || !assetTitle.trim() || !assetUrl.trim()}
          >
            {addingAsset ? 'Adding...' : '+ Add'}
          </button>
        </div>
      </section>

      {/* ── Body editor ─────────────────────────────────────────────────── */}
      <section className="doc-body-section">
        <h3>Document Body</h3>
        <div className="editor-toolbar">
          {isDirty && <span className="dirty-indicator">Unsaved changes</span>}
        </div>

        <RichTextEditor
          content={editorContent}
          onChange={handleContentChange}
          placeholder="Write document content here..."
          contentEntries={contentEntries}
        />

        <div className="editor-footer-row">
          <input
            className="summary-input"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Revision summary (optional)"
            maxLength={120}
          />
          <button
            className="btn btn-primary"
            onClick={saveBody}
            disabled={!isDirty || saving || !isAuthenticated}
          >
            {saving ? 'Saving...' : 'Save revision'}
          </button>
        </div>
      </section>

      {/* ── Revisions ───────────────────────────────────────────────────── */}
      {state && state.revisions.length > 0 && (
        <section className="revision-list">
          <h3>Revisions ({state.revisions.length})</h3>
          <ol reversed>
            {state.revisions.slice().reverse().map((r) => (
              <li key={r.rev_id} className="rev-item">
                <div className="rev-item-header">
                  <span className="rev-id">{r.rev_id}</span>
                  <span className="rev-ts">{new Date(r.ts).toLocaleString()}</span>
                  <span className="rev-summary">{r.summary || '\u2014'}</span>
                  <button className="btn btn-xs" onClick={() => {
                    const html = r.format === 'markdown' ? mdToHtml(r.content) : r.content;
                    setEditorContent(html);
                    setIsDirty(true);
                  }}>Restore</button>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
