#!/usr/bin/env node
/**
 * Generate batch-edits.json from the March 9 2026 patch list.
 *
 * Outputs a JSON array of { type: "edit", record_id, find, replace } objects
 * ready to paste into the BatchPost tool.
 *
 * NOTE: Global URL patterns use the most likely link format. The Validate &
 * Preview step in BatchPost will show 0 matches if the format doesn't match
 * the stored content. Adjust the FIND strings based on actual content format
 * (HTML <a> tags vs markdown [text](url)).
 */

// ── Record ID mapping ─────────────────────────────────────────────────────
// Article Name → record_id (best guesses — verify with Validate & Preview)
const RECORDS = {
  'Main page':            'wiki:emergent-ontology',
  'Influences':           'wiki:influences',
  'Triadic Minimum':      'wiki:triadic-minimum',
  'Three Triads':         'wiki:three-triads',
  'Ground/Figure/Pattern':'wiki:ground-figure-pattern',
  'Nine Operators':       'wiki:operators',
  'Integral Theory':      'wiki:integral-theory',
  'EO Notation':          'wiki:eo-notation',
  'SIG Inflation':        'wiki:sig-inflation',
  'Phase Space Cube':     'wiki:phase-space-cube',
  '27 Phaseposts':        'wiki:phaseposts',
  'EO Event Streaming':   'wiki:eo-event-streaming',
  'NUL':                  'wiki:nul',
  'Operator Naming':      'wiki:operator-naming',
  'Bivalent Compression': 'wiki:bivalent-compression',
  'REC':                  'wiki:rec',
  'Handbook':             'wiki:handbook',
};

const ALL_RECORD_IDS = Object.values(RECORDS);

// ── Helper ────────────────────────────────────────────────────────────────
function edit(article, find, replace) {
  const rid = RECORDS[article];
  if (!rid) throw new Error(`Unknown article: ${article}`);
  return { type: 'edit', record_id: rid, find, replace };
}

function globalEdit(find, replace) {
  return ALL_RECORD_IDS.map(rid => ({ type: 'edit', record_id: rid, find, replace }));
}

// ── Build edits array ─────────────────────────────────────────────────────
const edits = [];

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 1: See Also block replacements (010, 036, 055) — MUST go first
// These replace entire blocks including links, before global URL stripping.
// NOTE: These assume markdown link format. If content is HTML, adjust.
// ═══════════════════════════════════════════════════════════════════════════

// PATCH 010 — Influences See Also
// NOTE: The exact link format in stored content may differ. If 0 matches,
// the user should check the actual content format and adjust.
edits.push(edit('Influences',
  '- The Formal Proof\n- Cross-Linguistic Findings',
  '- The Dependency Argument\n- Cross-Linguistic Findings'
));

// PATCH 036 — Integral Theory See Also
// Only the text change matters here (links handled by globals)
// This is a no-op for URL removal since globals handle the links.
// Skipped — the global URL patterns will handle link removal in this section.

// PATCH 055 — Operator Naming See Also
edits.push(edit('Operator Naming',
  '[The Nine Operators] — full specifications, formal mappings, biological grounding\n- [The Three Faces] — Act, Resolution, and Site projections of the 27-cell cube\n- [The 27 Phaseposts] — complete phase-space addressing with phenomenological names\n- [Notation Systems] — practitioner glyphs, Greek letters, three-face notation\n- [Cross-Linguistic Findings] — 27-language verb classification, population data, universal patterns',
  'The Nine Operators — full specifications, formal mappings, biological grounding\n- The Three Faces — Act, Resolution, and Site projections of the 27-cell cube\n- The 27 Phaseposts — complete phase-space addressing with phenomenological names\n- Notation Systems — practitioner glyphs, Greek letters, three-face notation\n- Cross-Linguistic Findings — 27-language verb classification, population data, universal patterns'
));

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2: Global URL patterns — strip dead internal links
// NOTE: These use TWO variants per pattern to handle both possible formats:
//   1. Markdown: [text](/wiki/slug)
//   2. HTML: <a href="/wiki/slug">text</a>
//   3. HTML with data attr: <a href="/wiki/slug" data-content-id="wiki:slug">text</a>
// Only matching variants will be applied (0-match ones are skipped).
// ═══════════════════════════════════════════════════════════════════════════

