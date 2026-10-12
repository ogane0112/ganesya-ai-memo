// @vitest-environment jsdom
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import type { NoteSummary } from '../src/api/types';
import { NoteTree } from '../src/components/NoteTree';

const note = (path: string): NoteSummary => ({
  path,
  title: path.split('/').pop()!.replace('.md', ''),
  createdBy: null,
  aiAgent: null,
  updatedAt: null,
  tags: [],
});

const render = (notes: NoteSummary[], folders: string[]) =>
  renderToString(
    <MemoryRouter>
      <NoteTree notes={notes} folders={folders} onDeleteFolder={() => undefined} />
    </MemoryRouter>,
  );

/** The rendered text of each folder's block, by folder name. */
const deleteOffered = (html: string) => (html.match(/フォルダーを削除/g) ?? []).length;

describe('deleting folders from the tree', () => {
  beforeEach(() => localStorage.setItem('gmemo.treeOpen', JSON.stringify(['A', 'A/B', 'C'])));

  it('offers it for an empty folder, and for one that only holds empty folders', () => {
    // A holds only the empty B: both can be deleted.
    expect(deleteOffered(render([], ['A', 'A/B']))).toBe(2);
  });

  it('never offers it for a folder with notes in it or below it', () => {
    expect(deleteOffered(render([note('A/B/n.md')], ['A', 'A/B']))).toBe(0);
    // C has a note; the empty A next to it can still go.
    expect(deleteOffered(render([note('C/n.md')], ['A', 'C']))).toBe(1);
  });
});
