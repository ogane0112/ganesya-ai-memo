import { resolveLink, type ViewDefinition, type ViewNote } from '@gmemo/core';
import { describe, expect, it } from 'vitest';
import type { ViewRows } from '../src/api/types';
import { moveCard, movableProperty } from '../src/lib/kanban';
import { linkTarget, searchNotes, wikiLink } from '../src/lib/links';

describe('note link picker', () => {
  const paths = ['Projects/Plan.md', 'Archive/Plan.md', 'Inbox/Memo.md', 'Readme.md'];

  it('writes a link that leads to the picked note, never to its namesake', () => {
    for (const p of paths) expect(resolveLink(linkTarget(p, paths), paths), p).toBe(p);
    expect(linkTarget('Inbox/Memo.md', paths)).toBe('Memo');
    expect(linkTarget('Readme.md', paths)).toBe('Readme');
    // Two notes called "Plan": both keep their folder, so neither link depends on
    // which path happens to be shorter, now or after more notes are added.
    expect(linkTarget('Archive/Plan.md', paths)).toBe('Archive/Plan');
    expect(linkTarget('Projects/Plan.md', paths)).toBe('Projects/Plan');
  });

  it('keeps the selected text as the label, without breaking the link', () => {
    expect(wikiLink('Memo')).toBe('[[Memo]]');
    expect(wikiLink('Memo', 'see the memo')).toBe('[[Memo|see the memo]]');
    expect(wikiLink('Memo', 'Memo')).toBe('[[Memo]]');
    expect(wikiLink('Memo', 'a|b]]c\nd')).toBe('[[Memo|a b c d]]');
  });

  it('finds notes by title first, then by folder', () => {
    const notes = [
      { path: 'Work/Meeting.md', title: 'Meeting' },
      { path: 'Meeting notes/Plan.md', title: 'Plan' },
      { path: 'Weekly meeting.md', title: 'Weekly meeting' },
      { path: 'Other.md', title: 'Other' },
    ];
    expect(searchNotes(notes, 'meeting').map((n) => n.title)).toEqual([
      'Meeting',
      'Weekly meeting',
      'Plan',
    ]);
    expect(searchNotes(notes, '').length).toBe(4);
    expect(searchNotes(notes, 'zzz')).toEqual([]);
  });
});

describe('kanban moves', () => {
  const view = (groupBy?: string): ViewDefinition =>
    ({ name: 'Board', type: 'kanban', columns: [], ...(groupBy ? { groupBy } : {}) }) as never;
  const note = (path: string, status?: unknown): ViewNote => ({
    path,
    title: path,
    tags: [],
    properties: status === undefined ? {} : { status },
  });

  it('moves cards along plain properties only', () => {
    expect(movableProperty(view())).toBe('status');
    expect(movableProperty(view('priority'))).toBe('priority');
    expect(movableProperty(view('$folder'))).toBeNull();
    expect(movableProperty(view('$tags'))).toBeNull();
    expect(movableProperty(view(), note('a', ['x', 'y']))).toBeNull();
  });

  it('shows the card in its new column right away', () => {
    const a = note('a', '未着手');
    const b = note('b', '進行中');
    const data: ViewRows = {
      view: view(),
      rows: [a, b],
      groups: [
        { key: '未着手', rows: [a] },
        { key: '進行中', rows: [b] },
        { key: '完了', rows: [] },
      ],
    };
    const moved = moveCard(data, 'a', '完了', 'status');
    expect(moved.groups!.map((g) => [g.key, g.rows.map((r) => r.path)])).toEqual([
      ['未着手', []],
      ['進行中', ['b']],
      ['完了', ['a']],
    ]);
    expect(moved.rows.find((r) => r.path === 'a')!.properties['status']).toBe('完了');
    // The original data is untouched, so a failed save can put it back.
    expect(data.groups![0]!.rows.map((r) => r.path)).toEqual(['a']);

    const unset = moveCard(moved, 'b', '', 'status');
    expect(unset.rows.find((r) => r.path === 'b')!.properties).toEqual({});
    expect(unset.groups!.find((g) => g.key === '')!.rows.map((r) => r.path)).toEqual(['b']);
  });
});
