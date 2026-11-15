// @vitest-environment jsdom
import { act, forwardRef, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- stand-ins: the save queue, the app state, and CodeMirror ---------------

const enqueued: Record<string, unknown>[] = [];
vi.mock('../src/lib/sync', () => ({
  syncQueue: {
    snapshot: { items: [], conflicts: [] },
    enqueue: vi.fn(async (op: Record<string, unknown>) => {
      enqueued.push(op);
    }),
    onResult: () => () => undefined,
    outcome: async () => 'saved',
  },
}));
vi.mock('../src/state/app', () => ({
  useApp: () => ({
    storage: 'builtin',
    notes: [{ path: 'Inbox/買い物.md' }, { path: 'Work/plan.md' }],
    queue: { items: [], conflicts: [] },
    folders: [],
    paths: [],
  }),
}));
// One object, as the real toast context gives (a new one per render would re-save).
const toast = { show: () => undefined };
vi.mock('../src/state/toast', () => ({ useToast: () => toast }));
vi.mock('../src/api/client', () => ({
  api: { editing: async () => ({ ok: true }), scanSensitive: async () => ({ findings: [] }) },
}));
vi.mock('../src/lib/queueStore', () => ({
  loadDraft: async () => undefined,
  saveDraft: async () => undefined,
}));
vi.mock('../src/components/EditorToolbar', () => ({ EditorToolbar: () => null }));
vi.mock('../src/components/PropertiesPanel', () => ({ PropertiesPanel: () => null }));
vi.mock('../src/components/Editor', () => ({
  // A textarea with the parts of EditorHandle the note editor uses.
  Editor: forwardRef(function FakeEditor(
    props: { initialValue: string; onChange: (v: string) => void; placeholder?: string },
    ref,
  ) {
    const el = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => ({
      focus: () => el.current?.focus(),
      getValue: () => el.current?.value ?? '',
      setValue: (v: string) => {
        el.current!.value = v;
        props.onChange(v);
      },
      replaceRange: (from: number, to: number, text: string) => {
        const v = el.current!.value;
        el.current!.value = v.slice(0, from) + text + v.slice(to);
        props.onChange(el.current!.value);
      },
    }));
    return (
      <textarea
        ref={el}
        defaultValue={props.initialValue}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
    );
  }),
}));

const { NoteEditor } = await import('../src/components/NoteEditor');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no modal dialogs; open/closed is all these tests need.
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open');
};

let host: HTMLElement;
let root: Root;
const onDone = vi.fn();
const NL = '\n';
const lines = (...l: string[]) => l.join(NL);

function open(props: { path?: string; content?: string } = {}) {
  act(() => {
    root.render(
      <MemoryRouter>
        <NoteEditor
          path={props.path ?? null}
          content={props.content ?? null}
          sha={props.path ? 'abc' : null}
          onDone={onDone}
        />
      </MemoryRouter>,
    );
  });
}

const textarea = () => host.querySelector('textarea')!;

function type(text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    set.call(textarea(), text);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(label: string) {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!btn) throw new Error(`no button "${label}"`);
  await act(async () => {
    btn.click();
  });
}

async function pick(label: string) {
  const opt = [...document.querySelectorAll<HTMLButtonElement>('[role=radio]')].find((b) =>
    b.textContent?.includes(label),
  );
  if (!opt) throw new Error(`no option "${label}"`);
  await act(async () => {
    opt.click();
  });
}

const sheetOpen = () => !!document.querySelector('dialog[open]');

beforeEach(() => {
  enqueued.length = 0;
  onDone.mockReset();
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a new memo', () => {
  it('says the first line is the title, and creates nothing when left empty', async () => {
    open();
    expect(textarea().placeholder).toBe('1行目がタイトルになります');
    await click('完了');
    expect(sheetOpen()).toBe(false);
    expect(enqueued).toEqual([]);
    expect(onDone).toHaveBeenCalledWith(null);
  });

  it('asks where to save on 完了, with Inbox chosen, and is named after its first line', async () => {
    open();
    type(lines('買い物', '牛乳', '卵'));
    expect(enqueued).toEqual([]); // nothing is sent while writing
    await click('完了');
    expect(sheetOpen()).toBe(true);
    expect(document.querySelector('[role=radio][aria-checked=true]')!.textContent).toContain(
      'Inbox',
    );
    await click('保存');
    // "Inbox/買い物.md" exists already, so the new one does not overwrite it.
    expect(enqueued).toEqual([
      {
        kind: 'save',
        path: 'Inbox/買い物 2.md',
        content: lines('# 買い物', '牛乳', '卵'),
        baseSha: null,
      },
    ]);
    expect(onDone).toHaveBeenCalledWith('Inbox/買い物 2.md');
  });

  it('saves into the folder picked in the sheet, and remembers it for next time', async () => {
    open();
    type('計画');
    await click('完了');
    await pick('Work');
    await click('保存');
    expect(enqueued[0]).toMatchObject({ path: 'Work/計画.md' });
    expect(JSON.parse(localStorage.getItem('gmemo.lastSaveTarget')!)).toEqual({
      kind: 'folder',
      folder: 'Work',
    });
  });

  it("can be appended to today's memo instead", async () => {
    open();
    type('思いつき');
    await click('完了');
    await pick('今日のメモに追記');
    await click('追記');
    expect(enqueued).toEqual([{ kind: 'capture', text: '思いつき', folder: 'Inbox' }]);
    expect(onDone).toHaveBeenCalledWith(null);
  });

  it('can be kept as a draft without saving', async () => {
    open();
    type('まだ途中');
    await click('完了');
    await click('下書きに残す');
    expect(enqueued).toEqual([]);
    expect(onDone).toHaveBeenCalledWith(null);
  });
});

describe('editing a note', () => {
  const head = lines('---', 'tags: [仕事]', 'status: todo', '---', '');

  it('shows the body only, and keeps the frontmatter when saving', async () => {
    open({ path: 'Work/会議.md', content: head + lines('# 会議', '決めたこと', '') });
    expect(textarea().value).toBe(lines('# 会議', '決めたこと', ''));
    type(lines('# 会議', '決めたこと', '次回は来週', ''));
    await click('完了');
    expect(sheetOpen()).toBe(false);
    expect(enqueued).toEqual([
      expect.objectContaining({
        path: 'Work/会議.md',
        content: head + lines('# 会議', '決めたこと', '次回は来週', ''),
        baseSha: 'abc',
      }),
    ]);
    expect(onDone).toHaveBeenCalledWith('Work/会議.md');
  });
});
