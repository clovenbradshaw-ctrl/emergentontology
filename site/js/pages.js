/**
 * pages.js — Page-specific renderers.
 *
 * Each renderer takes a DOM element + optional slug, loads data, and renders HTML.
 * All renderers return a Promise so the caller can chain post-render actions.
 */

import { BASE, OPERATORS } from './config.js';
import { getSiteIndex, loadContent } from './api.js';
import { contentUrl } from './router.js';
import {
  esc, md, setBreadcrumbs, setTitle, renderBlock,
  revisionHistoryHtml, renderRevisionContent, revealAdmin,
  activateScripts
} from './render.js';

// ── Sort helper ──────────────────────────────────────────────────────────────

function sortByUpdated(entries) {
  return entries.slice().sort(function (a, b) {
    var ta = a.updated_at || '';
    var tb = b.updated_at || '';
    if (tb > ta) return 1;
    if (tb < ta) return -1;
    return 0;
  });
}

var COLUMN_LIMIT = 6;

// ═══════════════════════════════════════════════════════════════════════════
// Home
// ═══════════════════════════════════════════════════════════════════════════

export function renderHome(el) {
  var idx = getSiteIndex();
  setTitle('Home');
  setBreadcrumbs([]);
  el.className = 'home';

  var publicEntries = (idx.entries || []).filter(function (e) {
    return e.visibility === 'public' && e.status !== 'archived';
  });
  var wikis = sortByUpdated(publicEntries.filter(function (e) { return e.content_type === 'wiki'; }));
  var blogs = sortByUpdated(publicEntries.filter(function (e) { return e.content_type === 'blog'; }));
  var exps  = sortByUpdated(publicEntries.filter(function (e) { return e.content_type === 'experiment'; }));
  var pages = sortByUpdated(publicEntries.filter(function (e) { return e.content_type === 'page'; }));
  var total = wikis.length + blogs.length + exps.length + pages.length;

  var allTags = [];
  var tagSet = {};
  publicEntries.forEach(function (e) {
    (e.tags || []).forEach(function (t) {
      if (t && !tagSet[t]) { tagSet[t] = true; allTags.push(t); }
    });
  });
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

  if (wikis.length > 0) h += sectionHtml('Wiki', 'wiki', wikis, COLUMN_LIMIT, 'grid');
  h += sectionHtml('Blog', 'blog', blogs, COLUMN_LIMIT, 'list');
  h += sectionHtml('Experiments', 'experiment', exps, COLUMN_LIMIT, 'grid');

  if (pages.length > 0) {
    h += '<section class="home-section"><div class="section-header"><h2 class="section-title">Pages</h2></div>';
    h += '<ul class="content-list">';
    pages.forEach(function (e) {
      h += '<li><a href="' + contentUrl('page', e.slug) + '">' + esc(e.title) + '</a></li>';
    });
    h += '</ul></section>';
  }

  if (allTags.length > 0) {
    h += '<section class="home-section home-section--tags"><h2 class="section-title">Topics</h2><div class="tag-cloud">';
    allTags.forEach(function (t) { h += '<span class="tag tag-lg">' + esc(t) + '</span>'; });
    h += '</div></section>';
  }

  h += '</div>'; // home-col-main
  h += runeGridHtml();
  h += '</div>'; // home-columns

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
      h += cardHtml(type, e);
    });
    h += '</div>';
    if (entries.length > max) {
      h += '<details class="show-more-wrap"><summary class="show-more-toggle">Show ' + (entries.length - max) + ' more</summary>';
      h += '<div class="content-grid' + (type === 'experiment' ? ' content-grid--sm' : '') + ' show-more-items">';
      entries.slice(max).forEach(function (e) {
        h += cardHtml(type, e);
      });
      h += '</div></details>';
    }
  } else {
    h += '<div class="content-list-cards">';
    entries.slice(0, max).forEach(function (e) {
      h += listCardHtml(type, e);
    });
    h += '</div>';
    if (entries.length > max) {
      h += '<details class="show-more-wrap"><summary class="show-more-toggle">Show ' + (entries.length - max) + ' more</summary>';
      h += '<div class="content-list-cards show-more-items">';
      entries.slice(max).forEach(function (e) {
        h += listCardHtml(type, e);
      });
      h += '</div></details>';
    }
  }
  h += '</section>';
  return h;
}

