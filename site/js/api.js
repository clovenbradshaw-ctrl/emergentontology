/**
 * api.js — Data loading layer (current-state-first).
 *
 * The site loads entirely from the current-state table (eowikicurrent).
 * The event log is NOT used on the public site — it exists only for
 * admin change tracking.  If the event log were deleted, the site
 * continues to work normally.
 *
 * Sources (in priority order):
 *   1. Static JSON files (generated at build time by the projector)
 *   2. Xano current-state API (get_eowikicurrent — paginated list)
 *
 * The Xano endpoint supports pagination:
 *   ?page=1&per_page=25   → paginated results (default 25 per page)
 *
 * Provides:
 *   - loadIndex()   → SiteIndex
 *   - loadContent() → content object for a specific content_id
 *
 * Handles deduplication, caching, error recovery, and index synthesis.
 */

import { BASE, API_TIMEOUT, SUBSTACK_FEED_URL } from './config.js';

// Xano current-state endpoint — paginated list of all records.
var XANO_PUBLIC = 'https://xvkq-pq7i-idtl.n7d.xano.io/api:GGzWIVAW/get_eowikicurrent';

// ── State ────────────────────────────────────────────────────────────────────

var _siteIndex = null;
var _contentCache = {};
var _apiRecords = null;      // deduped map of record_id → record
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

// ── Xano paginated fetch ─────────────────────────────────────────────────────

/**
 * Fetch ALL records from the Xano paginated endpoint.
 * Iterates through pages until all records are loaded.
 * Returns a deduped map: record_id → record.
 *
 * @param {Object} [filters] - Optional server-side filters:
 *   id, created_at, record_id, displayName, values, context,
 *   uuid, lastModified (all optional, maps to Xano WHERE clauses)
 */
function fetchAllXanoRecords(filters) {
  // When no filters, use the cached result
  if (!filters && _apiRecords) return Promise.resolve(_apiRecords);
  if (!filters && _apiPromise) return _apiPromise;

  console.log('[eo] Fetching records from Xano (paginated)…');

  var promise = fetchXanoPage(1, [], filters)
    .then(function (allRecords) {
      if (!filters) _apiPromise = null;
      if (!allRecords || allRecords.length === 0) return null;

      var result = dedup(allRecords);
      var ids = Object.keys(result);
      console.log('[eo] Fetched ' + allRecords.length + ' records, ' + ids.length + ' unique');
      if (!filters) _apiRecords = result;
      return result;
    })
    .catch(function (e) {
      if (!filters) _apiPromise = null;
      console.warn('[eo] Xano fetch failed:', e.message || e);
      return null;
    });

  if (!filters) _apiPromise = promise;
  return promise;
}

/**
 * Build query string from optional filter params.
 * Supported Xano-native filters: id, created_at, record_id,
 * displayName, values, context, uuid, lastModified.
 */
function buildFilterQS(filters) {
  if (!filters) return '';
  var parts = [];
  var keys = ['id', 'created_at', 'record_id', 'displayName', 'values', 'context', 'uuid', 'lastModified'];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (filters[k] != null) {
      var v = (typeof filters[k] === 'object') ? JSON.stringify(filters[k]) : String(filters[k]);
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
  }
  return parts.length > 0 ? '&' + parts.join('&') : '';
}

/**
 * Fetch a single page from Xano and recurse for remaining pages.
 * @param {number} page - Page number
 * @param {Array} accumulated - Records accumulated so far
 * @param {Object} [filters] - Optional server-side filters
 */
