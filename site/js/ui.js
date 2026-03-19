/**
 * ui.js — UI setup: theme toggle, search, admin drawer, SPA navigation, logo cycling.
 */

import { BASE, OPERATORS } from './config.js';
import { contentUrl } from './router.js';
import { revealAdmin } from './render.js';

/**
 * Initialize all UI interactions. Call once on page load.
 *
 * @param {function} renderFn — the main render function to call on SPA navigation
 */
export function setupUI(renderFn) {
  setupThemeToggle();
  setupSearch();
  setupAdminDrawer();
  setupAdminEscReveal();
  setupLogoCycling();
  setupButtonActions();
  setupArticleLinkModal(renderFn);
  setupSpaNavigation(renderFn);
  revealAdmin();
}

// ── Theme toggle ─────────────────────────────────────────────────────────────

function setupThemeToggle() {
  var themeBtn = document.getElementById('theme-toggle');
  if (!themeBtn) return;
  themeBtn.addEventListener('click', function () {
    var current = document.documentElement.getAttribute('data-theme') || 'dark';
    var next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('eo-theme', next);
  });
}

// ── Search overlay ───────────────────────────────────────────────────────────

function setupSearch() {
  var searchToggle = document.getElementById('search-toggle');
  var overlay = document.getElementById('search-overlay');
  var closeBtn = document.getElementById('search-close');
  var searchInput = document.getElementById('search-input');
  if (!searchToggle || !overlay) return;

  searchToggle.addEventListener('click', function () {
    overlay.hidden = false;
    if (searchInput) searchInput.focus();
  });
  if (closeBtn) closeBtn.addEventListener('click', function () { overlay.hidden = true; });
  overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.hidden = true; });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !overlay.hidden) overlay.hidden = true;
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      overlay.hidden = false;
      if (searchInput) searchInput.focus();
    }
  });
}

// ── Admin drawer ─────────────────────────────────────────────────────────────

function setupAdminDrawer() {
  var drawerOverlay = document.getElementById('admin-drawer-overlay');
  var drawer = document.getElementById('admin-drawer');
  var iframe = document.getElementById('admin-drawer-iframe');
  var drawerClose = document.getElementById('admin-drawer-close');
  if (!drawerOverlay || !drawer || !iframe || !drawerClose) return;

  function openDrawer(href) {
    iframe.src = href;
    drawer.classList.add('open');
    drawerOverlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeDrawer() {
    drawer.classList.remove('open');
    drawerOverlay.classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(function () { iframe.src = ''; }, 300);
  }

  drawerClose.addEventListener('click', closeDrawer);
  drawerOverlay.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && drawer.classList.contains('open')) {
      e.stopImmediatePropagation();
      closeDrawer();
    }
  });
  document.addEventListener('click', function (e) {
    var link = e.target.closest('.btn-edit');
    if (link && link.href) { e.preventDefault(); openDrawer(link.href); }
  });
}

// ── Admin reveal via triple-ESC ──────────────────────────────────────────────

function setupAdminEscReveal() {
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
}

// ── Logo mark cycling ────────────────────────────────────────────────────────

function setupLogoCycling() {
  var mark = document.getElementById('logo-mark');
  if (!mark) return;
  var idx = parseInt(localStorage.getItem('eo-logo-idx') || '1', 10) % OPERATORS.length;
  mark.textContent = OPERATORS[idx].symbol;
  mark.style.color = OPERATORS[idx].color;
  mark.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    idx = (idx + 1) % OPERATORS.length;
    mark.textContent = OPERATORS[idx].symbol;
    mark.style.color = OPERATORS[idx].color;
    localStorage.setItem('eo-logo-idx', String(idx));
  });
}

// ── Button block actions (copy to clipboard) ─────────────────────────────────

function setupButtonActions() {
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action="copy"]');
    if (!btn) return;
    e.preventDefault();
    var copyText = btn.getAttribute('data-copy-text');
    if (!copyText) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(copyText).then(function () {
        showCopyFeedback(btn);
      }).catch(function () {
        fallbackCopy(copyText, btn);
      });
    } else {
      fallbackCopy(copyText, btn);
    }
  });
}

function fallbackCopy(text, btn) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showCopyFeedback(btn);
  } catch (e) { /* silent fail */ }
  document.body.removeChild(ta);
}

function showCopyFeedback(btn) {
  var original = btn.textContent;
  btn.textContent = 'Copied!';
  btn.classList.add('btn-copied');
  setTimeout(function () {
    btn.textContent = original;
    btn.classList.remove('btn-copied');
  }, 1500);
}

// ── Article link modal ──────────────────────────────────────────────────────

var LINK_STOP = {};
'the a an and or of to in is it for on by at as be do if no so up we he my not but are was has had its can all may you how why what when from with this that will been have they their them into than then each also more some about which would other could'.split(' ').forEach(function (w) { LINK_STOP[w] = true; });

// Map URL path prefixes to content_type values
var PREFIX_TO_TYPE = { wiki: 'wiki', blog: 'blog', exp: 'experiment', doc: 'document', page: 'page' };
var INTERNAL_LINK_RE = /^\/(wiki|blog|exp|doc|page)\/([^\/]+)\/?$/;

function parseInternalHref(href) {
  if (!href) return null;
  try {
    var path = href;
    // Handle full URLs on same origin
    if (href.indexOf('http') === 0) {
      var u = new URL(href);
      if (u.origin !== location.origin) return null;
      path = u.pathname;
    }
    if (BASE && path.indexOf(BASE) === 0) path = path.slice(BASE.length);
    var m = path.match(INTERNAL_LINK_RE);
    if (!m) return null;
    return { type: PREFIX_TO_TYPE[m[1]] || m[1], slug: m[2] };
  } catch (e) { return null; }
}

