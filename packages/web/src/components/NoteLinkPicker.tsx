import { useEffect, useMemo, useState } from 'react';
import { displayPath, folderOf } from '../lib/paths';
import { linkTarget, searchNotes, wikiLink } from '../lib/links';
import { useApp } from '../state/app';
import { Modal } from './ui';

/**
 * Pick a note to link to instead of typing its exact name. Inserts the same
 * [[…]] text a person would write by hand; text selected in the editor
 * becomes what the link shows.
 */
export function NoteLinkPicker({
  open,
  selection,
  onClose,
  onPick,
}: {
  open: boolean;
  /** Text selected in the editor when the picker opened. */
  selection: string;
  onClose: () => void;
  onPick: (markdown: string) => void;
}) {
  const { notes, paths } = useApp();
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (open) setQuery(selection.trim().slice(0, 80));
  }, [open, selection]);

  const hits = useMemo(() => searchNotes(notes, query), [notes, query]);
  const typed = query
    .trim()
    .replace(/[[\]|#\r\n]+/g, ' ')
    .trim();
  const exact = hits.some((n) => n.title.toLowerCase() === typed.toLowerCase());

  return (
    <Modal open={open} onClose={onClose} title="ノートへのリンク">
      <div className="field">
        <label htmlFor="link-q">ノートを検索</label>
        <input
          id="link-q"
          className="input"
          type="search"
          value={query}
          autoFocus
          placeholder="タイトルやフォルダで探す"
          enterKeyHint="go"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            e.preventDefault();
            const first = hits[0];
            if (first) onPick(wikiLink(linkTarget(first.path, paths), selection));
            else if (typed) onPick(wikiLink(typed, selection));
          }}
        />
      </div>
      <ul className="link-picker" aria-label="候補">
        {hits.map((n) => (
          <li key={n.path}>
            <button
              type="button"
              onClick={() => onPick(wikiLink(linkTarget(n.path, paths), selection))}
            >
              <span className="link-picker-title">{n.title}</span>
              {folderOf(n.path) && <span className="hint">{displayPath(folderOf(n.path))}</span>}
            </button>
          </li>
        ))}
        {typed && !exact && (
          <li>
            <button type="button" onClick={() => onPick(wikiLink(typed, selection))}>
              <span className="link-picker-title">「{typed}」への新しいリンク</span>
              <span className="hint">まだないノート。リンクを開くと作成できます</span>
            </button>
          </li>
        )}
        {hits.length === 0 && !typed && <li className="hint">まだノートがありません</li>}
      </ul>
    </Modal>
  );
}
