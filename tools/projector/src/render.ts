/**
 * render.ts
 *
 * Turns projected state objects into static HTML files and JSON state files.
 *
 * Output layout:
 *   {out_dir}/state/index.json              ← site index
 *   {out_dir}/state/content/<content_id>.json
 *   {out_dir}/search_index.json             ← Fuse.js-compatible search index
 *   {out_dir}/blog/<slug>/index.html
 *   {out_dir}/wiki/<slug>/index.html
 *   {out_dir}/exp/<id>/index.html
 *   {out_dir}/page/<slug>/index.html
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type {
  ProjectedContent,
  ProjectedPage,
  ProjectedWiki,
  ProjectedBlog,
  ProjectedExperiment,
  SiteIndex,
  Block,
  BuildConfig,
} from './types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function write(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMarkdown(md: string): string {
  // Minimal markdown: headings, bold, italic, code, paragraphs, links
  return md
    .replace(/^#{4}\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^#{3}\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^#{2}\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^#{1}\s+(.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(.+)$/gm, (line) =>
      line.startsWith('<') ? line : line
    )
    .replace(/^(?!<)(.+)/, '<p>$1')
    .trimEnd() + '</p>';
}

function baseLayout(cfg: BuildConfig, opts: {
  title: string;
  description?: string;
  slug: string;
  content: string;
  nav: SiteIndex['nav'];
  breadcrumbs?: Array<{ label: string; href: string }>;
  head?: string;
}): string {
  const { title, description, content, nav, breadcrumbs, head } = opts;
  const navItems = nav
    .map((e) => `<li><a href="${cfg.site_base_url}/${e.content_type === 'page' ? 'page' : e.content_type}/${e.slug}/">${escapeHtml(e.title)}</a></li>`)
    .join('\n          ');

  const breadcrumbHtml = breadcrumbs
    ? `<nav class="breadcrumbs" aria-label="Breadcrumb">
        <ol>${breadcrumbs
          .map((b, i) =>
            i === breadcrumbs.length - 1
              ? `<li aria-current="page">${escapeHtml(b.label)}</li>`
              : `<li><a href="${b.href}">${escapeHtml(b.label)}</a></li>`
          )
          .join('')}
        </ol>
      </nav>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)} — Emergent Ontology</title>
  ${description ? `<meta name="description" content="${escapeHtml(description)}" />` : ''}
  <link rel="stylesheet" href="${cfg.site_base_url}/styles/main.css" />
  <link rel="alternate" type="application/json" href="${cfg.site_base_url}/state/index.json" />
  ${head ?? ''}
</head>
<body>
  <header class="site-header">
    <a class="site-logo" href="${cfg.site_base_url}/">Emergent Ontology</a>
    <nav class="site-nav" aria-label="Main navigation">
      <ul>
        ${navItems}
      </ul>
    </nav>
    <a class="admin-link" href="${cfg.site_base_url}/admin/">Admin</a>
  </header>
  <main>
    ${breadcrumbHtml}
    ${content}
  </main>
  <footer class="site-footer">
    <p>Content stored as append-only events in Matrix. <a href="${cfg.site_base_url}/state/index.json">Site index JSON</a></p>
  </footer>
  <script src="${cfg.site_base_url}/js/search.js" defer></script>
</body>
</html>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Block renderers
// ──────────────────────────────────────────────────────────────────────────────

function renderBlock(block: Block, cfg: BuildConfig): string {
  if (block.deleted) return '';
  const { block_type, data } = block;

  switch (block_type) {
    case 'text':
      return `<section class="block block-text">${renderMarkdown(String(data.md ?? data.text ?? ''))}</section>`;
    case 'image':
      return `<figure class="block block-image">
        <img src="${escapeHtml(String(data.src ?? ''))}" alt="${escapeHtml(String(data.alt ?? ''))}" loading="lazy" />
        ${data.caption ? `<figcaption>${escapeHtml(String(data.caption))}</figcaption>` : ''}
      </figure>`;
    case 'callout':
      return `<aside class="block block-callout callout-${escapeHtml(String(data.kind ?? 'info'))}">
        ${data.icon ? `<span class="callout-icon">${escapeHtml(String(data.icon))}</span>` : ''}
        <div>${renderMarkdown(String(data.text ?? ''))}</div>
      </aside>`;
    case 'quote':
      return `<blockquote class="block block-quote">
        <p>${escapeHtml(String(data.text ?? ''))}</p>
        ${data.attribution ? `<cite>— ${escapeHtml(String(data.attribution))}</cite>` : ''}
      </blockquote>`;
    case 'divider':
      return `<hr class="block block-divider" />`;
    case 'embed':
      return `<div class="block block-embed">
        <iframe src="${escapeHtml(String(data.src ?? ''))}" title="${escapeHtml(String(data.title ?? 'Embedded content'))}" loading="lazy" allowfullscreen></iframe>
      </div>`;
    case 'wiki-embed':
      return `<div class="block block-wiki-embed" data-wiki-id="${escapeHtml(String(data.wiki_id ?? ''))}">
        <a href="${cfg.site_base_url}/wiki/${escapeHtml(String(data.slug ?? data.wiki_id ?? ''))}/"><em>[Wiki: ${escapeHtml(String(data.title ?? data.wiki_id ?? ''))}]</em></a>
      </div>`;
    case 'experiment-embed':
      return `<div class="block block-exp-embed" data-exp-id="${escapeHtml(String(data.exp_id ?? ''))}">
        <a href="${cfg.site_base_url}/exp/${escapeHtml(String(data.exp_id ?? ''))}/"><em>[Experiment: ${escapeHtml(String(data.title ?? data.exp_id ?? ''))}]</em></a>
      </div>`;
    case 'toc':
      return `<nav class="block block-toc" aria-label="Table of contents"><div class="toc-placeholder">[Table of Contents — generated client-side]</div></nav>`;
    default:
      return `<div class="block block-unknown">[Unknown block type: ${escapeHtml(block_type)}]</div>`;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Page renderer
// ──────────────────────────────────────────────────────────────────────────────

function renderPageContent(proj: ProjectedPage, cfg: BuildConfig): string {
  const blockMap = new Map(proj.blocks.map((b) => [b.block_id, b]));
  const blockHtml = proj.block_order
    .map((id) => {
      const block = blockMap.get(id);
      return block ? renderBlock(block, cfg) : '';
    })
    .join('\n');

  return `<article class="page-content">
    <header class="content-header">
      <h1>${escapeHtml(proj.meta.title)}</h1>
    </header>
    <div class="blocks">
      ${blockHtml || '<p class="empty-page">This page has no content yet.</p>'}
    </div>
  </article>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Wiki renderer
// ──────────────────────────────────────────────────────────────────────────────

function renderWikiContent(proj: ProjectedWiki): string {
  const rev = proj.current_revision;
  const conflictBanner = proj.has_conflict
    ? `<div class="conflict-banner">
        <strong>Conflict detected:</strong> There are ${proj.conflict_candidates.length} concurrent revisions.
        <a href="#history">View history</a> or resolve via admin.
      </div>`
    : '';

  const revHistory = proj.revisions
    .slice()
    .reverse()
    .map(
      (r) =>
        `<li class="rev-entry">
          <span class="rev-id">${escapeHtml(r.rev_id)}</span>
          <span class="rev-ts">${new Date(r.ts).toLocaleDateString()}</span>
          <span class="rev-summary">${escapeHtml(r.summary)}</span>
        </li>`
    )
    .join('\n');

  return `<article class="wiki-content">
    <header class="content-header">
      <h1>${escapeHtml(proj.meta.title)}</h1>
      <div class="content-tags">${proj.meta.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(' ')}</div>
    </header>
    ${conflictBanner}
    <div class="wiki-body">
      ${rev ? renderMarkdown(rev.content) : '<p class="empty-page">No content yet.</p>'}
    </div>
    <section class="revision-history" id="history">
      <h2>Revision History</h2>
      <ol class="rev-list" reversed>${revHistory || '<li>No revisions yet.</li>'}</ol>
    </section>
  </article>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Blog renderer
// ──────────────────────────────────────────────────────────────────────────────

function renderBlogContent(proj: ProjectedBlog): string {
  const rev = proj.current_revision;
  return `<article class="blog-content">
    <header class="content-header">
      <h1>${escapeHtml(proj.meta.title)}</h1>
      <div class="post-meta">
        <time datetime="${escapeHtml(rev?.ts ?? '')}">${rev ? new Date(rev.ts).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : ''}</time>
        <div class="content-tags">${proj.meta.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(' ')}</div>
      </div>
    </header>
    <div class="blog-body">
      ${rev ? renderMarkdown(rev.content) : '<p class="empty-page">No content yet.</p>'}
    </div>
  </article>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Experiment renderer
// ──────────────────────────────────────────────────────────────────────────────

function renderExperimentContent(proj: ProjectedExperiment): string {
  const ICONS: Record<string, string> = {
    note: '📝',
    dataset: '📊',
    result: '✅',
    chart: '📈',
    link: '🔗',
    decision: '⚖️',
  };

  const entries = proj.entries
    .map(
      (e) => `<li class="exp-entry exp-entry-${escapeHtml(e.kind)}">
        <span class="entry-kind" title="${escapeHtml(e.kind)}">${ICONS[e.kind] ?? '•'}</span>
        <div class="entry-body">
          <div class="entry-text">${renderMarkdown(String(e.data.text ?? ''))}</div>
          ${e.data.attachments && Array.isArray(e.data.attachments) && e.data.attachments.length > 0
            ? `<ul class="attachments">${(e.data.attachments as string[]).map((a) => `<li><a href="${escapeHtml(a)}">${escapeHtml(a)}</a></li>`).join('')}</ul>`
            : ''}
        </div>
        <time class="entry-ts">${new Date(e.ts).toLocaleDateString()}</time>
      </li>`
    )
    .join('\n');

  return `<article class="exp-content">
    <header class="content-header">
      <h1>${escapeHtml(proj.meta.title)}</h1>
      <div class="content-tags">${proj.meta.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(' ')}</div>
    </header>
    <ol class="exp-entries">
      ${entries || '<li class="empty-page">No entries yet.</li>'}
    </ol>
  </article>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Home page
// ──────────────────────────────────────────────────────────────────────────────

export function renderHome(index: SiteIndex, cfg: BuildConfig): void {
  const byType = (type: string) =>
    index.nav
      .filter((e) => e.content_type === type)
      .map(
        (e) =>
          `<li><a href="${cfg.site_base_url}/${type === 'page' ? 'page' : type}/${e.slug}/">${escapeHtml(e.title)}</a>
            ${e.tags.length ? `<span class="tags">${e.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(' ')}</span>` : ''}
          </li>`
      )
      .join('\n');

  const content = `<div class="home">
    <section class="hero">
      <h1>Emergent Ontology</h1>
      <p class="hero-sub">A minimal, universal framework for data transformation.</p>
      <div class="search-box">
        <input id="search-input" type="search" placeholder="Search…" aria-label="Search site" />
        <div id="search-results" class="search-results" role="list" hidden></div>
      </div>
    </section>
    ${index.nav.filter((e) => e.content_type === 'wiki').length ? `
    <section class="home-section">
      <h2>Wiki</h2>
      <ul class="content-list">${byType('wiki')}</ul>
    </section>` : ''}
    ${index.nav.filter((e) => e.content_type === 'blog').length ? `
    <section class="home-section">
      <h2>Blog</h2>
      <ul class="content-list">${byType('blog')}</ul>
    </section>` : ''}
    ${index.nav.filter((e) => e.content_type === 'experiment').length ? `
    <section class="home-section">
      <h2>Experiments</h2>
      <ul class="content-list">${byType('experiment')}</ul>
    </section>` : ''}
    ${index.nav.filter((e) => e.content_type === 'page').length ? `
    <section class="home-section">
      <h2>Pages</h2>
      <ul class="content-list">${byType('page')}</ul>
    </section>` : ''}
  </div>`;

  const html = baseLayout(cfg, {
    title: 'Emergent Ontology',
    description: 'A minimal, universal framework for data transformation.',
    slug: '',
    content,
    nav: index.nav,
  });

  write(join(cfg.out_dir, 'index.html'), html);
}

// ──────────────────────────────────────────────────────────────────────────────
// Individual content page renderer
// ──────────────────────────────────────────────────────────────────────────────

export function renderContentPage(proj: ProjectedContent, index: SiteIndex, cfg: BuildConfig): void {
  const { meta } = proj;
  let bodyContent: string;
  let typeDir: string;

  switch (proj.content_type) {
    case 'page':
      bodyContent = renderPageContent(proj, cfg);
      typeDir = 'page';
      break;
    case 'wiki':
      bodyContent = renderWikiContent(proj);
      typeDir = 'wiki';
      break;
    case 'blog':
      bodyContent = renderBlogContent(proj);
      typeDir = 'blog';
      break;
    case 'experiment':
      bodyContent = renderExperimentContent(proj);
      typeDir = 'exp';
      break;
  }

  const html = baseLayout(cfg, {
    title: meta.title,
    slug: meta.slug,
    content: bodyContent,
    nav: index.nav,
    breadcrumbs: [
      { label: 'Home', href: `${cfg.site_base_url}/` },
      { label: typeDir.charAt(0).toUpperCase() + typeDir.slice(1), href: `${cfg.site_base_url}/${typeDir}/` },
      { label: meta.title, href: `${cfg.site_base_url}/${typeDir}/${meta.slug}/` },
    ],
  });

  write(join(cfg.out_dir, typeDir, meta.slug, 'index.html'), html);

  // Write per-content JSON state
  write(
    join(cfg.out_dir, 'state', 'content', `${meta.content_id.replace(':', '-')}.json`),
    JSON.stringify(proj, null, 2)
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// CSS  (single file, inlined into build output)
// ──────────────────────────────────────────────────────────────────────────────

export function renderStyles(cfg: BuildConfig): void {
  const css = `/* Emergent Ontology — generated site styles */
