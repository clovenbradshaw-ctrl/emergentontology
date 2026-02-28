/**
 * HtmlWidget — TipTap node extension for embedding active HTML.
 *
 * Renders user-supplied HTML inside a sandboxed iframe in the editor,
 * with an overlay to edit the source code. Output HTML uses a
 * <div data-type="html-widget"> wrapper that the site renderer
 * can hydrate into a live widget.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';

// ── React NodeView Component ─────────────────────────────────────────────────

function HtmlWidgetView({ node, updateAttributes, selected, deleteNode }: any) {
  const [editing, setEditing] = useState(!node.attrs.htmlContent);
  const [draft, setDraft] = useState(node.attrs.htmlContent || '');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const htmlContent: string = node.attrs.htmlContent || '';

  // Write HTML into the sandboxed iframe whenever content changes
  useEffect(() => {
    if (!iframeRef.current || !htmlContent) return;
    const doc = iframeRef.current.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; color: #e8e8e8; background: #1a1a1a; padding: 8px; }
</style>
</head>
<body>${htmlContent}</body>
</html>`);
    doc.close();
  }, [htmlContent]);

  // Auto-resize iframe to fit content
  useEffect(() => {
    if (!iframeRef.current || !htmlContent) return;
    const iframe = iframeRef.current;
    const resize = () => {
      try {
        const body = iframe.contentDocument?.body;
        if (body) {
          iframe.style.height = Math.max(60, body.scrollHeight + 16) + 'px';
        }
      } catch (_) { /* cross-origin safety */ }
    };
    iframe.addEventListener('load', resize);
    // Also resize after a short delay for scripts that modify DOM
    const t = setTimeout(resize, 300);
    return () => { iframe.removeEventListener('load', resize); clearTimeout(t); };
  }, [htmlContent]);

  const handleSave = useCallback(() => {
    updateAttributes({ htmlContent: draft });
    setEditing(false);
  }, [draft, updateAttributes]);

  const handleCancel = useCallback(() => {
    if (!htmlContent) {
      deleteNode();
    } else {
      setDraft(htmlContent);
      setEditing(false);
    }
  }, [htmlContent, deleteNode]);

  return (
    <NodeViewWrapper className={`html-widget-wrapper ${selected ? 'selected' : ''}`} data-type="html-widget">
      {editing ? (
        <div className="html-widget-editor">
          <div className="html-widget-editor-header">
            <span>Edit HTML Widget</span>
            <div className="html-widget-editor-actions">
              <button className="btn btn-xs" onClick={handleCancel}>Cancel</button>
              <button className="btn btn-xs btn-primary" onClick={handleSave}>Save</button>
            </div>
          </div>
          <textarea
            className="html-widget-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="<div>Your HTML here…</div>"
            autoFocus
            spellCheck={false}
            onKeyDown={(e) => {
              // Ctrl/Cmd+Enter to save
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleSave();
              }
              // Escape to cancel
              if (e.key === 'Escape') {
                e.preventDefault();
                handleCancel();
              }
              // Allow Tab to insert tab character
              if (e.key === 'Tab') {
                e.preventDefault();
                const target = e.target as HTMLTextAreaElement;
                const start = target.selectionStart;
                const end = target.selectionEnd;
                setDraft(draft.substring(0, start) + '  ' + draft.substring(end));
                requestAnimationFrame(() => {
                  target.selectionStart = target.selectionEnd = start + 2;
                });
              }
            }}
          />
          <div className="html-widget-editor-hint">
            Ctrl+Enter to save &middot; Escape to cancel &middot; Tab to indent
          </div>
        </div>
      ) : (
        <div className="html-widget-preview">
          <div className="html-widget-label">HTML Widget</div>
          {htmlContent ? (
            <iframe
              ref={iframeRef}
              className="html-widget-iframe"
              sandbox="allow-scripts"
              title="HTML Widget Preview"
            />
          ) : (
            <div className="html-widget-empty">Empty widget — click Edit to add HTML</div>
          )}
          <div className="html-widget-overlay">
            <button className="btn btn-xs" onClick={() => { setDraft(htmlContent); setEditing(true); }}>
              Edit HTML
            </button>
            <button className="btn btn-xs rte-btn-danger" onClick={deleteNode}>
              Delete
            </button>
          </div>
        </div>
      )}
    </NodeViewWrapper>
  );
}

// ── TipTap Node Extension ────────────────────────────────────────────────────

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    htmlWidget: {
      insertHtmlWidget: (attrs?: { htmlContent?: string }) => ReturnType;
    };
  }
}

export const HtmlWidget = Node.create({
  name: 'htmlWidget',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      htmlContent: {
        default: '',
        parseHTML: (el) => el.innerHTML || '',
        renderHTML: () => ({}), // content goes inside the tag, not as an attribute
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="html-widget"]' }];
  },

  renderHTML({ node }) {
    return ['div', mergeAttributes({ 'data-type': 'html-widget' }), node.attrs.htmlContent || ''];
  },

  addNodeView() {
    return ReactNodeViewRenderer(HtmlWidgetView);
  },

  addCommands() {
    return {
      insertHtmlWidget:
        (attrs) =>
        ({ commands }) => {
          return commands.insertContent({
            type: 'htmlWidget',
            attrs: { htmlContent: attrs?.htmlContent || '' },
          });
        },
    };
  },
});
