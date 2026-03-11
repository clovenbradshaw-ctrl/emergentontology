/**
 * pages.js — Page-specific renderers.
 *
 * Each renderer takes a DOM element + optional slug, loads data, and renders HTML.
 * All renderers return a Promise so the caller can chain post-render actions.
 */

import { BASE, OPERATORS } from './config.js';
import { classifyEntry, classifyText } from './classify.js';
import { getSiteIndex, getHomeConfig, loadHomeConfig, loadContent } from './api.js';
import { contentUrl } from './router.js';
import {
  esc, md, setBreadcrumbs, setTitle, renderBlock,
  revisionHistoryHtml, renderRevisionContent, revealAdmin,
  hydrateHtmlWidgets, activateScripts, timeAgo, autoSizeIframe
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

var SKIP_WORDS = ['the', 'a', 'an'];

function titleLetter(title) {
  if (!title) return '?';
  var words = title.trim().split(/\s+/);
  for (var i = 0; i < words.length; i++) {
    if (SKIP_WORDS.indexOf(words[i].toLowerCase()) === -1) {
      return words[i].charAt(0).toUpperCase();
    }
  }
  return words[0].charAt(0).toUpperCase();
}

// ── Related pages (auto-link by keyword ↔ slug matching) ────────────────────

var RELATED_STOP = {};
'the a an and or of to in is it for on by at as be do if no so up we he my not but are was has had its can all may you how why what when from with this that will been have they their them into than then each also more some about which would other could'.split(' ').forEach(function (w) { RELATED_STOP[w] = true; });

function extractKeywords(entry) {
  var words = {};
  var raw = (entry.slug || '').split('-')
    .concat((entry.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/))
    .concat((entry.tags || []).map(function (t) { return t.toLowerCase(); }));
  raw.forEach(function (w) {
    if (w.length >= 3 && !RELATED_STOP[w]) words[w] = true;
  });
  return words;
}

function findRelatedPages(currentEntry, maxResults) {
  maxResults = maxResults || 5;
  var keywords = extractKeywords(currentEntry);
  var idx = getSiteIndex();
  var candidates = [];

  (idx.entries || []).forEach(function (e) {
    if (e.content_id === currentEntry.content_id) return;
    if (e.visibility !== 'public' || e.status === 'archived') return;

    var score = 0;
    var slugParts = (e.slug || '').split('-');
    var titleParts = (e.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
    var tags = (e.tags || []).map(function (t) { return t.toLowerCase(); });

    slugParts.concat(titleParts).forEach(function (w) {
      if (keywords[w]) score += 1;
    });
    tags.forEach(function (t) {
      if (keywords[t]) score += 2;
    });

    if (score > 0) candidates.push({ entry: e, score: score });
  });

  candidates.sort(function (a, b) { return b.score - a.score; });
  return candidates.slice(0, maxResults);
}

function relatedPagesHtml(currentEntry) {
  var related = findRelatedPages(currentEntry, 5);
  if (related.length === 0) return '';

  var h = '<nav class="related-pages"><h2>Related</h2><ul>';
  related.forEach(function (r) {
    var e = r.entry;
    h += '<li><a href="' + contentUrl(e.content_type, e.slug) + '">' + esc(e.title) + '</a></li>';
  });
  h += '</ul></nav>';
  return h;
}

// ═══════════════════════════════════════════════════════════════════════════
// Home
// ═══════════════════════════════════════════════════════════════════════════

export function renderHome(el) {
  var idx = getSiteIndex();
  setTitle('Home');
  setBreadcrumbs([]);
  el.className = 'home';

  // Ensure home config is loaded before rendering (it loads in parallel with index)
  return loadHomeConfig().then(function () {
    return _renderHomeInner(el, idx);
  });
}

function _renderHomeInner(el, idx) {
  var publicEntries = (idx.entries || []).filter(function (e) {
    return e.visibility === 'public' && e.status !== 'archived';
  });
  var wikis = sortByUpdated(publicEntries.filter(function (e) { return e.content_type === 'wiki'; }));
  var blogs = sortByUpdated(publicEntries.filter(function (e) { return e.content_type === 'blog'; }));
  var exps  = sortByUpdated(publicEntries.filter(function (e) { return e.content_type === 'experiment'; }));
  var docs  = sortByUpdated(publicEntries.filter(function (e) { return e.content_type === 'document'; }));

  var home = getHomeConfig();
  var h = '';

  // ── Hero ──
  var heroTitle = (home && home.hero && home.hero.title)
    ? esc(home.hero.title.replace(/\n+$/, '')).replace(/\n/g, '<br>')
    : 'A theory that changes everything<br>about everything that changes.';
  var heroBadge = (home && home.hero && home.hero.badge)
    ? esc(home.hero.badge)
    : 'Emergent Ontology (EO)';
  var heroSub = (home && home.hero && home.hero.subtitle)
    ? esc(home.hero.subtitle.replace(/\n+$/, '').replace(/\s+/g, ' '))
    : '';

  h += '<section class="home-hero">';
  h += '<div class="hero-badge">' + heroBadge + '</div>';
  h += '<h1 class="hero-title">' + heroTitle + '</h1>';
  if (heroSub) {
    h += '<p class="hero-sub">' + heroSub + '</p>';
  }
  h += '<div class="hero-ctas">';
  // Find handbook document for CTA
  var handbook = docs.find(function (d) { return d.slug && d.slug.indexOf('handbook') !== -1; })
    || docs.find(function (d) { return d.title && d.title.toLowerCase().indexOf('handbook') !== -1; });
  if (handbook) {
    h += '<a class="hero-btn hero-btn--primary" href="' + contentUrl('document', handbook.slug) + '">Read the Handbook</a>';
  }
  h += '<a class="hero-btn hero-btn--secondary" href="' + BASE + 'wiki/">Browse Wiki</a>';
  h += '</div>';
  h += '</section>';

  // ── Concepts Row ──
  var concepts = (home && home.concepts) || [];
  if (concepts.length > 0) {
    h += '<div class="concepts-row"><div class="concepts-grid">';
    concepts.forEach(function (c) {
      h += '<div class="concept-card">';
      h += '<div class="concept-label">' + esc(c.label) + '</div>';
      h += '<div class="concept-brief">' + esc(c.brief) + '</div>';
      h += '</div>';
    });
    h += '</div></div>';
  }

  // ── Divider ──
  h += '<hr class="home-divider">';

  // ── Two-column content area ──
  h += '<div class="home-content-area">';

  // Left: Wiki feed
  h += '<div>';
  h += feedSectionHtml('Wiki', 'wiki', wikis, COLUMN_LIMIT);
  h += '</div>';

  // Right sidebar
  h += '<div class="home-content-sidebar">';

  // Handbook callout
  if (handbook) {
    h += '<a class="handbook-callout" href="' + contentUrl('document', handbook.slug) + '">';
    h += '<div class="callout-label">Start Here</div>';
    h += '<div class="callout-title">' + esc(handbook.title) + '</div>';
    if (handbook.description) {
      h += '<div class="callout-desc">' + esc(handbook.description) + '</div>';
    } else {
      h += '<div class="callout-desc">The comprehensive guide to Emergent Ontology — the best entry point for newcomers.</div>';
    }
    h += '<div class="callout-cta">Open Handbook \u2192</div>';
    h += '</a>';
  }

  // Experiments feed
  if (exps.length > 0) {
    h += feedSectionHtml('Experiments', 'experiment', exps, 4);
  }

  // Blog (placeholder or feed)
  if (blogs.length > 0) {
    h += feedSectionHtml('Blog', 'blog', blogs, 5);
  } else {
    h += '<div class="blog-placeholder">';
    h += '<div class="blog-placeholder-title">Blog</div>';
    h += '<div class="blog-placeholder-note">No entries published yet.</div>';
    h += '</div>';
  }

  // Documents & Assets (excluding handbook which is already shown)
  var otherDocs = docs.filter(function (d) { return !handbook || d.slug !== handbook.slug; });
  if (otherDocs.length > 0) {
    h += feedSectionHtml('Documents', 'document', otherDocs, 4);
  }

  h += '</div>'; // home-content-sidebar
  h += '</div>'; // home-content-area

  // ── Footer ──
  h += '<div class="home-footer">';
  h += '<span class="home-footer-copy">\u00A9 Emergent Ontology</span>';
  h += '<div class="home-footer-links">';
  ['Wiki', 'Blog', 'Experiments', 'Documents'].forEach(function (name) {
    h += '<a href="' + BASE + name.toLowerCase() + '/">' + name + '</a>';
  });
  h += '</div></div>';

  el.innerHTML = h;
}

function sectionHtml(title, type, entries, max, layout) {
  var h = '<section class="home-section"><div class="section-header"><h2 class="section-title">' + esc(title) + '</h2></div>';
  if (entries.length === 0) {
    return ''; // hide empty sections entirely
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

// ── Feed-style rendering (redesigned home) ──────────────────────────────────

function feedItemHtml(type, e) {
  var op = classifyEntry(e);
  var h = '<a class="feed-item" href="' + contentUrl(type, e.slug) + '">';
  h += '<span class="feed-avatar" title="' + esc(op.code) + '">eo</span>';
  h += '<div class="feed-body">';
  h += '<div class="feed-header">';
  h += '<span class="feed-title">' + esc(e.title) + '</span>';
  if (e.tags && e.tags.length) {
    e.tags.slice(0, 2).forEach(function (t) { h += '<span class="tag">' + esc(t) + '</span>'; });
  }
  if (e.updated_at) {
    h += '<span class="feed-time">' + timeAgo(e.updated_at) + '</span>';
  }
  h += '</div>'; // feed-header
  if (e.description) {
    h += '<div class="feed-desc">' + esc(e.description) + '</div>';
  }
  h += '</div>'; // feed-body
  h += '</a>';
  return h;
}

function feedSectionHtml(title, type, entries, max) {
  var h = '<div>';
  h += '<div class="feed-section-header">';
  h += '<h2 class="feed-section-title">' + esc(title) + '</h2>';
  if (entries.length > max) {
    h += '<a class="feed-section-more" href="' + BASE + type + '/">+ ' + (entries.length - max) + ' more</a>';
  }
  h += '</div>';
  h += '<div class="feed-list">';
  entries.slice(0, max).forEach(function (e) {
    h += feedItemHtml(type, e);
  });
  h += '</div>';
  if (entries.length > max) {
    h += '<details class="show-more-wrap"><summary class="show-more-toggle">Show ' + (entries.length - max) + ' more</summary>';
    h += '<div class="feed-list show-more-items">';
    entries.slice(max).forEach(function (e) {
      h += feedItemHtml(type, e);
    });
    h += '</div></details>';
  }
  h += '</div>';
  return h;
}

function cardHtml(type, e) {
  var op = classifyEntry(e);
  var icon = (type === 'blog' || type === 'wiki') ? titleLetter(e.title) : op.symbol;
  var h = '<a class="content-card' + (type === 'experiment' ? ' content-card--exp' : '') + '" href="' + contentUrl(type, e.slug) + '">';
  h += '<span class="card-operator" style="color:' + op.color + '" title="' + op.code + '">' + icon + '</span>';
  h += '<h3 class="card-title">' + esc(e.title) + '</h3>';
  if (e.tags && e.tags.length) {
    h += '<div class="card-tags">';
    e.tags.slice(0, 3).forEach(function (t) { h += '<span class="tag">' + esc(t) + '</span>'; });
    h += '</div>';
  }
  if (e.updated_at) {
    h += '<div class="card-meta"><time>' + timeAgo(e.updated_at) + '</time></div>';
  }
  h += '</a>';
  return h;
}

function listCardHtml(type, e) {
  var op = classifyEntry(e);
  var icon = (type === 'blog' || type === 'wiki') ? titleLetter(e.title) : op.symbol;
  var h = '<a class="list-card" href="' + contentUrl(type, e.slug) + '">';
  h += '<span class="list-card-operator" style="color:' + op.color + '" title="' + op.code + '">' + icon + '</span>';
  h += '<div class="list-card-body"><h3 class="list-card-title">' + esc(e.title) + '</h3>';
  if (e.updated_at) {
    h += '<div class="list-card-meta"><time>' + timeAgo(e.updated_at) + '</time></div>';
  }
  h += '</div>';
  h += '<div class="list-card-arrow">\u2192</div></a>';
  return h;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase Cube (3D spinning cube with three faces: Site, Act, Resolution)
// ═══════════════════════════════════════════════════════════════════════════

var CUBE_FACES = [
  {
    name: 'Act',
    dim: 'Mode \u00d7 Domain',
    cells: [
      { sym: '\u2205', code: 'NUL', row: 0 },
      { sym: '\u22A1', code: 'SIG', row: 0 },
      { sym: '\u25B3', code: 'INS', row: 0 },
      { sym: '|',      code: 'SEG', row: 1 },
      { sym: '\u22C8', code: 'CON', row: 1 },
      { sym: '\u2228', code: 'SYN', row: 1 },
      { sym: '\u223F', code: 'ALT', row: 2 },
      { sym: '\u2225', code: 'SUP', row: 2 },
      { sym: '\u21AC', code: 'REC', row: 2 }
    ]
  },
  {
    name: 'Site',
    dim: 'Domain \u00d7 Object',
    cells: [
      { sym: '\u25CC', code: 'VOID', row: 0 },
      { sym: '\u25C6', code: 'ENTITY', row: 0 },
      { sym: '\u25C7', code: 'KIND', row: 0 },
      { sym: '\u224B', code: 'FIELD', row: 1 },
      { sym: '\u2194', code: 'LINK', row: 1 },
      { sym: '\u2B21', code: 'NETWORK', row: 1 },
      { sym: '\u2248', code: 'ATMO', row: 2 },
      { sym: '\u25CE', code: 'LENS', row: 2 },
      { sym: '\u27D0', code: 'PARA', row: 2 }
    ]
  },
  {
    name: 'Resolution',
    dim: 'Mode \u00d7 Object',
    cells: [
      { sym: '\u2300', code: 'CLRG', row: 0 },
      { sym: '\u233F', code: 'CUT', row: 0 },
      { sym: '\u21AF', code: 'UNRV', row: 0 },
      { sym: '\u2322', code: 'TEND', row: 1 },
      { sym: '\u2295', code: 'BIND', row: 1 },
      { sym: '\u2261', code: 'TRCE', row: 1 },
      { sym: '\u2299', code: 'CULV', row: 2 },
      { sym: '\u2726', code: 'FORG', row: 2 },
      { sym: '\u229E', code: 'COMP', row: 2 }
    ]
  }
];

function cubeFaceHtml(face, cssClass) {
  var h = '<div class="cube-face ' + cssClass + '">';
  face.cells.forEach(function (c) {
    h += '<div class="cube-cell r' + c.row + '" data-code="' + c.code + '">';
    h += '<span class="cube-cell-sym">' + c.sym + '</span>';
    h += '<span class="cube-cell-code">' + c.code + '</span>';
    h += '</div>';
  });
  h += '</div>';
  return h;
}

function phaseCubeHtml(allTags) {
  // Front/Right/Top faces + mirrored Back/Left/Bottom faces
  var mainClasses = ['cube-face--front', 'cube-face--right', 'cube-face--top'];
  var backClasses = ['cube-face--back',  'cube-face--left',  'cube-face--bottom'];
  var h = '<aside class="cube-sidebar" aria-label="Phase Cube">';

  // Label
  h += '<div class="cube-label" id="cube-label">';
  h += '<div>' + CUBE_FACES[0].name + '</div>';
  h += '<div class="cube-label-dim">' + CUBE_FACES[0].dim + '</div>';
  h += '</div>';

  // Cube
  h += '<div class="phase-cube-wrap">';
  h += '<div class="phase-cube" id="phase-cube" data-face="0">';
  CUBE_FACES.forEach(function (face, i) {
    // Main face (front, right, top)
    h += cubeFaceHtml(face, mainClasses[i]);
    // Mirrored back face (back, left, bottom)
    h += cubeFaceHtml(face, backClasses[i]);
  });
  h += '</div></div>';

  // Navigation dots + arrows (horizontal + vertical)
  h += '<div class="cube-controls">';
  h += '<button class="cube-nav-btn cube-nav-up" id="cube-up" title="Tilt up (&#8593;)">\u25B5</button>';
  h += '<div class="cube-nav">';
  h += '<button class="cube-nav-btn" id="cube-prev" title="Previous face (&#8592;)">\u2039</button>';
  h += '<div class="cube-dots" id="cube-dots">';
  CUBE_FACES.forEach(function (_, i) {
    h += '<span class="cube-dot' + (i === 0 ? ' active' : '') + '"></span>';
  });
  h += '</div>';
  h += '<button class="cube-nav-btn" id="cube-next" title="Next face (&#8594;)">\u203A</button>';
  h += '</div>';
  h += '<button class="cube-nav-btn cube-nav-down" id="cube-down" title="Tilt down (&#8595;)">\u25BF</button>';
  h += '</div>';

  // Topics
  if (allTags.length > 0) {
    h += '<div class="sidebar-topics sidebar-tags">';
    h += '<div class="sidebar-label">Topics</div>';
    h += '<div class="tag-cloud">';
    allTags.forEach(function (t) { h += '<span class="tag tag-lg">' + esc(t) + '</span>'; });
    h += '</div></div>';
  }

  h += '</aside>';
  return h;
}

function initPhaseCube(container) {
  var cube = container.querySelector('#phase-cube');
  var label = container.querySelector('#cube-label');
  var dots = container.querySelectorAll('#cube-dots .cube-dot');
  var prevBtn = container.querySelector('#cube-prev');
  var nextBtn = container.querySelector('#cube-next');
  var upBtn = container.querySelector('#cube-up');
  var downBtn = container.querySelector('#cube-down');
  if (!cube) return;

  var current = 0;
  var total = CUBE_FACES.length;
  var wrap = container.querySelector('.phase-cube-wrap');

  // ── Free rotation state ──
  var FACE_RX = [-15, -15, 75];   // per-face rotateX (keeps text right-side up)
  var FACE_RY = [25, -65, 25];    // per-face rotateY
  var userX = 0, userY = 0; // accumulated user rotation offsets
  var TILT_MAX = 22; // max degrees of drag/tilt offset
  var PARALLAX = 5;  // hover tilt intensity (degrees)

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function applyTransform(transition, duration) {
    var rx = FACE_RX[current] + userX;
    var ry = FACE_RY[current] + userY;
    var dur = duration || '0.6s';
    cube.style.transition = transition ? 'transform ' + dur + ' cubic-bezier(.4, 0, .2, 1)' : 'none';
    cube.style.transform = 'rotateX(' + rx + 'deg) rotateY(' + ry + 'deg)';
  }

  function showFace(index) {
    current = ((index % total) + total) % total;
    cube.setAttribute('data-face', String(current));
    // Reset drag offsets so face snaps to clean readable orientation
    userX = 0;
    userY = 0;
    if (label) {
      label.classList.add('fading');
      setTimeout(function () {
        label.innerHTML = '<div>' + CUBE_FACES[current].name + '</div><div class="cube-label-dim">' + CUBE_FACES[current].dim + '</div>';
        label.classList.remove('fading');
      }, 300);
    }
    for (var i = 0; i < dots.length; i++) {
      dots[i].classList.toggle('active', i === current);
    }
    applyTransform(true);
  }

  function tiltUp() {
    userX = TILT_MAX;
    applyTransform(true);
    pauseAuto();
    setTimeout(function () { userX = 0; applyTransform(true, '0.35s'); resumeAuto(); }, 800);
  }
  function tiltDown() {
    userX = -TILT_MAX;
    applyTransform(true);
    pauseAuto();
    setTimeout(function () { userX = 0; applyTransform(true, '0.35s'); resumeAuto(); }, 800);
  }
  function spinLeft()  { showFace(current - 1); }
  function spinRight() { showFace(current + 1); }

  if (prevBtn) prevBtn.addEventListener('click', function () { spinLeft(); });
  if (nextBtn) nextBtn.addEventListener('click', function () { spinRight(); });
  if (upBtn)   upBtn.addEventListener('click', function () { tiltUp(); });
  if (downBtn) downBtn.addEventListener('click', function () { tiltDown(); });

  // Auto-rotate every 15 seconds
  var autoTimer = setInterval(function () { showFace(current + 1); }, 15000);

  function pauseAuto() { clearInterval(autoTimer); }
  function resumeAuto() {
    clearInterval(autoTimer);
    autoTimer = setInterval(function () { showFace(current + 1); }, 15000);
  }

  // ── Swipe / drag to rotate (2D) ──
  var dragStartX = 0, dragStartY = 0;
  var dragging = false;
  var swipeThreshold = 40;

  function onPointerDown(e) {
    if (e.target.closest('.cube-nav-btn')) return;
    dragging = true;
    var touch = e.touches && e.touches[0];
    dragStartX = e.clientX || (touch && touch.clientX) || 0;
    dragStartY = e.clientY || (touch && touch.clientY) || 0;
    pauseAuto();
    cube.classList.add('no-transition');
  }

  function onPointerMove(e) {
    if (!dragging) return;
    e.preventDefault();
    var touch = e.touches && e.touches[0];
    var cx = e.clientX || (touch && touch.clientX) || 0;
    var cy = e.clientY || (touch && touch.clientY) || 0;
    var dx = cx - dragStartX;
    var dy = cy - dragStartY;
    // Live preview rotation during drag (clamped to tilt range)
    var previewY = clamp(dx * 0.5, -TILT_MAX, TILT_MAX);
    var previewX = clamp(-dy * 0.5, -TILT_MAX, TILT_MAX);
    var rx = FACE_RX[current] + previewX;
    var ry = FACE_RY[current] + previewY;
    cube.style.transition = 'none';
    cube.style.transform = 'rotateX(' + rx + 'deg) rotateY(' + ry + 'deg)';
  }

  function onPointerEnd(e) {
    if (!dragging) return;
    dragging = false;
    cube.classList.remove('no-transition');
    var endX = e.clientX || (e.changedTouches && e.changedTouches[0].clientX) || 0;
    var endY = e.clientY || (e.changedTouches && e.changedTouches[0].clientY) || 0;
    var dx = endX - dragStartX;
    var dy = endY - dragStartY;

    // If horizontal swipe is dominant and exceeds threshold, cycle face
    if (Math.abs(dx) > swipeThreshold && Math.abs(dx) > Math.abs(dy)) {
      showFace(dx < 0 ? current + 1 : current - 1);
    } else {
      // Snap back to base orientation
      userX = 0;
      userY = 0;
      applyTransform(true, '0.35s');
    }
    resumeAuto();
  }

  if (wrap) {
    // Touch events
    wrap.addEventListener('touchstart', onPointerDown, { passive: true });
    wrap.addEventListener('touchmove', onPointerMove, { passive: false });
    wrap.addEventListener('touchend', onPointerEnd);
    // Mouse drag
    wrap.addEventListener('mousedown', onPointerDown);
    document.addEventListener('mousemove', onPointerMove);
    document.addEventListener('mouseup', onPointerEnd);

    // Pause auto-rotate on hover
    wrap.addEventListener('mouseenter', pauseAuto);
    wrap.addEventListener('mouseleave', function () {
      if (!dragging) resumeAuto();
    });

    // ── Multi-axis tilt (parallax hover) ──
    wrap.addEventListener('mousemove', function (e) {
      if (dragging) return;
      var rect = wrap.getBoundingClientRect();
      var x = (e.clientX - rect.left) / rect.width - 0.5;
      var y = (e.clientY - rect.top) / rect.height - 0.5;
      var tiltX = y * -PARALLAX;
      var tiltY = x * PARALLAX;
      var rx = FACE_RX[current] + tiltX;
      var ry = FACE_RY[current] + tiltY;
      cube.style.transition = 'none';
      cube.style.transform = 'rotateX(' + rx + 'deg) rotateY(' + ry + 'deg)';
    });

    wrap.addEventListener('mouseleave', function () {
      applyTransform(true);
    });
  }

  // ── Keyboard controls ──
  document.addEventListener('keydown', function (e) {
    // Only respond when cube is visible
    if (!cube.offsetParent) return;
    // Don't hijack input fields
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    switch (e.key) {
      case 'ArrowLeft':  e.preventDefault(); spinLeft(); break;
      case 'ArrowRight': e.preventDefault(); spinRight(); break;
      case 'ArrowUp':    e.preventDefault(); tiltUp(); break;
      case 'ArrowDown':  e.preventDefault(); tiltDown(); break;
    }
  });

  // ── Click to expand face detail ──
  cube.addEventListener('click', function (e) {
    if (dragging) return;
    var cell = e.target.closest('.cube-cell');
    openCubeDetail(current, cell ? cell.getAttribute('data-code') : null);
  });
}

// ── Cube Detail Overlay ──
function openCubeDetail(faceIndex, highlightCode) {
  // Remove existing overlay if any
  var existing = document.querySelector('.cube-detail-overlay');
  if (existing) existing.remove();

  var face = CUBE_FACES[faceIndex];
  var rowLabels = ['Mode', 'Domain', 'Object'];
  var rowColors = ['#9b8ff5', '#5f8dd3', '#c47a5a'];

  var h = '<div class="cube-detail-overlay" role="dialog" aria-label="' + face.name + ' face detail">';
  h += '<div class="cube-detail-backdrop"></div>';
  h += '<div class="cube-detail-panel">';

  // Header
  h += '<div class="cube-detail-header">';
  h += '<div class="cube-detail-title">' + face.name + '</div>';
  h += '<div class="cube-detail-dim">' + face.dim + '</div>';
  h += '<button class="cube-detail-close" aria-label="Close">&times;</button>';
  h += '</div>';

  // Grid
  h += '<div class="cube-detail-grid">';
  face.cells.forEach(function (c, i) {
    var rowIdx = c.row;
    var isHighlighted = highlightCode && c.code === highlightCode;
    h += '<div class="cube-detail-cell' + (isHighlighted ? ' highlighted' : '') + '" style="--row-color: ' + rowColors[rowIdx] + '">';
    h += '<div class="cube-detail-cell-sym">' + c.sym + '</div>';
    h += '<div class="cube-detail-cell-code">' + c.code + '</div>';
    h += '</div>';
  });
  h += '</div>';

  // Face indicator
  h += '<div class="cube-detail-nav">';
  CUBE_FACES.forEach(function (f, i) {
    h += '<button class="cube-detail-nav-btn' + (i === faceIndex ? ' active' : '') + '" data-face="' + i + '">' + f.name + '</button>';
  });
  h += '</div>';

  h += '</div></div>';

  document.body.insertAdjacentHTML('beforeend', h);

  var overlay = document.querySelector('.cube-detail-overlay');
  // Trigger enter animation
  requestAnimationFrame(function () {
    overlay.classList.add('open');
  });

  // Close handlers
  function close() {
    overlay.classList.remove('open');
    overlay.addEventListener('transitionend', function () { overlay.remove(); }, { once: true });
    // Fallback removal
    setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 400);
  }

  overlay.querySelector('.cube-detail-backdrop').addEventListener('click', close);
  overlay.querySelector('.cube-detail-close').addEventListener('click', close);
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });

  // Face switching within overlay
  overlay.querySelectorAll('.cube-detail-nav-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var idx = parseInt(btn.getAttribute('data-face'), 10);
      close();
      setTimeout(function () { openCubeDetail(idx, null); }, 300);
    });
  });
}

