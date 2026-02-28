/**
 * app.js — Emergent Ontology site engine
 *
 * Plain HTML/JS — no build step, no framework.
 *
 * Architecture (the EO way):
 *   Current State DB  →  generated/state/*.json  →  this script  →  DOM
 *   (eowikicurrent)       (projector output)        (client render)
 *
 *   History DB  →  revision lists in content JSON  →  revision history UI
 *   (eowiki)       (projected into snapshots)
 */
(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════
  // Configuration
  // ═══════════════════════════════════════════════════════════════════════

  var baseEl = document.querySelector('base');
  var BASE = baseEl ? baseEl.getAttribute('href').replace(/\/$/, '') : '';
  var XANO_PUBLIC = 'https://xvkq-pq7i-idtl.n7d.xano.io/api:GGzWIVAW';
  var N8N_CURRENT = 'https://n8n.intelechia.com/webhook/81ca952a-3387-4837-8bcd-d18e3d28e758';
  var XANO_CURRENT = N8N_CURRENT;

  var OPERATORS = [
    { num: 1, symbol: '\u2205', code: 'NUL', greek: '\u03BD', label: 'Absence & Nullity', color: '#9ca3af', slug: 'nul' },
    { num: 2, symbol: '\u22A1', code: 'DES', greek: '\u03B4', label: 'Designation', color: '#60a5fa', slug: 'des' },
    { num: 3, symbol: '\u25B3', code: 'INS', greek: '\u03B9', label: 'Instantiation', color: '#4ade80', slug: 'ins' },
    { num: 4, symbol: '\uFF5C', code: 'SEG', greek: '\u03C3', label: 'Segmentation', color: '#c084fc', slug: 'seg' },
    { num: 5, symbol: '\u22C8', code: 'CON', greek: '\u03BA', label: 'Connection', color: '#34d399', slug: 'con' },
    { num: 6, symbol: '\u2228', code: 'SYN', greek: '\u03C8', label: 'Synthesis', color: '#818cf8', slug: 'syn' },
    { num: 7, symbol: '\u223F', code: 'ALT', greek: '\u03B4', label: 'Alternation', color: '#fbbf24', slug: 'alt' },
    { num: 8, symbol: '\u2225', code: 'SUP', greek: '\u03C6', label: 'Superposition', color: '#f472b6', slug: 'sup' },
    { num: 9, symbol: '\u27F3', code: 'REC', greek: '\u03C1', label: 'Recursion', color: '#fb923c', slug: 'rec' }
  ];

  // ═══════════════════════════════════════════════════════════════════════
  // State
  // ═══════════════════════════════════════════════════════════════════════

  var siteIndex = null;
  var contentCache = {};

  // ═══════════════════════════════════════════════════════════════════════
  // Utilities
  // ═══════════════════════════════════════════════════════════════════════

  function esc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function md(text) {
    if (!text) return '';
    if (window.marked) {
      try { return window.marked.parse(text); } catch (e) { /* fall through */ }
    }
    // Fallback: simple regex renderer
    return text
      .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
      .replace(/((?:^\|.+\|[ \t]*\n){2,})/gm, function(tableBlock) {
        var lines = tableBlock.trim().split('\n');
        if (lines.length < 2) return tableBlock;
        if (!/^\|[\s\-:|]+\|$/.test(lines[1].trim())) return tableBlock;
        function parseRow(line) {
          return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function(c) { return c.trim(); });
        }
        var headers = parseRow(lines[0]);
        var h = '<table><thead><tr>' + headers.map(function(hd) { return '<th>' + hd + '</th>'; }).join('') + '</tr></thead><tbody>';
        for (var i = 2; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          var cells = parseRow(lines[i]);
          h += '<tr>' + cells.map(function(c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
        }
        return h + '</tbody></table>';
      })
      .replace(/\n\n/g, '</p><p>')
      .replace(/^(?!<[hulot])(.+)/gm, '<p>$1</p>');
  }

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) return null;
      return r.json();
    }).catch(function () { return null; });
  }

  function contentUrl(type, slug) {
    var prefix = { wiki: 'wiki', blog: 'blog', experiment: 'exp', page: 'page' };
    return BASE + '/' + (prefix[type] || type) + '/' + slug + '/';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Data Loading — two sources: generated JSON (current state) + Xano API
  // ═══════════════════════════════════════════════════════════════════════

  /** Pick the most recently modified record when duplicates exist for a record_id. */
  function dedup(records) {
    var map = {};
    records.forEach(function (r) {
      var prev = map[r.record_id];
      if (!prev || r.lastModified > prev.lastModified) map[r.record_id] = r;
    });
    return map;
  }

  // Cache the deduped Xano records so loadContent can reuse the same fetch
  var _xanoRecords = null;

  function loadXanoRecords() {
    if (_xanoRecords) return Promise.resolve(_xanoRecords);
    try {
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 15000);
      return fetch(XANO_CURRENT, { signal: controller.signal })
        .then(function (r) { clearTimeout(timer); return r.ok ? r.json() : null; })
        .then(function (records) {
          if (!Array.isArray(records)) return null;
          _xanoRecords = dedup(records);
          return _xanoRecords;
        }).catch(function (e) { clearTimeout(timer); console.warn('Xano fetch failed:', e); return null; });
    } catch (e) {
      console.warn('Xano fetch setup failed:', e);
      return Promise.resolve(null);
    }
  }

  function loadIndex() {
    if (siteIndex) return Promise.resolve(siteIndex);

    // Try generated JSON first; fall back to Xano API
    return fetchJson(BASE + '/generated/state/index.json').then(function (data) {
      if (data) { siteIndex = data; return data; }
      return loadXanoRecords().then(function (map) {
        if (!map || !map['site:index']) return emptyIndex();
        try {
          var raw = JSON.parse(map['site:index'].values);
          // Ensure nav exists (synthesize from entries if missing)
          if (!raw.nav && raw.entries) {
            raw.nav = raw.entries.filter(function (e) {
              return e.status === 'published' && e.visibility === 'public';
            });
          }
          siteIndex = raw;
          return siteIndex;
        } catch (e) { return emptyIndex(); }
      });
    });
  }

  function emptyIndex() {
    siteIndex = { entries: [], nav: [], slug_map: {}, built_at: '' };
    return siteIndex;
  }

  function loadContent(contentId) {
    if (contentCache[contentId]) return Promise.resolve(contentCache[contentId]);
    var fileName = contentId.replace(':', '-') + '.json';

    // Try generated JSON first; fall back to Xano API
    return fetchJson(BASE + '/generated/state/content/' + fileName).then(function (data) {
      if (data) { contentCache[contentId] = data; return data; }
      return loadXanoRecords().then(function (map) {
        if (!map || !map[contentId]) return null;
        try {
          var parsed = JSON.parse(map[contentId].values);
          // Xano snapshots store content_id inside meta; inject at top level
          if (!parsed.content_id) parsed.content_id = contentId;
          contentCache[contentId] = parsed;
          return parsed;
        } catch (e) { return null; }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Router
  // ═══════════════════════════════════════════════════════════════════════

  function getRoute() {
    var path = location.pathname;
    if (BASE && path.indexOf(BASE) === 0) path = path.slice(BASE.length);
    path = path.replace(/\/$/, '') || '/';

    if (path === '/') return { page: 'home' };

    var parts = path.split('/').filter(Boolean);
    if (parts[0] === 'wiki')  return parts[1] ? { page: 'wiki', slug: parts[1] } : { page: 'wiki-list' };
    if (parts[0] === 'blog')  return parts[1] ? { page: 'blog', slug: parts[1] } : { page: 'blog-list' };
    if (parts[0] === 'exp')   return parts[1] ? { page: 'exp',  slug: parts[1] } : { page: 'exp-list' };
    if (parts[0] === 'page' && parts[1]) return { page: 'page', slug: parts[1] };
    if (parts[0] === 'all') return { page: 'all' };
    if (parts[0] === 'admin') return { page: 'admin' };

    return { page: '404' };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Navigation
  // ═══════════════════════════════════════════════════════════════════════

  function updateNav() {
    if (!siteIndex) return;
    var nav = siteIndex.nav || [];

    function fillDropdown(id, countId, entries, type, max) {
      var dd = document.getElementById(id);
      var countEl = document.getElementById(countId);
      if (!dd) return;
      if (entries.length === 0) { dd.innerHTML = ''; if (countEl) countEl.hidden = true; return; }
      if (countEl) { countEl.textContent = entries.length; countEl.hidden = false; }
      var listUrl = BASE + '/' + (type === 'experiment' ? 'exp' : type) + '/';
      dd.innerHTML = entries.slice(0, max).map(function (e) {
        return '<li><a href="' + contentUrl(e.content_type, e.slug) + '">' + esc(e.title) + '</a></li>';
      }).join('') + (entries.length > max ? '<li class="nav-more"><a href="' + listUrl + '">More \u2192</a></li>' : '');
    }

    fillDropdown('nav-wiki-dd', 'nav-wiki-count', nav.filter(function (e) { return e.content_type === 'wiki'; }), 'wiki', 8);
    fillDropdown('nav-blog-dd', 'nav-blog-count', nav.filter(function (e) { return e.content_type === 'blog'; }), 'blog', 6);
    fillDropdown('nav-exp-dd', 'nav-exp-count', nav.filter(function (e) { return e.content_type === 'experiment'; }), 'experiment', 6);

    // Update site name
    var siteName = (siteIndex.site_settings && siteIndex.site_settings.siteName) || 'Emergent Ontology';
    var h = document.getElementById('site-name-header');
    var f = document.getElementById('site-name-footer');
    if (h) h.textContent = siteName;
    if (f) f.textContent = siteName;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Breadcrumbs & Title
  // ═══════════════════════════════════════════════════════════════════════

  function setBreadcrumbs(crumbs) {
    var el = document.getElementById('breadcrumbs');
    if (!el) return;
    if (!crumbs || crumbs.length === 0) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = '<ol><li><a href="' + BASE + '/">Home</a></li>' +
      crumbs.map(function (c, i) {
        if (i === crumbs.length - 1) return '<li aria-current="page">' + esc(c.label) + '</li>';
        return '<li><a href="' + esc(c.href) + '">' + esc(c.label) + '</a></li>';
      }).join('') + '</ol>';
  }

  function setTitle(t) {
    var siteName = (siteIndex && siteIndex.site_settings && siteIndex.site_settings.siteName) || 'Emergent Ontology';
    document.title = t + ' \u2014 ' + siteName;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Block Renderer (for pages)
  // ═══════════════════════════════════════════════════════════════════════

  function renderBlock(block, page) {
    if (block.deleted) return '';
    var d = block.data || {};
    switch (block.block_type) {
      case 'text':
        return md(String(d.md || d.text || ''));
      case 'heading': {
        var text = String(d.text || '');
        var level = Math.min(Math.max(Number(d.level || 2), 1), 6);
        var slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        return '<h' + level + ' id="' + slug + '" class="block block-heading">' + esc(text) + '</h' + level + '>';
      }
      case 'callout':
        return '<aside class="block block-callout callout-' + (d.kind || 'info') + '"><div>' + md(String(d.text || '')) + '</div></aside>';
      case 'quote':
        return '<blockquote class="block block-quote"><p>' + esc(String(d.text || '')) + '</p>' + (d.attribution ? '<cite>\u2014 ' + esc(String(d.attribution)) + '</cite>' : '') + '</blockquote>';
      case 'divider':
        return '<hr class="block block-divider">';
      case 'spacer':
        return '<div class="block block-spacer" style="height:' + esc(String(d.height || '2rem')) + '"></div>';
      case 'image':
        return '<figure class="block block-image"><img src="' + esc(String(d.src || '')) + '" alt="' + esc(String(d.alt || '')) + '" loading="lazy">' + (d.caption ? '<figcaption>' + esc(String(d.caption)) + '</figcaption>' : '') + '</figure>';
      case 'code':
        return '<div class="block block-code"><pre><code' + (d.lang ? ' class="language-' + esc(String(d.lang)) + '"' : '') + '>' + esc(String(d.code || '')) + '</code></pre></div>';
      case 'button':
        return '<div class="block block-button"><a class="btn btn-' + esc(String(d.style || 'primary')) + '" href="' + esc(String(d.url || '#')) + '">' + esc(String(d.text || 'Click here')) + '</a></div>';
      case 'embed': {
        var src = String(d.src || '');
        if (!src) return '';
        var title = String(d.title || '');
        return '<figure class="block block-embed"><iframe src="' + esc(src) + '" title="' + esc(title) + '" loading="lazy" allowfullscreen frameborder="0"></iframe>' + (title ? '<figcaption>' + esc(title) + '</figcaption>' : '') + '</figure>';
      }
      case 'video': {
        var vsrc = String(d.src || '');
        if (!vsrc) return '';
        var embedSrc = vsrc;
        var yt = vsrc.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
        if (yt) embedSrc = 'https://www.youtube.com/embed/' + yt[1];
        var vim = vsrc.match(/vimeo\.com\/(\d+)/);
        if (vim) embedSrc = 'https://player.vimeo.com/video/' + vim[1];
        var cap = String(d.caption || '');
        return '<figure class="block block-video"><iframe src="' + esc(embedSrc) + '" title="' + esc(cap || 'Video') + '" loading="lazy" allowfullscreen frameborder="0"></iframe>' + (cap ? '<figcaption>' + esc(cap) + '</figcaption>' : '') + '</figure>';
      }
      case 'columns': {
        var raw = Array.isArray(d.columns) ? d.columns : [];
        var isNew = raw.length > 0 && typeof raw[0] === 'object' && raw[0] !== null && raw[0].blocks;
        var cols;
        if (isNew) {
          cols = raw.map(function (col) {
            var inner = (col.block_order || []).map(function (id) {
              return (col.blocks || []).find(function (b) { return b.block_id === id; });
            }).filter(Boolean).map(function (sub) {
              return renderBlock(sub, page);
            }).join('');
            return '<div class="column">' + (inner || '') + '</div>';
          }).join('');
        } else {
          cols = raw.map(function (c) { return '<div class="column">' + md(String(c)) + '</div>'; }).join('');
        }
        return '<div class="block block-columns block-columns-' + raw.length + '">' + cols + '</div>';
      }
      case 'wiki-embed': {
        var wslug = String(d.slug || d.wiki_id || '');
        if (!wslug) return '<div class="block block-wiki-embed">[wiki embed: no slug]</div>';
        return '<div class="block block-wiki-embed"><a class="wiki-embed-link" href="' + BASE + '/wiki/' + esc(wslug) + '/">Linked wiki: ' + esc(wslug) + '</a></div>';
      }
      case 'experiment-embed': {
        var eid = String(d.exp_id || '');
        if (!eid) return '<div class="block block-experiment-embed">[experiment embed: no ID]</div>';
        var eslug = eid.replace('experiment:', '');
        return '<div class="block block-experiment-embed"><a class="exp-embed-link" href="' + BASE + '/exp/' + esc(eslug) + '/">Linked experiment: ' + esc(eslug) + '</a></div>';
      }
      case 'toc': {
        var headings = [];
        var blockMap = {};
        (page.blocks || []).forEach(function (b) { blockMap[b.block_id] = b; });
        (page.block_order || []).forEach(function (id) {
          var b = blockMap[id];
          if (!b || b.deleted) return;
          if (b.block_type === 'text') {
            (String(b.data.md || b.data.text || '')).split('\n').forEach(function (line) {
              var m = line.match(/^(#{1,4})\s+(.+)$/);
              if (m) {
                var lvl = m[1].length;
                var txt = m[2];
                var s = txt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
                headings.push('<li class="toc-level-' + lvl + '"><a href="#' + s + '">' + esc(txt) + '</a></li>');
              }
            });
          }
          if (b.block_type === 'heading') {
            var htxt = String(b.data.text || '');
            var hs = htxt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
            headings.push('<li class="toc-level-' + (b.data.level || 2) + '"><a href="#' + hs + '">' + esc(htxt) + '</a></li>');
          }
        });
        if (!headings.length) return '';
        return '<nav class="block block-toc"><div class="toc-title">Contents</div><ol>' + headings.join('') + '</ol></nav>';
      }
      case 'html':
        return '<div class="block block-html">' + String(d.html || '') + '</div>';
      case 'content-feed':
        return ''; // Rendered specially on home page
      case 'operator-grid':
        return ''; // Rendered specially on home page
      default:
        return '<div class="block block-' + block.block_type + '">[' + block.block_type + ']</div>';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Page Renderers
  // ═══════════════════════════════════════════════════════════════════════

  // ── Home ──

  function renderHome(el) {
    setTitle('Home');
    setBreadcrumbs([]);
    el.className = 'home';

    // Show all public, non-archived entries (including drafts) — not just nav (published-only)
    var publicEntries = (siteIndex.entries || []).filter(function (e) {
      return e.visibility === 'public' && e.status !== 'archived';
    });
    var wikis = publicEntries.filter(function (e) { return e.content_type === 'wiki'; });
    var blogs = publicEntries.filter(function (e) { return e.content_type === 'blog'; });
    var exps  = publicEntries.filter(function (e) { return e.content_type === 'experiment'; });
    var pages = publicEntries.filter(function (e) { return e.content_type === 'page'; });
    var total = wikis.length + blogs.length + exps.length + pages.length;

    var allTags = [];
    var tagSet = {};
    publicEntries.forEach(function (e) { (e.tags || []).forEach(function (t) { if (t && !tagSet[t]) { tagSet[t] = true; allTags.push(t); } }); });
    allTags.sort();

    var h = '';

    // Hero
    h += '<section class="home-hero">';
    h += '<div class="hero-badge">Emergent Ontology (EO)</div>';
    h += '<h1 class="hero-title">A framework that changes everything<br>about everything that changes</h1>';
    h += '<p class="hero-sub">Every language encodes the same nine transformations. Every system implements them. Every experience moves through them. EO is a universal grammar of change.</p>';
    if (total > 0) {
      h += '<p class="hero-stats">' + total + ' article' + (total !== 1 ? 's' : '');
      if (wikis.length) h += ' \u00B7 ' + wikis.length + ' wiki';
      if (blogs.length) h += ' \u00B7 ' + blogs.length + ' blog';
      if (exps.length)  h += ' \u00B7 ' + exps.length + ' experiments';
      h += '</p>';
    }
    h += '</section>';

    // Two-column layout
    h += '<div class="home-columns"><div class="home-col-main">';

    // Wiki section
    if (wikis.length > 0) h += sectionHtml('Wiki', 'wiki', wikis, 6, 'grid');
    // Blog section
    h += sectionHtml('Blog', 'blog', blogs, 5, 'list');
    // Experiments section
    h += sectionHtml('Experiments', 'experiment', exps, 4, 'grid');
    // Pages section
    if (pages.length > 0) {
      h += '<section class="home-section"><div class="section-header"><h2 class="section-title">Pages</h2></div>';
      h += '<ul class="content-list">';
      pages.forEach(function (e) { h += '<li><a href="' + contentUrl('page', e.slug) + '">' + esc(e.title) + '</a></li>'; });
      h += '</ul></section>';
    }
    // Tags
    if (allTags.length > 0) {
      h += '<section class="home-section home-section--tags"><h2 class="section-title">Topics</h2><div class="tag-cloud">';
      allTags.forEach(function (t) { h += '<span class="tag tag-lg">' + esc(t) + '</span>'; });
      h += '</div></section>';
    }

    h += '</div>'; // end home-col-main
    h += runeGridHtml();
    h += '</div>'; // end home-columns

    el.innerHTML = h;
    initRuneGrid(el);
    return Promise.resolve();
  }

  function sectionHtml(title, type, entries, max, layout) {
    var h = '<section class="home-section"><div class="section-header"><h2 class="section-title">' + esc(title) + '</h2></div>';
    if (entries.length === 0) {
      h += '<p class="empty-note">No ' + type + ' entries published yet.</p>';
    } else if (layout === 'grid') {
      h += '<div class="content-grid' + (type === 'experiment' ? ' content-grid--sm' : '') + '">';
      entries.slice(0, max).forEach(function (e) {
        h += '<a class="content-card' + (type === 'experiment' ? ' content-card--exp' : '') + '" href="' + contentUrl(type, e.slug) + '">';
        h += '<h3 class="card-title">' + esc(e.title) + '</h3>';
        if (e.tags && e.tags.length) {
          h += '<div class="card-tags">';
          e.tags.slice(0, 3).forEach(function (t) { h += '<span class="tag">' + esc(t) + '</span>'; });
          h += '</div>';
        }
        h += '</a>';
      });
      h += '</div>';
    } else {
      h += '<div class="content-list-cards">';
      entries.slice(0, max).forEach(function (e) {
        h += '<a class="list-card" href="' + contentUrl(type, e.slug) + '">';
        h += '<div class="list-card-body"><h3 class="list-card-title">' + esc(e.title) + '</h3></div>';
        h += '<div class="list-card-arrow">\u2192</div></a>';
      });
      h += '</div>';
    }
    h += '</section>';
    return h;
  }

  // ── Rune Grid ──

  function runeGridHtml() {
    var h = '<aside class="rune-grid-aside" aria-label="Nine Operators">';
    h += '<div class="rune-grid" id="rune-grid">';
    OPERATORS.forEach(function (op) {
      h += '<a class="rune-cell" href="' + contentUrl('wiki', op.slug) + '" title="' + op.code + ' \u2014 ' + op.label + '" style="--rune-color:' + op.color + '">';
      h += '<span class="rune-display rune-sym--rune">' + op.symbol + '</span>';
      h += '<span class="rune-display rune-sym--code">' + op.code + '</span>';
      h += '<span class="rune-display rune-sym--greek">' + op.greek + '</span>';
      h += '</a>';
    });
    h += '</div>';
    h += '<button class="alt-toggle" id="alt-toggle" title="Switch naming version"><span class="alt-toggle-icon">\u223F</span></button>';
    h += '</aside>';
    return h;
  }

  function initRuneGrid(container) {
    var modes = ['rune', 'code', 'greek'];
    var icons = { rune: '\u223F', code: 'ALT', greek: '\u03B4' };
    var current = 0;
    var saved = localStorage.getItem('eo-rune-version');
    if (saved) { var i = modes.indexOf(saved); if (i >= 0) current = i; }

    function apply() {
      container.querySelectorAll('.rune-grid').forEach(function (grid) {
        grid.setAttribute('data-mode', modes[current]);
      });
      container.querySelectorAll('.alt-toggle-icon').forEach(function (el) {
        el.textContent = icons[modes[current]];
      });
    }

    apply();
    container.querySelectorAll('.alt-toggle').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        current = (current + 1) % modes.length;
        localStorage.setItem('eo-rune-version', modes[current]);
        apply();
      });
    });
  }

  // ── Wiki List ──

  function renderWikiList(el) {
    setTitle('Wiki');
    setBreadcrumbs([{ label: 'Wiki', href: BASE + '/wiki/' }]);
    el.className = '';

    var wikis = (siteIndex.entries || []).filter(function (e) {
      return e.content_type === 'wiki' && e.visibility === 'public' && e.status !== 'archived';
    });

    var h = '<section class="home-section"><h1>Wiki</h1>';
    if (wikis.length > 0) {
      h += '<ul class="content-list">';
      wikis.forEach(function (w) {
        h += '<li><a href="' + contentUrl('wiki', w.slug) + '">' + esc(w.title) + '</a>';
        if (w.tags && w.tags.length) {
          h += ' <span class="tags">';
          w.tags.forEach(function (t) { h += '<span class="tag">' + esc(t) + '</span>'; });
          h += '</span>';
        }
        h += '</li>';
      });
      h += '</ul>';
    } else {
      h += '<p class="empty-page">No wiki entries yet.</p>';
    }
    h += '</section>';
    el.innerHTML = h;
    return Promise.resolve();
  }

  // ── Wiki Article ──

  function renderWiki(el, slug) {
    el.className = '';
    var entry = (siteIndex.entries || []).find(function (e) { return e.content_type === 'wiki' && e.slug === slug; });
    var contentId = entry ? entry.content_id : 'wiki:' + slug;

    return loadContent(contentId).then(function (content) {
      var operator = OPERATORS.find(function (op) { return op.slug === slug; });

      if (content && content.meta) {
        var title = content.meta.title;
        setTitle(title);
        setBreadcrumbs([{ label: 'Wiki', href: BASE + '/wiki/' }, { label: title, href: BASE + '/wiki/' + slug + '/' }]);

        var h = '<article class="wiki-content" data-eo-op="DES" data-eo-target="' + esc(content.content_id) + '">';
        h += '<header class="content-header"><h1>' + esc(title) + '</h1>';
        h += '<code class="eo-op"><span class="eo-sym">\u22A1</span> <span class="eo-name">DES</span>(<span class="eo-target">' + esc(content.content_id) + '</span>)</code>';
        h += '<div class="content-tags">';
        (content.meta.tags || []).forEach(function (t) { h += '<span class="tag">' + esc(t) + '</span>'; });
        h += '</div></header>';

        if (content.has_conflict) {
          h += '<div class="conflict-banner"><strong>Conflict detected:</strong> ' + (content.conflict_candidates || []).length + ' concurrent revisions. <a href="#history">View history</a>.</div>';
        }

        h += '<div class="wiki-body">';
        if (content.current_revision && content.current_revision.content) {
          var fmt = content.current_revision.format || 'markdown';
          h += fmt === 'html' ? content.current_revision.content : md(content.current_revision.content);
        } else {
          h += '<p class="empty-page">No content yet.</p>';
        }
        h += '</div>';

        h += revisionHistoryHtml(content);

        h += '<div class="content-actions eo-admin-only" hidden>';
        h += '<a class="btn btn-edit" href="' + BASE + '/admin/#wiki/' + esc(slug) + '">Edit in Admin</a></div>';
        h += '</article>';
        el.innerHTML = h;
      } else if (operator) {
        setTitle(operator.code + ' \u2014 ' + operator.label);
        setBreadcrumbs([{ label: 'Wiki', href: BASE + '/wiki/' }, { label: operator.code + ' \u2014 ' + operator.label, href: BASE + '/wiki/' + slug + '/' }]);

        var h2 = '<article class="wiki-content operator-page" data-eo-op="' + operator.code + '" data-eo-target="wiki:' + operator.slug + '">';
        h2 += '<header class="content-header"><h1><span style="color:' + operator.color + '">' + operator.symbol + '</span> ' + operator.code + ' \u2014 ' + esc(operator.label) + '</h1></header>';
        h2 += '<div class="wiki-body"></div>';
        h2 += '<div class="content-actions eo-admin-only" hidden>';
        h2 += '<a class="btn btn-edit" href="' + BASE + '/admin/#wiki/' + esc(slug) + '">Edit in Admin</a></div>';
        h2 += '</article>';
        el.innerHTML = h2;
      } else {
        render404(el);
      }
      revealAdmin();
    });
  }

  function revisionHistoryHtml(content) {
    var revs = content.revisions || [];
    var h = '<section class="revision-history" id="history"><h2>Revision History</h2>';
    if (revs.length > 0) {
      h += '<ol class="rev-list" reversed>';
      revs.slice().reverse().slice(0, 6).forEach(function (r) {
        var isFirst = r.rev_id === revs[0].rev_id;
        var opName = isFirst ? 'INS' : 'ALT';
        h += '<li class="rev-entry rev-entry--' + opName.toLowerCase() + '">';
        h += '<code class="eo-op eo-op-inline"><span class="eo-name">' + opName + '</span>(<span class="eo-target">' + esc(content.content_id) + '/rev:' + esc(r.rev_id) + '</span>, <span class="eo-operand">{summary: "' + esc(r.summary || '\u2026') + '"}</span>)</code>';
        h += ' <time class="rev-ts">' + new Date(r.ts).toLocaleDateString() + '</time>';
        h += '</li>';
      });
      h += '</ol>';
      if (revs.length > 6) {
        h += '<details class="rev-overflow"><summary class="rev-expand-toggle">Show ' + (revs.length - 6) + ' older revision' + (revs.length - 6 !== 1 ? 's' : '') + '</summary>';
        h += '<ol class="rev-list rev-list-older">';
        revs.slice().reverse().slice(6).forEach(function (r) {
          var isFirst = r.rev_id === revs[0].rev_id;
          var opName = isFirst ? 'INS' : 'ALT';
          h += '<li class="rev-entry"><code class="eo-op eo-op-inline"><span class="eo-name">' + opName + '</span>(<span class="eo-target">' + esc(content.content_id) + '/rev:' + esc(r.rev_id) + '</span>)</code>';
          h += ' <time class="rev-ts">' + new Date(r.ts).toLocaleDateString() + '</time></li>';
        });
        h += '</ol></details>';
      }
    } else {
      h += '<ol class="rev-list"><li>No revisions yet.</li></ol>';
    }
    h += '</section>';
    return h;
  }

  // ── Blog List ──

  function renderBlogList(el) {
    setTitle('Blog');
    setBreadcrumbs([{ label: 'Blog', href: BASE + '/blog/' }]);
    el.className = '';

    var blogs = (siteIndex.entries || []).filter(function (e) {
      return e.content_type === 'blog' && e.visibility === 'public' && e.status !== 'archived';
    });

    var h = '<section class="home-section"><h1>Blog</h1>';
    if (blogs.length > 0) {
      h += '<div class="content-list-cards">';
      blogs.forEach(function (b) {
        h += '<a class="list-card" href="' + contentUrl('blog', b.slug) + '">';
        h += '<div class="list-card-body"><h3 class="list-card-title">' + esc(b.title) + '</h3></div>';
        h += '<div class="list-card-arrow">\u2192</div></a>';
      });
      h += '</div>';
    } else {
      h += '<p class="empty-page">No blog posts yet.</p>';
    }
    h += '</section>';
    el.innerHTML = h;
    return Promise.resolve();
  }

  // ── Blog Article ──

  function renderBlog(el, slug) {
    el.className = '';
    var entry = (siteIndex.entries || []).find(function (e) { return e.content_type === 'blog' && e.slug === slug; });
    var contentId = entry ? entry.content_id : 'blog:' + slug;

    return loadContent(contentId).then(function (content) {
      if (!content || !content.meta) { render404(el); return; }

      var title = content.meta.title;
      setTitle(title);
      setBreadcrumbs([{ label: 'Blog', href: BASE + '/blog/' }, { label: title, href: BASE + '/blog/' + slug + '/' }]);

      var h = '<article class="wiki-content" data-eo-op="DES" data-eo-target="' + esc(content.content_id) + '">';
      h += '<header class="content-header"><h1>' + esc(title) + '</h1>';
      h += '<div class="post-meta">';
      if (content.meta.updated_at) h += '<time>' + new Date(content.meta.updated_at).toLocaleDateString() + '</time>';
      h += '</div>';
      h += '<div class="content-tags">';
      (content.meta.tags || []).forEach(function (t) { h += '<span class="tag">' + esc(t) + '</span>'; });
      h += '</div></header>';

      h += '<div class="wiki-body">';
      if (content.current_revision && content.current_revision.content) {
        var fmt = content.current_revision.format || 'markdown';
        h += fmt === 'html' ? content.current_revision.content : md(content.current_revision.content);
      } else {
        h += '<p class="empty-page">No content yet.</p>';
      }
      h += '</div>';

      h += revisionHistoryHtml(content);

      h += '<div class="content-actions eo-admin-only" hidden>';
      h += '<a class="btn btn-edit" href="' + BASE + '/admin/#blog/' + esc(slug) + '">Edit in Admin</a></div>';
      h += '</article>';
      el.innerHTML = h;
      revealAdmin();
    });
  }

  // ── Experiment List ──

  function renderExpList(el) {
    setTitle('Experiments');
    setBreadcrumbs([{ label: 'Experiments', href: BASE + '/exp/' }]);
    el.className = '';

    var exps = (siteIndex.entries || []).filter(function (e) {
      return e.content_type === 'experiment' && e.visibility === 'public' && e.status !== 'archived';
    });

    var h = '<section class="home-section"><h1>Experiments</h1>';
    if (exps.length > 0) {
      h += '<div class="content-grid content-grid--sm">';
      exps.forEach(function (e) {
        h += '<a class="content-card content-card--exp" href="' + contentUrl('experiment', e.slug) + '">';
        h += '<h3 class="card-title">' + esc(e.title) + '</h3></a>';
      });
      h += '</div>';
    } else {
      h += '<p class="empty-page">No experiments yet.</p>';
    }
    h += '</section>';
    el.innerHTML = h;
    return Promise.resolve();
  }

  // ── Experiment Detail ──

  function renderExp(el, slug) {
    el.className = '';
    var entry = (siteIndex.entries || []).find(function (e) { return e.content_type === 'experiment' && e.slug === slug; });
    var contentId = entry ? entry.content_id : 'experiment:' + slug;

    return loadContent(contentId).then(function (content) {
      if (!content || !content.meta) { render404(el); return; }

      var title = content.meta.title;
      setTitle(title);
      setBreadcrumbs([{ label: 'Experiments', href: BASE + '/exp/' }, { label: title, href: BASE + '/exp/' + slug + '/' }]);

      var kindIcons = { note: '\uD83D\uDCDD', dataset: '\uD83D\uDCC1', result: '\u2705', chart: '\uD83D\uDCC8', link: '\uD83D\uDD17', decision: '\u2696\uFE0F', html: '\uD83C\uDF10' };
      var entries = (content.entries || []).filter(function (e) { return !e.deleted; });

      var h = '<article data-eo-op="DES" data-eo-target="' + esc(content.content_id) + '">';
      h += '<header class="content-header"><h1>' + esc(title) + '</h1>';
      h += '<div class="content-tags">';
      (content.meta.tags || []).forEach(function (t) { h += '<span class="tag">' + esc(t) + '</span>'; });
      h += '</div></header>';

      if (entries.length > 0) {
        h += '<ul class="exp-entries">';
        entries.forEach(function (entry) {
          var icon = kindIcons[entry.kind] || '\uD83D\uDCDD';
          h += '<li class="exp-entry" data-eo-op="INS" data-eo-target="' + esc(content.content_id) + '/entry:' + esc(entry.entry_id) + '">';
          h += '<span class="entry-kind">' + icon + '</span>';
          h += '<div class="entry-body">';
          if (entry.kind === 'html') {
            h += '<div class="entry-html">' + String((entry.data && entry.data.html) || '') + '</div>';
          } else {
            if (entry.data && entry.data.text) h += md(String(entry.data.text));
            if (entry.data && entry.data.title) h += '<strong>' + esc(String(entry.data.title)) + '</strong>';
            if (entry.data && entry.data.url) h += '<p><a href="' + esc(String(entry.data.url)) + '">' + esc(String(entry.data.url)) + '</a></p>';
          }
          h += '</div>';
          h += '<time class="entry-ts">' + new Date(entry.ts).toLocaleDateString() + '</time>';
          h += '</li>';
        });
        h += '</ul>';
      } else {
        h += '<p class="empty-page">No entries yet.</p>';
      }

      h += '<div class="content-actions eo-admin-only" hidden>';
      h += '<a class="btn btn-edit" href="' + BASE + '/admin/#exp/' + esc(slug) + '">Edit in Admin</a></div>';
      h += '</article>';
      el.innerHTML = h;
      revealAdmin();
    });
  }

  // ── Page ──

  function renderPage(el, slug) {
    el.className = '';
    var entry = (siteIndex.entries || []).find(function (e) { return e.content_type === 'page' && e.slug === slug; });
    var contentId = entry ? entry.content_id : 'page:' + slug;

    return loadContent(contentId).then(function (content) {
      if (!content || !content.meta) { render404(el); return; }

      var title = content.meta.title;
      setTitle(title);
      setBreadcrumbs([{ label: title, href: BASE + '/page/' + slug + '/' }]);

      var h = '<article data-eo-op="DES" data-eo-target="' + esc(content.content_id) + '">';
      h += '<header class="content-header"><h1>' + esc(title) + '</h1></header>';

      var blocks = content.blocks || [];
      var order = content.block_order || [];
      var blockMap = {};
      blocks.forEach(function (b) { blockMap[b.block_id] = b; });

      h += '<div class="blocks">';
      order.forEach(function (id) {
        var block = blockMap[id];
        if (!block || block.deleted) return;
        h += renderBlock(block, content);
      });
      h += '</div>';

      h += '<div class="content-actions eo-admin-only" hidden>';
      h += '<a class="btn btn-edit" href="' + BASE + '/admin/#page/' + esc(slug) + '">Edit in Admin</a></div>';
      h += '</article>';
      el.innerHTML = h;
      revealAdmin();
    });
  }

  // ── All Content (printable) ──

  function renderAll(el) {
    setTitle('All Content');
    setBreadcrumbs([{ label: 'All Content', href: BASE + '/all/' }]);
    el.className = 'all-content';

    var entries = (siteIndex.entries || []).filter(function (e) {
      return e.visibility === 'public' && e.status !== 'archived';
    });

    var wikis = entries.filter(function (e) { return e.content_type === 'wiki'; });
    var blogs = entries.filter(function (e) { return e.content_type === 'blog'; });
    var pages = entries.filter(function (e) { return e.content_type === 'page'; });

    // Load all content in parallel
    var allEntries = wikis.concat(blogs).concat(pages);
    var loads = allEntries.map(function (e) {
      return loadContent(e.content_id).then(function (content) {
        return { entry: e, content: content };
      });
    });

    el.innerHTML = '<div class="all-loading"><p>Loading all content\u2026</p></div>';

    return Promise.all(loads).then(function (results) {
      var h = '<div class="all-header">';
      h += '<h1>All Content</h1>';
      h += '<p class="all-stats">' + results.length + ' article' + (results.length !== 1 ? 's' : '') + '</p>';
      h += '<button class="btn btn-primary all-print-btn" onclick="window.print()">Print / Save PDF</button>';
      h += '</div>';

      // Group by type
      var groups = [
        { label: 'Wiki', items: results.filter(function (r) { return r.entry.content_type === 'wiki'; }) },
        { label: 'Blog', items: results.filter(function (r) { return r.entry.content_type === 'blog'; }) },
        { label: 'Pages', items: results.filter(function (r) { return r.entry.content_type === 'page'; }) }
      ];

      // Table of contents
      h += '<nav class="all-toc"><h2>Table of Contents</h2><ol>';
      groups.forEach(function (g) {
        if (g.items.length === 0) return;
        h += '<li><strong>' + g.label + '</strong><ol>';
        g.items.forEach(function (r) {
          var anchor = (r.entry.content_id || '').replace(/[^a-z0-9]+/gi, '-');
          h += '<li><a href="#all-' + anchor + '">' + esc(r.entry.title) + '</a></li>';
        });
        h += '</ol></li>';
      });
      h += '</ol></nav>';

      // Render each article
      groups.forEach(function (g) {
        if (g.items.length === 0) return;
        h += '<section class="all-section"><h2 class="all-section-title">' + esc(g.label) + '</h2>';

        g.items.forEach(function (r) {
          var anchor = (r.entry.content_id || '').replace(/[^a-z0-9]+/gi, '-');
          h += '<article class="all-article" id="all-' + anchor + '">';
          h += '<header class="all-article-header"><h3>' + esc(r.entry.title) + '</h3>';
          h += '<a class="all-article-link" href="' + contentUrl(r.entry.content_type, r.entry.slug) + '">' + esc(r.entry.content_type) + '/' + esc(r.entry.slug) + '</a>';
          if (r.entry.tags && r.entry.tags.length) {
            h += '<div class="all-article-tags">';
            r.entry.tags.forEach(function (t) { h += '<span class="tag">' + esc(t) + '</span>'; });
            h += '</div>';
          }
          h += '</header>';
          h += '<div class="all-article-body">';

          if (r.content) {
            if (r.entry.content_type === 'wiki' || r.entry.content_type === 'blog') {
              var rev = r.content.current_revision;
              if (rev && rev.content) {
                h += (rev.format === 'html') ? rev.content : md(rev.content);
              } else {
                h += '<p class="empty-page">No content yet.</p>';
              }
            } else if (r.entry.content_type === 'page') {
              var blocks = r.content.blocks || [];
              var order = r.content.block_order || [];
              var blockMap = {};
              blocks.forEach(function (b) { blockMap[b.block_id] = b; });
              order.forEach(function (id) {
                var block = blockMap[id];
                if (block && !block.deleted) h += renderBlock(block, r.content);
              });
            }
          } else {
            h += '<p class="empty-page">Content not available.</p>';
          }

          h += '</div></article>';
        });

        h += '</section>';
      });

      el.innerHTML = h;
    });
  }

  // ── 404 ──

  function render404(el) {
    setTitle('Not Found');
    setBreadcrumbs([]);
    el.className = '';
    el.innerHTML = '<div class="home-empty"><div class="empty-card"><div class="empty-icon">\u2205</div><h2>Page Not Found</h2><p>NUL \u2014 This page doesn\'t exist yet.</p><a href="' + BASE + '/" class="btn btn-primary">Return Home</a></div></div>';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Admin Reveal
  // ═══════════════════════════════════════════════════════════════════════

  function revealAdmin() {
    try {
      if (window.self !== window.top) return;
      if (localStorage.getItem('eo_xano_auth') === '1') {
        document.documentElement.setAttribute('data-eo-auth', '');
        document.querySelectorAll('.eo-admin-only').forEach(function (el) { el.removeAttribute('hidden'); });
        var link = document.getElementById('admin-link');
        if (link) link.hidden = false;
        document.querySelectorAll('.admin-footer-link').forEach(function (el) { el.hidden = false; });
      }
    } catch (e) { /* ignore */ }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Main Render
  // ═══════════════════════════════════════════════════════════════════════

  function render() {
    var route = getRoute();
    if (route.page === 'admin') return; // Let admin SPA handle itself
    var main = document.getElementById('content');
    if (!main) return;

    loadIndex().then(function () {
      updateNav();

      switch (route.page) {
        case 'home':      return renderHome(main);
        case 'wiki-list': return renderWikiList(main);
        case 'wiki':      return renderWiki(main, route.slug);
        case 'blog-list': return renderBlogList(main);
        case 'blog':      return renderBlog(main, route.slug);
        case 'exp-list':  return renderExpList(main);
        case 'exp':       return renderExp(main, route.slug);
        case 'page':      return renderPage(main, route.slug);
        case 'all':       return renderAll(main);
        default:          render404(main); return Promise.resolve();
      }
    }).then(function () {
      revealAdmin();
    }).catch(function (err) {
      console.error('Render failed:', err);
      main.innerHTML = '<div style="text-align:center;padding:3rem;color:var(--text-dim)">' +
        '<h2>Failed to load</h2><p>Could not fetch content. <a href="javascript:location.reload()">Retry</a></p></div>';
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UI Setup
  // ═══════════════════════════════════════════════════════════════════════

  function setupUI() {
    // Theme toggle
    var themeBtn = document.getElementById('theme-toggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', function () {
        var current = document.documentElement.getAttribute('data-theme') || 'dark';
        var next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('eo-theme', next);
      });
    }

    // Search toggle
    var searchToggle = document.getElementById('search-toggle');
    var overlay = document.getElementById('search-overlay');
    var closeBtn = document.getElementById('search-close');
    var searchInput = document.getElementById('search-input');
    if (searchToggle && overlay) {
      searchToggle.addEventListener('click', function () { overlay.hidden = false; if (searchInput) searchInput.focus(); });
      if (closeBtn) closeBtn.addEventListener('click', function () { overlay.hidden = true; });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.hidden = true; });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !overlay.hidden) overlay.hidden = true;
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); overlay.hidden = false; if (searchInput) searchInput.focus(); }
      });
    }

    // Admin drawer
    var drawerOverlay = document.getElementById('admin-drawer-overlay');
    var drawer = document.getElementById('admin-drawer');
    var iframe = document.getElementById('admin-drawer-iframe');
    var drawerClose = document.getElementById('admin-drawer-close');
    if (drawerOverlay && drawer && iframe && drawerClose) {
      function openDrawer(href) { iframe.src = href; drawer.classList.add('open'); drawerOverlay.classList.add('open'); document.body.style.overflow = 'hidden'; }
      function closeDrawer() { drawer.classList.remove('open'); drawerOverlay.classList.remove('open'); document.body.style.overflow = ''; setTimeout(function () { iframe.src = ''; }, 300); }
      drawerClose.addEventListener('click', closeDrawer);
      drawerOverlay.addEventListener('click', closeDrawer);
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && drawer.classList.contains('open')) { e.stopImmediatePropagation(); closeDrawer(); }
      });
      document.addEventListener('click', function (e) {
        var link = e.target.closest('.btn-edit');
        if (link && link.href) { e.preventDefault(); openDrawer(link.href); }
      });
    }

    // Admin reveal via triple-ESC
    var escCount = 0, escTimer = null;
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || window.self !== window.top) return;
      var searchOvl = document.getElementById('search-overlay');
      if (searchOvl && !searchOvl.hidden) return;
      escCount++;
      clearTimeout(escTimer);
      escTimer = setTimeout(function () { escCount = 0; }, 800);
      if (escCount >= 3) { escCount = 0; revealAdmin(); }
    });

    // Logo mark cycling
    var operators = OPERATORS;
    var mark = document.getElementById('logo-mark');
    if (mark) {
      var idx = parseInt(localStorage.getItem('eo-logo-idx') || '1', 10) % operators.length;
      mark.textContent = operators[idx].symbol;
      mark.style.color = operators[idx].color;
      mark.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        idx = (idx + 1) % operators.length;
        mark.textContent = operators[idx].symbol;
        mark.style.color = operators[idx].color;
        localStorage.setItem('eo-logo-idx', String(idx));
      });
    }

    // SPA link interception
    document.addEventListener('click', function (e) {
      var link = e.target.closest('a[href]');
      if (!link) return;
      var href = link.getAttribute('href');
      // Skip external links, anchors, admin, edit buttons
      if (!href) return;
      if (href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('#')) return;
      if (link.classList.contains('btn-edit')) return; // handled by drawer
      // Resolve relative to base
      var resolved = new URL(href, document.baseURI);
      if (resolved.origin !== location.origin) return;
      if (resolved.pathname.indexOf(BASE + '/admin') === 0) return;
      e.preventDefault();
      history.pushState(null, '', resolved.pathname);
      render();
      window.scrollTo(0, 0);
    });

    // Back/forward
    window.addEventListener('popstate', render);

    // Auto-reveal admin if previously authenticated
    revealAdmin();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Init
  // ═══════════════════════════════════════════════════════════════════════

  setupUI();
  render();

})();
