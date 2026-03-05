/**
 * smartDiff — character-level diff with semantic cleanup.
 *
 * Uses Google's diff-match-patch under the hood.  The key step is
 * `diff_cleanupSemantic()` which shifts edit boundaries to word/sentence
 * breaks so that "copy-paste the whole thing and tweak a few words" shows
 * meaningful, human-legible changes instead of a wall of red/green.
 */

import DiffMatchPatch from 'diff-match-patch';

/** Diff operation constants from diff-match-patch */
const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const DIFF_EQUAL = 0;

export type DiffOp = typeof DIFF_DELETE | typeof DIFF_INSERT | typeof DIFF_EQUAL;

/** A single span in the diff output. */
export interface DiffSpan {
  op: DiffOp;
  text: string;
}

/**
 * Compute a character-level diff between two strings, then run semantic
 * cleanup so edits align with natural word/sentence boundaries.
 *
 * Returns an array of DiffSpans where op is -1 (delete), 0 (equal), or
 * 1 (insert).
 */
export function smartDiff(oldText: string, newText: string): DiffSpan[] {
  const dmp = new DiffMatchPatch();
  const diffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupSemantic(diffs);
  return diffs.map(([op, text]) => ({ op: op as DiffOp, text }));
}

/**
 * Group a flat list of DiffSpans into logical "lines" for display.
 *
 * Each output chunk is either:
 *   - `type: 'equal'`   — context line (unchanged text)
 *   - `type: 'change'`  — one or more adjacent delete/insert spans
 *
 * Equal chunks that are far from any change are collapsed to `'···'`.
 * A context window of `contextLines` lines is kept around each change.
 */
export interface DiffChunk {
  type: 'equal' | 'change';
  /** For 'equal' chunks, the plain text. */
  text?: string;
  /** For 'change' chunks, the constituent spans. */
  spans?: DiffSpan[];
}

export function groupDiffChunks(
  spans: DiffSpan[],
  contextLines = 2,
): DiffChunk[] {
  if (spans.length === 0) return [];

  // Split into alternating runs of equal vs non-equal spans.
  const groups: DiffChunk[] = [];
  let currentEqual: string[] = [];
  let currentChange: DiffSpan[] = [];

  function flushChange() {
    if (currentChange.length > 0) {
      groups.push({ type: 'change', spans: [...currentChange] });
      currentChange = [];
    }
  }

  function flushEqual() {
    if (currentEqual.length > 0) {
      groups.push({ type: 'equal', text: currentEqual.join('') });
      currentEqual = [];
    }
  }

  for (const span of spans) {
    if (span.op === DIFF_EQUAL) {
      flushChange();
      currentEqual.push(span.text);
    } else {
      flushEqual();
      currentChange.push(span);
    }
  }
  flushChange();
  flushEqual();

  // Now collapse long equal sections, keeping contextLines of leading/trailing
  // context around each change.
  const result: DiffChunk[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.type === 'change') {
      result.push(g);
      continue;
    }

    // It's an equal chunk — decide how much context to keep.
    const text = g.text!;
    const lines = text.split('\n');
    const hasChangeBefore = i > 0 && groups[i - 1].type === 'change';
    const hasChangeAfter = i < groups.length - 1 && groups[i + 1].type === 'change';

    if (lines.length <= contextLines * 2 + 3) {
      // Short enough to show in full.
      result.push(g);
    } else {
      // Collapse the middle.
      if (hasChangeBefore) {
        const kept = lines.slice(0, contextLines + 1).join('\n');
        if (kept) result.push({ type: 'equal', text: kept });
      }
      result.push({ type: 'equal', text: '\n···\n' });
      if (hasChangeAfter) {
        const kept = lines.slice(-(contextLines + 1)).join('\n');
        if (kept) result.push({ type: 'equal', text: kept });
      }
    }
  }

  return result;
}

/** Re-export the op constants for consumers. */
export { DIFF_DELETE, DIFF_INSERT, DIFF_EQUAL };
