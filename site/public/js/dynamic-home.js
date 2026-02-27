/**
 * dynamic-home.js — Client-side content loader for the home page.
 *
 * When the static build has no content (empty index.json), this script
 * fetches published content directly from the public Xano API and renders
 * it on the page. Works for all visitors — no admin login required.
 *
 * Architecture:
 *   1. Check if static content was rendered (any .home-section elements)
 *   2. If empty, fetch from the public Xano API endpoint
 *   3. Parse the site:index record to get published entries
 *   4. Render content cards and home page blocks dynamically
 */
(async function () {
  'use strict';

  var XANO_BASE = 'https://xvkq-pq7i-idtl.n7d.xano.io/api:GGzWIVAW';
  var PUBLIC_ENDPOINT = 'get_public_eowiki';

  // Derive base URL from data attribute or <link rel="alternate">
  var homeColumns = document.querySelector('.home-columns');
  var base = (homeColumns && homeColumns.getAttribute('data-base')) || '';

  // Check if static content exists
  var mainCol = document.querySelector('.home-col-main');
  var heroSection = document.querySelector('.home-hero');
  var editableSection = document.querySelector('.home-editable');
  var staticSections = mainCol ? mainCol.querySelectorAll('.home-section').length : 0;
  var hasStaticContent = staticSections > 0 || !!editableSection;

  // Only fetch dynamically if static build is empty
  if (hasStaticContent) return;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function typeUrl(type) {
    switch (type) {
      case 'wiki': return base + '/wiki/';
      case 'blog': return base + '/blog/';
      case 'experiment': return base + '/exp/';
      case 'page': return base + '/page/';
      default: return base + '/';
    }
  }

  function itemUrl(type, slug) {
    return typeUrl(type) + slug + '/';
  }

  function typeIcon(type) {
    switch (type) {
      case 'wiki': return 'ph-book-open-text';
      case 'blog': return 'ph-pen-nib';
      case 'experiment': return 'ph-flask';
      case 'page': return 'ph-file-text';
      default: return 'ph-file';
    }
  }

  var typeLabels = { wiki: 'Wiki', blog: 'Blog', experiment: 'Experiments', page: 'Pages' };

  // Simple markdown → HTML for text blocks
  function simpleMd(md) {
    if (!md) return '';
    return md
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/^(?!<[a-z]).+$/gm, function (line) {
        var t = line.trim();
        return t ? '<p>' + t + '</p>' : '';
      });
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
    console.warn('[eo-dynamic] Public API fetch failed:', err);
    return;
  }

  if (!Array.isArray(records) || records.length === 0) return;

  // ── Detect response format ───────────────────────────────────────────────
  // XanoCurrentRecord has record_id + values (current state snapshots)
  // XanoRecord has op + subject + value (event log)

  var isCurrentFormat = records[0].record_id !== undefined && records[0].values !== undefined;

  var recordMap = {};
  var siteIndex = null;
  var navEntries = [];

  if (isCurrentFormat) {
    // ── Handle XanoCurrentRecord[] format ─────────────────────────────────
    for (var i = 0; i < records.length; i++) {
      recordMap[records[i].record_id] = records[i];
    }

    var indexRec = recordMap['site:index'];
    if (!indexRec) return;

    try {
      siteIndex = JSON.parse(indexRec.values);
    } catch (e) {
      return;
    }

    // Use nav (pre-filtered published+public) or filter entries ourselves
    navEntries = siteIndex.nav && siteIndex.nav.length > 0
      ? siteIndex.nav
      : (siteIndex.entries || []).filter(function (e) {
          return e.status === 'published' && e.visibility === 'public';
        });

  } else {
    // ── Handle XanoRecord[] format (event log) ─────────────────────────────
    // Extract the most recent DES event for site:index to get the entries list
    var indexEvents = records
      .filter(function (r) { return r.subject === 'site:index' && r.op === 'DES'; })
      .sort(function (a, b) { return b.created_at - a.created_at; });

    if (indexEvents.length === 0) return;

    try {
      var indexOperand = JSON.parse(indexEvents[0].value);
      // The DES operand for site:index contains the full state
      siteIndex = indexOperand;
      navEntries = (siteIndex.nav || siteIndex.entries || []).filter(function (e) {
        return e.status === 'published' && e.visibility === 'public';
      });
    } catch (e) {
      return;
    }

    // Build a record map from the event log (most recent event per subject)
    var latestBySubject = {};
    for (var j = 0; j < records.length; j++) {
      var r = records[j];
      var rootSubject = r.subject.split('/')[0];
      if (!latestBySubject[rootSubject] || r.created_at > latestBySubject[rootSubject].created_at) {
        latestBySubject[rootSubject] = r;
      }
    }
    // Wrap event log entries in a current-record-like shape
    for (var subj in latestBySubject) {
      recordMap[subj] = { record_id: subj, values: latestBySubject[subj].value };
    }
  }

  if (navEntries.length === 0 && !recordMap['page:home']) return;

  // ── Render page:home blocks if present ────────────────────────────────────

  var homeRec = recordMap['page:home'];
  var homeState = null;
  if (homeRec) {
    try {
      homeState = JSON.parse(homeRec.values);
    } catch (e) { /* ignore */ }
  }

  var hasHomeBlocks = homeState && homeState.block_order && homeState.block_order.length > 0;

  if (hasHomeBlocks && heroSection) {
    var blockMap = {};
    if (homeState.blocks) {
      for (var b = 0; b < homeState.blocks.length; b++) {
        blockMap[homeState.blocks[b].block_id] = homeState.blocks[b];
      }
    }

    var html = '<section class="home-editable" data-eo-op="DES" data-eo-target="page:home">';
    html += '<div class="blocks">';

    var coveredTypes = {};

    for (var bi = 0; bi < homeState.block_order.length; bi++) {
      var blockId = homeState.block_order[bi];
      var block = blockMap[blockId];
      if (!block || block.deleted) continue;

      if (block.block_type === 'text') {
        html += '<div class="block-eo-wrap">' + simpleMd(block.data.md || block.data.text || '') + '</div>';

      } else if (block.block_type === 'heading') {
        var level = Math.min(Math.max(Number(block.data.level || 2), 1), 6);
        html += '<h' + level + ' class="block block-heading">' + esc(block.data.text || '') + '</h' + level + '>';

      } else if (block.block_type === 'callout') {
        html += '<aside class="block block-callout callout-' + esc(block.data.kind || 'info') + '"><div>' + simpleMd(block.data.text || '') + '</div></aside>';

      } else if (block.block_type === 'divider') {
        html += '<hr class="block block-divider" />';

      } else if (block.block_type === 'operator-grid') {
        var ops = [
          { symbol: '\u2205', code: 'NUL', greek: '\u03BD', label: 'Absence & Nullity', color: '#9ca3af', slug: 'nul' },
          { symbol: '\u22A1', code: 'DES', greek: '\u03B4', label: 'Designation', color: '#60a5fa', slug: 'des' },
          { symbol: '\u25B3', code: 'INS', greek: '\u03B9', label: 'Instantiation', color: '#4ade80', slug: 'ins' },
          { symbol: '\uFF5C', code: 'SEG', greek: '\u03C3', label: 'Segmentation', color: '#c084fc', slug: 'seg' },
          { symbol: '\u22C8', code: 'CON', greek: '\u03BA', label: 'Connection', color: '#34d399', slug: 'con' },
          { symbol: '\u2228', code: 'SYN', greek: '\u03C8', label: 'Synthesis', color: '#818cf8', slug: 'syn' },
          { symbol: '\u223F', code: 'ALT', greek: '\u03B4', label: 'Alternation', color: '#fbbf24', slug: 'alt' },
          { symbol: '\u2225', code: 'SUP', greek: '\u03C6', label: 'Superposition', color: '#f472b6', slug: 'sup' },
          { symbol: '\u27F3', code: 'REC', greek: '\u03C1', label: 'Recursion', color: '#fb923c', slug: 'rec' }
        ];
        html += '<section class="home-section"><div class="operator-grid-container" id="operator-grid-dynamic">';
        html += '<div class="rune-grid rune-grid--inline">';
        for (var o = 0; o < ops.length; o++) {
          var op = ops[o];
          html += '<a class="rune-cell" href="' + base + '/wiki/' + op.slug + '/" title="' + op.code + ' \u2014 ' + op.label + '" style="--rune-color: ' + op.color + '" data-symbol="' + op.symbol + '" data-code="' + op.code + '" data-greek="' + op.greek + '" data-label="' + op.label + '">';
          html += '<span class="rune-display" data-version="symbol">' + op.symbol + '</span>';
          html += '<span class="rune-display" data-version="code" hidden>' + op.code + '</span>';
          html += '<span class="rune-display" data-version="greek" hidden>' + op.greek + '</span>';
          html += '</a>';
        }
        html += '</div>';
        html += '<button class="alt-toggle" title="Switch naming version"><span class="alt-toggle-icon">\u223F</span></button>';
        html += '</div></section>';

      } else if (block.block_type === 'content-feed') {
        var feedType = String(block.data.content_type || 'wiki');
        var maxItems = Number(block.data.max_items || 6);
        coveredTypes[feedType] = true;
        var feedEntries = navEntries.filter(function (e) { return e.content_type === feedType; });
        if (feedEntries.length > 0) {
          html += '<section class="home-section">';
          html += '<div class="section-header"><h2 class="section-title"><i class="ph ' + typeIcon(feedType) + ' section-icon"></i> ' + esc(typeLabels[feedType] || feedType) + '</h2>';
          html += '<a class="section-viewall" href="' + typeUrl(feedType) + '">View all \u2192</a></div>';
          html += '<div class="content-grid">';
          for (var f = 0; f < Math.min(feedEntries.length, maxItems); f++) {
            var fe = feedEntries[f];
            html += '<a class="content-card" href="' + itemUrl(feedType, fe.slug) + '">';
            html += '<h3 class="card-title">' + esc(fe.title) + '</h3>';
            if (fe.tags && fe.tags.length > 0) {
              html += '<div class="card-tags">';
              for (var t = 0; t < Math.min(fe.tags.length, 3); t++) {
                html += '<span class="tag">' + esc(fe.tags[t]) + '</span>';
              }
              html += '</div>';
            }
            html += '</a>';
          }
          html += '</div></section>';
        }
      }
    }

    html += '</div>'; // .blocks
    html += '<div class="home-edit-link eo-admin-only" hidden>';
    html += '<a class="btn btn-edit" href="' + base + '/admin/#page/home">Edit Homepage</a>';
    html += '</div>';
    html += '</section>';

    heroSection.outerHTML = html;

    // Re-apply saved rune version to dynamically rendered grids
    var savedVersion = null;
    try { savedVersion = localStorage.getItem('eo-rune-version'); } catch (e) { /* SSR */ }
    savedVersion = savedVersion || 'symbol';
    document.querySelectorAll('.rune-grid').forEach(function (grid) {
      grid.querySelectorAll('.rune-cell').forEach(function (cell) {
        cell.querySelectorAll('.rune-display').forEach(function (d) {
          d.hidden = d.getAttribute('data-version') !== savedVersion;
        });
      });
    });

    // Wire up dynamic alt-toggle buttons
    var altIcons = { symbol: '\u223F', code: 'ALT', greek: '\u03B4' };
    document.querySelectorAll('#operator-grid-dynamic .alt-toggle').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        var vs = ['symbol', 'code', 'greek'];
        var curSaved = null;
        try { curSaved = localStorage.getItem('eo-rune-version'); } catch (ex) { /* SSR */ }
        var cur = vs.indexOf(curSaved || 'symbol');
        cur = (cur + 1) % vs.length;
        try { localStorage.setItem('eo-rune-version', vs[cur]); } catch (ex) { /* SSR */ }
        document.querySelectorAll('.rune-grid').forEach(function (g) {
          g.querySelectorAll('.rune-cell').forEach(function (c) {
            c.querySelectorAll('.rune-display').forEach(function (d) {
              d.hidden = d.getAttribute('data-version') !== vs[cur];
            });
          });
        });
        document.querySelectorAll('.alt-toggle-icon').forEach(function (el) {
          el.textContent = altIcons[vs[cur]];
        });
      });
    });

    // Reveal admin-only elements if logged in (but not in iframe/preview)
    try {
      if (window.self === window.top && localStorage.getItem('eo_xano_auth') === '1') {
        document.querySelectorAll('.eo-admin-only').forEach(function (el) {
          el.removeAttribute('hidden');
        });
      }
    } catch (e) { /* SSR */ }
  }

  // ── Render fallback content sections for types not covered by home blocks ──

  if (mainCol && navEntries.length > 0) {
    // Group entries by type
    var grouped = {};
    for (var k = 0; k < navEntries.length; k++) {
      var entry = navEntries[k];
      var ct = entry.content_type;
      if (!grouped[ct]) grouped[ct] = [];
      grouped[ct].push(entry);
    }

    // Hide the empty card
    var emptyCard = mainCol.querySelector('.home-empty');
    if (emptyCard) emptyCard.style.display = 'none';

    // Find insertion point (before tags section or at end)
    var insertBefore = mainCol.querySelector('.home-section--tags');

    var types = ['wiki', 'blog', 'experiment', 'page'];
    for (var ti = 0; ti < types.length; ti++) {
      var type = types[ti];
      if (coveredTypes && coveredTypes[type]) continue;
      var entries = grouped[type];
      if (!entries || entries.length === 0) continue;

      var section = document.createElement('section');
      section.className = 'home-section';
      var shtml = '<div class="section-header">';
      shtml += '<h2 class="section-title"><i class="ph ' + typeIcon(type) + ' section-icon"></i> ' + esc(typeLabels[type] || type) + '</h2>';
      shtml += '<a class="section-viewall" href="' + typeUrl(type) + '">View all \u2192</a>';
      shtml += '</div>';
      shtml += '<div class="content-grid' + (type === 'experiment' ? ' content-grid--sm' : '') + '">';
      for (var n = 0; n < Math.min(entries.length, 6); n++) {
        var ent = entries[n];
        shtml += '<a class="content-card' + (type === 'experiment' ? ' content-card--exp' : '') + '" href="' + itemUrl(type, ent.slug) + '">';
        shtml += '<h3 class="card-title">' + esc(ent.title) + '</h3>';
        if (ent.tags && ent.tags.length > 0) {
          shtml += '<div class="card-tags">';
          for (var tg = 0; tg < Math.min(ent.tags.length, 3); tg++) {
            shtml += '<span class="tag">' + esc(ent.tags[tg]) + '</span>';
          }
          shtml += '</div>';
        }
        shtml += '</a>';
      }
      shtml += '</div>';
      section.innerHTML = shtml;
      if (insertBefore) {
        mainCol.insertBefore(section, insertBefore);
      } else {
        mainCol.appendChild(section);
      }
    }

    // Update hero stats if present
    var heroStats = document.querySelector('.hero-stats');
    if (heroStats) {
      var total = navEntries.length;
      heroStats.textContent = total + ' ' + (total === 1 ? 'article' : 'articles');
      heroStats.style.display = '';
    }
  }

})();
