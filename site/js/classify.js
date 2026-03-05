/**
 * classify.js — Client-side TF-IDF operator classification.
 *
 * Classifies content by primary EO operator using term-frequency /
 * inverse-document-frequency scoring against keyword profiles.
 * Runs in the browser at render time — no build step needed.
 */

import { OPERATORS } from './config.js';

// ── Keyword profiles per operator ────────────────────────────────────────────

var PROFILES = {
  NUL: [
    'absence', 'nothing', 'void', 'null', 'empty', 'zero', 'negation',
    'silence', 'blank', 'vacuum', 'nonexistence', 'nihil', 'lack',
    'missing', 'removed', 'deleted', 'erased', 'cleared', 'reset',
    'default', 'undefined', 'nil', 'nul', 'nullity', 'tombstone',
    'inactive', 'disabled', 'gone', 'vanish'
  ],
  DES: [
    'designation', 'naming', 'identity', 'label', 'definition',
    'describe', 'classify', 'categorize', 'metadata', 'title',
    'attribute', 'property', 'schema', 'taxonomy', 'ontology',
    'designate', 'identify', 'specify', 'declare', 'name',
    'type', 'kind', 'class', 'tag', 'annotation', 'meaning',
    'semantic', 'concept', 'term', 'vocabulary', 'reference'
  ],
  INS: [
    'instantiation', 'create', 'new', 'genesis', 'birth', 'origin',
    'begin', 'start', 'initialize', 'generate', 'produce', 'construct',
    'build', 'make', 'instantiate', 'emerge', 'spawn', 'introduce',
    'launch', 'found', 'establish', 'invent', 'pioneer', 'first',
    'prototype', 'original', 'novel', 'fresh', 'inception'
  ],
  SEG: [
    'segmentation', 'divide', 'partition', 'separate', 'boundary',
    'section', 'segment', 'split', 'decompose', 'analyze', 'part',
    'component', 'module', 'fragment', 'chunk', 'slice', 'layer',
    'hierarchy', 'structure', 'organize', 'breakdown', 'dissect',
    'differentiate', 'distinguish', 'isolate', 'granular', 'discrete',
    'categorical', 'classification'
  ],
  CON: [
    'connection', 'link', 'relation', 'network', 'graph', 'bridge',
    'join', 'connect', 'associate', 'bind', 'couple', 'attach',
    'integrate', 'interface', 'communicate', 'interact', 'reference',
    'navigate', 'route', 'path', 'traverse', 'map', 'dependency',
    'relationship', 'correlation', 'association', 'between', 'together',
    'mutual', 'exchange'
  ],
  SYN: [
    'synthesis', 'combine', 'merge', 'unify', 'integrate', 'compose',
    'synthesize', 'fusion', 'blend', 'harmonize', 'converge', 'resolve',
    'reconcile', 'consolidate', 'aggregate', 'holistic', 'whole',
    'comprehensive', 'synergy', 'emergent', 'transcend', 'unified',
    'consensus', 'conclude', 'summary', 'overview', 'framework',
    'theory', 'model', 'paradigm'
  ],
  ALT: [
    'alternation', 'change', 'modify', 'transform', 'alter', 'vary',
    'mutate', 'shift', 'evolve', 'adapt', 'update', 'revise',
    'oscillate', 'alternate', 'switch', 'toggle', 'cycle', 'wave',
    'fluctuate', 'iterate', 'version', 'variation', 'different',
    'dynamic', 'transition', 'flux', 'mutable', 'edit', 'patch',
    'migration'
  ],
  SUP: [
    'superposition', 'parallel', 'simultaneous', 'concurrent', 'overlay',
    'coexist', 'multiple', 'ambiguity', 'quantum', 'probabilistic',
    'potential', 'possibility', 'spectrum', 'both', 'duality',
    'superpose', 'stack', 'overlap', 'conflict', 'tension',
    'paradox', 'contradiction', 'pluralism', 'multiplicity',
    'multivalent', 'polysemy', 'indeterminate', 'uncertain'
  ],
  REC: [
    'recursion', 'recursive', 'self-reference', 'loop', 'fractal',
    'feedback', 'iteration', 'repeat', 'cycle', 'recurrence', 'spiral',
    'meta', 'self-similar', 'nested', 'embed', 'reflect', 'mirror',
    'autopoiesis', 'bootstrap', 'reentry', 'strange-loop', 'hofstadter',
    'godel', 'self-organize', 'emergence', 'complex',
    'recombine', 'derive', 'projection'
  ]
};

// Build operator lookup from config
var OP_BY_CODE = {};
OPERATORS.forEach(function (op) { OP_BY_CODE[op.code] = op; });

// ── Stopwords ────────────────────────────────────────────────────────────────

var STOP = {
  the:1, a:1, an:1, is:1, are:1, was:1, were:1, be:1, been:1, being:1,
  have:1, has:1, had:1, do:1, does:1, did:1, will:1, would:1, could:1,
  should:1, may:1, might:1, shall:1, can:1, need:1, to:1, of:1, in:1,
  for:1, on:1, with:1, at:1, by:1, from:1, as:1, into:1, through:1,
  during:1, before:1, after:1, above:1, below:1, between:1, out:1, off:1,
  over:1, under:1, again:1, then:1, once:1, here:1, there:1, when:1,
  where:1, why:1, how:1, all:1, each:1, every:1, both:1, few:1, more:1,
  most:1, other:1, some:1, such:1, no:1, nor:1, not:1, only:1, own:1,
  same:1, so:1, than:1, too:1, very:1, just:1, because:1, but:1, and:1,
  or:1, if:1, while:1, about:1, this:1, that:1, these:1, those:1, it:1,
  its:1, i:1, we:1, they:1, them:1, their:1, what:1, which:1, who:1, whom:1
};

// ── Tokenizer ────────────────────────────────────────────────────────────────

function tokenize(text) {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_~`>|]/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(function (t) { return t.length > 1 && !STOP[t]; });
}

// ── Classify a single item ───────────────────────────────────────────────────

/**
 * Classify text and return { code, symbol, color }.
 * Uses simple keyword frequency (no IDF needed for single-doc classification).
 */
export function classifyText(text) {
  var tokens = tokenize(text);
  var freq = {};
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    freq[t] = (freq[t] || 0) + 1;
  }

  var bestCode = 'DES';
  var bestScore = 0;
  var codes = Object.keys(PROFILES);
  for (var ci = 0; ci < codes.length; ci++) {
    var code = codes[ci];
    var keywords = PROFILES[code];
    var score = 0;
    for (var ki = 0; ki < keywords.length; ki++) {
      score += freq[keywords[ki]] || 0;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCode = code;
    }
  }

  var op = OP_BY_CODE[bestCode];
  return { code: op.code, symbol: op.symbol, color: op.color };
}

// ── Classify an index entry from title + tags ────────────────────────────────

/**
 * Classify an index entry using its title and tags.
 * Returns { code, symbol, color }.
 */
export function classifyEntry(entry) {
  var parts = [entry.title || '', entry.title || ''];  // double-weight title
  if (entry.tags) {
    for (var i = 0; i < entry.tags.length; i++) {
      parts.push(entry.tags[i]);
    }
  }
  return classifyText(parts.join(' '));
}