function cardHtml(type, e) {
  var h = '<a class="content-card' + (type === 'experiment' ? ' content-card--exp' : '') + '" href="' + contentUrl(type, e.slug) + '">';
  h += '<h3 class="card-title">' + esc(e.title) + '</h3>';
  if (e.tags && e.tags.length) {
    h += '<div class="card-tags">';
    e.tags.slice(0, 3).forEach(function (t) { h += '<span class="tag">' + esc(t) + '</span>'; });
    h += '</div>';
  }
  h += '</a>';
  return h;
}

function listCardHtml(type, e) {
  var h = '<a class="list-card" href="' + contentUrl(type, e.slug) + '">';
  h += '<div class="list-card-body"><h3 class="list-card-title">' + esc(e.title) + '</h3></div>';
  h += '<div class="list-card-arrow">\u2192</div></a>';
  return h;
}

// ═══════════════════════════════════════════════════════════════════════════
// Rune Grid
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// Wiki List
// ═══════════════════════════════════════════════════════════════════════════

export function renderWikiList(el) {
  var idx = getSiteIndex();
  setTitle('Wiki');
  setBreadcrumbs([{ label: 'Wiki', href: BASE + '/wiki/' }]);
  el.className = '';

  var wikis = sortByUpdated((idx.entries || []).filter(function (e) {
    return e.content_type === 'wiki' && e.visibility === 'public' && e.status !== 'archived';
  }));

  var h = '<section class="home-section"><h1>Wiki</h1>';
  if (wikis.length > 0) {
    h += '<ul class="content-list">';
    wikis.slice(0, COLUMN_LIMIT).forEach(function (w) {
      h += wikiListItem(w);
    });
    h += '</ul>';
    if (wikis.length > COLUMN_LIMIT) {
      h += '<details class="show-more-wrap"><summary class="show-more-toggle">Show ' + (wikis.length - COLUMN_LIMIT) + ' more</summary>';
      h += '<ul class="content-list show-more-items">';
      wikis.slice(COLUMN_LIMIT).forEach(function (w) {
        h += wikiListItem(w);
      });
      h += '</ul></details>';
    }
  } else {
    h += '<p class="empty-page">No wiki entries yet.</p>';
  }
  h += '</section>';
  el.innerHTML = h;
  return Promise.resolve();
}

function wikiListItem(w) {
  var h = '<li><a href="' + contentUrl('wiki', w.slug) + '">' + esc(w.title) + '</a>';
  if (w.tags && w.tags.length) {
    h += ' <span class="tags">';
    w.tags.forEach(function (t) { h += '<span class="tag">' + esc(t) + '</span>'; });
    h += '</span>';
  }
  h += '</li>';
  return h;
}

// ═══════════════════════════════════════════════════════════════════════════
// Wiki Article
// ═══════════════════════════════════════════════════════════════════════════

