import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  undo,
} from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.35em', fontWeight: '700' },
  { tag: t.heading2, fontSize: '1.2em', fontWeight: '700' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--accent-text)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', color: 'var(--code-fg)' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--muted)' },
  { tag: t.quote, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--faint)' },
]);

const theme = EditorView.theme({
  '&': { fontSize: '16px', backgroundColor: 'transparent', color: 'var(--fg)', height: '100%' },
  '.cm-scroller': { fontFamily: 'var(--font-body)', lineHeight: '1.75', overflow: 'auto' },
  '.cm-content': { padding: '12px 4px 40vh', caretColor: 'var(--fg-strong)' },
  '.cm-line': { padding: '0 4px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-placeholder': { color: 'var(--faint)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-cursor': { borderLeftColor: 'var(--fg-strong)', borderLeftWidth: '1.5px' },
});

export interface EditorHandle {
  focus(): void;
  getValue(): string;
  /** The selected text (empty when nothing is selected). */
  getSelection(): string;
  setValue(text: string): void;
  /** Replace the first `length` characters (the frontmatter block); the rest, the cursor and undo history stay. */
  replaceStart(length: number, text: string): void;
  /** Insert text at the cursor (replacing the selection). `cursorOffset` places the caret inside the inserted text. */
  insert(text: string, cursorOffset?: number): void;
  /** Wrap the selection, or insert `before`+`after` with the caret between. */
  wrap(before: string, after: string): void;
  /** Toggle a Markdown prefix (e.g. "- ", "- [ ] ") on the current lines. */
  togglePrefix(prefix: string): void;
  /** Cycle heading level on the current line: none → # → ## → ### → none. */
  cycleHeading(): void;
  undo(): void;
  redo(): void;
}

interface Props {
  initialValue: string;
  onChange?: (text: string) => void;
  onSave?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
}

const LIST_PREFIX_RE = /^(\s*)(- \[[ xX]\] |[-*+] |\d+[.)] )?/;

export const Editor = forwardRef<EditorHandle, Props>(function Editor(
  { initialValue, onChange, onSave, placeholder, autoFocus, ariaLabel = '本文' },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage, addKeymap: true }),
          syntaxHighlighting(highlight),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          cmPlaceholder(placeholder ?? ''),
          theme,
          EditorView.contentAttributes.of({
            'aria-label': ariaLabel,
            'aria-multiline': 'true',
            autocapitalize: 'sentences',
            spellcheck: 'true',
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    if (autoFocus) {
      v.focus();
      v.dispatch({ selection: EditorSelection.cursor(v.state.doc.length) });
    }
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is created once; later value changes go through setValue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    getValue: () => view.current?.state.doc.toString() ?? '',
    getSelection: () => {
      const s = view.current?.state;
      return s ? s.sliceDoc(s.selection.main.from, s.selection.main.to) : '';
    },
    setValue: (text) => {
      const v = view.current;
      if (!v) return;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    },
    replaceStart: (length, text) => {
      const v = view.current;
      if (!v) return;
      v.dispatch({ changes: { from: 0, to: Math.min(length, v.state.doc.length), insert: text } });
    },
    insert: (text, cursorOffset) => {
      const v = view.current;
      if (!v) return;
      const { from, to } = v.state.selection.main;
      v.dispatch({
        changes: { from, to, insert: text },
        selection: EditorSelection.cursor(from + (cursorOffset ?? text.length)),
        scrollIntoView: true,
      });
      v.focus();
    },
    wrap: (before, after) => {
      const v = view.current;
      if (!v) return;
      const { from, to } = v.state.selection.main;
      const sel = v.state.sliceDoc(from, to);
      v.dispatch({
        changes: { from, to, insert: before + sel + after },
        selection: sel
          ? EditorSelection.range(from + before.length, from + before.length + sel.length)
          : EditorSelection.cursor(from + before.length),
        scrollIntoView: true,
      });
      v.focus();
    },
    togglePrefix: (prefix) => {
      const v = view.current;
      if (!v) return;
      const { state } = v;
      const changes: { from: number; to: number; insert: string }[] = [];
      const seen = new Set<number>();
      for (const r of state.selection.ranges) {
        for (let pos = r.from; pos <= r.to;) {
          const line = state.doc.lineAt(pos);
          if (!seen.has(line.number)) {
            seen.add(line.number);
            const m = LIST_PREFIX_RE.exec(line.text)!;
            const indent = m[1] ?? '';
            const existing = m[2] ?? '';
            const start = line.from + indent.length;
            if (existing === prefix)
              changes.push({ from: start, to: start + existing.length, insert: '' });
            else changes.push({ from: start, to: start + existing.length, insert: prefix });
          }
          pos = line.to + 1;
        }
      }
      v.dispatch(state.update({ changes, scrollIntoView: true }));
      v.focus();
    },
    cycleHeading: () => {
      const v = view.current;
      if (!v) return;
      const line = v.state.doc.lineAt(v.state.selection.main.head);
      const m = /^(#{1,6})\s+/.exec(line.text);
      const level = m ? m[1]!.length : 0;
      const next = level >= 3 ? '' : '#'.repeat(level + 1) + ' ';
      v.dispatch({
        changes: { from: line.from, to: line.from + (m ? m[0].length : 0), insert: next },
        scrollIntoView: true,
      });
      v.focus();
    },
    undo: () => {
      if (view.current) undo(view.current);
    },
    redo: () => {
      if (view.current) redo(view.current);
    },
  }));

  return <div ref={host} className="editor-host" />;
});
