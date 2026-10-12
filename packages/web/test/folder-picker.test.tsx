// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanFolderPath, FolderPicker } from '../src/components/FolderPicker';

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
const onChange = vi.fn();
const FOLDERS = ['Ideas', 'Projects', 'Projects/Alpha', 'Projects/Alpha/Q1'];

const show = (props: Partial<React.ComponentProps<typeof FolderPicker>> = {}) =>
  act(() => {
    root.render(
      <FolderPicker
        label="保存先のフォルダー"
        value="Projects/Alpha"
        onChange={onChange}
        folders={FOLDERS}
        {...props}
      />,
    );
  });
const field = () => host.querySelector<HTMLButtonElement>('button.folder-field')!;
const options = () => [...host.querySelectorAll<HTMLElement>('.folder-option')];

beforeEach(() => {
  onChange.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('cleanFolderPath', () => {
  it('turns what was typed into a folder path', () => {
    expect(cleanFolderPath(' Projects \\ 新規 //Q1/ ')).toBe('Projects/新規/Q1');
    expect(cleanFolderPath('a/../b/./c')).toBe('a/b/c');
    expect(cleanFolderPath('  ')).toBe('');
  });
});

describe('the folder picker', () => {
  it('shows the chosen folder with its levels, and the empty choice by name', () => {
    show();
    expect(field().textContent).toContain('Projects › Alpha');
    show({ value: '', emptyLabel: 'ルート' });
    expect(field().textContent).toContain('ルート');
  });

  it('lists the folders indented by level, marking the chosen one', () => {
    show();
    act(() => field().click());
    const rows = options();
    expect(rows.map((r) => r.querySelector('.folder-option-name')!.textContent)).toEqual([
      'ルート',
      'Ideas',
      'Projects',
      'Alpha',
      'Q1',
    ]);
    expect(rows.map((r) => r.style.paddingLeft)).toEqual(['', '12px', '12px', '30px', '48px']);
    expect(rows.filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    expect(rows[3]!.getAttribute('aria-checked')).toBe('true');
  });

  it('picks a folder with one tap and closes', () => {
    show();
    act(() => field().click());
    act(() => options()[1]!.click());
    expect(onChange).toHaveBeenCalledWith('Ideas');
    expect(host.querySelector('dialog')?.hasAttribute('open')).toBe(false);
  });

  it('picks the top level, unless the field needs a folder', () => {
    show();
    act(() => field().click());
    act(() => options()[0]!.click());
    expect(onChange).toHaveBeenCalledWith('');
    show({ allowEmpty: false });
    act(() => field().click());
    expect(options().map((r) => r.textContent)).not.toContain('ルート');
  });

  it('closes only itself on Escape when it sits inside another dialog', () => {
    const outerCancel = vi.fn();
    act(() => {
      root.render(
        <dialog onCancel={outerCancel}>
          <FolderPicker label="保存先のフォルダー" value="" onChange={onChange} folders={FOLDERS} />
        </dialog>,
      );
    });
    act(() => field().click());
    const picker = host.querySelector<HTMLElement>('dialog.modal')!;
    act(() => {
      picker.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(picker.hasAttribute('open')).toBe(false);
    expect(outerCancel).not.toHaveBeenCalled();
  });

  it('takes a typed path, even for a folder that does not exist yet', () => {
    show();
    act(() => field().click());
    const input = host.querySelector<HTMLInputElement>('#folder-new-input')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      set.call(input, ' Projects / 新規 ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.textContent).toContain('作成先: Projects › 新規');
    act(() => {
      host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onChange).toHaveBeenCalledWith('Projects/新規');
  });
});
