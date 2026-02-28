/**
 * router.js — URL routing.
 *
 * Parses location.pathname into a route object: { page, slug? }
 */

import { BASE } from './config.js';

/**
 * Parse the current URL into a route descriptor.
 *
 * Returns: { page: string, slug?: string }
 *
 * Pages: home, wiki-list, wiki, blog-list, blog, exp-list, exp, page, all, admin, 404
 */
export function getRoute() {
  var path = location.pathname;
  if (BASE && path.indexOf(BASE) === 0) path = path.slice(BASE.length);
  path = path.replace(/\/$/, '') || '/';

  if (path === '/') return { page: 'home' };

  var parts = path.split('/').filter(Boolean);
  if (parts[0] === 'wiki')  return parts[1] ? { page: 'wiki', slug: parts[1] } : { page: 'wiki-list' };
  if (parts[0] === 'blog')  return parts[1] ? { page: 'blog', slug: parts[1] } : { page: 'blog-list' };
  if (parts[0] === 'exp')   return parts[1] ? { page: 'exp',  slug: parts[1] } : { page: 'exp-list' };
  if (parts[0] === 'page' && parts[1]) return { page: 'page', slug: parts[1] };
  if (parts[0] === 'all') return { page: 'all' };
  if (parts[0] === 'admin') return { page: 'admin' };

  return { page: '404' };
}

/**
 * Build a content URL for a given type and slug.
 */
export function contentUrl(type, slug) {
  var prefix = { wiki: 'wiki', blog: 'blog', experiment: 'exp', page: 'page' };
  return BASE + '/' + (prefix[type] || type) + '/' + slug + '/';
}
