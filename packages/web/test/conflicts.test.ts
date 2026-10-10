import { diffOps, mergeNotes, splitBlocks } from '@gmemo/core';
import { describe, expect, it } from 'vitest';
import type { ProposalFile } from '../src/api/types';
import {
  binaryFileChoice,
  countUnresolved,
  needsDecision,
  previewMerged,
  resolutionReducer,
  type ResolutionState,
  toRequest,
  unresolved,
} from '../src/lib/conflicts';

function file(
  path: string,
  base: string | null,
  current: string | null,
  proposed: string | null,
): ProposalFile {
  const mainChanged = current !== base;
  const deleteConflict =
    mainChanged && (proposed === null || current === null) && proposed !== current;
  return {
    path,
    status: base === null ? 'added' : proposed === null ? 'deleted' : 'modified',
    base,
    current,
    proposed,
    mainChanged,
    diff: diffOps(
      splitBlocks(base ?? '').map((b) => b.key),
      splitBlocks(proposed ?? '').map((b) => b.key),
    ),
    merge: !deleteConflict && proposed !== null ? mergeNotes(base, current, proposed) : null,
    deleteConflict,
  };
}

const base = 'Intro\n\nShared paragraph.\n\nOutro\n';
const ours = 'Intro\n\nShared paragraph, edited on phone.\n\nOutro\n';
const theirs = 'Intro\n\nShared paragraph, edited by AI.\n\nOutro\n';

describe('conflict resolution state', () => {
  const conflicted = file('a.md', base, ours, theirs);
  const clean = file('b.md', 'x\n', 'x\n', 'x\n\ny\n');
  const deleted = file('c.md', 'old\n', 'old, changed\n', null);

  it('detects what needs a decision', () => {
    expect(needsDecision(conflicted)).toBe(true);
    expect(needsDecision(clean)).toBe(false);
    expect(needsDecision(deleted)).toBe(true);
    expect(unresolved([conflicted, clean, deleted], {})).toEqual([
      { path: 'a.md', blocks: [0], keys: [], file: false },
      { path: 'c.md', blocks: [], keys: [], file: true },
    ]);
  });

  it('resolves block by block and builds the merge request', () => {
    let s: ResolutionState = {};
    s = resolutionReducer(s, { type: 'block', path: 'a.md', index: 0, choice: 'theirs' });
    s = resolutionReducer(s, { type: 'file', path: 'c.md', choice: 'keep' });
    expect(countUnresolved([conflicted, deleted], s)).toBe(0);
    expect(toRequest(s)).toEqual({ 'a.md': { blocks: { 0: 'theirs' } }, 'c.md': { file: 'keep' } });
    expect(previewMerged(conflicted, s['a.md'])).toBe(theirs);
  });

  it('supports "both" and custom text', () => {
    const both = resolutionReducer({}, { type: 'block', path: 'a.md', index: 0, choice: 'both' });
    expect(previewMerged(conflicted, both['a.md'])).toBe(
      'Intro\n\nShared paragraph, edited on phone.\n\nShared paragraph, edited by AI.\n\nOutro\n',
    );
    const custom = resolutionReducer(
      {},
      { type: 'block', path: 'a.md', index: 0, choice: { custom: 'Mine.\n' } },
    );
    expect(previewMerged(conflicted, custom['a.md'])).toBe('Intro\n\nMine.\n\nOutro\n');
  });

  it('can reject a single file, which removes it from the pending list', () => {
    const s = resolutionReducer({}, { type: 'reject', path: 'a.md', reject: true });
    expect(unresolved([conflicted], s)).toEqual([]);
    expect(toRequest(s)).toEqual({ 'a.md': { reject: true } });
    expect(
      toRequest(resolutionReducer(s, { type: 'reject', path: 'a.md', reject: false })),
    ).toEqual({});
  });

  it('"all" picks one side everywhere', () => {
    const s = resolutionReducer(
      {},
      { type: 'all', files: [conflicted, clean, deleted], choice: 'ours' },
    );
    expect(countUnresolved([conflicted, clean, deleted], s)).toBe(0);
    expect(s['a.md']?.blocks).toEqual({ 0: 'ours' });
    expect(s['c.md']?.file).toBe('keep');
  });

  it('resolves frontmatter conflicts by key', () => {
    const f = file(
      'd.md',
      '---\nstatus: todo\n---\nBody\n',
      '---\nstatus: doing\n---\nBody\n',
      '---\nstatus: done\n---\nBody\n',
    );
    expect(unresolved([f], {})).toEqual([
      { path: 'd.md', blocks: [], keys: ['status'], file: false },
    ]);
    const s = resolutionReducer(
      {},
      { type: 'frontmatter', path: 'd.md', key: 'status', choice: 'theirs' },
    );
    expect(unresolved([f], s)).toEqual([]);
    expect(previewMerged(f, s['d.md'])).toContain('status: done');
  });

  it('maps binary clash choices to the server convention', () => {
    expect(binaryFileChoice('ours')).toBe('keep');
    expect(binaryFileChoice('theirs')).toBe('theirs');
  });
});