// Legacy rune grid functions (kept for non-home pages)
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
  el.className = 'wiki-list';

  var wikis = sortByUpdated((idx.entries || []).filter(function (e) {
    return e.content_type === 'wiki' && e.visibility === 'public' && e.status !== 'archived';
  }));

  var h = '<section class="home-section"><h1>Wiki</h1>';
  h += '<div class="wiki-export-bar"><a class="btn btn-outline wiki-export-btn" href="' + BASE + '/wiki/all/">Export Wiki PDF</a></div>';
  if (wikis.length > 0) {
    // Group wikis by tag — entries appear under each of their tags
    var tagGroups = {};
    var tagOrder = [];
    var uncategorized = [];

    wikis.forEach(function (w) {
      var tags = w.tags && w.tags.length ? w.tags : [];
      if (tags.length === 0) {
        uncategorized.push(w);
      } else {
        tags.forEach(function (t) {
          if (!tagGroups[t]) {
            tagGroups[t] = [];
            tagOrder.push(t);
          }
          tagGroups[t].push(w);
        });
      }
    });

    // Sort tags alphabetically (case-insensitive)
    tagOrder.sort(function (a, b) {
      return a.localeCompare(b);
    });

    // Sort pinned items to top, then by updated_at (already sorted)
    function pinnedFirst(items) {
      var pinned = items.filter(function (w) { return w.pinned; });
      var rest = items.filter(function (w) { return !w.pinned; });
      return pinned.concat(rest);
    }

    h += '<div class="wiki-accordion">';
    tagOrder.forEach(function (tag) {
      var items = pinnedFirst(tagGroups[tag]);
      h += '<details class="wiki-accordion-group" open>';
      h += '<summary class="wiki-accordion-header"><span class="accordion-chevron"></span> <span class="accordion-tag">' + esc(tag) + '</span> <span class="tag-count">(' + items.length + ')</span></summary>';
      h += '<ul class="wiki-accordion-list">';
      items.forEach(function (w) {
        h += wikiListItem(w);
      });
      h += '</ul>';
      h += '</details>';
    });

    if (uncategorized.length > 0) {
      var uncatSorted = pinnedFirst(uncategorized);
      h += '<details class="wiki-accordion-group" open>';
      h += '<summary class="wiki-accordion-header"><span class="accordion-chevron"></span> <span class="accordion-tag">Other</span> <span class="tag-count">(' + uncatSorted.length + ')</span></summary>';
      h += '<ul class="wiki-accordion-list">';
      uncatSorted.forEach(function (w) {
        h += wikiListItem(w);
      });
      h += '</ul>';
      h += '</details>';
    }
    h += '</div>';
  } else {
    h += '<p class="empty-page">No wiki entries yet.</p>';
  }
  h += '</section>';
  el.innerHTML = h;
  return Promise.resolve();
}