const urlPatterns = [
  // [linkText, slug, replaceText]
  ['NUL', 'nul', 'NUL'],
  ['SUP', 'sup', 'SUP'],
  ['REC', 'rec', 'REC'],
  ['CON', 'con', 'CON'],
  ['SEG', 'seg', 'SEG'],
  ['helix', 'helix', 'helix'],
  ['operators', 'operators', 'operators'],
  ['phaseposts', 'phaseposts', 'phaseposts'],
  ['main page', 'main', 'Emergent Ontology main page'],
  ['fractal self-similarity', 'fractal-self-similarity', 'fractal self-similarity'],
  ['ground/figure/pattern', 'ground-figure-pattern', 'ground/figure/pattern'],
  ['degraded historically', 'degraded-historically', 'degraded historically'],
  ['phenomenal address', 'phenomenal-address', 'phenomenal address'],
  ['Experience Engine', 'experience-engine', 'Experience Engine'],
  ['EO and Integral Theory', 'integral-theory', 'EO and Integral Theory'],
  ['Global Cross-Cultural Crosswalk', 'global-cross-cultural-crosswalk', 'Global Cross-Cultural Crosswalk'],
  ['Existence, Structure, Interpretation', 'existence-structure-interpretation', 'Existence, Structure, Interpretation'],
  ['EO Notation §7', 'eo-notation', 'EO Notation §7'],
  ['EO Notation §8', 'eo-notation', 'EO Notation §8'],
  ['EO Notation §9', 'eo-notation', 'EO Notation §9'],
];

// Links are stored as HTML <a> tags (per InternalLink.ts).
// Include both with and without data-content-id since older links may lack it.
for (const [text, slug, replace] of urlPatterns) {
  edits.push(...globalEdit(`<a href="/wiki/${slug}">${text}</a>`, replace));
  edits.push(...globalEdit(`<a href="/wiki/${slug}" data-content-id="wiki:${slug}">${text}</a>`, replace));
}

// Patches 017, 018 — unique URL patterns in Integral Theory
edits.push(edit('Integral Theory', '<a href="/wiki/emergent-ontology">Emergent Ontology (EO)</a>', 'Emergent Ontology (EO)'));
edits.push(edit('Integral Theory', '<a href="/wiki/emergent-ontology" data-content-id="wiki:emergent-ontology">Emergent Ontology (EO)</a>', 'Emergent Ontology (EO)'));

edits.push(edit('Integral Theory', '(see <a href="/wiki/main">main page</a> for detail)', '(see Emergent Ontology main page for detail)'));
edits.push(edit('Integral Theory', '(see <a href="/wiki/emergent-ontology">main page</a> for detail)', '(see Emergent Ontology main page for detail)'));

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 3: Individual patches — language softening + numerical fixes
// These are all plain text, format-independent.
// ═══════════════════════════════════════════════════════════════════════════

// PATCH 001 [L] — Main page
edits.push(edit('Main page',
  'Its formal proof, coauthored with the AI system Claude (Anthropic), demonstrates a unique non-degenerate ordering of nine transformation operators using Codd\'s relational algebra as a mathematical witness.',
  'Its dependency argument, co-developed with the AI system Claude (Anthropic), derives a unique non-degenerate ordering of nine transformation operators using Codd\'s relational algebra as a mathematical witness.'
));

// PATCH 002 [L] — Main page
edits.push(edit('Main page',
  'The helix ordering was proven unique by exhaustive computational verification: of the 1,296 possible orderings of nine operators, 1,295 fail non-degeneracy criteria derived from Codd\'s relational algebra. Only one survives.',
  'The helix ordering was derived by exhaustive computational verification: of the 1,296 possible orderings of nine operators, 1,295 fail non-degeneracy criteria from Codd\'s relational algebra. Only one survives.'
));

// PATCH 003 [L] — Main page
edits.push(edit('Main page',
  'the one with a proven unique ordering.',
  'the one with an established dependency ordering.'
));

// PATCH 004 [L] — Main page (section heading)
edits.push(edit('Main page',
  'Formal proof',
  'Dependency argument'
));

edits.push(edit('Main page',
  'The proof that the helix ordering NUL',
  'The argument that the helix ordering NUL'
));

// PATCH 005 [L] — Main page
edits.push(edit('Main page',
  '2. Dependency proof: Intra-triad dependencies are proven within each axis',
  '2. Dependency argument: Intra-triad dependencies are established within each axis'
));

// PATCH 006 [L] — Main page
edits.push(edit('Main page',
  'Inter-triad dependencies are proven across axes',
  'Inter-triad dependencies are established across axes'
));

// PATCH 007 [L] — Main page
edits.push(edit('Main page',
  'A revised version of the proof (v2',
  'A revised version of the argument (v2'
));

