/**
 * GlobalSearchReplace — search-and-replace a term across all content.
 *
 * Scans all wiki/blog revisions, page blocks, experiment entries, and metadata
 * titles for a search term, then applies replacements by creating new revisions
 * (wiki/blog) or updating state snapshots (pages/experiments).
 */

import React, { useState, useCallback, useRef } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useSettings } from '../settings/SettingsContext';
import {
  upsertCurrentRecord,
  type XanoCurrentRecord,
} from '../xano/client';
import { fetchAllCurrentRecordsCached, invalidateCurrentCache } from '../xano/stateCache';

// ── Types ──────────────────────────────────────────────────────────────────

interface Match {
  /** Xano record_id, e.g. "wiki:operators" */
  recordId: string;
  /** Human label for the match location */
  location: string;
  /** Content type */
  contentType: string;
  /** The field path where the match was found */
  field: string;
  /** Text snippet surrounding the match */
  snippet: string;
  /** Number of occurrences in this field */
  count: number;
  /** Whether this match is selected for replacement */
  selected: boolean;
}

interface ReplaceResult {
  recordId: string;
  location: string;
  success: boolean;
  error?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a context snippet around the first match. */
function buildSnippet(text: string, term: string, contextChars = 60): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(term.toLowerCase());
  if (idx < 0) return '';
  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + term.length + contextChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end) + suffix;
}

/** Count occurrences (case-insensitive or exact based on flag). */
function countOccurrences(text: string, term: string, caseSensitive: boolean): number {
  if (!term) return 0;
  const flags = caseSensitive ? 'g' : 'gi';
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = text.match(new RegExp(escaped, flags));
  return matches ? matches.length : 0;
}

/** Perform the replacement on a string. */
function replaceAll(text: string, search: string, replacement: string, caseSensitive: boolean): string {
  const flags = caseSensitive ? 'g' : 'gi';
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, flags), replacement);
}

// ── Component ──────────────────────────────────────────────────────────────

interface Props {
  siteBase: string;
}