function findCandidates(slug, type, maxResults) {
  maxResults = maxResults || 8;
  var idx = window.__eoSiteIndex;
  if (!idx || !idx.entries) return [];

  // Extract keywords from the clicked slug
  var keywords = {};
  slug.split('-').forEach(function (w) {
    if (w.length >= 3 && !LINK_STOP[w]) keywords[w] = true;
  });

  // Resolve the content type (support all types, not just wiki/experiment)
  var contentType = type || 'wiki';
  var exact = null;
  var candidates = [];

  (idx.entries || []).forEach(function (e) {
    if (e.visibility !== 'public' || e.status === 'archived') return;

    // Check if this is the exact target
    if (e.slug === slug && e.content_type === contentType) {
      exact = e;
      return;
    }

    // Score by keyword overlap
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
  var results = candidates.slice(0, maxResults);

  // Prepend the exact match if found
  if (exact) {
    results.unshift({ entry: exact, score: 999, exact: true });
  }

  return results;
}

function setupArticleLinkModal(renderFn) {
  var overlay = document.getElementById('article-link-modal-overlay');
  var list = document.getElementById('article-link-modal-list');
  var title = document.getElementById('article-link-modal-title');
  var closeBtn = document.getElementById('article-link-modal-close');
  if (!overlay || !list || !closeBtn) return;

  function closeModal() {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  function openModal(slug, type) {
    var candidates = findCandidates(slug, type);
    var displaySlug = slug.replace(/-/g, ' ');
    title.textContent = 'Related: ' + displaySlug;

    if (candidates.length === 0) {
      list.innerHTML = '<li class="article-link-modal-empty">No matching articles found.</li>';
    } else {
      var h = '';
      candidates.forEach(function (c) {
        var e = c.entry;
        var url = contentUrl(e.content_type, e.slug);
        var label = c.exact ? 'Exact match' : 'Related';
        var desc = e.description ? '<span class="alm-desc">' + escHtml(truncate(e.description, 120)) + '</span>' : '';
        var tagHtml = '';
        if (e.tags && e.tags.length > 0) {
          tagHtml = '<span class="alm-tags">' + e.tags.slice(0, 4).map(function (t) { return '<span class="alm-tag">' + escHtml(t) + '</span>'; }).join('') + '</span>';
        }
        h += '<li><a href="' + url + '" data-spa-nav="true">' +
          '<span class="alm-title">' +
          '<span class="alm-type">' + (e.content_type || '').toUpperCase() + '</span>' +
          escHtml(e.title || e.slug) +
          '</span>' +
          desc +
          tagHtml +
          '<span class="alm-match">' + label + '</span>' +
          '</a></li>';
      });
      list.innerHTML = h;
    }

    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  // Close handlers
  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay.classList.contains('open')) {
      e.stopImmediatePropagation();
      closeModal();
    }
  });

  // Intercept clicks on article embed links
  document.addEventListener('click', function (e) {
    var link = e.target.closest('[data-article-link]');
    if (!link) return;

    e.preventDefault();
    e.stopPropagation();

    var slug = link.getAttribute('data-article-slug');
    var type = link.getAttribute('data-article-link');
    if (!slug) return;

    openModal(slug, type);
  });

  // Intercept clicks on inline internal links (e.g. links in rich text content)
  document.addEventListener('click', function (e) {
    var link = e.target.closest('a[href]');
    if (!link) return;
    // Skip links already handled by other systems
    if (link.hasAttribute('data-article-link')) return;
    if (link.hasAttribute('data-spa-nav')) return;
    if (link.classList.contains('btn-edit')) return;

    var href = link.getAttribute('href');
    if (!href) return;

    var parsed = parseInternalHref(href);
    if (!parsed) return;

    e.preventDefault();
    e.stopPropagation();
    openModal(parsed.slug, parsed.type);
  });

  // Handle clicks on items inside the modal — SPA navigate and close
  list.addEventListener('click', function (e) {
    var link = e.target.closest('a[data-spa-nav]');
    if (!link) return;

    e.preventDefault();
    closeModal();

    var href = link.getAttribute('href');
    var resolved = new URL(href, document.baseURI);
    history.pushState(null, '', resolved.pathname);
    renderFn();
    window.scrollTo(0, 0);
  });
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(s, max) {
  if (!s || s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, '') + '\u2026';
}

// ── SPA link interception ────────────────────────────────────────────────────

function setupSpaNavigation(renderFn) {
  document.addEventListener('click', function (e) {
    var link = e.target.closest('a[href]');
    if (!link) return;
    var href = link.getAttribute('href');
    if (!href) return;
    if (href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('#')) return;
    if (link.classList.contains('btn-edit')) return; // handled by drawer
    if (link.hasAttribute('data-article-link')) return; // handled by article link modal
    if (link.hasAttribute('data-spa-nav')) return; // handled by modal list nav

    // Internal article links are handled by the modal (intercepted above)
    if (parseInternalHref(href)) return;

    var resolved = new URL(href, document.baseURI);
    if (resolved.origin !== location.origin) return;
    if (resolved.pathname.indexOf(BASE + '/admin') === 0) return;

    e.preventDefault();
    history.pushState(null, '', resolved.pathname);
    renderFn();
    window.scrollTo(0, 0);
  });

  window.addEventListener('popstate', renderFn);
}
