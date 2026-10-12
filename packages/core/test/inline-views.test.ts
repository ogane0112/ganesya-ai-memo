import { describe, expect, it } from 'vitest';
import {
  findInlineViews,
  inlineViewBlock,
  inlineViewFolder,
  inlineViewSource,
  parseView,
  patchInlineViewSource,
  replaceInlineView,
  splitBlocks,
} from '../src/index.js';

const note = [
  '---',
  'tags: [project]',
  '---',
  '# プロジェクトA',
  '',
  '方針を書く。',
  '',
  '```gmemo-view',
  'name: タスク',
  'type: kanban',
  'folder: Projects/プロジェクトA/タスク',
  '```',
  '',
  '```js',
  'console.log(1)',
  '```',
  '',
  '~~~~gmemo-view',
  'name: 予定',
  'type: calendar',
  '~~~~',
  '',
  '続き。',
  '',
].join('\n');

describe('inline views', () => {
  it('finds each view block and the exact range of its settings', () => {
    const views = findInlineViews(note);
    expect(views.map((v) => v.source)).toEqual([
      'name: タスク\ntype: kanban\nfolder: Projects/プロジェクトA/タスク',
      'name: 予定\ntype: calendar',
    ]);
    for (const v of views) expect(note.slice(v.from, v.to)).toBe(v.source);
    expect(parseView('inline', views[0]!.source).type).toBe('kanban');
  });

  it('recognises a block of the note body, and nothing else', () => {
    const blocks = splitBlocks(note.split('---\n')[2]!);
    const sources = blocks.map((b) => inlineViewSource(b.raw)).filter((s) => s !== null);
    expect(sources).toHaveLength(2);
    expect(inlineViewSource('```js\nx\n```\n')).toBeNull();
    expect(inlineViewSource('```gmemo-view\nname: open\n')).toBeNull(); // not closed
  });

  it('rewrites one view and leaves the rest of the note byte for byte', () => {
    const next = replaceInlineView(note, 1, 'name: 予定\ntype: table\n');
    expect(next).toBe(note.replace('name: 予定\ntype: calendar', 'name: 予定\ntype: table'));
    expect(replaceInlineView(note, 5, 'x: 1')).toBe(note);
  });

  it('stays fast on settings full of line breaks', () => {
    const hostile = 'type: table' + '\n'.repeat(200_000) + 'x';
    const start = Date.now();
    const next = replaceInlineView(note, 0, hostile);
    expect(Date.now() - start).toBeLessThan(500);
    expect(next).toContain(hostile);
    expect(replaceInlineView(note, 0, 'type: table\n\n\n')).toContain('type: table\n```');
  });

  it('patches settings, keeping unknown keys', () => {
    const src = 'name: タスク\ntype: kanban\ncustom: keep me';
    const next = patchInlineViewSource(src, { type: 'calendar', name: undefined });
    expect(next).toBe('type: calendar\ncustom: keep me');
    expect(patchInlineViewSource('', { type: 'table' })).toBe('type: table');
    expect(() => patchInlineViewSource('name: [unclosed', { type: 'table' })).toThrow();
    expect(() => patchInlineViewSource('- a list', { type: 'table' })).toThrow();
  });

  it('builds a new block whose notes live under the note', () => {
    const folder = inlineViewFolder('Projects/プロジェクトA.md', 'タスク/今週');
    expect(folder).toBe('Projects/プロジェクトA/タスク 今週');
    const block = inlineViewBlock({ name: 'タスク', type: 'kanban', folder });
    expect(block).toBe(
      '```gmemo-view\nname: タスク\ntype: kanban\nfolder: Projects/プロジェクトA/タスク 今週\n```\n',
    );
    expect(findInlineViews(`# A\n\n${block}`)[0]!.source).toContain('type: kanban');
    expect(inlineViewFolder('Memo.md', '  ')).toBe('Memo/一覧');
  });
});
