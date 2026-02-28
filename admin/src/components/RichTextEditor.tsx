/**
 * RichTextEditor — TipTap-based WYSIWYG editor for text blocks.
 *
 * Accepts markdown content, renders it as rich text, and outputs markdown on change.
 * Uses TipTap starter-kit for basic formatting (bold, italic, headings, lists, code, blockquote).
 */

import React, { useEffect, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';

// ── Simple markdown ↔ HTML conversion helpers ─────────────────────────────────

function mdToHtml(md: string): string {
  if (!md) return '';
  let html = md;

  // Code blocks (``` ... ```) — must come before inline code
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) =>
    `<pre><code>${code.replace(/</g, '&lt;').replace(/>/g, '&gt;').trimEnd()}</code></pre>`
  );

  // Headings
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');

  // Blockquotes
  html = html.replace(/^>\s+(.+)$/gm, '<blockquote><p>$1</p></blockquote>');

  // Unordered lists
  html = html.replace(/^(?:[-*+])\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

  // Ordered lists
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

  // Bold + italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Tables (pipe syntax)
  html = html.replace(
    /((?:^\|.+\|[ \t]*\n){2,})/gm,
    (tableBlock) => {
      const lines = tableBlock.trim().split('\n');
      if (lines.length < 2) return tableBlock;
      const sepLine = lines[1];
      if (!/^\|[\s\-:|]+\|$/.test(sepLine.trim())) return tableBlock;
      const parseRow = (line: string) =>
        line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const headers = parseRow(lines[0]);
      const headHtml = '<thead><tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr></thead>';
      const bodyRows = lines.slice(2).filter(l => l.trim());
      const bodyHtml = '<tbody>' + bodyRows.map(line => {
        const cells = parseRow(line);
        return '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';
      }).join('') + '</tbody>';
      return `<table>${headHtml}${bodyHtml}</table>`;
    }
  );

  // Paragraphs: wrap remaining plain lines
  html = html.replace(/^(?!<[a-z]).+$/gm, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    return `<p>${trimmed}</p>`;
  });

  // Clean up empty lines
  html = html.replace(/\n{2,}/g, '\n');

  return html.trim();
}

function htmlToMd(html: string): string {
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

// ── Editor component ──────────────────────────────────────────────────────────

interface RichTextEditorProps {
  value: string;
  onChange: (md: string) => void;
  placeholder?: string;
  minHeight?: string;
}

export default function RichTextEditor({ value, onChange, placeholder, minHeight = '120px' }: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
      }),
      Link.configure({ openOnClick: false, HTMLAttributes: { class: 'editor-link' } }),
      Placeholder.configure({ placeholder: placeholder || 'Start typing...' }),
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
    ],
    content: mdToHtml(value),
    onUpdate: ({ editor: e }) => {
      onChange(htmlToMd(e.getHTML()));
    },
  });

  // Sync external value changes (e.g. switching between blocks)
  const currentRef = React.useRef(value);
  useEffect(() => {
    if (editor && value !== currentRef.current) {
      currentRef.current = value;
      editor.commands.setContent(mdToHtml(value));
    }
  }, [editor, value]);

  // Track changes from editor
  useEffect(() => {
    if (editor) {
      const handler = () => { currentRef.current = htmlToMd(editor.getHTML()); };
      editor.on('update', handler);
      return () => { editor.off('update', handler); };
    }
  }, [editor]);

  const setLink = useCallback(() => {
    if (!editor) return;
    const prev = editor.getAttributes('link').href;
    const url = window.prompt('URL', prev || 'https://');
    if (url === null) return;
    if (url === '') { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return; }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  if (!editor) return null;

  return (
    <div className="rich-text-editor" style={{ minHeight }}>
      {/* Toolbar */}
      <div className="rte-toolbar">
        <button type="button" className={`rte-btn ${editor.isActive('bold') ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold"><strong>B</strong></button>
        <button type="button" className={`rte-btn ${editor.isActive('italic') ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic"><em>I</em></button>
        <button type="button" className={`rte-btn ${editor.isActive('code') ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleCode().run()} title="Code">&lt;/&gt;</button>
        <span className="rte-sep" />
        <button type="button" className={`rte-btn ${editor.isActive('heading', { level: 2 }) ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading 2">H2</button>
        <button type="button" className={`rte-btn ${editor.isActive('heading', { level: 3 }) ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title="Heading 3">H3</button>
        <span className="rte-sep" />
        <button type="button" className={`rte-btn ${editor.isActive('bulletList') ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet list">&#8226;</button>
        <button type="button" className={`rte-btn ${editor.isActive('orderedList') ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Numbered list">1.</button>
        <button type="button" className={`rte-btn ${editor.isActive('blockquote') ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Quote">&ldquo;</button>
        <span className="rte-sep" />
        <button type="button" className={`rte-btn ${editor.isActive('link') ? 'active' : ''}`} onClick={setLink} title="Link">&#128279;</button>
        <button type="button" className={`rte-btn ${editor.isActive('codeBlock') ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleCodeBlock().run()} title="Code block">{'{ }'}</button>
        <span className="rte-sep" />
        <button type="button" className="rte-btn" onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Horizontal rule">&#8212;</button>
        <span className="rte-sep" />
        <button type="button" className="rte-btn" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} title="Insert table">Table</button>
      </div>

      {/* Editor content */}
      <EditorContent editor={editor} />
    </div>
  );
}
