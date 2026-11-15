// @vitest-environment jsdom
import { act, forwardRef, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- stand-ins: the save queue, the app state, and CodeMirror ---------------

const enqueued: { path: string; content: string; baseSha: unknown }[] = [];
vi.mock('../src/lib/sync', () => ({
  syncQueue: {
    snapshot: { items: [], conflicts: [] },
    enqueue: vi.fn(async (op: { path: string; content: string; baseSha: unknown }) => {
      enqueued.push(op);
    }),
    onResult: () => () => undefined,
    outcome: async () => 'saved',
  },
}));
vi.mock('../src/state/app', () => ({
  useApp: () => ({
    storage: 'builtin',
    notes: [{ path: 'Inbox/買い物.md' }],
    queue: { items: [], conflicts: [] },
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

let host: HTMLElement;
let root: Root;
const onDone = vi.fn();

function open() {
  act(() => {
    root.render(
      <MemoryRouter>
        <NoteEditor path={null} folder="Inbox" content={null} sha={null} onDone={onDone} />
      </MemoryRouter>,
    );
  });
}

function type(text: string) {
  const ta = host.querySelector('textarea')!;
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    set.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function done() {
  const btn = [...host.querySelectorAll('button')].find((b) => b.textContent === '完了')!;
  await act(async () => {
    btn.click();
  });
}

beforeEach(() => {
  enqueued.length = 0;
  onDone.mockReset();
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
    expect(host.querySelector('textarea')!.placeholder).toBe('1行目がタイトルになります');
    expect(host.textContent).toContain('新しいメモ(Inbox)');
    await done();
    expect(enqueued).toEqual([]);
    expect(onDone).toHaveBeenCalledWith(null);
  });

  it('is named after its first line, which becomes the heading', async () => {
    open();
    type('買い物\n牛乳\n卵');
    await done();
    // "Inbox/買い物.md" exists already, so the new one does not overwrite it.
    expect(enqueued).toEqual([
      expect.objectContaining({
        path: 'Inbox/買い物 2.md',
        content: '# 買い物\n牛乳\n卵',
        baseSha: null,
      }),
    ]);
    expect(onDone).toHaveBeenCalledWith('Inbox/買い物 2.md');
    expect(host.textContent).toContain('Inbox › 買い物 2');
  });

  it('keeps the name it got, when the first line changes later', async () => {
    open();
    type('旅行');
    // The app goes to the background: the memo is saved, and named, there.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    expect(enqueued.map((e) => e.path)).toEqual(['Inbox/旅行.md']);
    type('# 夏の旅行\n沖縄');
    await done();
    expect(enqueued.map((e) => e.path)).toEqual(['Inbox/旅行.md', 'Inbox/旅行.md']);
    expect(enqueued[1]!.content).toBe('# 夏の旅行\n沖縄');
  });
});
