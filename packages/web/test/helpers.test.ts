import { describe, expect, it } from 'vitest';
import { createSimulation, tick } from '../src/lib/forceGraph';
import { firstLineTitle, quickNoteContent, uniquePath } from '../src/lib/newNote';
import {
  displayPath,
  folderList,
  noteUrl,
  pathFromSplat,
  safeNext,
  toNotePath,
} from '../src/lib/paths';
import { buildTree } from '../src/lib/tree';
import { emptyViewForm, formToYaml, yamlToForm } from '../src/lib/viewYaml';

describe('paths', () => {
  it('builds and parses note URLs', () => {
    const url = noteUrl('Folder/My note #1.md');
    expect(url).toBe('/n/Folder/My%20note%20%231.md');
    expect(pathFromSplat(url.slice(3))).toBe('Folder/My note #1.md');
    expect(noteUrl('a.md', { edit: true })).toBe('/n/a.md?edit=1');
  });

  it('turns user input into safe note paths', () => {
    expect(toNotePath('My: note?', 'Inbox')).toBe('Inbox/My note.md');
    expect(toNotePath('/Projects/../x/Plan.md')).toBe('Projects/x/Plan.md');
    expect(toNotePath('  ')).toBe('');
  });

  it('shows where a note is without the file extension', () => {
    expect(displayPath('Plan.md')).toBe('Plan');
    expect(displayPath('Projects/2026/Plan.md')).toBe('Projects › 2026 › Plan');
    expect(displayPath('Projects/v1.2 notes.MD')).toBe('Projects › v1.2 notes');
  });

  it('lists folders with notes, their parents, and folders created on their own', () => {
    expect(
      folderList(['a.md', 'Work/2026/Plan.md', 'Inbox/x.md'], ['Ideas', 'Work/Archive']),
    ).toEqual(['Ideas', 'Inbox', 'Work', 'Work/2026', 'Work/Archive']);
  });

  it('only allows relative redirects', () => {
    expect(safeNext('/notes?x=1')).toBe('/notes?x=1');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext(null, '/home')).toBe('/home');
  });
});

describe('quick notes', () => {
  it('derives a title from the first line', () => {
    expect(firstLineTitle('\n## Shopping list\n- milk')).toBe('Shopping list');
    expect(firstLineTitle('- [ ] call mom')).toBe('call mom');
  });

  it('avoids path collisions', () => {
    const taken = new Set(['inbox/memo.md', 'inbox/memo 2.md']);
    expect(uniquePath('Memo', 'Inbox', taken)).toBe('Inbox/Memo 3.md');
  });

  it('adds a heading only when a title was typed', () => {
    expect(quickNoteContent('Title', 'body')).toBe('# Title\n\nbody\n');
    expect(quickNoteContent('', 'body')).toBe('body\n');
    expect(quickNoteContent('T', '# Own heading\ntext')).toBe('# Own heading\ntext\n');
  });
});

describe('note tree', () => {
  it('groups notes into sorted folders', () => {
    const n = (path: string) => ({
      path,
      title: path.split('/').pop()!.replace('.md', ''),
      createdBy: null,
      aiAgent: null,
      updatedAt: null,
      tags: [],
    });
    const tree = buildTree([n('b.md'), n('Z/x.md'), n('A/y.md'), n('A/B/z.md'), n('a.md')]);
    expect(tree.folders.map((f) => f.name)).toEqual(['A', 'Z']);
    expect(tree.notes.map((x) => x.title)).toEqual(['a', 'b']);
    expect(tree.folders[0]!.folders[0]!.path).toBe('A/B');
  });

  it('keeps folders created on their own, even when empty', () => {
    const n = (path: string) => ({
      path,
      title: path.split('/').pop()!.replace('.md', ''),
      createdBy: null,
      aiAgent: null,
      updatedAt: null,
      tags: [],
    });
    const tree = buildTree([n('A/y.md')], ['Empty', 'A/Sub', 'A']);
    expect(tree.folders.map((f) => f.name)).toEqual(['A', 'Empty']);
    expect(tree.folders[0]!.folders.map((f) => f.path)).toEqual(['A/Sub']);
    expect(tree.folders[0]!.notes).toHaveLength(1);
    expect(tree.folders[1]!.notes).toHaveLength(0);
  });
});

describe('view form ⇄ YAML', () => {
  it('round-trips a kanban view', () => {
    const form = {
      ...emptyViewForm(),
      name: 'Tasks',
      type: 'kanban' as const,
      folder: 'Projects',
      tag: '#task',
      columns: '$title, due',
      groupBy: 'status',
      groups: 'todo, doing, done',
      filters: [{ property: 'priority', op: 'gte' as const, value: '2' }],
      sort: [{ property: 'due', direction: 'desc' as const }],
    };
    const yaml = formToYaml(form);
    expect(yaml).toContain('type: kanban');
    expect(yaml).toContain('tag: task');
    const back = yamlToForm('tasks', yaml);
    expect(back).toMatchObject({
      name: 'Tasks',
      type: 'kanban',
      folder: 'Projects',
      tag: 'task',
      columns: '$title, due',
      groupBy: 'status',
      groups: 'todo, doing, done',
    });
    expect(back.filters).toEqual([{ property: 'priority', op: 'gte', value: 2 }]);
    expect(back.sort).toEqual([{ property: 'due', direction: 'desc' }]);
  });
});

describe('force layout', () => {
  it('pulls linked nodes closer than unlinked ones', () => {
    const sim = createSimulation(['a', 'b', 'c'], [{ source: 'a', target: 'b' }]);
    for (let i = 0; i < 300; i++) tick(sim);
    const [a, b, c] = [sim.nodes[0]!, sim.nodes[1]!, sim.nodes[2]!];
    const d = (p: { x: number; y: number }, q: { x: number; y: number }) =>
      Math.hypot(p.x - q.x, p.y - q.y);
    expect(d(a, b)).toBeLessThan(d(a, c));
    expect(Number.isFinite(a.x)).toBe(true);
  });
});