// PATCH 008 [L] — Main page
edits.push(edit('Main page',
  'the formal proof uses relational algebra rather than categorical language',
  'the dependency argument uses relational algebra rather than categorical language'
));

// PATCH 009 [L] — Influences
edits.push(edit('Influences',
  'EO proposes a transformation algebra with formal constraints and computational verification).',
  'EO proposes a transformation algebra with structural constraints and computational verification).'
));

// PATCH 011 [L+N] — Triadic Minimum
edits.push(edit('Triadic Minimum',
  '10.4 The Proof',
  '10.4 The Dependency Argument'
));
edits.push(edit('Triadic Minimum',
  'The formal proof of EO\'s operator ordering tests all 1,296 structurally admissible orderings',
  'The dependency argument for EO\'s operator ordering tests all 1,296 structurally admissible orderings'
));
edits.push(edit('Triadic Minimum',
  'eliminating the remaining 107 candidates.',
  'eliminating the remaining 108 candidates.'
));

// PATCH 012 [L] — Triadic Minimum
edits.push(edit('Triadic Minimum',
  'EO\'s formal derivation of the 3×3×3 phase space, the dependency helix, and the exhaustive computational proof against Codd\'s closure criterion has not undergone external peer review.',
  'EO\'s derivation of the 3×3×3 phase space, the dependency helix, and the exhaustive computational argument against Codd\'s closure criterion has not undergone external peer review.'
));

// PATCH 013 [L] — Three Triads
edits.push(edit('Three Triads',
  'In the formal proof, this is supported computationally',
  'In the dependency argument, this is supported computationally'
));

// PATCH 014 [L] — Ground/Figure/Pattern
edits.push(edit('Ground/Figure/Pattern',
  'In the formal proof, co-constitution is supported computationally',
  'In the dependency argument, co-constitution is supported computationally'
));

// PATCH 015 [L] — Nine Operators
edits.push(edit('Nine Operators',
  'The helix ordering is the subject of a formal proof using relational calculus and computational verification; this proof has not been peer-reviewed.',
  'The helix ordering is the subject of a dependency argument using relational calculus and computational verification; this argument has not been peer-reviewed.'
));

// PATCH 016 [L] — Nine Operators See Also
edits.push(edit('Nine Operators',
  'Formal Proof — the relational calculus argument',
  'Dependency Argument — the relational calculus derivation'
));

// PATCH 019 [L] — Integral Theory
edits.push(edit('Integral Theory',
  'EO is built from combinatorial structure and formal proof — nine operators derived from a 3×3 lattice, with their dependency ordering verified by relational calculus and exhaustive computation. Its evidence is structural: the same ordering emerges from three independent lines of argument (formal proof, computational verification, and relational algebra).',
  'EO is built from combinatorial structure and structural derivation — nine operators derived from a 3×3 lattice, with their dependency ordering supported by relational calculus and exhaustive computation. Its evidence is structural: a computational argument using relational algebra as the formal witness.'
));

// PATCH 020 [L] — Integral Theory
edits.push(edit('Integral Theory',
  'EO proposes a transformation algebra with formal constraints and computational verification. Gebser\'s evidence is cultural-historical (art, architecture, language, myth). EO\'s evidence is formal and computational (relational calculus, functional dependency closure, operator decomposition).',
  'EO proposes a transformation algebra with structural constraints and computational verification. Gebser\'s evidence is cultural-historical (art, architecture, language, myth). EO\'s evidence is computational (relational calculus, functional dependency closure, operator decomposition).'
));

// PATCH 022 [L] — Integral Theory
edits.push(edit('Integral Theory',
  'Formal proof, computational verification, relational algebra',
  'Structural derivation, computational verification, relational algebra'
));

// PATCH 037 [L] — EO Notation
edits.push(edit('EO Notation',
  'Greek symbols in formal proofs and algebraic contexts.',
  'Greek symbols in algebraic and formal contexts.'
));

// PATCH 038 [L] — SIG Inflation
edits.push(edit('SIG Inflation',
  'This face has a proven necessary sequence: a computational proof tested all 1,296 possible orderings against Codd\'s functional dependency closure criterion, and only one ordering survives.',
  'This face has an established dependency sequence: a computational argument tested all 1,296 possible orderings against Codd\'s functional dependency closure criterion, and only one ordering survives.'
));

// PATCH 039 [L] — SIG Inflation
edits.push(edit('SIG Inflation',
  'there is no proven single valid path through all nine positions',
  'there is no established single valid path through all nine positions'
));

