/**
 * blocks.ts — Shared block rendering for pages.
 *
 * Used by both index.astro (homepage editable blocks) and page/[slug].astro.
 */

export interface Block {
  block_id: string;
  block_type: string;
  data: Record<string, unknown>;
  after: string | null;
  deleted: boolean;
}

export interface PageLike {
  content_id: string;
  blocks: Block[];
  block_order: string[];
}

export function renderMarkdown(md: string): string {
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
    .replace(/^(?!<)(.+)/m, '<p>$1')
    .trimEnd() + '</p>';
}

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Render a sub-block inside a column (no nesting, no toc/wiki-embed/experiment-embed). */
function renderSubBlock(sub: { block_id: string; block_type: string; data: Record<string, unknown> }, base: string): string {
  const { block_type, data } = sub;
  switch (block_type) {
    case 'text':
      return renderMarkdown(String(data.md ?? data.text ?? ''));
    case 'heading': {
      const text = String(data.text ?? '');
      const level = Math.min(Math.max(Number(data.level ?? 2), 1), 6);
      const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      return `<h${level} id="${slug}" class="block block-heading">${escHtml(text)}</h${level}>`;
    }
    case 'callout':
      return `<aside class="block block-callout callout-${data.kind ?? 'info'}"><div>${renderMarkdown(String(data.text ?? ''))}</div></aside>`;
    case 'quote':
      return `<blockquote class="block block-quote"><p>${String(data.text ?? '')}</p>${data.attribution ? `<cite>— ${String(data.attribution)}</cite>` : ''}</blockquote>`;
    case 'divider':
      return '<hr class="block block-divider" />';
    case 'spacer':
      return `<div class="block block-spacer" style="height:${escHtml(String(data.height ?? '2rem'))}"></div>`;
    case 'image':
      return `<figure class="block block-image"><img src="${String(data.src ?? '')}" alt="${String(data.alt ?? '')}" loading="lazy" />${data.caption ? `<figcaption>${String(data.caption)}</figcaption>` : ''}</figure>`;
    case 'code': {
      const code = String(data.code ?? '');
      const lang = String(data.lang ?? '');
      return `<div class="block block-code"><pre><code${lang ? ` class="language-${escHtml(lang)}"` : ''}>${escHtml(code)}</code></pre></div>`;
    }
    case 'button': {
      const text = String(data.text ?? 'Click here');
      const url = String(data.url ?? '#');
      const style = String(data.style ?? 'primary');
      return `<div class="block block-button"><a class="btn btn-${escHtml(style)}" href="${escHtml(url)}">${escHtml(text)}</a></div>`;
    }
    case 'embed': {
      const src = String(data.src ?? '');
      const title = String(data.title ?? '');
      if (!src) return '';
      return `<figure class="block block-embed"><iframe src="${escHtml(src)}" title="${escHtml(title)}" loading="lazy" allowfullscreen frameborder="0"></iframe>${title ? `<figcaption>${escHtml(title)}</figcaption>` : ''}</figure>`;
    }
    case 'video': {
      const src = String(data.src ?? '');
      if (!src) return '';
      let embedSrc = src;
      const ytMatch = src.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
      if (ytMatch) embedSrc = `https://www.youtube.com/embed/${ytMatch[1]}`;
      const vimeoMatch = src.match(/vimeo\.com\/(\d+)/);
      if (vimeoMatch) embedSrc = `https://player.vimeo.com/video/${vimeoMatch[1]}`;
      const caption = String(data.caption ?? '');
      return `<figure class="block block-video"><iframe src="${escHtml(embedSrc)}" title="${escHtml(caption || 'Video')}" loading="lazy" allowfullscreen frameborder="0"></iframe>${caption ? `<figcaption>${escHtml(caption)}</figcaption>` : ''}</figure>`;
    }
    case 'html':
      return `<div class="block block-html">${String(data.html ?? '')}</div>`;
    default:
      return `<div class="block block-${block_type}">[${block_type}]</div>`;
  }
}

