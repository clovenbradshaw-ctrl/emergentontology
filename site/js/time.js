/**
 * time.js — Relative timestamp formatting.
 *
 * Converts ISO 8601 timestamps into human-readable relative strings
 * like "3 minutes ago", "2 days ago", or falls back to a short date
 * for anything older than 30 days.
 */

/**
 * Format a timestamp as a relative time string.
 * @param {string|number|Date} ts — ISO 8601 string, epoch ms, or Date
 * @returns {string} e.g. "just now", "5 minutes ago", "3 days ago", "Jan 15, 2025"
 */
export function timeAgo(ts) {
  if (!ts) return '';
  var date = ts instanceof Date ? ts : new Date(ts);
  var now = Date.now();
  var diff = now - date.getTime();

  if (diff < 0) return 'just now';

  var seconds = Math.floor(diff / 1000);
  var minutes = Math.floor(seconds / 60);
  var hours = Math.floor(minutes / 60);
  var days = Math.floor(hours / 24);

  if (seconds < 60) return 'just now';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return minutes + ' minutes ago';
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return hours + ' hours ago';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + ' days ago';

  // Older than 30 days: show short date
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