function wikiListItem(w) {
  var op = classifyEntry(w);
  var opHtml = '<span class="list-operator" style="color:' + op.color + '" title="' + op.code + '">' + op.symbol + '</span> ';
  var pinClass = w.pinned ? ' pinned' : '';
  var pinHtml = w.pinned ? '<span class="pin-indicator" title="Pinned">\uD83D\uDCCC</span> ' : '';
  var h = '<li class="wiki-accordion-item' + pinClass + '">';
  h += '<div class="wiki-item-main">' + pinHtml + opHtml + '<a href="' + contentUrl('wiki', w.slug) + '">' + esc(w.title) + '</a></div>';
  var hasMeta = (w.tags && w.tags.length) || w.updated_at;
  if (hasMeta) {
    h += '<div class="wiki-item-meta">';
    if (w.tags && w.tags.length) {
      h += '<span class="tags">';
      w.tags.forEach(function (t) { h += '<span class="tag">' + esc(t) + '</span>'; });
      h += '</span>';
    }
    if (w.updated_at) {
      h += '<time class="list-updated">' + timeAgo(w.updated_at) + '</time>';
    }
    h += '</div>';
  }
  h += '</li>';
  return h;
}

// ═══════════════════════════════════════════════════════════════════════════
// Wiki All (printable PDF export)
// ═══════════════════════════════════════════════════════════════════════════