:root {
  --bg: #0f0f0f;
  --bg2: #1a1a1a;
  --bg3: #222;
  --border: #333;
  --text: #e8e8e8;
  --text-dim: #888;
  --accent: #7c6fcd;
  --accent2: #5f9ea0;
  --link: #9b8fd4;
  --danger: #c0392b;
  --warn: #f39c12;
  --font-sans: system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  --radius: 6px;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { font-size: 16px; }
body { background: var(--bg); color: var(--text); font-family: var(--font-sans); line-height: 1.6; min-height: 100vh; display: flex; flex-direction: column; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre { font-family: var(--font-mono); }
pre { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem; overflow-x: auto; }
h1 { font-size: 2rem; font-weight: 700; }
h2 { font-size: 1.5rem; font-weight: 600; }
h3 { font-size: 1.2rem; font-weight: 600; }

/* Header */
.site-header { display: flex; align-items: center; gap: 2rem; padding: .75rem 2rem; background: var(--bg2); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 100; }
.site-logo { font-weight: 700; font-size: 1.1rem; color: var(--text); }
.site-nav ul { display: flex; gap: 1.5rem; list-style: none; }
.site-nav a { color: var(--text-dim); font-size: .9rem; }
.site-nav a:hover { color: var(--text); }
.admin-link { margin-left: auto; background: var(--accent); color: #fff; padding: .35rem .85rem; border-radius: var(--radius); font-size: .85rem; }
.admin-link:hover { background: var(--link); text-decoration: none; }

/* Main */
main { flex: 1; max-width: 860px; margin: 0 auto; padding: 2rem 1.5rem; width: 100%; }
.breadcrumbs ol { display: flex; gap: .5rem; list-style: none; font-size: .85rem; color: var(--text-dim); margin-bottom: 1.5rem; }
.breadcrumbs li + li::before { content: '/'; margin-right: .5rem; }

/* Content header */
.content-header { margin-bottom: 2rem; border-bottom: 1px solid var(--border); padding-bottom: 1rem; }
.content-header h1 { margin-bottom: .5rem; }
.content-tags, .tags { display: flex; flex-wrap: wrap; gap: .35rem; }
.tag { background: var(--bg3); border: 1px solid var(--border); border-radius: 999px; padding: .15rem .6rem; font-size: .78rem; color: var(--text-dim); }
.post-meta { display: flex; align-items: center; gap: 1rem; color: var(--text-dim); font-size: .9rem; }

/* Blocks */
.blocks { display: flex; flex-direction: column; gap: 1.25rem; }
.block-text p { margin-bottom: .75rem; }
.block-callout { border-left: 4px solid var(--accent); padding: .75rem 1rem; background: var(--bg2); border-radius: 0 var(--radius) var(--radius) 0; display: flex; gap: .75rem; align-items: flex-start; }
.callout-info { border-color: var(--accent2); }
.callout-warn { border-color: var(--warn); }
.callout-danger { border-color: var(--danger); }
.block-quote { border-left: 4px solid var(--accent); padding: .75rem 1.25rem; background: var(--bg2); }
.block-quote p { font-style: italic; font-size: 1.1rem; }
.block-quote cite { display: block; margin-top: .5rem; color: var(--text-dim); font-size: .9rem; }
.block-image img { max-width: 100%; border-radius: var(--radius); }
.block-image figcaption { margin-top: .5rem; color: var(--text-dim); font-size: .85rem; text-align: center; }
.block-embed iframe { width: 100%; aspect-ratio: 16/9; border: none; border-radius: var(--radius); }
.block-divider { border: none; border-top: 1px solid var(--border); margin: 1rem 0; }

/* Wiki */
.wiki-body h1, .wiki-body h2, .wiki-body h3 { margin: 1.5rem 0 .5rem; }
.wiki-body p { margin-bottom: .75rem; }
.conflict-banner { background: color-mix(in srgb, var(--warn) 15%, var(--bg2)); border: 1px solid var(--warn); border-radius: var(--radius); padding: .75rem 1rem; margin-bottom: 1.5rem; }
.revision-history { margin-top: 3rem; border-top: 1px solid var(--border); padding-top: 1.5rem; }
.revision-history h2 { margin-bottom: 1rem; font-size: 1.1rem; }
.rev-list { list-style: none; display: flex; flex-direction: column; gap: .5rem; }
.rev-entry { display: flex; gap: 1rem; font-size: .85rem; color: var(--text-dim); }
.rev-id { font-family: var(--font-mono); }

/* Experiments */
.exp-entries { list-style: none; display: flex; flex-direction: column; gap: 1rem; }
.exp-entry { display: flex; gap: 1rem; background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem; }
.entry-kind { font-size: 1.2rem; flex-shrink: 0; }
.entry-body { flex: 1; }
.entry-ts { flex-shrink: 0; color: var(--text-dim); font-size: .8rem; align-self: flex-start; }

/* Home */
.hero { text-align: center; padding: 3rem 0 2rem; }
.hero-sub { color: var(--text-dim); margin-top: .5rem; font-size: 1.1rem; }
.search-box { position: relative; max-width: 420px; margin: 1.5rem auto 0; }
#search-input { width: 100%; background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: .65rem 1rem; color: var(--text); font-size: 1rem; }
#search-input:focus { outline: none; border-color: var(--accent); }
.search-results { position: absolute; top: calc(100% + 4px); left: 0; right: 0; background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); z-index: 50; }
.search-result-item { padding: .6rem 1rem; border-bottom: 1px solid var(--border); cursor: pointer; }
.search-result-item:last-child { border-bottom: none; }
.search-result-item:hover { background: var(--bg3); }
.home-section { margin-top: 2.5rem; }
.home-section h2 { margin-bottom: 1rem; }
.content-list { list-style: none; display: flex; flex-direction: column; gap: .75rem; }
.content-list li { display: flex; align-items: baseline; gap: .75rem; }
.empty-page { color: var(--text-dim); font-style: italic; }

/* Footer */
.site-footer { text-align: center; padding: 1.5rem; color: var(--text-dim); font-size: .8rem; border-top: 1px solid var(--border); }

/* Responsive */
@media (max-width: 640px) {
  .site-header { flex-wrap: wrap; }
  .site-nav ul { gap: 1rem; }
  main { padding: 1.25rem 1rem; }
  h1 { font-size: 1.5rem; }
}
`;
  mkdirSync(join(cfg.out_dir, 'styles'), { recursive: true });
  writeFileSync(join(cfg.out_dir, 'styles', 'main.css'), css, 'utf-8');
}

// ──────────────────────────────────────────────────────────────────────────────
// Search index
// ──────────────────────────────────────────────────────────────────────────────

export function renderSearchIndex(contents: ProjectedContent[], cfg: BuildConfig): void {
  const items = contents.map((proj) => {
    const typeDir = proj.content_type === 'page' ? 'page'
      : proj.content_type === 'experiment' ? 'exp'
      : proj.content_type;

    let excerpt = '';
    if (proj.content_type === 'wiki' && proj.current_revision) {
      excerpt = proj.current_revision.content.slice(0, 200);
    } else if (proj.content_type === 'blog' && proj.current_revision) {
      excerpt = proj.current_revision.content.slice(0, 200);
    } else if (proj.content_type === 'page' && proj.blocks.length > 0) {
      const first = proj.blocks.find((b) => b.block_type === 'text' && !b.deleted);
      if (first) excerpt = String(first.data.md ?? first.data.text ?? '').slice(0, 200);
    }

    return {
      id: proj.content_id,
      title: proj.meta.title,
      tags: proj.meta.tags,
      type: proj.content_type,
      slug: proj.meta.slug,
      url: `${cfg.site_base_url}/${typeDir}/${proj.meta.slug}/`,
      excerpt,
    };
  });

  write(join(cfg.out_dir, 'search_index.json'), JSON.stringify(items, null, 2));
}

// ──────────────────────────────────────────────────────────────────────────────
// Client-side search JS  (Fuse.js loader)
// ──────────────────────────────────────────────────────────────────────────────

export function renderSearchScript(cfg: BuildConfig): void {
  const js = `
(async function () {
  const input = document.getElementById('search-input');
  const resultsBox = document.getElementById('search-results');
  if (!input || !resultsBox) return;

  // Load Fuse.js from CDN
  const fuseScript = document.createElement('script');
  fuseScript.src = 'https://cdn.jsdelivr.net/npm/fuse.js@7/dist/fuse.min.js';
  document.head.appendChild(fuseScript);
  await new Promise((r) => { fuseScript.onload = r; });

  const resp = await fetch('${cfg.site_base_url}/search_index.json');
  const data = await resp.json();

  const fuse = new Fuse(data, {
    keys: ['title', 'excerpt', 'tags'],
    threshold: 0.35,
    includeScore: true,
  });

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (!q) { resultsBox.hidden = true; resultsBox.innerHTML = ''; return; }
    const hits = fuse.search(q).slice(0, 8);
    if (!hits.length) { resultsBox.hidden = true; return; }
    resultsBox.innerHTML = hits
      .map((h) => \`<a class="search-result-item" href="\${h.item.url}">\${h.item.title} <span class="tag">\${h.item.type}</span></a>\`)
      .join('');
    resultsBox.hidden = false;
  });

  document.addEventListener('click', (e) => {
    if (!resultsBox.contains(e.target) && e.target !== input) {
      resultsBox.hidden = true;
    }
  });
})();
`;
  mkdirSync(join(cfg.out_dir, 'js'), { recursive: true });
  writeFileSync(join(cfg.out_dir, 'js', 'search.js'), js, 'utf-8');
}

// ──────────────────────────────────────────────────────────────────────────────
// State JSON files
// ──────────────────────────────────────────────────────────────────────────────

export function renderStateFiles(index: SiteIndex, contents: ProjectedContent[], cfg: BuildConfig): void {
  write(join(cfg.out_dir, 'state', 'index.json'), JSON.stringify(index, null, 2));
  for (const proj of contents) {
    write(
      join(cfg.out_dir, 'state', 'content', `${proj.meta.content_id.replace(':', '-')}.json`),
      JSON.stringify(proj, null, 2)
    );
  }
}