export function renderBlock(block: Block, page: PageLike, base: string): string {
  if (block.deleted) return '';
  const blockMap = new Map(page.blocks.map((b) => [b.block_id, b]));
  const { block_type, data } = block;

  switch (block_type) {
    case 'text':
      return renderMarkdown(String(data.md ?? data.text ?? ''));
    case 'callout':
      return `<aside class="block block-callout callout-${data.kind ?? 'info'}"><div>${renderMarkdown(String(data.text ?? ''))}</div></aside>`;
    case 'quote':
      return `<blockquote class="block block-quote"><p>${String(data.text ?? '')}</p>${data.attribution ? `<cite>— ${String(data.attribution)}</cite>` : ''}</blockquote>`;
    case 'divider':
      return '<hr class="block block-divider" />';
    case 'image':
      return `<figure class="block block-image"><img src="${String(data.src ?? '')}" alt="${String(data.alt ?? '')}" loading="lazy" />${data.caption ? `<figcaption>${String(data.caption)}</figcaption>` : ''}</figure>`;
    case 'embed': {
      const src = String(data.src ?? '');
      const title = String(data.title ?? '');
      if (!src) return '';
      return `<figure class="block block-embed"><iframe src="${escHtml(src)}" title="${escHtml(title)}" loading="lazy" allowfullscreen frameborder="0"></iframe>${title ? `<figcaption>${escHtml(title)}</figcaption>` : ''}</figure>`;
    }
    case 'toc': {
      const headings: string[] = [];
      for (const id of page.block_order) {
        const b = blockMap.get(id);
        if (!b || b.deleted) continue;
        if (b.block_type === 'text') {
          const md = String(b.data.md ?? b.data.text ?? '');
          const lines = md.split('\n');
          for (const line of lines) {
            const m = line.match(/^(#{1,4})\s+(.+)$/);
            if (m) {
              const level = m[1].length;
              const text = m[2];
              const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
              headings.push(`<li class="toc-level-${level}"><a href="#${slug}">${escHtml(text)}</a></li>`);
            }
          }
        }
        if (b.block_type === 'heading') {
          const text = String(b.data.text ?? '');
          const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
          const level = Number(b.data.level ?? 2);
          headings.push(`<li class="toc-level-${level}"><a href="#${slug}">${escHtml(text)}</a></li>`);
        }
      }
      if (headings.length === 0) return '';
      return `<nav class="block block-toc"><div class="toc-title">Contents</div><ol>${headings.join('')}</ol></nav>`;
    }
    case 'wiki-embed': {
      const slug = String(data.slug ?? data.wiki_id ?? '');
      if (!slug) return `<div class="block block-wiki-embed">[wiki embed: no slug set]</div>`;
      return `<div class="block block-wiki-embed"><a class="wiki-embed-link" href="${base}/wiki/${escHtml(slug)}/">Linked wiki article: ${escHtml(slug)}</a></div>`;
    }
    case 'experiment-embed': {
      const expId = String(data.exp_id ?? '');
      if (!expId) return `<div class="block block-experiment-embed">[experiment embed: no ID set]</div>`;
      const expSlug = expId.replace('experiment:', '');
      return `<div class="block block-experiment-embed"><a class="exp-embed-link" href="${base}/exp/${escHtml(expSlug)}/">Linked experiment: ${escHtml(expSlug)}</a></div>`;
    }
    case 'code': {
      const code = String(data.code ?? '');
      const lang = String(data.lang ?? '');
      return `<div class="block block-code"><pre><code${lang ? ` class="language-${escHtml(lang)}"` : ''}>${escHtml(code)}</code></pre></div>`;
    }
    case 'heading': {
      const text = String(data.text ?? '');
      const level = Math.min(Math.max(Number(data.level ?? 2), 1), 6);
      const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      return `<h${level} id="${slug}" class="block block-heading">${escHtml(text)}</h${level}>`;
    }
    case 'button': {
      const text = String(data.text ?? 'Click here');
      const url = String(data.url ?? '#');
      const style = String(data.style ?? 'primary');
      return `<div class="block block-button"><a class="btn btn-${escHtml(style)}" href="${escHtml(url)}">${escHtml(text)}</a></div>`;
    }
    case 'columns': {
      const raw = Array.isArray(data.columns) ? data.columns : [String(data.col1 ?? ''), String(data.col2 ?? '')];
      // Detect format: new (ColumnData[]) vs old (string[])
      const isNewFormat = raw.length > 0 && typeof raw[0] === 'object' && raw[0] !== null && 'blocks' in (raw[0] as Record<string, unknown>);
      const layout = data.layout ? ` style="grid-template-columns:${escHtml(String(data.layout))}"` : '';
      if (isNewFormat) {
        const cols = raw as Array<{ blocks: Array<{ block_id: string; block_type: string; data: Record<string, unknown> }>; block_order: string[] }>;
        const rendered = cols.map((col) => {
          const inner = col.block_order
            .map((id) => col.blocks.find((b) => b.block_id === id))
            .filter(Boolean)
            .map((sub) => renderSubBlock(sub!, base))
            .join('\n');
          return `<div class="column">${inner || ''}</div>`;
        }).join('');
        return `<div class="block block-columns block-columns-${cols.length}"${layout}>${rendered}</div>`;
      }
      // Old format: string[] of markdown
      const cols = raw as string[];
      const rendered = cols.map((c: string) => `<div class="column">${renderMarkdown(String(c))}</div>`).join('');
      return `<div class="block block-columns block-columns-${cols.length}"${layout}>${rendered}</div>`;
    }
    case 'spacer': {
      const height = String(data.height ?? '2rem');
      return `<div class="block block-spacer" style="height:${escHtml(height)}"></div>`;
    }
    case 'video': {
      const src = String(data.src ?? '');
      if (!src) return '';
      let embedSrc = src;
      const ytMatch = src.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
      if (ytMatch) embedSrc = `https://www.youtube.com/embed/${ytMatch[1]}`;
      const vimeoMatch = src.match(/vimeo\.com\/(\d+)/);
      if (vimeoMatch) embedSrc = `https://player.vimeo.com/video/${vimeoMatch[1]}`;
      const caption = String(data.caption ?? '');
      return `<figure class="block block-video"><iframe src="${escHtml(embedSrc)}" title="${escHtml(caption || 'Video')}" loading="lazy" allowfullscreen frameborder="0"></iframe>${caption ? `<figcaption>${escHtml(caption)}</figcaption>` : ''}</figure>`;
    }
    case 'html': {
      const html = String(data.html ?? '');
      return `<div class="block block-html">${html}</div>`;
    }
    default:
      return `<div class="block block-${block_type}">[${block_type}]</div>`;
  }
}
