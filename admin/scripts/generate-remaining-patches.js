#!/usr/bin/env node
/**
 * Generate batch-edits.json for the March 10, 2026 remaining patches.
 *
 * Section A: 25 global URL replacements (expanded across all records)
 * Section B: 10 individual patches (specific records)
 */

const ALL_RECORD_IDS = [
  'wiki:emergent-ontology-eo',
  'wiki:influences-and-lineage',
  'wiki:the-triadic-minimum',
  'wiki:the-three-triads',
  'wiki:ground-figure-pattern',
  'wiki:the-nine-operators',
  'wiki:the-integral-lineage',
  'wiki:eo-notation',
  'wiki:eo-on-platonic-forms',
  'wiki:the-eo-phase-space-cube',
  'wiki:the-27-phase-posts',
  'wiki:eo-event-streaming',
  'wiki:nul',
  'wiki:operator-naming-in-emergent-ontology',
  'wiki:bivalent-compression-and-dimensional-poverty',
  'wiki:rec',
  'document:eo-handbook',
];

function globalEdit(find, replace) {
  return ALL_RECORD_IDS.map(rid => ({ type: 'edit', record_id: rid, find, replace }));
}

function edit(recordId, find, replace) {
  return { type: 'edit', record_id: recordId, find, replace };
}

const edits = [];

// ═══════════════════════════════════════════════════════════════════════════
// SECTION A: Global URL replacements (apply as replace-all across all records)
// ═══════════════════════════════════════════════════════════════════════════

const globalPatterns = [
  ['[NUL](https://claude.ai/wiki/operators/nul)', 'NUL'],
  ['[SUP](https://claude.ai/wiki/operators/sup)', 'SUP'],
  ['[REC](https://claude.ai/wiki/operators/rec)', 'REC'],
  ['[CON](https://claude.ai/wiki/operators/con)', 'CON'],
  ['[SEG](https://claude.ai/wiki/operators/seg)', 'SEG'],
  ['[helix](https://claude.ai/wiki/helix)', 'helix'],
  ['[operators](https://claude.ai/wiki/operators)', 'operators'],
  ['[phaseposts](https://claude.ai/wiki/phaseposts)', 'phaseposts'],
  ['[main page](https://claude.ai/wiki/emergent-ontology)', '**Emergent Ontology** main page'],
  ['[fractal self-similarity](https://claude.ai/wiki/ground-figure-pattern)', 'fractal self-similarity'],
  ['[ground/figure/pattern](https://claude.ai/wiki/ground-figure-pattern)', 'ground/figure/pattern'],
  ['[degraded historically](https://claude.ai/wiki/operators/nul)', 'degraded historically'],
  ['[**phenomenal address**](https://claude.ai/wiki/operators/rec)', '**phenomenal address**'],
  ['[Experience Engine](https://claude.ai/wiki/experience-engines)', 'Experience Engine'],
  ['[EO and Integral Theory](https://claude.ai/wiki/integral-theory)', '**EO and Integral Theory**'],
  ['[Global Cross-Cultural Crosswalk](https://claude.ai/wiki/crosswalk)', 'Global Cross-Cultural Crosswalk'],
  ['[Existence, Structure, Interpretation](https://claude.ai/wiki/triads)', 'Existence, Structure, Interpretation'],
  ['[Emergent Ontology](https://claude.ai/wiki/emergent-ontology)', '**Emergent Ontology**'],
  ['[The Formal Proof](https://claude.ai/wiki/proof)', '**The Dependency Argument**'],
  ['[The Nine Operators](https://claude.ai/wiki/operators)', '**The Nine Operators**'],
  ['[The Helix](https://claude.ai/wiki/helix)', '**The Helix**'],
  ['[Cross-Linguistic Findings](https://claude.ai/wiki/cross-linguistic-findings)', '**Cross-Linguistic Findings**'],
  ['[Experience Engines](https://claude.ai/wiki/experience-engines)', '**Experience Engines**'],
  ['[Influences and Lineage](https://claude.ai/wiki/influences)', '**Influences and Lineage**'],
  ['[Ground / Figure / Pattern](https://claude.ai/wiki/ground-figure-pattern)', '**Ground / Figure / Pattern**'],
];