// PATCH 040 [L] — Phase Space Cube
edits.push(edit('Phase Space Cube',
  'The nine operators have a proven canonical ordering:',
  'The nine operators have an established canonical ordering:'
));

// PATCH 041 [N] — 27 Phaseposts
edits.push(edit('27 Phaseposts',
  'SYN × Ground has zero English verbs — no language has adequate vocabulary for synthesizing an ambient condition.',
  'SYN × Ground has zero English verbs and is nearly empty across all languages tested (19 verbs total, empty in 19 of 27 languages).'
));

// PATCH 042 [L] — EO Event Streaming See Also
edits.push(edit('EO Event Streaming',
  'EO Formal Proof (Dependency Helix) — Mathematical and computational derivation of the helix ordering',
  'EO Dependency Argument (Helix Ordering) — Structural derivation of the helix ordering'
));

// PATCH 043 [L] — NUL
edits.push(edit('NUL',
  'The formal proof maps NUL to',
  'The dependency argument maps NUL to'
));

// PATCH 044 [N] — NUL
edits.push(edit('NUL',
  'Verb count (English)',
  'Verb count (cross-linguistic)'
));

// PATCH 045 [N] — NUL
edits.push(edit('NUL',
  'NUL × Figure (1,873 verbs) dwarfs NUL × Ground (311) and NUL × Pattern (24).',
  'NUL × Figure (1,873 verbs across all languages) dwarfs NUL × Ground (311) and NUL × Pattern (24).'
));

// PATCH 046 [N] — NUL
edits.push(edit('NUL',
  'NUL\'s three Object cells vary dramatically in population. NUL × Figure (1,873 verbs in English) is among the most populated cells in the entire phase space. NUL × Ground (311 verbs) is moderately populated. NUL × Pattern (24 verbs, empty in 15 of 27 languages) is nearly deserted.',
  'NUL\'s three Object cells vary dramatically in population. NUL × Figure (1,873 verbs across all languages) is among the most populated cells in the entire phase space. NUL × Ground (311 verbs) is moderately populated. NUL × Pattern (24 verbs, empty in 15 of 27 languages) is nearly deserted.'
));

// PATCH 047 [L] — Operator Naming
edits.push(edit('Operator Naming',
  'Greek letters (ν, θ, α, etc.). Each system was developed for a different context — abbreviations for prose and documentation, glyphs for practitioner notation and data lineage, Greek letters for formal proofs and algebraic composition.',
  'Greek letters (ν, θ, α, etc.). Each system was developed for a different context — abbreviations for prose and documentation, glyphs for practitioner notation and data lineage, Greek letters for algebraic composition and formal work.'
));

// PATCH 048 [L] — Operator Naming
edits.push(edit('Operator Naming',
  'second in the proven dependency helix',
  'second in the dependency helix'
));

// PATCH 049 [L] — Operator Naming
edits.push(edit('Operator Naming',
  'The formal proof of the helix\'s unique ordering mapped SIG to DDL expressions',
  'The dependency argument for the helix ordering mapped SIG to DDL expressions'
));

// PATCH 050 [L] — Operator Naming
edits.push(edit('Operator Naming',
  'The proof\'s formal definition (Definition 2.2)',
  'The argument\'s formal definition (Definition 2.2)'
));

// PATCH 051 [L] — Operator Naming
edits.push(edit('Operator Naming',
  'is proven unique by exhaustive computational verification across all 1,296 admissible orderings.',
  'is established by exhaustive computational verification across all 1,296 admissible orderings.'
));

// PATCH 052 [L] — Operator Naming
edits.push(edit('Operator Naming',
  'was developed for formal proofs, algebraic composition, and contexts',
  'was developed for algebraic composition, formal work, and contexts'
));

// PATCH 053 [L] — Operator Naming
edits.push(edit('Operator Naming',
  'after the formal proof has been completed',
  'after the dependency argument has been completed'
));

// PATCH 054 [L] — Operator Naming
edits.push(edit('Operator Naming',
  'then a lexical re-analysis under SIG\'s semantic context should produce',
  'then a reclassification under SIG\'s semantic context should produce'
));

// PATCH 056 [N] — Bivalent Compression
edits.push(edit('Bivalent Compression',
  'The empty cell at SYN × Ground contains zero verbs across all languages in the corpus. No attested human language has a verb meaning "synthesize a condition." This absence is treated as data, not sampling artifact.',
  'The empty cell at SYN × Ground contains zero verbs in English and is empty in 19 of 27 tested languages (19 verbs total across all languages). No attested human language has robust vocabulary for "synthesizing a condition." This absence is treated as data, not sampling artifact.'
));

