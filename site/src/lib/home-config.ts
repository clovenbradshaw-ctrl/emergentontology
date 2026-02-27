/**
 * home-config.ts — Load homepage configuration from /home.yaml
 *
 * Reads the standalone home.yaml doc at the repo root and returns
 * typed configuration for the homepage hero, operators, and sections.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';

// ── Types ────────────────────────────────────────────────────────────

export interface HeroConfig {
  badge: string;
  title: string;
  subtitle: string;
}

export interface OperatorConfig {
  num: number;
  symbol: string;
  code: string;
  greek: string;
  label: string;
  color: string;
  slug: string;
}

export interface SectionConfig {
  enabled: boolean;
  max_items?: number;
  layout?: 'grid' | 'list';
}

export interface HomeConfig {
  hero: HeroConfig;
  operators: OperatorConfig[];
  sections: {
    wiki: SectionConfig;
    blog: SectionConfig;
    experiments: SectionConfig;
    pages: SectionConfig;
    tags: SectionConfig;
  };
}

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULTS: HomeConfig = {
  hero: {
    badge: 'Emergent Ontology',
    title: 'A framework for everything that changes',
    subtitle:
      'Nine operators, infinite composability. A minimal, universal language for data transformation, knowledge curation, and structured thought.',
  },
  operators: [
    { num: 1, symbol: '∅', code: 'NUL', greek: 'ν', label: 'Absence & Nullity', color: '#9ca3af', slug: 'nul' },
    { num: 2, symbol: '⊡', code: 'DES', greek: 'δ', label: 'Designation', color: '#60a5fa', slug: 'des' },
    { num: 3, symbol: '△', code: 'INS', greek: 'ι', label: 'Instantiation', color: '#4ade80', slug: 'ins' },
    { num: 4, symbol: '｜', code: 'SEG', greek: 'σ', label: 'Segmentation', color: '#c084fc', slug: 'seg' },
    { num: 5, symbol: '⋈', code: 'CON', greek: 'κ', label: 'Connection', color: '#34d399', slug: 'con' },
    { num: 6, symbol: '∨', code: 'SYN', greek: 'ψ', label: 'Synthesis', color: '#818cf8', slug: 'syn' },
    { num: 7, symbol: '∿', code: 'ALT', greek: 'δ', label: 'Alternation', color: '#fbbf24', slug: 'alt' },
    { num: 8, symbol: '∥', code: 'SUP', greek: 'φ', label: 'Superposition', color: '#f472b6', slug: 'sup' },
    { num: 9, symbol: '⟳', code: 'REC', greek: 'ρ', label: 'Recursion', color: '#fb923c', slug: 'rec' },
  ],
  sections: {
    wiki: { enabled: true, max_items: 6, layout: 'grid' },
    blog: { enabled: true, max_items: 5, layout: 'list' },
    experiments: { enabled: true, max_items: 4, layout: 'grid' },
    pages: { enabled: true, layout: 'list' },
    tags: { enabled: true },
  },
};

// ── Loader ───────────────────────────────────────────────────────────

let _cached: HomeConfig | null = null;

export function loadHomeConfig(): HomeConfig {
  if (_cached) return _cached;

  // home.yaml lives at the repo root, one level above site/
  const yamlPath = join(process.cwd(), '..', 'home.yaml');

  try {
    const raw = readFileSync(yamlPath, 'utf-8');
    const parsed = yaml.load(raw) as Partial<HomeConfig> | null;
    if (!parsed) {
      _cached = DEFAULTS;
      return _cached;
    }

    _cached = {
      hero: { ...DEFAULTS.hero, ...parsed.hero },
      operators: parsed.operators ?? DEFAULTS.operators,
      sections: {
        wiki: { ...DEFAULTS.sections.wiki, ...parsed.sections?.wiki },
        blog: { ...DEFAULTS.sections.blog, ...parsed.sections?.blog },
        experiments: { ...DEFAULTS.sections.experiments, ...parsed.sections?.experiments },
        pages: { ...DEFAULTS.sections.pages, ...parsed.sections?.pages },
        tags: { ...DEFAULTS.sections.tags, ...parsed.sections?.tags },
      },
    };
    return _cached;
  } catch {
    // If home.yaml doesn't exist or can't be parsed, use defaults
    _cached = DEFAULTS;
    return _cached;
  }
}
