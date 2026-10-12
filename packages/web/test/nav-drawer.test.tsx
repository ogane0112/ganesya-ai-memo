// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteSummary } from '../src/api/types';
import { NavDrawer } from '../src/components/NavDrawer';

const note = (path: string): NoteSummary => ({
  path,
  title: path.split('/').pop()!.replace('.md', ''),
  createdBy: null,
  aiAgent: null,
  updatedAt: null,
  tags: [],
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // jsdom has no modal dialogs; open/closed is all these tests need.
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});

let host: HTMLElement;
let root: Root;
const onClose = vi.fn();

const show = (open: boolean, notes: NoteSummary[] = [note('Projects/Alpha/plan.md')]) =>
  act(() => {
    root.render(
      <MemoryRouter>
        <NavDrawer
          open={open}
          onClose={onClose}
          notes={notes}
          folders={['Empty']}
          notesLoaded
          username="me"
          onDeleteFolder={() => undefined}
        />
      </MemoryRouter>,
    );
  });

beforeEach(() => {
  localStorage.setItem('gmemo.treeOpen', JSON.stringify(['Projects', 'Projects/Alpha']));
  onClose.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the folder menu on phones', () => {
  it('shows the folder tree, the user and the privacy link when open', () => {
    show(true);
    const text = host.textContent ?? '';
    expect(text).toContain('Projects');
    expect(text).toContain('Alpha');
    expect(text).toContain('plan');
    expect(text).toContain('Empty');
    expect(text).toContain('me');
    expect(host.querySelector('a[href="/privacy"]')).not.toBeNull();
    expect(host.querySelector('dialog')?.hasAttribute('open')).toBe(true);
  });

  it('renders nothing inside while closed', () => {
    show(false);
    expect(host.querySelector('dialog')?.hasAttribute('open')).toBe(false);
    expect(host.querySelector('.tree')).toBeNull();
  });

  it('closes when the dimmed area is tapped, but not when the menu itself is', () => {
    show(true);
    host.querySelector<HTMLElement>('.drawer-body')!.click();
    expect(onClose).not.toHaveBeenCalled();
    host.querySelector<HTMLElement>('dialog')!.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when a note is chosen, and from the close button', () => {
    show(true);
    host.querySelector<HTMLElement>('a.tree-note')!.click();
    expect(onClose).toHaveBeenCalledTimes(1);
    host.querySelector<HTMLElement>('button[aria-label="閉じる"]')!.click();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('closes on Escape (the dialog cancel event)', () => {
    show(true);
    host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says so when there are no notes at all', () => {
    act(() => {
      root.render(
        <MemoryRouter>
          <NavDrawer
            open
            onClose={onClose}
            notes={[]}
            folders={[]}
            notesLoaded
            onDeleteFolder={() => undefined}
          />
        </MemoryRouter>,
      );
    });
    expect(host.textContent).toContain('まだノートがありません');
  });
});
