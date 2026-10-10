import { describe, expect, it } from 'vitest';
import {
  diff3,
  diffHunks,
  joinBlocks,
  mergeNotes,
  renderMerge,
  renderWithMarkers,
  splitBlocks,
} from '../src/index.js';

describe('splitBlocks', () => {
  it('round-trips raw text', () => {
    const body =
      '# Title\n\npara one\nline two\n\n- a\n- b\n  cont\n\n```js\nx\n\ny\n```\n\n> quote\n\n| a | b |\n|---|---|\n';
    const blocks = splitBlocks(body);
    expect(blocks.map((b) => b.raw).join('')).toBe(body);
    expect(blocks.map((b) => b.kind)).toEqual([
      'heading',
      'paragraph',
      'list',
      'list',
      'code',
      'quote',
      'table',
    ]);
  });
  it('keeps leading blank lines', () => {
    const blocks = splitBlocks('\n\nhello\n');
    expect(blocks.map((b) => b.raw).join('')).toBe('\n\nhello\n');
  });
  it('joinBlocks inserts separators when needed', () => {
    const a = splitBlocks('first');
    const b = splitBlocks('second\n');
    expect(joinBlocks([...a, ...b])).toBe('first\n\nsecond\n');
  });
});

describe('diff', () => {
  it('finds hunks', () => {
    expect(diffHunks(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      { oStart: 1, oLen: 1, nStart: 1, nLen: 1 },
    ]);
    expect(diffHunks([], ['a'])).toEqual([{ oStart: 0, oLen: 0, nStart: 0, nLen: 1 }]);
  });
  it('diff3 merges adjacent edits without conflict', () => {
    const r = diff3(['a', 'b', 'c'], ['a', 'B', 'c'], ['a', 'b', 'C']);
    expect(r).toEqual([{ type: 'stable', items: ['a', 'B', 'C'] }]);
  });
  it('diff3 reports overlapping edits', () => {
    const r = diff3(['a', 'b', 'c'], ['a', 'X', 'c'], ['a', 'Y', 'c']);
    expect(r[1]).toEqual({ type: 'conflict', base: ['b'], ours: ['X'], theirs: ['Y'] });
  });
  it('diff3 accepts identical edits', () => {
    expect(diff3(['a'], ['b'], ['b'])).toEqual([{ type: 'stable', items: ['b'] }]);
  });
  it('diff3 handles insertions at the same point as a conflict', () => {
    const r = diff3(['a', 'b'], ['a', 'x', 'b'], ['a', 'y', 'b']);
    expect(r.some((x) => x.type === 'conflict')).toBe(true);
  });
  it('diff3 handles insertion next to a modification', () => {
    const r = diff3(['a', 'b', 'c'], ['a', 'new', 'b', 'c'], ['a', 'B', 'c']);
    expect(r).toEqual([{ type: 'stable', items: ['a', 'new', 'B', 'c'] }]);
  });
});

describe('mergeNotes', () => {
  const base = '---\ntitle: T\nstatus: todo\ntags: [a]\n---\n# T\n\nPara 1\n\nPara 2\n\nPara 3\n';
  it('merges frontmatter by key and body by paragraph', () => {
    const ours = base.replace('status: todo', 'status: doing').replace('Para 1', 'Para 1 (human)');
    const theirs = base
      .replace('title: T', 'title: T2')
      .replace('Para 3', 'Para 3 (ai)')
      .replace('tags: [a]', 'tags: [a, b]');
    const r = mergeNotes(base, ours, theirs);
    expect(r.clean).toBe(true);
    expect(r.frontmatter).toEqual({ title: 'T2', status: 'doing', tags: ['a', 'b'] });
    expect(r.text).toContain('Para 1 (human)');
    expect(r.text).toContain('Para 3 (ai)');
    expect(r.text).toContain('Para 2');
  });
  it('reports conflicts and resolves them', () => {
    const ours = base.replace('Para 2', 'Para 2 human');
    const theirs = base.replace('Para 2', 'Para 2 ai').replace('status: todo', 'status: done');
    const ours2 = ours.replace('status: todo', 'status: doing');
    const r = mergeNotes(base, ours2, theirs);
    expect(r.clean).toBe(false);
    expect(r.frontmatterConflicts.map((c) => c.key)).toEqual(['status']);
    const conflict = r.segments.find((s) => s.type === 'conflict');
    expect(conflict).toBeDefined();
    const text = renderMerge(r, { blocks: { 0: 'theirs' }, frontmatter: { status: 'theirs' } });
    expect(text).toContain('Para 2 ai');
    expect(text).not.toContain('Para 2 human');
    expect(text).toContain('status: done');
    const both = renderMerge(r, { blocks: { 0: 'both' } });
    expect(both).toContain('Para 2 human\n\nPara 2 ai');
    expect(renderWithMarkers(r)).toContain('<<<<<<< ours');
  });
  it('merges tag arrays as sets', () => {
    const r = mergeNotes(
      '---\ntags: [a, b]\n---\n',
      '---\ntags: [a, b, c]\n---\n',
      '---\ntags: [b, d]\n---\n',
    );
    expect(r.frontmatter['tags']).toEqual(['b', 'c', 'd']);
  });
  it('handles a missing base (both created)', () => {
    const r = mergeNotes(null, 'hello\n', 'hello\n');
    expect(r.clean).toBe(true);
    expect(r.text).toBe('hello\n');
  });
  it('appending on both sides at end conflicts, both resolves', () => {
    const r = mergeNotes('a\n', 'a\n\nb\n', 'a\n\nc\n');
    expect(r.clean).toBe(false);
    expect(renderMerge(r, { blocks: { 0: 'both' } })).toBe('a\n\nb\n\nc\n');
  });
});