export function renderWiki(el, slug) {
  var idx = getSiteIndex();
  el.className = '';
  var entry = (idx.entries || []).find(function (e) { return e.content_type === 'wiki' && e.slug === slug; });
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
      h += renderRevisionContent(content.current_revision);
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

// ═══════════════════════════════════════════════════════════════════════════
// Blog List
// ═══════════════════════════════════════════════════════════════════════════

export function renderBlogList(el) {
  var idx = getSiteIndex();
  setTitle('Blog');
  setBreadcrumbs([{ label: 'Blog', href: BASE + '/blog/' }]);
  el.className = '';

  var blogs = sortByUpdated((idx.entries || []).filter(function (e) {
    return e.content_type === 'blog' && e.visibility === 'public' && e.status !== 'archived';
  }));

  var h = '<section class="home-section"><h1>Blog</h1>';
  if (blogs.length > 0) {
    h += '<div class="content-list-cards">';
    blogs.slice(0, COLUMN_LIMIT).forEach(function (b) {
      h += listCardHtml('blog', b);
    });
    h += '</div>';
    if (blogs.length > COLUMN_LIMIT) {
      h += '<details class="show-more-wrap"><summary class="show-more-toggle">Show ' + (blogs.length - COLUMN_LIMIT) + ' more</summary>';
      h += '<div class="content-list-cards show-more-items">';
      blogs.slice(COLUMN_LIMIT).forEach(function (b) {
        h += listCardHtml('blog', b);
      });
      h += '</div></details>';
    }
  } else {
    h += '<p class="empty-page">No blog posts yet.</p>';
  }
  h += '</section>';
  el.innerHTML = h;
  return Promise.resolve();
}

// ═══════════════════════════════════════════════════════════════════════════
// Blog Article
// ═══════════════════════════════════════════════════════════════════════════

export function renderBlog(el, slug) {
  var idx = getSiteIndex();
  el.className = '';
  var entry = (idx.entries || []).find(function (e) { return e.content_type === 'blog' && e.slug === slug; });
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
    h += renderRevisionContent(content.current_revision);
    h += '</div>';

    h += revisionHistoryHtml(content);

    h += '<div class="content-actions eo-admin-only" hidden>';
    h += '<a class="btn btn-edit" href="' + BASE + '/admin/#blog/' + esc(slug) + '">Edit in Admin</a></div>';
    h += '</article>';
    el.innerHTML = h;
    revealAdmin();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Experiment List
// ═══════════════════════════════════════════════════════════════════════════

export function renderExpList(el) {
  var idx = getSiteIndex();
  setTitle('Experiments');
  setBreadcrumbs([{ label: 'Experiments', href: BASE + '/exp/' }]);
  el.className = '';

  var exps = sortByUpdated((idx.entries || []).filter(function (e) {
    return e.content_type === 'experiment' && e.visibility === 'public' && e.status !== 'archived';
  }));

  var h = '<section class="home-section"><h1>Experiments</h1>';
  if (exps.length > 0) {
    h += '<div class="content-grid content-grid--sm">';
    exps.slice(0, COLUMN_LIMIT).forEach(function (e) {
      h += '<a class="content-card content-card--exp" href="' + contentUrl('experiment', e.slug) + '">';
      h += '<h3 class="card-title">' + esc(e.title) + '</h3></a>';
    });
    h += '</div>';
    if (exps.length > COLUMN_LIMIT) {
      h += '<details class="show-more-wrap"><summary class="show-more-toggle">Show ' + (exps.length - COLUMN_LIMIT) + ' more</summary>';
      h += '<div class="content-grid content-grid--sm show-more-items">';
      exps.slice(COLUMN_LIMIT).forEach(function (e) {
        h += '<a class="content-card content-card--exp" href="' + contentUrl('experiment', e.slug) + '">';
        h += '<h3 class="card-title">' + esc(e.title) + '</h3></a>';
      });
      h += '</div></details>';
    }
  } else {
    h += '<p class="empty-page">No experiments yet.</p>';
  }
  h += '</section>';
  el.innerHTML = h;
  return Promise.resolve();
}

// ═══════════════════════════════════════════════════════════════════════════
// Experiment Detail
// ═══════════════════════════════════════════════════════════════════════════

export function renderExp(el, slug) {
  var idx = getSiteIndex();
  el.className = '';
  var entry = (idx.entries || []).find(function (e) { return e.content_type === 'experiment' && e.slug === slug; });
  var contentId = entry ? entry.content_id : 'experiment:' + slug;

  return loadContent(contentId).then(function (content) {
    if (!content || !content.meta) { render404(el); return; }

    var title = content.meta.title;
    setTitle(title);
    setBreadcrumbs([{ label: 'Experiments', href: BASE + '/exp/' }, { label: title, href: BASE + '/exp/' + slug + '/' }]);

    var rev = content.current_revision;
    var kindIcons = { note: '\uD83D\uDCDD', dataset: '\uD83D\uDCC1', result: '\u2705', chart: '\uD83D\uDCC8', link: '\uD83D\uDD17', decision: '\u2696\uFE0F', html: '\uD83C\uDF10' };
    var entries = (content.entries || []).filter(function (e) { return !e.deleted; });

    var h = '<article class="experiment-article" data-eo-op="DES" data-eo-target="' + esc(content.content_id) + '">';
    h += '<header class="content-header"><h1>' + esc(title) + '</h1>';
    h += '<div class="post-meta">';
    if (content.meta.updated_at) h += '<time>' + new Date(content.meta.updated_at).toLocaleDateString() + '</time>';
    h += '</div>';
    h += '<div class="content-tags">';
    (content.meta.tags || []).forEach(function (t) { h += '<span class="tag">' + esc(t) + '</span>'; });
    h += '</div></header>';

    // Revision-based body (like a blog post — supports full HTML/JS)
    if (rev && rev.content) {
      h += '<div class="wiki-body exp-body">';
      h += renderRevisionContent(rev);
      h += '</div>';
    }

    // Entry-based log (experiment entries)
    if (entries.length > 0) {
      h += '<ul class="exp-entries">';
      entries.forEach(function (entry) {
        var icon = kindIcons[entry.kind] || '\uD83D\uDCDD';
        h += '<li class="exp-entry" data-eo-op="INS" data-eo-target="' + esc(content.content_id) + '/entry:' + esc(entry.entry_id) + '">';
        h += '<span class="entry-kind">' + icon + '</span>';
        h += '<div class="entry-body">';
        if (entry.kind === 'html') {
          h += '<div class="exp-html-sandbox">' + String((entry.data && entry.data.html) || '') + '</div>';
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
    } else if (!rev || !rev.content) {
      h += '<p class="empty-page">No content yet.</p>';
    }

    if (rev) h += revisionHistoryHtml(content);

    h += '<div class="content-actions eo-admin-only" hidden>';
    h += '<a class="btn btn-edit" href="' + BASE + '/admin/#exp/' + esc(slug) + '">Edit in Admin</a></div>';
    h += '</article>';
    el.innerHTML = h;

    // Activate embedded scripts so HTML/JS experiments actually run
    activateScripts(el);
    revealAdmin();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Page
// ═══════════════════════════════════════════════════════════════════════════

export function renderPage(el, slug) {
  var idx = getSiteIndex();
  el.className = '';
  var entry = (idx.entries || []).find(function (e) { return e.content_type === 'page' && e.slug === slug; });
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

// ═══════════════════════════════════════════════════════════════════════════
// All Content (printable)
// ═══════════════════════════════════════════════════════════════════════════

export function renderAll(el) {
  var idx = getSiteIndex();
  setTitle('All Content');
  setBreadcrumbs([{ label: 'All Content', href: BASE + '/all/' }]);
  el.className = 'all-content';

  var entries = (idx.entries || []).filter(function (e) {
    return e.visibility === 'public' && e.status !== 'archived';
  });

  var wikis = entries.filter(function (e) { return e.content_type === 'wiki'; });
  var blogs = entries.filter(function (e) { return e.content_type === 'blog'; });
  var pages = entries.filter(function (e) { return e.content_type === 'page'; });

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
            h += renderRevisionContent(r.content.current_revision);
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

// ═══════════════════════════════════════════════════════════════════════════
// 404
// ═══════════════════════════════════════════════════════════════════════════

export function render404(el) {
  setTitle('Not Found');
  setBreadcrumbs([]);
  el.className = '';
  el.innerHTML = '<div class="home-empty"><div class="empty-card"><div class="empty-icon">\u2205</div>' +
    '<h2>Page Not Found</h2><p>NUL \u2014 This page doesn\'t exist yet.</p>' +
    '<a href="' + BASE + '/" class="btn btn-primary">Return Home</a></div></div>';
}

// ═══════════════════════════════════════════════════════════════════════════
// Navigation
// ═══════════════════════════════════════════════════════════════════════════

export function updateNav() {
  var idx = getSiteIndex();
  if (!idx) return;
  var nav = idx.nav || [];

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

  var siteName = (idx.site_settings && idx.site_settings.siteName) || 'Emergent Ontology';
  var hEl = document.getElementById('site-name-header');
  var fEl = document.getElementById('site-name-footer');
  if (hEl) hEl.textContent = siteName;
  if (fEl) fEl.textContent = siteName;
}