for (const [find, replace] of globalPatterns) {
  edits.push(...globalEdit(find, replace));
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION B: Individual patches
// ═══════════════════════════════════════════════════════════════════════════

// B-01 — Line 73 — Main page
edits.push(edit('wiki:emergent-ontology-eo',
  '**Dependency proof**: Intra-triad dependencies are proven within each axis',
  '**Dependency argument**: Intra-triad dependencies are established within each axis'
));

// B-02 — Line 421 — Three Triads
edits.push(edit('wiki:the-three-triads',
  'In the formal proof, this is supported computationally — functional dependency growth is identical regardless of the internal ordering of operators within a triad. All six permutations produce the same FD-closure.',
  'In the dependency argument, this is supported computationally — functional dependency growth is identical regardless of the internal ordering of operators within a triad. All six permutations produce the same FD-closure.'
));

// B-10 — Line 956 — Nine Operators See Also
edits.push(edit('wiki:the-nine-operators',
  '- **Formal Proof** — the relational calculus argument',
  '- **Dependency Argument** — the relational calculus derivation'
));

// B-11 — Line 1090 — Integral Theory
edits.push(edit('wiki:the-integral-lineage',
  'EO is built from combinatorial structure and formal proof — nine operators derived from a 3×3 lattice, with their dependency ordering verified by [relational calculus](https://en.wikipedia.org/wiki/Tuple_relational_calculus) and [exhaustive computation](https://en.wikipedia.org/wiki/Model_checking). Its evidence is structural: the same ordering emerges from three independent lines of argument (formal proof, computational verification, and relational algebra).',
  'EO is built from combinatorial structure and structural derivation — nine operators derived from a 3×3 lattice, with their dependency ordering supported by [relational calculus](https://en.wikipedia.org/wiki/Tuple_relational_calculus) and [exhaustive computation](https://en.wikipedia.org/wiki/Model_checking). Its evidence is structural: a computational argument using relational algebra as the formal witness.'
));

// B-12 — Line 1386 — Influences
edits.push(edit('wiki:influences-and-lineage',
  '- **The formal proof.** Exhaustive computational verification of the helix ordering against Codd\'s relational algebra.',
  '- **The dependency argument.** Exhaustive computational verification of the helix ordering against Codd\'s relational algebra.'
));

// B-13 — Line 3289 — Event Streaming See Also
edits.push(edit('wiki:eo-event-streaming',
  '- **EO Formal Proof (Dependency Helix)** — Mathematical and computational derivation of the helix ordering',
  '- **EO Dependency Argument (Helix Ordering)** — Structural derivation of the helix ordering'
));

// B-14 — Line 3710 — Bivalent Compression
edits.push(edit('wiki:bivalent-compression-and-dimensional-poverty',
  '- **The empty cell at SYN × Ground** contains zero verbs across all languages in the corpus. No attested human language has a verb meaning "synthesize a condition." This absence is treated as data, not sampling artifact.',
  '- **The empty cell at SYN × Ground** contains zero verbs in English and is empty in 19 of 27 tested languages (19 verbs total across all languages). No attested human language has robust vocabulary for "synthesizing a condition." This absence is treated as data, not sampling artifact.'
));

// B-15 — Line 3691 — Operator Naming See Also
edits.push(edit('wiki:operator-naming-in-emergent-ontology',
  '---## See Also- [**[The Nine Operators]**](/wiki/the-nine-operators) — full specifications, formal mappings, biological grounding- [**[The Three Faces]**](/wiki/the-three-faces-of-emergent-ontology) — Act, Resolution, and Site projections of the 27-cell cube- [**[The 27 Phaseposts]**](/wiki/the-27-phase-posts) — complete phase-space addressing with phenomenological names- **[Notation Systems]** — practitioner glyphs, Greek letters, three-face notation- **[Cross-Linguistic Findings]** — 27-language verb classification, population data, universal patterns',
  '---## See Also- **The Nine Operators** — full specifications, formal mappings, biological grounding- **The Three Faces** — Act, Resolution, and Site projections of the 27-cell cube- **The 27 Phaseposts** — complete phase-space addressing with phenomenological names- **Notation Systems** — practitioner glyphs, Greek letters, three-face notation- **Cross-Linguistic Findings** — 27-language verb classification, population data, universal patterns'
));

// B-16 — Line 4552 — Handbook
edits.push(edit('document:eo-handbook',
  'Everything in this manual is available in more detail across the EO wiki, the Technical Handbook, and the Formal Proof. This document synthesizes them into a single usable reference.',
  'Everything in this manual is available in more detail across the EO wiki, the Technical Handbook, and the Dependency Argument. This document synthesizes them into a single usable reference.'
));

// B-17 — Line 4998 — Handbook
edits.push(edit('document:eo-handbook',
  'Remaining 107 candidates eliminated under the non-degeneracy criterion.',
  'Remaining 108 candidates eliminated under the non-degeneracy criterion.'
));

// ── Output ──────────────────────────────────────────────────────────────
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, '..', 'batch-edits.json');
writeFileSync(outPath, JSON.stringify(edits, null, 2));
console.log(`Generated ${edits.length} edit operations → ${outPath}`);
console.log(`  - Section A globals: ${globalPatterns.length} patterns × ${ALL_RECORD_IDS.length} records = ${globalPatterns.length * ALL_RECORD_IDS.length}`);
console.log(`  - Section B individual: 10`);
