/**
 * InternalLink — extends TipTap's Link mark to support unbreakable
 * internal links using content_id.
 *
 * Stored HTML: <a href="/wiki/slug" data-content-id="wiki:slug-name">Title</a>
 *
 * The data-content-id attribute is the stable identifier. If the slug changes,
 * the href can be re-resolved at render time using the site index.
 */

import Link from '@tiptap/extension-link';

export const InternalLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      'data-content-id': {
        default: null,
        parseHTML: (el) => el.getAttribute('data-content-id'),
        renderHTML: (attrs) => {
          if (!attrs['data-content-id']) return {};
          return { 'data-content-id': attrs['data-content-id'] };
        },
      },
    };
  },
});
