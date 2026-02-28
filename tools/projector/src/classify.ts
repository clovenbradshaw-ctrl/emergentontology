/**
 * classify.ts — TF-IDF operator classification.
 *
 * Classifies content items by their primary EO operator using
 * term-frequency / inverse-document-frequency scoring against
 * curated keyword profiles for each of the 9 operators.
 *
 * Zero external dependencies. Runs at build time in the projector.
 */

import type {
  ProjectedContent,
  ProjectedWiki,
  ProjectedBlog,
  ProjectedPage,
  ProjectedExperiment,
} from './types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Operator keyword profiles
// ──────────────────────────────────────────────────────────────────────────────

interface OperatorProfile {
  code: string;
  symbol: string;
  color: string;
  keywords: string[];
}

const OPERATOR_PROFILES: Record<string, OperatorProfile> = {
  NUL: {
    code: 'NUL', symbol: '\u2205', color: '#9ca3af',
    keywords: [
      'absence', 'nothing', 'void', 'null', 'empty', 'zero', 'negation',
      'silence', 'blank', 'vacuum', 'nonexistence', 'nihil', 'lack',
      'missing', 'removed', 'deleted', 'erased', 'cleared', 'reset',
      'default', 'undefined', 'nil', 'nul', 'nullity', 'tombstone',
      'inactive', 'disabled', 'gone', 'vanish',
    ],
  },
  DES: {
    code: 'DES', symbol: '\u22A1', color: '#60a5fa',
    keywords: [
      'designation', 'naming', 'identity', 'label', 'definition',
      'describe', 'classify', 'categorize', 'metadata', 'title',
      'attribute', 'property', 'schema', 'taxonomy', 'ontology',
      'designate', 'identify', 'specify', 'declare', 'name',
      'type', 'kind', 'class', 'tag', 'annotation', 'meaning',
      'semantic', 'concept', 'term', 'vocabulary', 'reference',
    ],
  },
  INS: {
    code: 'INS', symbol: '\u25B3', color: '#4ade80',
    keywords: [
      'instantiation', 'create', 'new', 'genesis', 'birth', 'origin',
      'begin', 'start', 'initialize', 'generate', 'produce', 'construct',
      'build', 'make', 'instantiate', 'emerge', 'spawn', 'introduce',
      'launch', 'found', 'establish', 'invent', 'pioneer', 'first',
      'prototype', 'original', 'novel', 'fresh', 'inception',
    ],
  },
  SEG: {
    code: 'SEG', symbol: '\uFF5C', color: '#c084fc',
    keywords: [
      'segmentation', 'divide', 'partition', 'separate', 'boundary',
      'section', 'segment', 'split', 'decompose', 'analyze', 'part',
      'component', 'module', 'fragment', 'chunk', 'slice', 'layer',
      'hierarchy', 'structure', 'organize', 'breakdown', 'dissect',
      'differentiate', 'distinguish', 'isolate', 'granular', 'discrete',
      'categorical', 'classification',
    ],
  },
  CON: {
    code: 'CON', symbol: '\u22C8', color: '#34d399',
    keywords: [
      'connection', 'link', 'relation', 'network', 'graph', 'bridge',
      'join', 'connect', 'associate', 'bind', 'couple', 'attach',
      'integrate', 'interface', 'communicate', 'interact', 'reference',
      'navigate', 'route', 'path', 'traverse', 'map', 'dependency',
      'relationship', 'correlation', 'association', 'between', 'together',
      'mutual', 'exchange',
    ],
  },
  SYN: {
    code: 'SYN', symbol: '\u2228', color: '#818cf8',
    keywords: [
      'synthesis', 'combine', 'merge', 'unify', 'integrate', 'compose',
      'synthesize', 'fusion', 'blend', 'harmonize', 'converge', 'resolve',
      'reconcile', 'consolidate', 'aggregate', 'holistic', 'whole',
      'comprehensive', 'synergy', 'emergent', 'transcend', 'unified',
      'consensus', 'conclude', 'summary', 'overview', 'framework',
      'theory', 'model', 'paradigm',
    ],
  },
  ALT: {
    code: 'ALT', symbol: '\u223F', color: '#fbbf24',
    keywords: [
      'alternation', 'change', 'modify', 'transform', 'alter', 'vary',
      'mutate', 'shift', 'evolve', 'adapt', 'update', 'revise',
      'oscillate', 'alternate', 'switch', 'toggle', 'cycle', 'wave',
      'fluctuate', 'iterate', 'version', 'variation', 'different',
      'dynamic', 'transition', 'flux', 'mutable', 'edit', 'patch',
      'migration',
    ],
  },
  SUP: {
    code: 'SUP', symbol: '\u2225', color: '#f472b6',
    keywords: [
      'superposition', 'parallel', 'simultaneous', 'concurrent', 'overlay',
      'coexist', 'multiple', 'ambiguity', 'quantum', 'probabilistic',
      'potential', 'possibility', 'spectrum', 'both', 'duality',
      'superpose', 'stack', 'overlap', 'conflict', 'tension',
      'paradox', 'contradiction', 'pluralism', 'multiplicity',
      'multivalent', 'polysemy', 'indeterminate', 'uncertain',
    ],
  },
  REC: {
    code: 'REC', symbol: '\u27F3', color: '#fb923c',
    keywords: [
      'recursion', 'recursive', 'self-reference', 'loop', 'fractal',
      'feedback', 'iteration', 'repeat', 'cycle', 'recurrence', 'spiral',
      'meta', 'self-similar', 'nested', 'embed', 'reflect', 'mirror',
      'autopoiesis', 'bootstrap', 'reentry', 'strange-loop', 'hofstadter',
      'godel', 'self-organize', 'emergence', 'complex',
      'recombine', 'derive', 'projection',
    ],
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Stopwords
// ──────────────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'because', 'but', 'and', 'or', 'if', 'while', 'about',
  'this', 'that', 'these', 'those', 'it', 'its', 'i', 'we', 'they',
  'them', 'their', 'what', 'which', 'who', 'whom',
]);

