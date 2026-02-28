/**
 * api.js — Data loading layer.
 *
 * Fetches content from two sources in order:
 *   1. Static JSON files (generated at build time by the projector)
 *   2. Xano public API (get_public_eowiki with server-side filtering)
 *   3. N8N webhook fallback (legacy, fetches all records)
 *
 * The Xano endpoint supports query parameters:
 *   ?record_id=wiki:operators   → single record by ID
 *   ?content_type=wiki          → filter by type
 *   ?status=published           → filter by status (default: published)
 *   ?visibility=public          → filter by visibility (default: public)
 *
 * Provides:
 *   - loadIndex()   → SiteIndex
 *   - loadContent() → content object for a specific content_id
 *
 * Handles deduplication, caching, error recovery, and index synthesis.
 */

import { BASE, API_URL, API_TIMEOUT } from './config.js';

// Xano public endpoint — supports server-side filtering via query params.
var XANO_PUBLIC = 'https://xvkq-pq7i-idtl.n7d.xano.io/api:GGzWIVAW/get_public_eowiki';

// ── State ────────────────────────────────────────────────────────────────────

var _siteIndex = null;
var _contentCache = {};
var _apiRecords = null;      // deduped map of record_id → record (legacy full-fetch)
var _apiPromise = null;      // in-flight API fetch (prevents duplicate requests)
var _homeConfig = null;

// ── Public getters ───────────────────────────────────────────────────────────

export function getSiteIndex() { return _siteIndex; }
export function getHomeConfig() { return _homeConfig; }

// ── JSON fetch helper ────────────────────────────────────────────────────────

function fetchJson(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) return null;
    return r.json();
  }).catch(function () { return null; });
}

// ── Xano single-record fetch ─────────────────────────────────────────────────

/**
 * Fetch a single record from the Xano public endpoint by record_id.
 * Uses the server-side ?record_id= filter so we don't download everything.
 * Returns the parsed record object, or null on failure.
 */
function fetchXanoRecord(recordId) {
  var url = XANO_PUBLIC + '?record_id=' + encodeURIComponent(recordId);

  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, API_TIMEOUT);

  return fetch(url, { signal: controller.signal })
    .then(function (r) {
      clearTimeout(timer);
      if (!r.ok) return null;
      return r.json();
    })
    .then(function (data) {
      if (!data) return null;
      // Xano may return a single object or an array
      if (Array.isArray(data)) return data[0] || null;
      return data;
    })
    .catch(function (e) {
      clearTimeout(timer);
      console.warn('[eo] Xano single-record fetch failed for ' + recordId + ':', e.message || e);
      return null;
    });
}

// ── Legacy full-fetch (N8N webhook fallback) ─────────────────────────────────

/**
 * Fetch all current-state records from the N8N webhook (legacy fallback).
 * Returns a deduped map: record_id → most-recent record.
 * Only used when Xano single-record fetches fail and we need to synthesize.
 */
function fetchApiRecords() {
  if (_apiRecords) return Promise.resolve(_apiRecords);
  if (_apiPromise) return _apiPromise;

  console.log('[eo] Fetching all records from API (fallback)…');

  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, API_TIMEOUT);

  _apiPromise = fetch(API_URL, { signal: controller.signal })
    .then(function (r) {
      clearTimeout(timer);
      if (!r.ok) {
        console.warn('[eo] API returned HTTP ' + r.status);
        return null;
      }
      return r.json();
    })
    .then(function (data) {
      _apiPromise = null;
      if (!data) return null;

      // Handle both array responses and wrapped { records: [...] } responses
      var records = Array.isArray(data) ? data : (data.records || data.items || null);
      if (!Array.isArray(records)) {
        console.warn('[eo] API returned unexpected shape:', typeof data);
        return null;
      }

      _apiRecords = dedup(records);
      var ids = Object.keys(_apiRecords);
      console.log('[eo] Fetched ' + records.length + ' records, ' + ids.length + ' unique');
      return _apiRecords;
    })
    .catch(function (e) {
      clearTimeout(timer);
      _apiPromise = null;
      console.warn('[eo] API fetch failed:', e.message || e);
      return null;
    });

  return _apiPromise;
}

/**
 * Deduplicate records by record_id, keeping the most recently modified.
 * Handles records with or without lastModified timestamps.
 */
