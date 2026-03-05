import { describe, it, expect } from 'vitest';
import {
  smartDiff,
  groupDiffChunks,
  DIFF_DELETE,
  DIFF_INSERT,
  DIFF_EQUAL,
  type DiffSpan,
} from '../smartDiff';

describe('smartDiff', () => {
  it('returns a single equal span for identical texts', () => {
    const result = smartDiff('hello world', 'hello world');
    expect(result).toEqual([{ op: DIFF_EQUAL, text: 'hello world' }]);
  });

  it('detects a simple word change', () => {
    const result = smartDiff('The quick brown fox', 'The quiet red fox');
    // After semantic cleanup, the change should be grouped around whole words
    const ops = result.map(s => s.op);
    expect(ops).toContain(DIFF_DELETE);
    expect(ops).toContain(DIFF_INSERT);
    expect(ops).toContain(DIFF_EQUAL);

    // Reconstruct: applying the diff should yield the new text
    const reconstructed = result
      .filter(s => s.op !== DIFF_DELETE)
      .map(s => s.text)
      .join('');
    expect(reconstructed).toBe('The quiet red fox');

    // Removing inserts should yield the old text
    const original = result
      .filter(s => s.op !== DIFF_INSERT)
      .map(s => s.text)
      .join('');
    expect(original).toBe('The quick brown fox');
  });

  it('handles empty old text (full insertion)', () => {
    const result = smartDiff('', 'new content');
    expect(result).toEqual([{ op: DIFF_INSERT, text: 'new content' }]);
  });

  it('handles empty new text (full deletion)', () => {
    const result = smartDiff('old content', '');
    expect(result).toEqual([{ op: DIFF_DELETE, text: 'old content' }]);
  });

  it('produces semantically clean boundaries for copy-paste-and-edit', () => {
    const old = 'The quick brown fox jumps over the lazy dog.';
    const new_ = 'The quick brown cat jumps over the lazy dog.';
    const result = smartDiff(old, new_);

    // The change should be exactly "fox" → "cat", not split across characters
    const deletes = result.filter(s => s.op === DIFF_DELETE);
    const inserts = result.filter(s => s.op === DIFF_INSERT);
    expect(deletes.length).toBe(1);
    expect(inserts.length).toBe(1);
    expect(deletes[0].text).toBe('fox');
    expect(inserts[0].text).toBe('cat');
  });

  it('handles HTML content diffs', () => {
    const old = '<p>Hello <strong>world</strong></p>';
    const new_ = '<p>Hello <strong>earth</strong></p>';
    const result = smartDiff(old, new_);

    const reconstructed = result
      .filter(s => s.op !== DIFF_DELETE)
      .map(s => s.text)
      .join('');
    expect(reconstructed).toBe(new_);
  });
});

describe('groupDiffChunks', () => {
  it('returns empty array for empty input', () => {
    expect(groupDiffChunks([])).toEqual([]);
  });

  it('groups adjacent changes into a single change chunk', () => {
    const spans: DiffSpan[] = [
      { op: DIFF_EQUAL, text: 'Hello ' },
      { op: DIFF_DELETE, text: 'world' },
      { op: DIFF_INSERT, text: 'earth' },
      { op: DIFF_EQUAL, text: '!' },
    ];
    const chunks = groupDiffChunks(spans);
    const changeChunks = chunks.filter(c => c.type === 'change');
    expect(changeChunks.length).toBe(1);
    expect(changeChunks[0].spans!.length).toBe(2);
  });

  it('collapses long equal sections with ellipsis', () => {
    const longText = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join('\n');
    const spans: DiffSpan[] = [
      { op: DIFF_EQUAL, text: longText },
      { op: DIFF_INSERT, text: 'new stuff' },
      { op: DIFF_EQUAL, text: longText },
    ];
    const chunks = groupDiffChunks(spans, 2);
    const texts = chunks.filter(c => c.type === 'equal').map(c => c.text);
    expect(texts.some(t => t!.includes('···'))).toBe(true);
  });

  it('keeps short equal sections intact', () => {
    const spans: DiffSpan[] = [
      { op: DIFF_DELETE, text: 'old' },
      { op: DIFF_EQUAL, text: 'ok' },
      { op: DIFF_INSERT, text: 'new' },
    ];
    const chunks = groupDiffChunks(spans);
    const equalChunks = chunks.filter(c => c.type === 'equal');
    expect(equalChunks.length).toBe(1);
    expect(equalChunks[0].text).toBe('ok');
  });
});
