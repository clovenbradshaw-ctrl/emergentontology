/**
 * markdown.ts — Shared markdown ↔ HTML conversion helpers.
 *
 * Used by both the simple RichTextEditor (PageBuilder blocks) and
 * the WikiEditor for converting legacy markdown revisions.
 */

// ── Markdown → HTML ──────────────────────────────────────────────────────────

export function mdToHtml(md: string): string {
  if (!md) return '';

  // 1. Extract fenced code blocks to prevent double-processing
  const codeBlocks: string[] = [];
  let s = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cls = lang ? ` class="language-${lang}"` : '';
    codeBlocks.push(`<pre><code${cls}>${escaped}</code></pre>`);
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });

  // 2. Escape HTML entities in remaining content
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Headings
  s = s
    .replace(/^######\s+(.+)$/gm, '<h6>$1</h6>')
    .replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>')
    .replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // Horizontal rules
  s = s.replace(/^---$/gm, '<hr>');

  // Blockquotes
  s = s.replace(/^>\s+(.+)$/gm, '<blockquote><p>$1</p></blockquote>');

  // Unordered lists
  s = s.replace(/((?:^[ \t]*[-*+]\s+.+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map((l) => `<li>${l.replace(/^[ \t]*[-*+]\s+/, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered lists
  s = s.replace(/((?:^[ \t]*\d+\.\s+.+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map((l) => `<li>${l.replace(/^[ \t]*\d+\.\s+/, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // Tables (pipe syntax)
  s = s.replace(
    /((?:^\|.+\|[ \t]*\n){2,})/gm,
    (tableBlock) => {
      const lines = tableBlock.trim().split('\n');
      if (lines.length < 2) return tableBlock;
      const sepLine = lines[1];
      if (!/^\|[\s\-:|]+\|$/.test(sepLine.trim())) return tableBlock;
      const parseRow = (line: string) =>
        line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c: string) => c.trim());
      const headers = parseRow(lines[0]);
      const headHtml = '<thead><tr>' + headers.map((h: string) => `<th>${h}</th>`).join('') + '</tr></thead>';
      const bodyRows = lines.slice(2).filter((l: string) => l.trim());
      const bodyHtml = '<tbody>' + bodyRows.map((line: string) => {
        const cells = parseRow(line);
        return '<tr>' + cells.map((c: string) => `<td>${c}</td>`).join('') + '</tr>';
      }).join('') + '</tbody>';
      return `<table>${headHtml}${bodyHtml}</table>`;
    }
  );

  // Inline formatting
  s = s
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Paragraphs
  s = s.replace(/\n\n+/g, '</p><p>');
  s = `<p>${s}</p>`;

  // 3. Restore code blocks
  s = s.replace(/\x00CODE(\d+)\x00/g, (_m, i) => codeBlocks[Number(i)]);

  // Clean up: don't wrap block elements in <p>
  s = s.replace(/<p>(<(?:h[1-6]|ul|ol|hr|pre|blockquote|table)[^>]*>)/g, '$1');
  s = s.replace(/(<\/(?:h[1-6]|ul|ol|hr|pre|blockquote|table)>)<\/p>/g, '$1');

  return s;
}

// ── HTML → Markdown ──────────────────────────────────────────────────────────

export function htmlToMd(html: string): string {
  if (!html) return '';
  let md = html;

  // Code blocks
  md = md.replace(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g, (_m, code) => {
    const decoded = code.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return `\`\`\`\n${decoded}\n\`\`\``;
  });

  // Headings
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/g, '# $1');
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/g, '## $1');
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/g, '### $1');
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/g, '#### $1');
  md = md.replace(/<h5[^>]*>(.*?)<\/h5>/g, '##### $1');
  md = md.replace(/<h6[^>]*>(.*?)<\/h6>/g, '###### $1');

  // Horizontal rules
  md = md.replace(/<hr\s*\/?>/g, '---');

  // Blockquotes
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/g, (_m, inner) => {
    const text = inner.replace(/<\/?p[^>]*>/g, '').trim();
    return text.split('\n').map((line: string) => `> ${line}`).join('\n');
  });

  // Lists
  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/g, (_m, inner) => {
    return inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/g, (_m2: string, content: string) => {
      const text = content.replace(/<\/?p[^>]*>/g, '').trim();
      return `- ${text}`;
    }).trim();
  });
  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/g, (_m, inner) => {
    let i = 0;
    return inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/g, (_m2: string, content: string) => {
      const text = content.replace(/<\/?p[^>]*>/g, '').trim();
      return `${++i}. ${text}`;
    }).trim();
  });

  // Bold + italic
  md = md.replace(/<strong><em>(.*?)<\/em><\/strong>/g, '***$1***');
  md = md.replace(/<em><strong>(.*?)<\/strong><\/em>/g, '***$1***');
  md = md.replace(/<strong[^>]*>(.*?)<\/strong>/g, '**$1**');
  md = md.replace(/<em[^>]*>(.*?)<\/em>/g, '*$1*');

  // Inline code
  md = md.replace(/<code[^>]*>(.*?)<\/code>/g, '`$1`');

  // Links
  md = md.replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/g, '[$2]($1)');

  // Tables
  md = md.replace(/<table[^>]*>([\s\S]*?)<\/table>/g, (_m, inner) => {
    const headers: string[] = [];
    const rows: string[][] = [];
    const theadMatch = inner.match(/<thead[^>]*>([\s\S]*?)<\/thead>/);
    if (theadMatch) {
      theadMatch[1].replace(/<th[^>]*>([\s\S]*?)<\/th>/g, (_: string, cell: string) => {
        headers.push(cell.replace(/<[^>]+>/g, '').trim());
        return '';
      });
    }
    const tbodyMatch = inner.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/);
    if (tbodyMatch) {
      tbodyMatch[1].replace(/<tr[^>]*>([\s\S]*?)<\/tr>/g, (_: string, row: string) => {
        const cells: string[] = [];
        row.replace(/<td[^>]*>([\s\S]*?)<\/td>/g, (_: string, cell: string) => {
          cells.push(cell.replace(/<[^>]+>/g, '').trim());
          return '';
        });
        if (cells.length) rows.push(cells);
        return '';
      });
    }
    if (!headers.length) return inner;
    const headerLine = '| ' + headers.join(' | ') + ' |';
    const sepLine = '| ' + headers.map(() => '---').join(' | ') + ' |';
    const bodyLines = rows.map(r => '| ' + r.join(' | ') + ' |').join('\n');
    return '\n' + headerLine + '\n' + sepLine + '\n' + bodyLines + '\n';
  });

  // Paragraphs
  md = md.replace(/<p[^>]*>(.*?)<\/p>/g, '$1\n');

  // Line breaks
  md = md.replace(/<br\s*\/?>/g, '\n');

  // Clean remaining tags
  md = md.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  md = md.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

  // Normalize whitespace
  md = md.replace(/\n{3,}/g, '\n\n').trim();

  return md;
}
