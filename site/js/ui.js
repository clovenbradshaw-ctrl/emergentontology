/**
 * ui.js — UI setup: theme toggle, search, admin drawer, SPA navigation, logo cycling.
 */

import { BASE, OPERATORS } from './config.js';
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

// ── SPA link interception ────────────────────────────────────────────────────

function setupSpaNavigation(renderFn) {
  document.addEventListener('click', function (e) {
    var link = e.target.closest('a[href]');
    if (!link) return;
    var href = link.getAttribute('href');
    if (!href) return;
    if (href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('#')) return;
    if (link.classList.contains('btn-edit')) return; // handled by drawer

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
