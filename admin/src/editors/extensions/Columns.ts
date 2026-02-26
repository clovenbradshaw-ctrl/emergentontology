/**
 * Columns extension for TipTap — drag-and-drop column layout.
 *
 * Creates two node types:
 *   - `columns`: a container that holds 2–6 column children
 *   - `column`: a single column that accepts block content
 *
 * Usage: editor.commands.insertColumns({ count: 2 })
 */

import { Node, mergeAttributes } from '@tiptap/core';

// ── Column (single column cell) ──────────────────────────────────────────────

export const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,
  draggable: false,

  parseHTML() {
    return [{ tag: 'div[data-type="column"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'column', class: 'editor-column' }), 0];
  },
});

// ── Columns (container) ──────────────────────────────────────────────────────

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    columns: {
      insertColumns: (attrs?: { count?: number; layout?: string }) => ReturnType;
      deleteColumns: () => ReturnType;
      addColumn: () => ReturnType;
      removeColumn: () => ReturnType;
    };
  }
}

export const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column{2,6}',
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      layout: {
        default: '1fr 1fr',
        parseHTML: (el) => el.getAttribute('data-layout') || '1fr 1fr',
        renderHTML: (attrs) => ({ 'data-layout': attrs.layout, style: `grid-template-columns: ${attrs.layout}` }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="columns"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'columns', class: 'editor-columns' }), 0];
  },

  addCommands() {
    return {
      insertColumns:
        (attrs) =>
        ({ commands, state }) => {
          const count = attrs?.count ?? 2;
          const layout = attrs?.layout ?? `repeat(${count}, 1fr)`;

          // Build column content: each column starts with an empty paragraph
          let columnContent = '';
          for (let i = 0; i < count; i++) {
            columnContent += '<div data-type="column"><p></p></div>';
          }

          return commands.insertContent(
            `<div data-type="columns" data-layout="${layout}">${columnContent}</div>`
          );
        },

      deleteColumns:
        () =>
        ({ commands, state }) => {
          return commands.deleteNode('columns');
        },

      addColumn:
        () =>
        ({ state, tr, dispatch }) => {
          // Find the columns node containing the cursor
          const { $from } = state.selection;
          let columnsPos: number | null = null;
          let columnsNode: any = null;

          for (let depth = $from.depth; depth >= 0; depth--) {
            const node = $from.node(depth);
            if (node.type.name === 'columns') {
              columnsPos = $from.before(depth);
              columnsNode = node;
              break;
            }
          }

          if (columnsPos === null || !columnsNode) return false;
          if (columnsNode.childCount >= 6) return false;

          if (dispatch) {
            const columnType = state.schema.nodes.column;
            const pType = state.schema.nodes.paragraph;
            const newColumn = columnType.create(null, pType.create());
            // Insert at end of columns node
            const insertPos = columnsPos + columnsNode.nodeSize - 1;
            tr.insert(insertPos, newColumn);
            // Update layout
            const newCount = columnsNode.childCount + 1;
            tr.setNodeMarkup(columnsPos, undefined, {
              ...columnsNode.attrs,
              layout: `repeat(${newCount}, 1fr)`,
            });
            dispatch(tr);
          }

          return true;
        },

      removeColumn:
        () =>
        ({ state, tr, dispatch }) => {
          const { $from } = state.selection;
          let columnsPos: number | null = null;
          let columnsNode: any = null;

          for (let depth = $from.depth; depth >= 0; depth--) {
            const node = $from.node(depth);
            if (node.type.name === 'columns') {
              columnsPos = $from.before(depth);
              columnsNode = node;
              break;
            }
          }

          if (columnsPos === null || !columnsNode) return false;
          if (columnsNode.childCount <= 2) return false;

          if (dispatch) {
            // Remove last column
            let lastColStart = columnsPos + 1;
            for (let i = 0; i < columnsNode.childCount - 1; i++) {
              lastColStart += columnsNode.child(i).nodeSize;
            }
            const lastColEnd = lastColStart + columnsNode.child(columnsNode.childCount - 1).nodeSize;
            tr.delete(lastColStart, lastColEnd);
            // Update layout
            const newCount = columnsNode.childCount - 1;
            tr.setNodeMarkup(columnsPos, undefined, {
              ...columnsNode.attrs,
              layout: `repeat(${newCount}, 1fr)`,
            });
            dispatch(tr);
          }

          return true;
        },
    };
  },
});