export default function GlobalSearchReplace({ siteBase }: Props) {
  const { isAuthenticated } = useAuth();
  const { settings } = useSettings();

  const [searchTerm, setSearchTerm] = useState('');
  const [replaceTerm, setReplaceTerm] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [searching, setSearching] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [matches, setMatches] = useState<Match[]>([]);
  const [results, setResults] = useState<ReplaceResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep a reference to the raw records so we can mutate them during replace
  const recordsRef = useRef<Map<string, XanoCurrentRecord>>(new Map());

  // ── Search ──────────────────────────────────────────────────────────────

  const doSearch = useCallback(async () => {
    if (!searchTerm.trim()) return;
    setSearching(true);
    setError(null);
    setResults([]);
    setHasSearched(true);

    try {
      invalidateCurrentCache();
      const records = await fetchAllCurrentRecordsCached();
      const recordMap = new Map<string, XanoCurrentRecord>();
      const found: Match[] = [];

      for (const rec of records) {
        recordMap.set(rec.record_id, rec);

        // Skip the site:index record
        if (rec.record_id === 'site:index') continue;

        let snapshot: Record<string, unknown>;
        try {
          snapshot = JSON.parse(rec.values);
        } catch {
          continue;
        }

        const contentType = rec.record_id.split(':')[0] || 'unknown';
        const title = (snapshot.meta as Record<string, unknown>)?.title as string || rec.record_id;

        // Search metadata title
        if (typeof title === 'string') {
          const count = countOccurrences(title, searchTerm, caseSensitive);
          if (count > 0) {
            found.push({
              recordId: rec.record_id,
              location: title,
              contentType,
              field: 'meta.title',
              snippet: buildSnippet(title, searchTerm),
              count,
              selected: true,
            });
          }
        }

        // Search wiki/blog current revision content
        if (contentType === 'wiki' || contentType === 'blog') {
          const rev = snapshot.current_revision as Record<string, unknown> | null;
          if (rev && typeof rev.content === 'string') {
            const count = countOccurrences(rev.content, searchTerm, caseSensitive);
            if (count > 0) {
              found.push({
                recordId: rec.record_id,
                location: `${title} (current revision)`,
                contentType,
                field: 'current_revision.content',
                snippet: buildSnippet(rev.content, searchTerm),
                count,
                selected: true,
              });
            }
          }
        }

        // Search page blocks
        if (contentType === 'page') {
          const blocks = snapshot.blocks as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(blocks)) {
            for (const block of blocks) {
              const data = block.data as Record<string, unknown> | undefined;
              if (!data) continue;

              // Check common text fields in block data
              for (const key of ['body', 'text', 'content', 'html', 'caption', 'label', 'title', 'heading']) {
                const val = data[key];
                if (typeof val === 'string') {
                  const count = countOccurrences(val, searchTerm, caseSensitive);
                  if (count > 0) {
                    found.push({
                      recordId: rec.record_id,
                      location: `${title} / block ${block.block_id} (${block.block_type})`,
                      contentType,
                      field: `blocks.${block.block_id}.data.${key}`,
                      snippet: buildSnippet(val, searchTerm),
                      count,
                      selected: true,
                    });
                  }
                }
              }

              // Also deep-search stringified block data for nested matches
              const dataStr = JSON.stringify(data);
              if (countOccurrences(dataStr, searchTerm, caseSensitive) > 0) {
                // Only add if we didn't already find it in specific fields
                const alreadyFound = found.some(
                  m => m.recordId === rec.record_id && m.field.startsWith(`blocks.${block.block_id}`)
                );
                if (!alreadyFound) {
                  found.push({
                    recordId: rec.record_id,
                    location: `${title} / block ${block.block_id} (${block.block_type}) [nested]`,
                    contentType,
                    field: `blocks.${block.block_id}.data._json`,
                    snippet: buildSnippet(dataStr, searchTerm),
                    count: countOccurrences(dataStr, searchTerm, caseSensitive),
                    selected: true,
                  });
                }
              }
            }
          }
        }

        // Search experiment entries
        if (contentType === 'experiment') {
          const entries = snapshot.entries as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(entries)) {
            for (const entry of entries) {
              const data = entry.data as Record<string, unknown> | undefined;
              if (!data) continue;
              const dataStr = JSON.stringify(data);
              const count = countOccurrences(dataStr, searchTerm, caseSensitive);
              if (count > 0) {
                found.push({
                  recordId: rec.record_id,
                  location: `${title} / entry ${entry.entry_id} (${entry.kind})`,
                  contentType,
                  field: `entries.${entry.entry_id}.data`,
                  snippet: buildSnippet(dataStr, searchTerm),
                  count,
                  selected: true,
                });
              }
            }
          }

          // Also check experiment current_revision
          const rev = snapshot.current_revision as Record<string, unknown> | null;
          if (rev && typeof rev.content === 'string') {
            const count = countOccurrences(rev.content, searchTerm, caseSensitive);
            if (count > 0) {
              found.push({
                recordId: rec.record_id,
                location: `${title} (current revision)`,
                contentType,
                field: 'current_revision.content',
                snippet: buildSnippet(rev.content, searchTerm),
                count,
                selected: true,
              });
            }
          }
        }
      }

      recordsRef.current = recordMap;
      setMatches(found);
    } catch (err) {
      setError(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSearching(false);
    }
  }, [searchTerm, caseSensitive]);

  // ── Replace ─────────────────────────────────────────────────────────────

  const doReplace = useCallback(async () => {
    const selected = matches.filter(m => m.selected);
    if (selected.length === 0) return;

    setReplacing(true);
    setError(null);
    const replaceResults: ReplaceResult[] = [];

    // Group matches by recordId so we apply all changes to one record at once
    const byRecord = new Map<string, Match[]>();
    for (const m of selected) {
      const existing = byRecord.get(m.recordId) || [];
      existing.push(m);
      byRecord.set(m.recordId, existing);
    }

    const agent = settings.displayName || 'editor';

    for (const [recordId, recordMatches] of byRecord) {
      const rec = recordsRef.current.get(recordId);
      if (!rec) {
        replaceResults.push({ recordId, location: recordId, success: false, error: 'Record not found in cache' });
        continue;
      }

      try {
        let snapshot: Record<string, unknown> = JSON.parse(rec.values);
        const contentType = recordId.split(':')[0];

        for (const match of recordMatches) {
          if (match.field === 'meta.title') {
            const meta = (snapshot.meta || {}) as Record<string, unknown>;
            if (typeof meta.title === 'string') {
              meta.title = replaceAll(meta.title, searchTerm, replaceTerm, caseSensitive);
              snapshot.meta = meta;
            }
          } else if (match.field === 'current_revision.content') {
            // For wiki/blog/experiment: update the current revision content
            // and add a new revision to the revisions array
            const rev = snapshot.current_revision as Record<string, unknown> | null;
            if (rev && typeof rev.content === 'string') {
              const newContent = replaceAll(rev.content, searchTerm, replaceTerm, caseSensitive);
              const newRevId = `r_${Date.now()}`;
              const newRev = {
                ...rev,
                rev_id: newRevId,
                content: newContent,
                summary: `Global replace: "${searchTerm}" → "${replaceTerm}"`,
                ts: new Date().toISOString(),
              };
              snapshot.current_revision = newRev;
              const revisions = (snapshot.revisions || []) as Array<Record<string, unknown>>;
              revisions.push(newRev);
              snapshot.revisions = revisions;
            }
          } else if (match.field.startsWith('blocks.')) {
            // Page blocks
            const parts = match.field.split('.');
            const blockId = parts[1];
            const blocks = (snapshot.blocks || []) as Array<Record<string, unknown>>;
            const block = blocks.find(b => b.block_id === blockId);
            if (block) {
              const data = (block.data || {}) as Record<string, unknown>;
              if (parts[3] === '_json') {
                // Deep replace on entire JSON data
                const replaced = replaceAll(JSON.stringify(data), searchTerm, replaceTerm, caseSensitive);
                try {
                  block.data = JSON.parse(replaced);
                } catch {
                  // If JSON parse fails after replace, skip
                  replaceResults.push({ recordId, location: match.location, success: false, error: 'JSON replacement produced invalid data' });
                  continue;
                }
              } else {
                const fieldKey = parts[3];
                if (typeof data[fieldKey] === 'string') {
                  data[fieldKey] = replaceAll(data[fieldKey] as string, searchTerm, replaceTerm, caseSensitive);
                  block.data = data;
                }
              }
            }
          } else if (match.field.startsWith('entries.')) {
            // Experiment entries
            const parts = match.field.split('.');
            const entryId = parts[1];
            const entries = (snapshot.entries || []) as Array<Record<string, unknown>>;
            const entry = entries.find(e => e.entry_id === entryId);
            if (entry) {
              const replaced = replaceAll(JSON.stringify(entry.data), searchTerm, replaceTerm, caseSensitive);
              try {
                entry.data = JSON.parse(replaced);
              } catch {
                replaceResults.push({ recordId, location: match.location, success: false, error: 'JSON replacement produced invalid data' });
                continue;
              }
            }
          }
        }

        // Update the meta timestamp
        const meta = (snapshot.meta || {}) as Record<string, unknown>;
        meta.updated_at = new Date().toISOString();
        snapshot.meta = meta;

        // Upsert the updated snapshot
        await upsertCurrentRecord(recordId, snapshot, agent, rec);

        for (const match of recordMatches) {
          replaceResults.push({ recordId, location: match.location, success: true });
        }
      } catch (err) {
        for (const match of recordMatches) {
          replaceResults.push({
            recordId,
            location: match.location,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    setResults(replaceResults);
    setReplacing(false);
    invalidateCurrentCache();

    // Clear matches that were successfully replaced
    const failedIds = new Set(
      replaceResults.filter(r => !r.success).map(r => `${r.recordId}:${r.location}`)
    );
    setMatches(prev => prev.filter(m => failedIds.has(`${m.recordId}:${m.location}`)));
  }, [matches, searchTerm, replaceTerm, caseSensitive, settings.displayName]);

  // ── Selection helpers ───────────────────────────────────────────────────

  function toggleMatch(idx: number) {
    setMatches(prev => prev.map((m, i) => i === idx ? { ...m, selected: !m.selected } : m));
  }

  function selectAll() {
    setMatches(prev => prev.map(m => ({ ...m, selected: true })));
  }

  function selectNone() {
    setMatches(prev => prev.map(m => ({ ...m, selected: false })));
  }

  const selectedCount = matches.filter(m => m.selected).length;
  const totalOccurrences = matches.filter(m => m.selected).reduce((sum, m) => sum + m.count, 0);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="gsr">
      <div className="gsr-header">
        <h2>Global Search &amp; Replace</h2>
        <p className="gsr-desc">
          Find and replace a term across all wiki pages, blog posts, page blocks, and experiments.
          Changes are applied as new revisions (wiki/blog) or direct state updates (pages/experiments).
        </p>
      </div>

      {error && (
        <div className="error-banner">
          {error}
          <button onClick={() => setError(null)}>&times;</button>
        </div>
      )}

      {/* Search form */}
      <div className="gsr-form">
        <div className="gsr-inputs">
          <label className="field">
            <span>Search for</span>
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Term to find…"
              onKeyDown={e => e.key === 'Enter' && doSearch()}
            />
          </label>
          <label className="field">
            <span>Replace with</span>
            <input
              type="text"
              value={replaceTerm}
              onChange={e => setReplaceTerm(e.target.value)}
              placeholder="Replacement text…"
              onKeyDown={e => e.key === 'Enter' && doSearch()}
            />
          </label>
        </div>
        <div className="gsr-options">
          <label className="gsr-checkbox">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={e => setCaseSensitive(e.target.checked)}
            />
            <span>Case sensitive</span>
          </label>
          <button
            className="btn btn-primary"
            onClick={doSearch}
            disabled={searching || !searchTerm.trim()}
          >
            {searching ? 'Searching…' : 'Search all content'}
          </button>
        </div>
      </div>

      {/* Results */}
      {hasSearched && !searching && (
        <div className="gsr-results">
          {matches.length === 0 ? (
            <div className="gsr-no-results">
              No matches found for &ldquo;{searchTerm}&rdquo;
            </div>
          ) : (
            <>
              <div className="gsr-results-header">
                <span className="gsr-results-count">
                  {matches.length} match{matches.length !== 1 ? 'es' : ''} across content
                  {selectedCount > 0 && ` (${selectedCount} selected, ${totalOccurrences} occurrence${totalOccurrences !== 1 ? 's' : ''})`}
                </span>
                <div className="gsr-select-actions">
                  <button className="btn btn-xs" onClick={selectAll}>Select all</button>
                  <button className="btn btn-xs" onClick={selectNone}>Select none</button>
                </div>
              </div>

              <div className="gsr-match-list">
                {matches.map((m, idx) => (
                  <label key={`${m.recordId}-${m.field}-${idx}`} className={`gsr-match ${m.selected ? 'gsr-match-selected' : ''}`}>
                    <input
                      type="checkbox"
                      checked={m.selected}
                      onChange={() => toggleMatch(idx)}
                    />
                    <div className="gsr-match-info">
                      <div className="gsr-match-location">
                        <span className={`gsr-badge gsr-badge-${m.contentType}`}>{m.contentType}</span>
                        <span>{m.location}</span>
                        <span className="gsr-match-count">{m.count}x</span>
                      </div>
                      <div className="gsr-match-field">{m.field}</div>
                      <div className="gsr-match-snippet">
                        <HighlightedSnippet snippet={m.snippet} term={searchTerm} caseSensitive={caseSensitive} />
                      </div>
                    </div>
                  </label>
                ))}
              </div>

              {/* Replace button */}
              <div className="gsr-actions">
                <button
                  className="btn btn-primary btn-danger-confirm"
                  onClick={doReplace}
                  disabled={replacing || selectedCount === 0 || !isAuthenticated}
                  title={!isAuthenticated ? 'Login required to make changes' : undefined}
                >
                  {replacing
                    ? 'Replacing…'
                    : `Replace ${selectedCount} match${selectedCount !== 1 ? 'es' : ''} (${totalOccurrences} occurrence${totalOccurrences !== 1 ? 's' : ''})`
                  }
                </button>
                {!isAuthenticated && (
                  <span className="gsr-auth-warn">Login required to apply changes</span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Replace results */}
      {results.length > 0 && (
        <div className="gsr-replace-results">
          <h3>Results</h3>
          <ul>
            {results.map((r, i) => (
              <li key={i} className={r.success ? 'gsr-result-ok' : 'gsr-result-err'}>
                <span className={r.success ? 'gsr-status-ok' : 'gsr-status-err'}>
                  {r.success ? 'OK' : 'ERR'}
                </span>
                <span>{r.location}</span>
                {r.error && <span className="gsr-result-error">{r.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Highlighted snippet ──────────────────────────────────────────────────────

function HighlightedSnippet({ snippet, term, caseSensitive }: { snippet: string; term: string; caseSensitive: boolean }) {
  if (!term) return <code>{snippet}</code>;
  const flags = caseSensitive ? 'g' : 'gi';
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = snippet.split(new RegExp(`(${escaped})`, flags));
  return (
    <code>
      {parts.map((part, i) => {
        const isMatch = caseSensitive
          ? part === term
          : part.toLowerCase() === term.toLowerCase();
        return isMatch
          ? <mark key={i} className="gsr-highlight">{part}</mark>
          : <span key={i}>{part}</span>;
      })}
    </code>
  );
}
