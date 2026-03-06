/**
 * config.js — Constants, operators, and site configuration.
 */

var baseEl = document.querySelector('base');
export var BASE = baseEl ? baseEl.getAttribute('href').replace(/\/$/, '') : '';

export var API_URL = 'https://n8n.intelechia.com/webhook/81ca952a-3387-4837-8bcd-d18e3d28e758';

export var API_TIMEOUT = 15000;

export var OPERATORS = [
  { num: 1, symbol: '\u2205', code: 'NUL', greek: '\u03BD', label: 'Absence & Nullity', color: '#9ca3af', slug: 'nul' },
  { num: 2, symbol: '\u03C3', code: 'SIG', greek: '\u03C3', label: 'Designation', color: '#60a5fa', slug: 'sig' },
  { num: 3, symbol: '\u03B9', code: 'INS', greek: '\u03B1', label: 'Instantiation', color: '#4ade80', slug: 'ins' },
  { num: 4, symbol: '|', code: 'SEG', greek: '\u03BA', label: 'Segmentation', color: '#c084fc', slug: 'seg' },
  { num: 5, symbol: '\u22C8', code: 'CON', greek: '\u03B5', label: 'Connection', color: '#34d399', slug: 'con' },
  { num: 6, symbol: '\u2228', code: 'SYN', greek: '\u03B7', label: 'Synthesis', color: '#818cf8', slug: 'syn' },
  { num: 7, symbol: '\u223F', code: 'ALT', greek: '\u03B4', label: 'Alternation', color: '#fbbf24', slug: 'alt' },
  { num: 8, symbol: '\u2295', code: 'SUP', greek: '\u03C8', label: 'Superposition', color: '#f472b6', slug: 'sup' },
  { num: 9, symbol: '\u21AC', code: 'REC', greek: '\u03A9', label: 'Recursion', color: '#fb923c', slug: 'rec' }
];
