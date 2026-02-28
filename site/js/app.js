/**
 * app.js — Emergent Ontology site engine (entry point).
 *
 * Architecture:
 *   config.js   — constants, operators
 *   api.js      — data loading (static JSON + API fallback)
 *   router.js   — URL routing
 *   render.js   — block rendering, markdown, utilities
 *   pages.js    — page-specific renderers
 *   ui.js       — UI interactions (theme, search, admin, SPA nav)
 */

import { loadIndex, getSiteIndex } from './api.js';
import { getRoute } from './router.js';
import { revealAdmin } from './render.js';
import {
  renderHome, renderWikiList, renderWiki,
  renderBlogList, renderBlog,
  renderExpList, renderExp,
  renderPage, renderAll, render404, updateNav
} from './pages.js';
import { setupUI } from './ui.js';

// ── Main render ──────────────────────────────────────────────────────────────

function render() {
  var route = getRoute();
  if (route.page === 'admin') return;
  var main = document.getElementById('content');
  if (!main) return;

  // Show loading state
  main.innerHTML = '<div style="text-align:center;padding:3rem;color:var(--text-dim)">Loading\u2026</div>';

  loadIndex()
    .then(function (idx) {
      // Expose index for title helper
      window.__eoSiteIndex = idx;
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
    })
    .then(function () {
      revealAdmin();
    })
    .catch(function (err) {
      console.error('[eo] Render failed:', err);
      main.innerHTML = '<div style="text-align:center;padding:3rem;color:var(--text-dim)">' +
        '<h2>Failed to load</h2>' +
        '<p>Could not fetch content. Check the console for details.</p>' +
        '<p><a href="javascript:location.reload()">Retry</a></p></div>';
    });
}

// ── Init ─────────────────────────────────────────────────────────────────────

setupUI(render);
render();
