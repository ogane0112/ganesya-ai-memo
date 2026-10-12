// @vitest-environment jsdom
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const phone = vi.hoisted(() => ({ value: false }));

vi.mock('../src/lib/hooks', async (orig) => ({
  ...(await orig<typeof import('../src/lib/hooks')>()),
  useIsPhone: () => phone.value,
}));
vi.mock('../src/state/app', () => ({
  useApp: () => ({
    notes: [
      {
        path: 'Projects/Alpha/plan.md',
        title: 'plan',
        createdBy: null,
        aiAgent: null,
        updatedAt: null,
        tags: [],
      },
    ],
    notesLoaded: true,
    queue: { items: [], conflicts: [] },
    folders: ['Empty'],
    refreshNotes: () => undefined,
  }),
}));
vi.mock('../src/state/folders', () => ({ useDeleteFolder: () => async () => false }));
vi.mock('../src/state/toast', () => ({ useToast: () => ({ show: () => undefined }) }));

import { NotesListPage } from '../src/pages/NotesList';

const render = () =>
  renderToString(
    <MemoryRouter>
      <NotesListPage />
    </MemoryRouter>,
  );

describe('the notes page on a phone and on a computer', () => {
  beforeEach(() => {
    localStorage.clear();
    phone.value = false;
  });

  it('offers the folder tree on a phone, which has no sidebar to show it', () => {
    phone.value = true;
    localStorage.setItem('gmemo.notesView', 'tree');
    const html = render();
    expect(html).toContain('表示のしかた');
    expect(html).toContain('role="tree"');
    expect(html).toContain('Projects');
    expect(html).toContain('Empty');
    expect(html).not.toContain('id="notes-filter"');
  });

  it('keeps the list as the default view on a phone', () => {
    phone.value = true;
    const html = render();
    expect(html).toContain('表示のしかた');
    expect(html).toContain('id="notes-filter"');
    expect(html).not.toContain('role="tree"');
  });

  it('leaves the computer layout alone, whatever a phone chose', () => {
    localStorage.setItem('gmemo.notesView', 'tree');
    const html = render();
    expect(html).not.toContain('表示のしかた');
    expect(html).not.toContain('role="tree"');
    expect(html).toContain('id="notes-filter"');
  });
});
