/**
 * RichTextEditor — TipTap-based rich text editor with:
 *   - Formatting toolbar (bold, italic, headings, lists, code, etc.)
 *   - Column layouts (drag blocks into columns)
 *   - Internal page links with unbreakable content_id references
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import { Columns, Column } from './extensions/Columns';
import { InternalLink } from './extensions/InternalLink';

interface ContentEntry {
  content_id: string;
  slug: string;
  title: string;
  content_type: string;
}

interface Props {
  content: string;
  onChange: (html: string) => void;
  placeholder?: string;
  contentEntries?: ContentEntry[];
}

export default function RichTextEditor({ content, onChange, placeholder, contentEntries = [] }: Props) {
  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [showColumnMenu, setShowColumnMenu] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
      }),
      Placeholder.configure({
        placeholder: placeholder || 'Start writing…',
      }),
      Image.configure({
        inline: false,
        allowBase64: true,
      }),
      Columns,
      Column,
      InternalLink.configure({
        openOnClick: false,
        HTMLAttributes: {
          rel: 'noopener noreferrer',
        },
      }),
    ],
    content,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
  });

  // Sync external content changes (e.g. restore revision)
  useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content, { emitUpdate: false });
    }
  }, [content]);

  if (!editor) return null;

  return (
    <div className="rich-editor-wrapper">
      <Toolbar
        editor={editor}
        onLinkPicker={() => setShowLinkPicker(true)}
        onColumnMenu={() => setShowColumnMenu(!showColumnMenu)}
        showColumnMenu={showColumnMenu}
      />

      {showColumnMenu && (
        <ColumnMenu
          editor={editor}
          onClose={() => setShowColumnMenu(false)}
        />
      )}

      <EditorContent editor={editor} className="rich-editor-content" />

      {showLinkPicker && (
        <LinkPicker
          editor={editor}
          contentEntries={contentEntries}
          onClose={() => setShowLinkPicker(false)}
        />
      )}
    </div>
  );
}

// ── Toolbar ──────────────────────────────────────────────────────────────────

function Toolbar({ editor, onLinkPicker, onColumnMenu, showColumnMenu }: {
  editor: ReturnType<typeof useEditor>;
  onLinkPicker: () => void;
  onColumnMenu: () => void;
  showColumnMenu: boolean;
}) {
  if (!editor) return null;

  return (
    <div className="rte-toolbar">
      <div className="rte-toolbar-group">
        <button
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={`rte-btn ${editor.isActive('bold') ? 'active' : ''}`}
          title="Bold"
        >B</button>
        <button
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={`rte-btn ${editor.isActive('italic') ? 'active' : ''}`}
          title="Italic"
        ><em>I</em></button>
        <button
          onClick={() => editor.chain().focus().toggleStrike().run()}
          className={`rte-btn ${editor.isActive('strike') ? 'active' : ''}`}
          title="Strikethrough"
        ><s>S</s></button>
        <button
          onClick={() => editor.chain().focus().toggleCode().run()}
          className={`rte-btn ${editor.isActive('code') ? 'active' : ''}`}
          title="Inline code"
        >{'<>'}</button>
      </div>

      <span className="rte-sep" />

      <div className="rte-toolbar-group">
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          className={`rte-btn ${editor.isActive('heading', { level: 1 }) ? 'active' : ''}`}
          title="Heading 1"
        >H1</button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          className={`rte-btn ${editor.isActive('heading', { level: 2 }) ? 'active' : ''}`}
          title="Heading 2"
        >H2</button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          className={`rte-btn ${editor.isActive('heading', { level: 3 }) ? 'active' : ''}`}
          title="Heading 3"
        >H3</button>
      </div>

      <span className="rte-sep" />

      <div className="rte-toolbar-group">
        <button
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={`rte-btn ${editor.isActive('bulletList') ? 'active' : ''}`}
          title="Bullet list"
        >&#8226; List</button>
        <button
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          className={`rte-btn ${editor.isActive('orderedList') ? 'active' : ''}`}
          title="Ordered list"
        >1. List</button>
        <button
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          className={`rte-btn ${editor.isActive('blockquote') ? 'active' : ''}`}
          title="Blockquote"
        >&ldquo;</button>
        <button
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          className={`rte-btn ${editor.isActive('codeBlock') ? 'active' : ''}`}
          title="Code block"
        >{'```'}</button>
      </div>

      <span className="rte-sep" />

      <div className="rte-toolbar-group">
        <button
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          className="rte-btn"
          title="Horizontal rule"
        >&mdash;</button>
        <button
          onClick={() => {
            const url = prompt('Image URL:');
            if (url) editor.chain().focus().setImage({ src: url }).run();
          }}
          className="rte-btn"
          title="Insert image"
        >Img</button>
        <button
          onClick={onLinkPicker}
          className={`rte-btn ${editor.isActive('link') ? 'active' : ''}`}
          title="Insert link (internal or external)"
        >Link</button>
        {editor.isActive('link') && (
          <button
            onClick={() => editor.chain().focus().unsetLink().run()}
            className="rte-btn rte-btn-danger"
            title="Remove link"
          >Unlink</button>
        )}
      </div>

      <span className="rte-sep" />

      <div className="rte-toolbar-group">
        <button
          onClick={onColumnMenu}
          className={`rte-btn ${showColumnMenu ? 'active' : ''}`}
          title="Insert column layout"
        >Columns</button>
      </div>

      <span className="rte-sep" />

      <div className="rte-toolbar-group">
        <button
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
          className="rte-btn"
          title="Undo"
        >↺</button>
        <button
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
          className="rte-btn"
          title="Redo"
        >↻</button>
      </div>
    </div>
  );
}

// ── Column Menu ──────────────────────────────────────────────────────────────

const COLUMN_PRESETS = [
  { label: '2 equal', count: 2, layout: '1fr 1fr' },
  { label: '2 — wide left', count: 2, layout: '2fr 1fr' },
  { label: '2 — wide right', count: 2, layout: '1fr 2fr' },
  { label: '3 equal', count: 3, layout: '1fr 1fr 1fr' },
  { label: '3 — wide center', count: 3, layout: '1fr 2fr 1fr' },
  { label: '4 equal', count: 4, layout: 'repeat(4, 1fr)' },
];

function ColumnMenu({ editor, onClose }: { editor: ReturnType<typeof useEditor>; onClose: () => void }) {
  if (!editor) return null;

  const isInColumns = (() => {
    const { $from } = editor.state.selection;
    for (let depth = $from.depth; depth >= 0; depth--) {
      if ($from.node(depth).type.name === 'columns') return true;
    }
    return false;
  })();

  return (
    <div className="column-menu">
      <div className="column-menu-header">Insert column layout</div>
      <div className="column-menu-presets">
        {COLUMN_PRESETS.map((preset) => (
          <button
            key={preset.label}
            className="column-preset-btn"
            onClick={() => {
              editor.chain().focus().insertColumns({ count: preset.count, layout: preset.layout }).run();
              onClose();
            }}
          >
            <div className="column-preset-preview" style={{ gridTemplateColumns: preset.layout }}>
              {Array.from({ length: preset.count }).map((_, i) => (
                <div key={i} className="column-preset-cell" />
              ))}
            </div>
            <span>{preset.label}</span>
          </button>
        ))}
      </div>
      {isInColumns && (
        <div className="column-menu-actions">
          <button className="btn btn-xs" onClick={() => { editor.chain().focus().addColumn().run(); onClose(); }}>+ Add column</button>
          <button className="btn btn-xs" onClick={() => { editor.chain().focus().removeColumn().run(); onClose(); }}>- Remove column</button>
          <button className="btn btn-xs rte-btn-danger" onClick={() => { editor.chain().focus().deleteColumns().run(); onClose(); }}>Delete columns</button>
        </div>
      )}
    </div>
  );
}

// ── Link Picker (internal + external) ────────────────────────────────────────

function LinkPicker({ editor, contentEntries, onClose }: {
  editor: ReturnType<typeof useEditor>;
  contentEntries: ContentEntry[];
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'internal' | 'external'>('internal');
  const [search, setSearch] = useState('');
  const [externalUrl, setExternalUrl] = useState('');

  if (!editor) return null;

  const filtered = contentEntries.filter((e) =>
    e.title.toLowerCase().includes(search.toLowerCase()) ||
    e.slug.toLowerCase().includes(search.toLowerCase()) ||
    e.content_id.toLowerCase().includes(search.toLowerCase())
  );

  function insertInternalLink(entry: ContentEntry) {
    const typePrefix = entry.content_type === 'experiment' ? 'exp' : entry.content_type;
    const href = `/${typePrefix}/${entry.slug}`;

    editor!
      .chain()
      .focus()
      .extendMarkRange('link')
      .setLink({
        href,
        'data-content-id': entry.content_id,
      } as any)
      .run();

    // If no text is selected, insert the title as link text
    const { from, to } = editor!.state.selection;
    if (from === to) {
      editor!
        .chain()
        .focus()
        .insertContent(`<a href="${href}" data-content-id="${entry.content_id}">${entry.title}</a>`)
        .run();
    }

    onClose();
  }

  function insertExternalLink() {
    if (!externalUrl.trim()) return;
    const url = externalUrl.startsWith('http') ? externalUrl : `https://${externalUrl}`;

    editor!
      .chain()
      .focus()
      .extendMarkRange('link')
      .setLink({ href: url })
      .run();

    const { from, to } = editor!.state.selection;
    if (from === to) {
      editor!
        .chain()
        .focus()
        .insertContent(`<a href="${url}">${url}</a>`)
        .run();
    }

    onClose();
  }

  return (
    <div className="link-picker-overlay" onClick={onClose}>
      <div className="link-picker" onClick={(e) => e.stopPropagation()}>
        <div className="link-picker-header">
          <h3>Insert Link</h3>
          <button className="btn btn-xs" onClick={onClose}>&times;</button>
        </div>

        <div className="link-picker-tabs">
          <button
            className={`link-tab ${mode === 'internal' ? 'active' : ''}`}
            onClick={() => setMode('internal')}
          >Internal Page</button>
          <button
            className={`link-tab ${mode === 'external' ? 'active' : ''}`}
            onClick={() => setMode('external')}
          >External URL</button>
        </div>

        {mode === 'internal' && (
          <div className="link-picker-body">
            <input
              className="link-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search pages…"
              autoFocus
            />
            <div className="link-results">
              {filtered.length === 0 && (
                <div className="link-empty">No pages found</div>
              )}
              {filtered.map((entry) => (
                <button
                  key={entry.content_id}
                  className="link-result-item"
                  onClick={() => insertInternalLink(entry)}
                >
                  <span className={`type-badge type-${entry.content_type}`}>{entry.content_type}</span>
                  <span className="link-result-title">{entry.title}</span>
                  <span className="link-result-slug">{entry.slug}</span>
                </button>
              ))}
            </div>
            <div className="link-picker-hint">
              Links use content IDs — they won't break if slugs change.
            </div>
          </div>
        )}

        {mode === 'external' && (
          <div className="link-picker-body">
            <input
              className="link-search"
              value={externalUrl}
              onChange={(e) => setExternalUrl(e.target.value)}
              placeholder="https://example.com"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') insertExternalLink(); }}
            />
            <button
              className="btn btn-primary btn-full"
              onClick={insertExternalLink}
              disabled={!externalUrl.trim()}
              style={{ marginTop: '.75rem' }}
            >
              Insert Link
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