function dedup(records) {
  var map = {};
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    var id = r.record_id;
    if (!id) continue; // skip records without a record_id

    var prev = map[id];
    if (!prev) {
      map[id] = r;
      continue;
    }

    // Compare by lastModified — handle string dates and epoch numbers
    var prevTime = parseTime(prev.lastModified);
    var rTime = parseTime(r.lastModified);
    if (rTime > prevTime) map[id] = r;
  }
  return map;
}

function parseTime(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  var t = new Date(val).getTime();
  return isNaN(t) ? 0 : t;
}

// ── Home config loading ──────────────────────────────────────────────────────

/**
 * Load the homepage config from generated/home.json (built from home.yaml).
 * Populates _homeConfig with hero, operators, sections from the YAML.
 */
export function loadHomeConfig() {
  if (_homeConfig) return Promise.resolve(_homeConfig);
  return fetchJson(BASE + '/generated/home.json')
    .then(function (data) {
      if (data) {
        _homeConfig = data;
        console.log('[eo] Loaded home config');
      }
      return _homeConfig;
    })
    .catch(function () { return null; });
}

// ── Index loading ────────────────────────────────────────────────────────────

/**
 * Load the site index.
 *
 * Strategy:
 *   1. Return cached index if available.
 *   2. Try static JSON (generated/state/index.json).
 *   3. Fall back to Xano — fetch just the site:index record.
 *   4. Fall back to N8N — fetch all, look for site:index or synthesize.
 *   5. If all else fails, return an empty index.
 */
export function loadIndex() {
  if (_siteIndex) return Promise.resolve(_siteIndex);

  // Load home config in parallel with the index
  loadHomeConfig();

  return fetchJson(BASE + '/generated/state/index.json')
    .then(function (data) {
      if (data && data.entries) {
        console.log('[eo] Using static index (' + data.entries.length + ' entries)');
        _siteIndex = normalizeIndex(data);
        return _siteIndex;
      }
      return loadIndexFromApi();
    })
    .catch(function (err) {
      console.warn('[eo] Index load error:', err);
      return loadIndexFromApi();
    });
}

function loadIndexFromApi() {
  // Try Xano single-record fetch for site:index first
  return fetchXanoRecord('site:index')
    .then(function (rec) {
      if (rec && rec.values) {
        try {
          var raw = JSON.parse(rec.values);
          if (raw && raw.entries) {
            console.log('[eo] Using site:index from Xano (' + raw.entries.length + ' entries)');
            _siteIndex = normalizeIndex(raw);
            return _siteIndex;
          }
        } catch (e) {
          console.warn('[eo] Failed to parse site:index from Xano:', e.message);
        }
      }

      // Xano single-record failed — fall back to N8N full fetch
      return loadIndexFromN8n();
    });
}

function loadIndexFromN8n() {
  return fetchApiRecords().then(function (map) {
    if (!map) {
      console.warn('[eo] No API data — showing empty site');
      _siteIndex = emptyIndex();
      return _siteIndex;
    }

    // Try the site:index record first
    if (map['site:index']) {
      try {
        var raw = JSON.parse(map['site:index'].values);
        if (raw && raw.entries) {
          console.log('[eo] Using site:index record (' + raw.entries.length + ' entries)');
          _siteIndex = normalizeIndex(raw);
          return _siteIndex;
        }
      } catch (e) {
        console.warn('[eo] Failed to parse site:index:', e.message);
      }
    }

    // No usable site:index — synthesize from individual content records
    console.log('[eo] No site:index — synthesizing from content records');
    _siteIndex = synthesizeIndex(map);
    return _siteIndex;
  });
}

/**
 * Normalize an index object — ensure nav and slug_map exist.
 */
function normalizeIndex(raw) {
  var entries = raw.entries || [];
  // Deduplicate by content_id (Xano index may contain duplicate entries)
  var dedupSeen = {};
  entries = entries.filter(function (e) {
    if (dedupSeen[e.content_id]) return false;
    dedupSeen[e.content_id] = true;
    return true;
  });
  var nav = raw.nav;
  if (!nav) {
    nav = entries.filter(function (e) {
      return e.status === 'published' && e.visibility === 'public';
    });
  }
  var slugMap = raw.slug_map || {};
  if (Object.keys(slugMap).length === 0) {
    entries.forEach(function (e) { slugMap[e.slug] = e.content_id; });
  }
  return {
    entries: entries,
    nav: nav,
    slug_map: slugMap,
    built_at: raw.built_at || '',
    site_settings: raw.site_settings || null
  };
}

