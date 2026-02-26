/**
 * constants.ts — Shared constants for operator data and special pages.
 */

export interface OperatorDef {
  num: number;
  symbol: string;
  code: string;
  greek: string;
  label: string;
  color: string;
  slug: string;
}

export const OPERATORS: OperatorDef[] = [
  { num: 1, symbol: '\u2205', code: 'NUL', greek: '\u03BD', label: 'Absence & Nullity', color: '#9ca3af', slug: 'nul' },
  { num: 2, symbol: '\u22A1', code: 'DES', greek: '\u03B4', label: 'Designation', color: '#60a5fa', slug: 'des' },
  { num: 3, symbol: '\u25B3', code: 'INS', greek: '\u03B9', label: 'Instantiation', color: '#4ade80', slug: 'ins' },
  { num: 4, symbol: '\uFF5C', code: 'SEG', greek: '\u03C3', label: 'Segmentation', color: '#c084fc', slug: 'seg' },
  { num: 5, symbol: '\u22C8', code: 'CON', greek: '\u03BA', label: 'Connection', color: '#34d399', slug: 'con' },
  { num: 6, symbol: '\u2228', code: 'SYN', greek: '\u03C8', label: 'Synthesis', color: '#818cf8', slug: 'syn' },
  { num: 7, symbol: '\u223F', code: 'ALT', greek: '\u03B4', label: 'Alternation', color: '#fbbf24', slug: 'alt' },
  { num: 8, symbol: '\u2225', code: 'SUP', greek: '\u03C6', label: 'Superposition', color: '#f472b6', slug: 'sup' },
  { num: 9, symbol: '\u27F3', code: 'REC', greek: '\u03C1', label: 'Recursion', color: '#fb923c', slug: 'rec' },
];

export interface SpecialPageDef {
  content_id: string;
  content_type: 'page' | 'wiki';
  slug: string;
  title: string;
  symbol?: string;
  color?: string;
  code?: string;
}

export const SPECIAL_PAGES: SpecialPageDef[] = [
  { content_id: 'page:home', content_type: 'page', slug: 'home', title: 'Homepage', symbol: '\u2302', color: '#60a5fa' },
  ...OPERATORS.map((op): SpecialPageDef => ({
    content_id: `wiki:${op.slug}`,
    content_type: 'wiki',
    slug: op.slug,
    title: `${op.code} \u2014 ${op.label}`,
    symbol: op.symbol,
    color: op.color,
    code: op.code,
  })),
];
