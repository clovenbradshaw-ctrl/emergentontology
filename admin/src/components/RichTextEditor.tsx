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
import { mdToHtml, htmlToMd } from '../eo/markdown';

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