function emptyIndex() {
  return { entries: [], nav: [], slug_map: {}, built_at: '', site_settings: null };
}

/**
 * Build a site index from individual content records in the API.
 * Each content record has a record_id like "wiki:operators", "page:about", etc.
 */
function synthesizeIndex(map) {
  var CONTENT_PREFIXES = ['wiki:', 'blog:', 'experiment:', 'page:'];
  var entries = [];

  var ids = Object.keys(map);
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    var isContent = false;
    for (var j = 0; j < CONTENT_PREFIXES.length; j++) {
      if (id.indexOf(CONTENT_PREFIXES[j]) === 0) { isContent = true; break; }
    }
    if (!isContent) continue;

    var rec = map[id];
    var parsed;
    try { parsed = JSON.parse(rec.values); } catch (e) { continue; }

    var meta = parsed.meta || {};
    if (meta.status === 'archived') continue;
    var parts = id.split(':');
    var prefix = parts[0];
    var slug = meta.slug || parts.slice(1).join(':');
    var contentType = meta.content_type || prefix;

    entries.push({
      content_id: id,
      slug: slug,
      title: meta.title || rec.displayName || slug,
      content_type: contentType,
      status: meta.status || 'published',
      visibility: meta.visibility || 'public',
      tags: meta.tags || [],
      updated_at: meta.updated_at || rec.lastModified || ''
    });
  }

  var nav = entries.filter(function (e) {
    return e.status === 'published' && e.visibility === 'public';
  });
  var slugMap = {};
  entries.forEach(function (e) { slugMap[e.slug] = e.content_id; });

  console.log('[eo] Synthesized index: ' + entries.length + ' entries, ' + nav.length + ' in nav');
  return { entries: entries, nav: nav, slug_map: slugMap, built_at: '', site_settings: null };
}

// ── Content loading ──────────────────────────────────────────────────────────

/**
 * Load content for a specific content_id.
 *
 * Strategy:
 *   1. Return cached content if available.
 *   2. Try static JSON (generated/state/content/{id}.json).
 *   3. Fall back to Xano — fetch single record by record_id.
 *   4. Fall back to N8N — fetch all records, find matching one.
 *   5. Return null if content not found anywhere.
 */
export function loadContent(contentId) {
  if (_contentCache[contentId]) return Promise.resolve(_contentCache[contentId]);

  var fileName = contentId.replace(':', '-') + '.json';

  return fetchJson(BASE + '/generated/state/content/' + fileName)
    .then(function (data) {
      if (data) {
        _contentCache[contentId] = data;
        return data;
      }
      return loadContentFromApi(contentId);
    })
    .catch(function () {
      return loadContentFromApi(contentId);
    });
}

/**
 * Load content from API — tries Xano single-record first, then N8N fallback.
 */
function loadContentFromApi(contentId) {
  // Try Xano single-record fetch first
  return fetchXanoRecord(contentId)
    .then(function (rec) {
      if (rec) {
        var parsed = parseContentRecord(contentId, rec);
        if (parsed) return parsed;
      }

      // Xano failed — fall back to N8N full fetch
      return fetchApiRecords().then(function (map) {
        if (!map || !map[contentId]) return null;
        return parseContentRecord(contentId, map[contentId]);
      });
    });
}

/**
 * Parse a raw API record into a content object.
 * Ensures content_id, meta, and content_type are set.
 */
function parseContentRecord(contentId, rec) {
  try {
    var parsed = JSON.parse(rec.values);
    if (!parsed) return null;

    // Ensure content_id is set at top level
    if (!parsed.content_id) parsed.content_id = contentId;

    // Ensure meta exists with at least basic fields
    if (!parsed.meta) {
      var parts = contentId.split(':');
      parsed.meta = {
        content_id: contentId,
        content_type: parts[0],
        slug: parts.slice(1).join(':'),
        title: rec.displayName || parts.slice(1).join(':'),
        status: 'published',
        visibility: 'public',
        tags: []
      };
    }

    // Ensure content_type is set at top level
    if (!parsed.content_type && parsed.meta) {
      parsed.content_type = parsed.meta.content_type;
    }

    _contentCache[contentId] = parsed;
    return parsed;
  } catch (e) {
    console.warn('[eo] Failed to parse content for ' + contentId + ':', e.message);
    return null;
  }
}