// PATCH 057 [L] — REC
edits.push(edit('REC',
  'The formal proof of the helix ordering maps REC to',
  'The dependency argument for the helix ordering maps REC to'
));

// PATCH 058 [L] — Handbook
edits.push(edit('Handbook',
  'This closure has been proven formally by exhaustive computational verification against Codd\'s relational algebra.',
  'This closure is supported by exhaustive computational verification against Codd\'s relational algebra.'
));

// PATCH 059 [L] — Handbook
edits.push(edit('Handbook',
  'For formal proofs, algebraic work, and contexts',
  'For algebraic work, formal derivations, and contexts'
));

// PATCH 060 [L] — Handbook
edits.push(edit('Handbook',
  'Formal proofs, algebra',
  'Algebra, formal derivations'
));

// PATCH 061 [L] — Handbook
edits.push(edit('Handbook',
  'This is EO\'s most developed face — the one with a proven unique ordering.',
  'This is EO\'s most developed face — the one with an established dependency ordering.'
));

// PATCH 062 [L] — Handbook
edits.push(edit('Handbook',
  'The helix ordering was proven unique by exhaustive computational verification: of the 1,296 possible orderings of nine operators (constrained to maintain intra-triad sequence), 1,295 fail non-degeneracy criteria derived from Codd\'s relational algebra. Only one survives.',
  'The helix ordering was derived by exhaustive computational verification: of the 1,296 possible orderings of nine operators (constrained to maintain intra-triad sequence), 1,295 fail non-degeneracy criteria from Codd\'s relational algebra. Only one survives.'
));

// PATCH 063 [N] — Handbook
edits.push(edit('Handbook',
  'Layer 2 (formal): Intra-triad presupposition established by formal argument. Ground → Figure → Pattern within each triad. Remaining 107 candidates eliminated under the non-degeneracy criterion.',
  'Layer 2 (formal): Intra-triad presupposition established by formal argument. Ground → Figure → Pattern within each triad. Remaining 108 candidates eliminated under the non-degeneracy criterion.'
));

// PATCH 064 [L] — Handbook
edits.push(edit('Handbook',
  'Appendix E: The Formal Proof (Summary)',
  'Appendix E: The Dependency Argument (Summary)'
));
edits.push(edit('Handbook',
  'Theorem: The helix ordering NUL',
  'Claim: The helix ordering NUL'
));

// PATCH 065 [N] — Handbook
edits.push(edit('Handbook',
  'Remaining 107 candidates eliminated under non-degeneracy criterion.',
  'Remaining 108 candidates eliminated under non-degeneracy criterion.'
));

// PATCH 066 [L] — Handbook
edits.push(edit('Handbook',
  'Formal proof co-authored with Claude (Anthropic)',
  'Dependency argument co-developed with Claude (Anthropic)'
));
edits.push(edit('Handbook',
  'This document synthesizes the EO wiki, Technical Handbook, and Formal Proof into a single practical reference.',
  'This document synthesizes the EO wiki, Technical Handbook, and Dependency Argument into a single practical reference.'
));

// PATCH 067 [L] — Influences
edits.push(edit('Influences',
  'The formal proof. Exhaustive computational verification of the helix ordering against Codd\'s relational algebra.',
  'The dependency argument. Exhaustive computational verification of the helix ordering against Codd\'s relational algebra.'
));

// PATCH 083 [L] — Bivalent Compression
edits.push(edit('Bivalent Compression',
  'EO Proof v5.2 (dependency helix and co-constitutive triads)',
  'EO Dependency Argument (dependency helix and co-constitutive triads)'
));

// ── Output ────────────────────────────────────────────────────────────────
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, '..', 'batch-edits.json');
writeFileSync(outPath, JSON.stringify(edits, null, 2));
console.log(`Generated ${edits.length} edit operations → ${outPath}`);
console.log(`  - See Also blocks: 2`);
console.log(`  - Global URL patterns: ${urlPatterns.length * 2 * ALL_RECORD_IDS.length} (2 format variants × ${urlPatterns.length} patterns × ${ALL_RECORD_IDS.length} records)`);
console.log(`  - Unique URL patches: 4 (patches 017, 018 × 2 variants)`);
console.log(`  - Individual patches: ${edits.length - 2 - urlPatterns.length * 3 * ALL_RECORD_IDS.length - 6}`);