function fetchXanoPage(page, accumulated, filters) {
  var url = XANO_PUBLIC + '?page=' + page + '&per_page=25' + buildFilterQS(filters);

  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, API_TIMEOUT);

  return fetch(url, { signal: controller.signal })
    .then(function (r) {
      clearTimeout(timer);
      if (!r.ok) {
        console.warn('[eo] Xano page ' + page + ' returned HTTP ' + r.status);
        return accumulated;
      }
      return r.json();
    })
    .then(function (data) {
      if (!data) return accumulated;

      // Handle paginated response: { items: [...], curPage, nextPage, pageTotal, itemsTotal }
      var records = Array.isArray(data) ? data : (data.items || []);
      var all = accumulated.concat(records);

      // Check if there are more pages
      var hasMore = data.nextPage && data.curPage < data.pageTotal;
      if (hasMore) {
        return fetchXanoPage(data.nextPage, all, filters);
      }

      console.log('[eo] Loaded ' + all.length + ' / ' + (data.itemsTotal || all.length) + ' records');
      return all;
    })
    .catch(function (e) {
      clearTimeout(timer);
      console.warn('[eo] Xano page ' + page + ' fetch error:', e.message || e);
      // Return what we have so far
      return accumulated;
    });
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
  return fetchAllXanoRecords().then(function (map) {
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
  var CONTENT_PREFIXES = ['wiki:', 'blog:', 'experiment:', 'page:', 'document:'];
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
        data._source = 'static';
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
 * Load content from API — fetches all records then finds matching one.
 */
function loadContentFromApi(contentId) {
  return fetchAllXanoRecords().then(function (map) {
    if (!map || !map[contentId]) return null;
    return parseContentRecord(contentId, map[contentId]);
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

    parsed._source = 'current_state';
    _contentCache[contentId] = parsed;
    return parsed;
  } catch (e) {
    console.warn('[eo] Failed to parse content for ' + contentId + ':', e.message);
    return null;
  }
}

// ── Substack RSS feed ─────────────────────────────────────────────────────

var _substackPosts = null;
var _substackPromise = null;

/**
 * Fetch and parse the Substack RSS feed.
 * Returns an array of post objects:
 *   { title, slug, link, description, content, pubDate, author, categories }
 */
export function loadSubstackFeed() {
  if (_substackPosts) return Promise.resolve(_substackPosts);
  if (_substackPromise) return _substackPromise;

  _substackPromise = fetch(SUBSTACK_FEED_URL)
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .then(function (xml) {
      _substackPosts = parseRssFeed(xml);
      _substackPromise = null;
      console.log('[eo] Loaded ' + _substackPosts.length + ' Substack posts');
      return _substackPosts;
    })
    .catch(function (e) {
      console.warn('[eo] Substack feed fetch failed:', e.message || e);
      _substackPromise = null;
      _substackPosts = [];
      return _substackPosts;
    });

  return _substackPromise;
}

function parseRssFeed(xml) {
  var parser = new DOMParser();
  var doc = parser.parseFromString(xml, 'text/xml');
  var items = doc.querySelectorAll('item');
  var posts = [];

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var link = textContent(item, 'link') || '';
    var slug = extractSlug(link);

    // Get content:encoded (CDATA) — try namespace first, then plain tag
    var contentEl = item.getElementsByTagNameNS('http://purl.org/rss/1.0/modules/content/', 'encoded')[0]
      || item.querySelector('content\\:encoded');
    var content = contentEl ? contentEl.textContent || '' : '';

    // Categories
    var catEls = item.querySelectorAll('category');
    var categories = [];
    for (var j = 0; j < catEls.length; j++) {
      var cat = (catEls[j].textContent || '').trim();
      if (cat) categories.push(cat);
    }

    posts.push({
      title: textContent(item, 'title') || 'Untitled',
      slug: slug,
      link: link,
      description: textContent(item, 'description') || '',
      content: content,
      pubDate: textContent(item, 'pubDate') || '',
      author: textContent(item, 'dc\\:creator') || textContent(item, 'author') || '',
      categories: categories
    });
  }

  return posts;
}

function textContent(parent, tag) {
  var el = parent.querySelector(tag);
  return el ? (el.textContent || '').trim() : '';
}

function extractSlug(url) {
  if (!url) return '';
  try {
    var path = new URL(url).pathname;
    // Substack URLs: /p/post-slug
    var match = path.match(/\/p\/([^\/]+)/);
    return match ? match[1] : path.replace(/^\/|\/$/g, '').replace(/\//g, '-') || '';
  } catch (e) {
    return '';
  }
}
