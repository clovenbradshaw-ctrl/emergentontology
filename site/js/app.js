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
  renderHome, renderWikiList, renderWikiAll, renderWiki,
  renderBlogList, renderBlog,
  renderExpList, renderExp,
  renderDocList, renderDoc,
  renderPage, renderAll, render404, updateNav,
  renderCommunity, renderSuggestion, renderSuggest
} from './pages.js';
import { setupUI } from './ui.js';
import { setupSuggestUI } from './suggest.js';

// ── Search highlight: scroll to and highlight matching text after navigation ──

function highlightSearchTerms(container) {
  var params = new URLSearchParams(location.search);
  var q = params.get('q');
  if (!q) return;

  // Clean the query param from the URL without triggering navigation
  var cleanUrl = location.pathname + location.hash;
  history.replaceState(null, '', cleanUrl);

  var terms = q.toLowerCase().trim().split(/\s+/).filter(function (t) { return t.length > 0; });
  if (!terms.length) return;

  // Find the main article body to search within
  var body = container.querySelector('.wiki-body, .article-main, .wiki-content, .content-body');
  if (!body) body = container;

  // Walk text nodes and wrap matching terms with <mark>
  var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null, false);
  var matches = [];
  var node;
  while ((node = walker.nextNode())) {
    var text = node.nodeValue;
    if (!text || !text.trim()) continue;
    var lower = text.toLowerCase();
    for (var i = 0; i < terms.length; i++) {
      if (lower.indexOf(terms[i]) >= 0) {
        matches.push(node);
        break;
      }
    }
  }

  if (!matches.length) return;

  // Build a regex to wrap all term occurrences
  var escaped = terms.map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
  var re = new RegExp('(' + escaped.join('|') + ')', 'gi');

  var firstMark = null;
  matches.forEach(function (textNode) {
    var parent = textNode.parentNode;
    if (!parent || parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') return;
    var frag = document.createDocumentFragment();
    var parts = textNode.nodeValue.split(re);
    parts.forEach(function (part, idx) {
      // Odd indices from split(regex-with-capture) are the matched groups
      if (idx % 2 === 1) {
        var mark = document.createElement('mark');
        mark.className = 'search-highlight';
        mark.textContent = part;
        if (!firstMark) firstMark = mark;
        frag.appendChild(mark);
      } else {
        frag.appendChild(document.createTextNode(part));
      }
    });
    parent.replaceChild(frag, textNode);
  });

  // Scroll to the first match
  if (firstMark) {
    setTimeout(function () {
      firstMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);

    // Auto-remove highlights after 6 seconds
    setTimeout(function () {
      var marks = body.querySelectorAll('mark.search-highlight');
      marks.forEach(function (m) {
        m.classList.add('search-highlight--fade');
      });
      // Remove the mark elements after fade
      setTimeout(function () {
        marks.forEach(function (m) {
          var p = m.parentNode;
          if (p) {
            p.replaceChild(document.createTextNode(m.textContent), m);
            p.normalize();
          }
        });
      }, 1000);
    }, 6000);
  }
}

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
        case 'wiki-all':  return renderWikiAll(main);
        case 'wiki':      return renderWiki(main, route.slug);
        case 'blog-list': return renderBlogList(main);
        case 'blog':      return renderBlog(main, route.slug);
        case 'exp-list':  return renderExpList(main);
        case 'exp':       return renderExp(main, route.slug);
        case 'doc-list':  return renderDocList(main);
        case 'doc':       return renderDoc(main, route.slug);
        case 'page':      return renderPage(main, route.slug);
        case 'all':        return renderAll(main);
        case 'community':  return renderCommunity(main);
        case 'suggestion': return renderSuggestion(main, route.slug);
        case 'suggest':    return renderSuggest(main, route.slug);
        default:           render404(main); return Promise.resolve();
      }
    })
    .then(function () {
      revealAdmin();
      highlightSearchTerms(main);
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
setupSuggestUI();
render();