// ──────────────────────────────────────────────────────────────────────────────
// Text processing
// ──────────────────────────────────────────────────────────────────────────────

/** Strip HTML tags and markdown formatting to plain text. */
function stripMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')                    // HTML tags
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')       // markdown images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')     // markdown links (keep text)
    .replace(/[#*_~`>|]/g, ' ')                  // markdown formatting chars
    .replace(/```[\s\S]*?```/g, ' ')             // fenced code blocks
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokenize text into lowercase terms, filtering stopwords. */
function tokenize(text: string): string[] {
  return stripMarkup(text)
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** Build term frequency map: term → count / totalTerms */
function termFrequency(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokens) {
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const total = tokens.length || 1;
  const tf = new Map<string, number>();
  for (const [term, count] of counts) {
    tf.set(term, count / total);
  }
  return tf;
}

// ──────────────────────────────────────────────────────────────────────────────
// Text extraction
// ──────────────────────────────────────────────────────────────────────────────

/** Extract full text from a projected content item for classification. */
export function extractFullText(proj: ProjectedContent): string {
  const parts: string[] = [];

  // Title (included twice for ~2x weight)
  parts.push(proj.meta.title);
  parts.push(proj.meta.title);

  // Tags
  for (const tag of proj.meta.tags) {
    parts.push(tag);
  }

  // Body text by content type
  if (proj.content_type === 'wiki' || proj.content_type === 'blog') {
    const typed = proj as ProjectedWiki | ProjectedBlog;
    if (typed.current_revision) {
      parts.push(typed.current_revision.content);
    }
  } else if (proj.content_type === 'page') {
    const typed = proj as ProjectedPage;
    for (const block of typed.blocks) {
      if (block.deleted) continue;
      if (
        block.block_type === 'text' ||
        block.block_type === 'heading' ||
        block.block_type === 'callout' ||
        block.block_type === 'quote'
      ) {
        parts.push(String(block.data.md ?? block.data.text ?? ''));
      }
    }
  } else if (proj.content_type === 'experiment') {
    const typed = proj as ProjectedExperiment;
    if (typed.current_revision) {
      parts.push(typed.current_revision.content);
    }
    for (const entry of typed.entries) {
      if (entry.deleted) continue;
      if (entry.data.text) parts.push(String(entry.data.text));
      if (entry.data.title) parts.push(String(entry.data.title));
    }
  }

  return parts.join(' ');
}

// ──────────────────────────────────────────────────────────────────────────────
// Classification
// ──────────────────────────────────────────────────────────────────────────────

export interface OperatorClassification {
  op_code: string;
  op_symbol: string;
  op_color: string;
  score: number;
}

/**
 * Classify a corpus of content items by their primary EO operator.
 *
 * Uses TF-IDF scoring: for each document, scores are computed against
 * each operator's keyword profile, and the highest-scoring operator wins.
 *
 * @returns Map from content_id to OperatorClassification
 */
export function classifyAll(
  items: Array<{ id: string; text: string }>,
): Map<string, OperatorClassification> {
  // 1. Tokenize all documents
  const docTokens = items.map((item) => ({
    id: item.id,
    tokens: tokenize(item.text),
  }));

  // 2. Build document frequency (how many docs contain each term)
  const df = new Map<string, number>();
  for (const doc of docTokens) {
    const seen = new Set(doc.tokens);
    for (const term of seen) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const N = docTokens.length || 1;

  // 3. For each document, compute TF-IDF score for each operator
  const results = new Map<string, OperatorClassification>();
  const defaultOp = OPERATOR_PROFILES['DES'];

  for (const doc of docTokens) {
    const tf = termFrequency(doc.tokens);
    let bestOp = defaultOp;
    let bestScore = 0;

    for (const op of Object.values(OPERATOR_PROFILES)) {
      let score = 0;
      for (const keyword of op.keywords) {
        // Handle multi-word keywords (split into tokens)
        const kwTokens = keyword.toLowerCase().split(/[^a-z0-9-]+/);
        for (const kwt of kwTokens) {
          const tfVal = tf.get(kwt) ?? 0;
          if (tfVal === 0) continue;
          const dfVal = df.get(kwt) ?? 0;
          const idf = Math.log(N / (1 + dfVal));
          score += tfVal * idf;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestOp = op;
      }
    }

    results.set(doc.id, {
      op_code: bestOp.code,
      op_symbol: bestOp.symbol,
      op_color: bestOp.color,
      score: bestScore,
    });
  }

  return results;
}