export function renderWikiAll(el) {
  var idx = getSiteIndex();
  setTitle('Wiki \u2014 Complete Collection');
  setBreadcrumbs([{ label: 'Wiki', href: BASE + '/wiki/' }, { label: 'Export PDF', href: BASE + '/wiki/all/' }]);
  el.className = 'all-content';

  var wikis = sortByUpdated((idx.entries || []).filter(function (e) {
    return e.content_type === 'wiki' && e.visibility === 'public' && e.status !== 'archived';
  }));

  var loads = wikis.map(function (e) {
    return loadContent(e.content_id).then(function (content) {
      return { entry: e, content: content };
    });
  });

  el.innerHTML = '<div class="all-loading"><p>Loading all wiki content\u2026</p></div>';

  return Promise.all(loads).then(function (results) {
    // Group by tag for TOC
    var tagGroups = {};
    var tagOrder = [];
    var uncategorized = [];

    results.forEach(function (r) {
      var tags = r.entry.tags && r.entry.tags.length ? r.entry.tags : [];
      if (tags.length === 0) {
        uncategorized.push(r);
      } else {
        tags.forEach(function (t) {
          if (!tagGroups[t]) { tagGroups[t] = []; tagOrder.push(t); }
          tagGroups[t].push(r);
        });
      }
    });
    tagOrder.sort(function (a, b) { return a.localeCompare(b); });

    // Header
    var h = '<div class="all-header">';
    h += '<h1>Wiki \u2014 Complete Collection</h1>';
    h += '<p class="all-stats">' + results.length + ' article' + (results.length !== 1 ? 's' : '') + '</p>';
    h += '<button class="btn btn-primary all-print-btn" onclick="window.print()">Print / Save as PDF</button>';
    h += ' <a class="btn btn-outline wiki-all-back" href="' + BASE + '/wiki/">Back to Wiki</a>';
    h += '</div>';

    // Table of contents grouped by tag
    h += '<nav class="all-toc"><h2>Table of Contents</h2><ol>';
    tagOrder.forEach(function (tag) {
      h += '<li><strong>' + esc(tag) + '</strong><ol>';
      tagGroups[tag].forEach(function (r) {
        var anchor = (r.entry.content_id || '').replace(/[^a-z0-9]+/gi, '-');
        h += '<li><a href="#all-' + anchor + '">' + esc(r.entry.title) + '</a></li>';
      });
      h += '</ol></li>';
    });
    if (uncategorized.length > 0) {
      h += '<li><strong>Other</strong><ol>';
      uncategorized.forEach(function (r) {
        var anchor = (r.entry.content_id || '').replace(/[^a-z0-9]+/gi, '-');
        h += '<li><a href="#all-' + anchor + '">' + esc(r.entry.title) + '</a></li>';
      });
      h += '</ol></li>';
    }
    h += '</ol></nav>';

    // Render each article (flat list, deduplicated)
    var rendered = {};
    h += '<section class="all-section"><h2 class="all-section-title">Wiki</h2>';
    results.forEach(function (r) {
      if (rendered[r.entry.content_id]) return;
      rendered[r.entry.content_id] = true;

      var anchor = (r.entry.content_id || '').replace(/[^a-z0-9]+/gi, '-');
      h += '<article class="all-article" id="all-' + anchor + '">';
      h += '<header class="all-article-header"><h3>' + esc(r.entry.title) + '</h3>';
      h += '<a class="all-article-link" href="' + contentUrl('wiki', r.entry.slug) + '">wiki/' + esc(r.entry.slug) + '</a>';
      if (r.entry.tags && r.entry.tags.length) {
        h += '<div class="all-article-tags">';
        r.entry.tags.forEach(function (t) { h += '<span class="tag">' + esc(t) + '</span>'; });
        h += '</div>';
      }
      h += '</header>';
      h += '<div class="all-article-body">';
      if (r.content) {
        h += renderRevisionContent(r.content.current_revision);
      } else {
        h += '<p class="empty-page">Content not available.</p>';
      }
      h += '</div></article>';
    });
    h += '</section>';

    el.innerHTML = h;
    hydrateHtmlWidgets(el);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Wiki Article
// ═══════════════════════════════════════════════════════════════════════════

function getNextWikiEntry(currentSlug) {
  var idx = getSiteIndex();
  var wikis = sortByUpdated((idx.entries || []).filter(function (e) {
    return e.content_type === 'wiki' && e.visibility === 'public' && e.status !== 'archived';
  }));
  if (wikis.length <= 1) return null;
  var currentIndex = -1;
  for (var i = 0; i < wikis.length; i++) {
    if (wikis[i].slug === currentSlug) { currentIndex = i; break; }
  }
  if (currentIndex === -1) return null;
  return wikis[(currentIndex + 1) % wikis.length];
}

function extractSnippet(revision, maxLen) {
  maxLen = maxLen || 150;
  var html = renderRevisionContent(revision);
  var tmp = document.createElement('div');
  tmp.innerHTML = html;
  var text = (tmp.textContent || tmp.innerText || '').trim();
  if (text.length <= maxLen) return text;
  var truncated = text.slice(0, maxLen);
  var lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.6) truncated = truncated.slice(0, lastSpace);
  return truncated + '\u2026';
}

export function renderWiki(el, slug) {
  var idx = getSiteIndex();
  el.className = '';
  var entry = (idx.entries || []).find(function (e) { return e.content_type === 'wiki' && e.slug === slug; });
  var contentId = entry ? entry.content_id : 'wiki:' + slug;

  return loadContent(contentId).then(function (content) {
    var operator = OPERATORS.find(function (op) { return op.slug === slug; });

    if (content && content.meta && content.meta.status !== 'archived') {
      var title = content.meta.title;
      setTitle(title);
      setBreadcrumbs([{ label: 'Wiki', href: BASE + '/wiki/' }, { label: title, href: BASE + '/wiki/' + slug + '/' }]);

      var classifyParts = [title, title];
      (content.meta.tags || []).forEach(function (t) { classifyParts.push(t); });
      if (content.current_revision && content.current_revision.content) {
        classifyParts.push(content.current_revision.content);
      }
      var op = classifyText(classifyParts.join(' '));
      var h = '<article class="wiki-content" data-eo-op="' + op.code + '" data-eo-target="' + esc(content.content_id) + '">';
      h += '<header class="content-header"><h1>' + esc(title) + '</h1>';
      h += '<code class="eo-op"><span class="eo-sym">' + op.symbol + '</span> <span class="eo-name">' + op.code + '</span>(<span class="eo-target">' + esc(content.content_id) + '</span>)</code>';
      h += '<div class="content-tags">';
      (content.meta.tags || []).forEach(function (t) { h += '<span class="tag">' + esc(t) + '</span>'; });
      h += '</div></header>';

      if (content.has_conflict) {
        h += '<div class="conflict-banner"><strong>Conflict detected:</strong> ' + (content.conflict_candidates || []).length + ' concurrent revisions. <a href="#history">View history</a>.</div>';
      }

      h += '<div class="wiki-body">';
      h += renderRevisionContent(content.current_revision);
      h += '</div>';

      h += relatedPagesHtml(content.meta);

      h += '<nav class="post-nav" id="next-wiki-preview"></nav>';

      h += revisionHistoryHtml(content);

      h += '<div class="content-actions eo-admin-only" hidden>';
      h += '<a class="btn btn-edit" href="' + BASE + '/admin/#wiki/' + esc(slug) + '">Edit in Admin</a></div>';
      h += '</article>';
      el.innerHTML = h;
      hydrateHtmlWidgets(el);

      var nextEntry = getNextWikiEntry(slug);
      if (nextEntry) {
        loadContent(nextEntry.content_id).then(function (nextContent) {
          var previewEl = document.getElementById('next-wiki-preview');
          if (!previewEl) return;
          if (!nextContent || !nextContent.current_revision) {
            previewEl.style.display = 'none';
            return;
          }
          var snippet = extractSnippet(nextContent.current_revision, 150);
          var url = contentUrl('wiki', nextEntry.slug);
          previewEl.innerHTML =
            '<a class="post-nav-next" href="' + url + '">' +
            '<span class="post-nav-label">Next article \u2192</span>' +
            '<span class="post-nav-title">' + esc(nextEntry.title) + '</span>' +
            (snippet ? '<span class="post-nav-snippet">' + esc(snippet) + '</span>' : '') +
            '</a>';
        });
      }
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
    if (!content || !content.meta || content.meta.status === 'archived') { render404(el); return; }

    var title = content.meta.title;
    setTitle(title);
    setBreadcrumbs([{ label: 'Blog', href: BASE + '/blog/' }, { label: title, href: BASE + '/blog/' + slug + '/' }]);

    var h = '<article class="wiki-content" data-eo-op="SIG" data-eo-target="' + esc(content.content_id) + '">';
    h += '<header class="content-header"><h1>' + esc(title) + '</h1>';
    h += '<div class="post-meta">';
    if (content.meta.updated_at) h += '<time>' + timeAgo(content.meta.updated_at) + '</time>';
    h += '</div>';
    h += '<div class="content-tags">';
    (content.meta.tags || []).forEach(function (t) { h += '<span class="tag">' + esc(t) + '</span>'; });
    h += '</div></header>';

    h += '<div class="wiki-body">';
    h += renderRevisionContent(content.current_revision);
    h += '</div>';

    h += relatedPagesHtml(content.meta);

    h += revisionHistoryHtml(content);

    h += '<div class="content-actions eo-admin-only" hidden>';
    h += '<a class="btn btn-edit" href="' + BASE + '/admin/#blog/' + esc(slug) + '">Edit in Admin</a></div>';
    h += '</article>';
    el.innerHTML = h;
    hydrateHtmlWidgets(el);
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
      h += '<h3 class="card-title">' + esc(e.title) + '</h3>';
      if (e.description) h += '<p class="card-desc">' + esc(e.description) + '</p>';
      h += '</a>';
    });
    h += '</div>';
    if (exps.length > COLUMN_LIMIT) {
      h += '<details class="show-more-wrap"><summary class="show-more-toggle">Show ' + (exps.length - COLUMN_LIMIT) + ' more</summary>';
      h += '<div class="content-grid content-grid--sm show-more-items">';
      exps.slice(COLUMN_LIMIT).forEach(function (e) {
        h += '<a class="content-card content-card--exp" href="' + contentUrl('experiment', e.slug) + '">';
        h += '<h3 class="card-title">' + esc(e.title) + '</h3>';
        if (e.description) h += '<p class="card-desc">' + esc(e.description) + '</p>';
        h += '</a>';
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
    if (!content || !content.meta || content.meta.status === 'archived') { render404(el); return; }

    var title = content.meta.title;
    setTitle(title);
    setBreadcrumbs([{ label: 'Experiments', href: BASE + '/exp/' }, { label: title, href: BASE + '/exp/' + slug + '/' }]);

    var rev = content.current_revision;
    var isHtmlCanvas = rev && rev.content && (rev.format === 'html' || (!rev.format && /^<!doctype\s|^<[a-z][\s\S]*>/i.test((rev.content || '').trim())));
    var kindIcons = { note: '\uD83D\uDCDD', dataset: '\uD83D\uDCC1', result: '\u2705', chart: '\uD83D\uDCC8', link: '\uD83D\uDD17', decision: '\u2696\uFE0F', html: '\uD83C\uDF10' };
    var entries = (content.entries || []).filter(function (e) { return !e.deleted; });

    var h = '';

    if (isHtmlCanvas) {
      // ── HTML canvas mode: render inside an iframe to isolate styles ──
      h += '<div class="exp-canvas" data-eo-op="SIG" data-eo-target="' + esc(content.content_id) + '">';
      h += '<div class="exp-canvas-header">';
      h += '<a class="exp-canvas-back" href="' + BASE + '/exp/">&larr; Experiments</a>';
      h += '<span class="exp-canvas-title">' + esc(title) + '</span>';
      h += '<div class="content-actions eo-admin-only" hidden>';
      h += '<a class="btn btn-edit btn-sm" href="' + BASE + '/admin/#exp/' + esc(slug) + '">Edit</a></div>';
      h += '</div>';
      h += '<div class="exp-canvas-body"></div>';
      h += '</div>';
      el.innerHTML = h;

      // Render content in a sandboxed iframe so embedded body/html styles
      // cannot affect the parent page (e.g. overflow:hidden, height:100vh).
      var canvasBody = el.querySelector('.exp-canvas-body');
      if (canvasBody) {
        var iframe = document.createElement('iframe');
        iframe.style.cssText = 'width:100%;border:none;display:block;min-height:60px;';
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        iframe.srcdoc = rev.content;
        canvasBody.appendChild(iframe);
        iframe.addEventListener('load', function () {
          autoSizeIframe(iframe);
        });
      }
    } else {
      // ── Standard mode: article chrome with entries ──
      h += '<article class="experiment-article" data-eo-op="SIG" data-eo-target="' + esc(content.content_id) + '">';
      h += '<header class="content-header"><h1>' + esc(title) + '</h1>';
      h += '<div class="post-meta">';
      if (content.meta.updated_at) h += '<time>' + timeAgo(content.meta.updated_at) + '</time>';
      h += '</div>';
      h += '<div class="content-tags">';
      (content.meta.tags || []).forEach(function (t) { h += '<span class="tag">' + esc(t) + '</span>'; });
      h += '</div></header>';

      // Revision-based body (markdown or plain text)
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
          h += '<time class="entry-ts">' + timeAgo(entry.ts) + '</time>';
          h += '</li>';
        });
        h += '</ul>';
      } else if (!rev || !rev.content) {
        h += '<p class="empty-page">No content yet.</p>';
      }

      h += relatedPagesHtml(content.meta);

      if (rev) h += revisionHistoryHtml(content);

      h += '<div class="content-actions eo-admin-only" hidden>';
      h += '<a class="btn btn-edit" href="' + BASE + '/admin/#exp/' + esc(slug) + '">Edit in Admin</a></div>';
      h += '</article>';
      el.innerHTML = h;
    }

    // Hydrate HTML widgets so their content renders instead of showing source
    hydrateHtmlWidgets(el);
    // Activate embedded scripts so HTML/JS experiments actually run
    activateScripts(el);
    revealAdmin();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Document List
// ═══════════════════════════════════════════════════════════════════════════

export function renderDocList(el) {
  var idx = getSiteIndex();
  setTitle('Documents & Assets');
  setBreadcrumbs([{ label: 'Documents', href: BASE + '/doc/' }]);
  el.className = '';

  var docs = sortByUpdated((idx.entries || []).filter(function (e) {
    return e.content_type === 'document' && e.visibility === 'public' && e.status !== 'archived';
  }));

  var h = '<section class="home-section"><h1>Documents &amp; Assets</h1>';
  if (docs.length > 0) {
    h += '<div class="content-list-cards">';
    docs.forEach(function (d) {
      h += '<a class="content-card content-card--doc" href="' + contentUrl('document', d.slug) + '">';
      h += '<span class="card-icon">\uD83D\uDCC4</span>';
      h += '<h3 class="card-title">' + esc(d.title) + '</h3>';
      if (d.tags && d.tags.length) {
        h += '<div class="card-tags">';
        d.tags.forEach(function (t) { h += '<span class="tag">' + esc(t) + '</span>'; });
        h += '</div>';
      }
      h += '</a>';
    });
    h += '</div>';
  } else {
    h += '<p class="empty-page">No documents yet.</p>';
  }
  h += '</section>';
  el.innerHTML = h;
  return Promise.resolve();
}

// ═══════════════════════════════════════════════════════════════════════════
// Document Detail
// ═══════════════════════════════════════════════════════════════════════════

var FILE_TYPE_ICONS = {
  pdf: '\uD83D\uDCC4', spreadsheet: '\uD83D\uDCCA', image: '\uD83D\uDDBC\uFE0F',
  video: '\uD83C\uDFA5', archive: '\uD83D\uDCE6', code: '\uD83D\uDCBB', other: '\uD83D\uDCCE'
};

export function renderDoc(el, slug) {
  var idx = getSiteIndex();
  el.className = '';
  var entry = (idx.entries || []).find(function (e) { return e.content_type === 'document' && e.slug === slug; });
  var contentId = entry ? entry.content_id : 'document:' + slug;

  return loadContent(contentId).then(function (content) {
    if (!content || !content.meta || content.meta.status === 'archived') { render404(el); return; }

    var title = content.meta.title;
    setTitle(title);
    setBreadcrumbs([{ label: 'Documents', href: BASE + '/doc/' }, { label: title, href: BASE + '/doc/' + slug + '/' }]);

    var assets = (content.assets || []).filter(function (a) { return !a.deleted; });
    var rev = content.current_revision;

    var h = '<article class="document-article" data-eo-op="SIG" data-eo-target="' + esc(content.content_id) + '">';
    h += '<header class="content-header"><h1>' + esc(title) + '</h1>';
    h += '<div class="post-meta">';
    if (content.meta.updated_at) h += '<time>' + timeAgo(content.meta.updated_at) + '</time>';
    h += '</div>';
    h += '<div class="content-tags">';
    (content.meta.tags || []).forEach(function (t) { h += '<span class="tag">' + esc(t) + '</span>'; });
    h += '</div></header>';

    // Assets / attachments list
    if (assets.length > 0) {
      h += '<section class="doc-assets"><h2>Attachments &amp; Links</h2>';
      h += '<div class="doc-assets-grid">';
      assets.forEach(function (asset) {
        var icon = FILE_TYPE_ICONS[asset.file_type] || FILE_TYPE_ICONS.other;
        h += '<a class="doc-asset-link" href="' + esc(asset.url) + '" target="_blank" rel="noopener noreferrer">';
        h += '<span class="doc-asset-icon">' + icon + '</span>';
        h += '<span class="doc-asset-name">' + esc(asset.title) + '</span>';
        h += '<span class="doc-asset-type">' + esc(asset.file_type) + '</span>';
        if (asset.description) h += '<span class="doc-asset-desc">' + esc(asset.description) + '</span>';
        h += '</a>';
      });
      h += '</div></section>';
    }

    // Document body
    if (rev && rev.content) {
      h += '<div class="wiki-body doc-body">';
      h += renderRevisionContent(rev);
      h += '</div>';
    } else if (assets.length === 0) {
      h += '<p class="empty-page">No content yet.</p>';
    }

    h += relatedPagesHtml(content.meta);

    if (rev) h += revisionHistoryHtml(content);

    h += '<div class="content-actions eo-admin-only" hidden>';
    h += '<a class="btn btn-edit" href="' + BASE + '/admin/#doc/' + esc(slug) + '">Edit in Admin</a></div>';
    h += '</article>';
    el.innerHTML = h;

    hydrateHtmlWidgets(el);
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
    if (!content || !content.meta || content.meta.status === 'archived') { render404(el); return; }

    var title = content.meta.title;
    setTitle(title);
    setBreadcrumbs([{ label: title, href: BASE + '/page/' + slug + '/' }]);

    var h = '<article data-eo-op="SIG" data-eo-target="' + esc(content.content_id) + '">';
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

    h += relatedPagesHtml(content.meta);

    h += '<div class="content-actions eo-admin-only" hidden>';
    h += '<a class="btn btn-edit" href="' + BASE + '/admin/#page/' + esc(slug) + '">Edit in Admin</a></div>';
    h += '</article>';
    el.innerHTML = h;
    hydrateHtmlWidgets(el);
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
  var docsAll = entries.filter(function (e) { return e.content_type === 'document'; });
  var pages = entries.filter(function (e) { return e.content_type === 'page'; });

  var allEntries = wikis.concat(blogs).concat(docsAll).concat(pages);
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
      { label: 'Documents', items: results.filter(function (r) { return r.entry.content_type === 'document'; }) },
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
          } else if (r.entry.content_type === 'document') {
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
    hydrateHtmlWidgets(el);
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

  fillDropdown('nav-wiki-dd', 'nav-wiki-count', sortByUpdated(nav.filter(function (e) { return e.content_type === 'wiki'; })), 'wiki', 8);
  fillDropdown('nav-blog-dd', 'nav-blog-count', sortByUpdated(nav.filter(function (e) { return e.content_type === 'blog'; })), 'blog', 6);
  fillDropdown('nav-exp-dd', 'nav-exp-count', sortByUpdated(nav.filter(function (e) { return e.content_type === 'experiment'; })), 'experiment', 6);
  fillDropdown('nav-doc-dd', 'nav-doc-count', sortByUpdated(nav.filter(function (e) { return e.content_type === 'document'; })), 'document', 6);

  var siteName = (idx.site_settings && idx.site_settings.siteName) || 'Emergent Ontology';
  var hEl = document.getElementById('site-name-header');
  var fEl = document.getElementById('site-name-footer');
  if (hEl) hEl.textContent = siteName;
  if (fEl) fEl.textContent = siteName;
}
