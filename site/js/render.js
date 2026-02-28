/**
 * render.js — Rendering utilities: HTML escaping, markdown, block rendering.
 */

import { BASE, OPERATORS } from './config.js';
import { contentUrl } from './router.js';
import { timeAgo } from './time.js';

// ── HTML escape ──────────────────────────────────────────────────────────────

export function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Markdown → HTML ──────────────────────────────────────────────────────────

export function md(text) {
  if (!text) return '';
  if (window.marked) {
    try { return window.marked.parse(text); } catch (e) { /* fall through */ }
  }
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

// ── Breadcrumbs & Title ──────────────────────────────────────────────────────

export function setBreadcrumbs(crumbs) {
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

export function setTitle(t) {
  var siteName = 'Emergent Ontology';
  try {
    var idx = window.__eoSiteIndex;
    if (idx && idx.site_settings && idx.site_settings.siteName) siteName = idx.site_settings.siteName;
  } catch (e) { /* ignore */ }
  document.title = t + ' \u2014 ' + siteName;
}

// ── Block renderer ───────────────────────────────────────────────────────────

export function renderBlock(block, page) {
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
      return '<blockquote class="block block-quote"><p>' + esc(String(d.text || '')) + '</p>' +
        (d.attribution ? '<cite>\u2014 ' + esc(String(d.attribution)) + '</cite>' : '') + '</blockquote>';

    case 'divider':
      return '<hr class="block block-divider">';

    case 'spacer':
      return '<div class="block block-spacer" style="height:' + esc(String(d.height || '2rem')) + '"></div>';

    case 'image':
      return '<figure class="block block-image"><img src="' + esc(String(d.src || '')) + '" alt="' + esc(String(d.alt || '')) + '" loading="lazy">' +
        (d.caption ? '<figcaption>' + esc(String(d.caption)) + '</figcaption>' : '') + '</figure>';

    case 'code':
      return '<div class="block block-code"><pre><code' +
        (d.lang ? ' class="language-' + esc(String(d.lang)) + '"' : '') + '>' +
        esc(String(d.code || '')) + '</code></pre></div>';

    case 'button':
      return '<div class="block block-button"><a class="btn btn-' + esc(String(d.style || 'primary')) + '" href="' + esc(String(d.url || '#')) + '">' + esc(String(d.text || 'Click here')) + '</a></div>';

    case 'embed': {
      var src = String(d.src || '');
      if (!src) return '';
      var title = String(d.title || '');
      return '<figure class="block block-embed"><iframe src="' + esc(src) + '" title="' + esc(title) + '" loading="lazy" allowfullscreen frameborder="0"></iframe>' +
        (title ? '<figcaption>' + esc(title) + '</figcaption>' : '') + '</figure>';
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
      return '<figure class="block block-video"><iframe src="' + esc(embedSrc) + '" title="' + esc(cap || 'Video') + '" loading="lazy" allowfullscreen frameborder="0"></iframe>' +
        (cap ? '<figcaption>' + esc(cap) + '</figcaption>' : '') + '</figure>';
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
    case 'operator-grid':
      return ''; // Rendered specially on home page

    default:
      return '<div class="block block-' + block.block_type + '">[' + block.block_type + ']</div>';
  }
}

// ── Revision history ─────────────────────────────────────────────────────────

export function revisionHistoryHtml(content) {
  var revs = content.revisions || [];
  var h = '<section class="revision-history" id="history"><h2>Revision History</h2>';
  if (revs.length > 0) {
    h += '<ol class="rev-list" reversed>';
    revs.slice().reverse().slice(0, 6).forEach(function (r) {
      var isFirst = r.rev_id === revs[0].rev_id;
      var opName = isFirst ? 'INS' : 'ALT';
      h += '<li class="rev-entry rev-entry--' + opName.toLowerCase() + '">';
      h += '<code class="eo-op eo-op-inline"><span class="eo-name">' + opName + '</span>(<span class="eo-target">' + esc(content.content_id) + '/rev:' + esc(r.rev_id) + '</span>, <span class="eo-operand">{summary: "' + esc(r.summary || '\u2026') + '"}</span>)</code>';
      h += ' <time class="rev-ts" title="' + new Date(r.ts).toLocaleString() + '">' + timeAgo(r.ts) + '</time>';
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
        h += ' <time class="rev-ts" title="' + new Date(r.ts).toLocaleString() + '">' + timeAgo(r.ts) + '</time></li>';
      });
      h += '</ol></details>';
    }
  } else {
    h += '<ol class="rev-list"><li>No revisions yet.</li></ol>';
  }
  h += '</section>';
  return h;
}

// ── Render content body (HTML or markdown) ───────────────────────────────────

/**
 * Render revision content, auto-detecting HTML vs markdown format.
 */
export function renderRevisionContent(revision) {
  if (!revision || !revision.content) return '<p class="empty-page">No content yet.</p>';
  var fmt = revision.format || 'markdown';
  if (fmt === 'html') return revision.content;
  return md(revision.content);
}

// ── Script activation (for live HTML/JS experiments) ─────────────────────────

/**
 * Activate <script> tags inside a container.
 *
 * When HTML is inserted via innerHTML, browsers ignore embedded <script> tags.
 * This function replaces each script with a fresh element so the browser
 * evaluates it.  Handles both inline scripts and external src scripts.
 */
export function activateScripts(container) {
  var scripts = container.querySelectorAll('script');
  for (var i = 0; i < scripts.length; i++) {
    var old = scripts[i];
    var fresh = document.createElement('script');
    for (var j = 0; j < old.attributes.length; j++) {
      fresh.setAttribute(old.attributes[j].name, old.attributes[j].value);
    }
    fresh.textContent = old.textContent;
    old.parentNode.replaceChild(fresh, old);
  }
}

// ── Admin reveal ─────────────────────────────────────────────────────────────

export function revealAdmin() {
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
