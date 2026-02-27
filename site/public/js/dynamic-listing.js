/**
 * dynamic-listing.js — Client-side content loader for listing pages.
 *
 * When the static build has no content (empty index.json), this script
 * fetches published content directly from the public Xano API and renders
 * it on wiki/index, blog/index, and exp/index pages.
 *
 * Include this script on any listing page with:
 *   <script src="/js/dynamic-listing.js" defer></script>
 */
(async function () {
  'use strict';

  var XANO_BASE = 'https://xvkq-pq7i-idtl.n7d.xano.io/api:GGzWIVAW';
  var PUBLIC_ENDPOINT = 'get_public_eowiki';

  // Detect if static content was already rendered
  var emptyMsg = document.querySelector('.empty-page');
  if (!emptyMsg) return; // Static build has content — nothing to do

  // Determine the content type from the URL path
  var path = window.location.pathname.replace(/\/+$/, '');
  var contentType = null;
  if (path.match(/\/wiki\/?$/)) contentType = 'wiki';
  else if (path.match(/\/blog\/?$/)) contentType = 'blog';
  else if (path.match(/\/exp\/?$/)) contentType = 'experiment';
  if (!contentType) return;

  // Derive base URL
  var baseTag = document.querySelector('link[rel="alternate"]');
  var base = '';
  if (baseTag) {
    base = (baseTag.getAttribute('href') || '').replace(/\/generated\/state\/index\.json$/, '');
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function itemUrl(type, slug) {
    switch (type) {
      case 'wiki': return base + '/wiki/' + slug + '/';
      case 'blog': return base + '/blog/' + slug + '/';
      case 'experiment': return base + '/exp/' + slug + '/';
      default: return base + '/';
    }
  }

  // ── Fetch from Xano ──────────────────────────────────────────────────────

  var records;
  try {
    var resp = await fetch(XANO_BASE + '/' + PUBLIC_ENDPOINT, {
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return;
    records = await resp.json();
  } catch (err) {
    console.warn('[eo-dynamic-listing] Public API fetch failed:', err);
    return;
  }

  if (!Array.isArray(records) || records.length === 0) return;

  // ── Parse response ───────────────────────────────────────────────────────

  var isCurrentFormat = records[0].record_id !== undefined && records[0].values !== undefined;
  var navEntries = [];
  var recordMap = {};

  if (isCurrentFormat) {
    for (var i = 0; i < records.length; i++) {
      recordMap[records[i].record_id] = records[i];
    }
    var indexRec = recordMap['site:index'];
    if (!indexRec) return;
    var siteIndex;
    try { siteIndex = JSON.parse(indexRec.values); } catch (e) { return; }
    navEntries = siteIndex.nav && siteIndex.nav.length > 0
      ? siteIndex.nav
      : (siteIndex.entries || []).filter(function (e) {
          return e.status === 'published' && e.visibility === 'public';
        });
  } else {
    var indexEvents = records
      .filter(function (r) { return r.subject === 'site:index' && r.op === 'DES'; })
      .sort(function (a, b) { return b.created_at - a.created_at; });
    if (indexEvents.length === 0) return;
    var indexOperand;
    try { indexOperand = JSON.parse(indexEvents[0].value); } catch (e) { return; }
    navEntries = (indexOperand.nav || indexOperand.entries || []).filter(function (e) {
      return e.status === 'published' && e.visibility === 'public';
    });

    // Build record map from event log
    var latestBySubject = {};
    for (var j = 0; j < records.length; j++) {
      var r = records[j];
      var rootSubject = r.subject.split('/')[0];
      if (!latestBySubject[rootSubject] || r.created_at > latestBySubject[rootSubject].created_at) {
        latestBySubject[rootSubject] = r;
      }
    }
    for (var subj in latestBySubject) {
      recordMap[subj] = { record_id: subj, values: latestBySubject[subj].value };
    }
  }

  // Filter to only the content type for this page
  var entries = navEntries.filter(function (e) { return e.content_type === contentType; });
  if (entries.length === 0) return;

  // Sort by most recent
  entries.sort(function (a, b) {
    var ta = a.first_public_at || a.updated_at || '';
    var tb = b.first_public_at || b.updated_at || '';
    return tb < ta ? -1 : tb > ta ? 1 : 0;
  });

  // ── Render ──────────────────────────────────────────────────────────────

  var section = emptyMsg.closest('.home-section') || emptyMsg.parentElement;
  if (!section) return;

  // Try to load excerpt from individual content records
  function getExcerpt(entry) {
    var rec = recordMap[entry.content_id];
    if (!rec) return '';
    try {
      var data = JSON.parse(rec.values);
      var text = (data.current_revision && data.current_revision.content) || '';
      if (!text) return '';
      // Strip HTML tags and markdown, take first 140 chars
      var plain = text.replace(/<[^>]+>/g, '').replace(/^#+\s+/gm, '').replace(/[*_`]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
      return plain.slice(0, 140).trimEnd() + (plain.length > 140 ? '\u2026' : '');
    } catch (e) { return ''; }
  }

  var html = '';

  if (contentType === 'blog') {
    // Blog uses card list layout
    html += '<ul class="content-list-cards">';
    for (var bi = 0; bi < entries.length; bi++) {
      var be = entries[bi];
      var bExcerpt = getExcerpt(be);
      html += '<li>';
      html += '<a class="list-card" href="' + itemUrl('blog', be.slug) + '">';
      html += '<div class="list-card-body">';
      html += '<div class="list-card-title">' + esc(be.title) + '</div>';
      if (bExcerpt) html += '<p class="card-excerpt">' + esc(bExcerpt) + '</p>';
      html += '<div class="list-card-meta">';
      html += '<code class="eo-op"><span class="eo-name">DES</span>(<span class="eo-target">' + esc(be.content_id) + '</span>)</code>';
      if (be.first_public_at) {
        html += '<time datetime="' + esc(be.first_public_at) + '">' + new Date(be.first_public_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) + '</time>';
      }
      if (be.tags && be.tags.length > 0) {
        html += '<span class="tags">';
        for (var bt = 0; bt < be.tags.length; bt++) {
          html += '<span class="tag">' + esc(be.tags[bt]) + '</span>';
        }
        html += '</span>';
      }
      html += '</div></div>';
      html += '<span class="list-card-arrow">\u2192</span>';
      html += '</a></li>';
    }
    html += '</ul>';
  } else {
    // Wiki and experiments use simple list layout
    html += '<ul class="content-list">';
    for (var wi = 0; wi < entries.length; wi++) {
      var we = entries[wi];
      html += '<li>';
      html += '<a href="' + itemUrl(contentType, we.slug) + '">' + esc(we.title) + '</a>';
      html += ' <code class="eo-op"><span class="eo-name">DES</span>(<span class="eo-target">' + esc(we.content_id) + '</span>)</code>';
      if (we.tags && we.tags.length > 0) {
        html += '<span class="tags">';
        for (var wt = 0; wt < we.tags.length; wt++) {
          html += '<span class="tag">' + esc(we.tags[wt]) + '</span>';
        }
        html += '</span>';
      }
      html += '</li>';
    }
    html += '</ul>';
  }

  // Replace the empty message with the content
  emptyMsg.outerHTML = html;

})();
