import { useEffect, useRef, useState } from 'react';
import { cleanFolderPath } from './FolderPicker';
import { Icon } from './Icon';
import { Modal, Spinner } from './ui';

/** Where a new memo goes: a folder (`''` is the top), or appended to today's memo. */
export type SaveTarget = { kind: 'folder'; folder: string } | { kind: 'append' };

const LAST_KEY = 'gmemo.lastSaveTarget';

/** The place chosen last time (remembered on this device), else Inbox. */
export function lastSaveTarget(): SaveTarget {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (raw) {
      const t = JSON.parse(raw) as SaveTarget;
      if (t.kind === 'append' || (t.kind === 'folder' && typeof t.folder === 'string')) return t;
    }
  } catch {
    /* nothing remembered */
  }
  return { kind: 'folder', folder: 'Inbox' };
}

export function rememberSaveTarget(t: SaveTarget): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(t));
  } catch {
    /* not remembered */
  }
}

const same = (a: SaveTarget, b: SaveTarget) =>
  a.kind === b.kind && (a.kind === 'append' || a.folder === (b as { folder: string }).folder);

/**
 * "Where do you want to save this?" — asked when a new memo is finished, not
 * before it is written. The last place is chosen already, so one tap saves.
 */
export function SaveSheet({
  open,
  initial,
  folders,
  busy,
  onSave,
  onKeepDraft,
  onClose,
}: {
  open: boolean;
  initial: SaveTarget;
  folders: readonly string[];
  busy: boolean;
  onSave: (target: SaveTarget) => void;
  onKeepDraft: () => void;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<SaveTarget>(initial);
  const [typed, setTyped] = useState('');
  const chosen = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    setTarget(initial);
    setTyped('');
    requestAnimationFrame(() => chosen.current?.scrollIntoView?.({ block: 'nearest' }));
  }, [open, initial]);

  // The chosen folder may be a new one typed below: list it too.
  const list = [
    ...new Set([...folders, ...(target.kind === 'folder' && target.folder ? [target.folder] : [])]),
  ].sort((a, b) => a.localeCompare(b, 'ja'));
  const typedPath = cleanFolderPath(typed);

  const option = (t: SaveTarget, label: string, icon: string, depth = 0, key?: string) => {
    const on = same(t, target);
    return (
      <button
        key={key ?? label}
        type="button"
        role="radio"
        aria-checked={on}
        className="folder-option"
        style={depth ? { paddingLeft: 12 + depth * 18 } : undefined}
        ref={on ? chosen : null}
        onClick={() => setTarget(t)}
      >
        <Icon name={icon} size={18} />
        <span className="folder-option-name">{label}</span>
        {on && <Icon name="check" size={18} />}
      </button>
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="どこに保存しますか?"
      sheet
      footer={
        <>
          <button type="button" className="btn" onClick={onKeepDraft} disabled={busy}>
            下書きに残す
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onSave(target)}
            disabled={busy}
          >
            {busy && <Spinner />}
            {target.kind === 'append' ? '追記' : '保存'}
          </button>
        </>
      }
    >
      <div className="folder-options" role="radiogroup" aria-label="保存先">
        {option({ kind: 'append' }, '今日のメモに追記', 'calendar')}
        {option({ kind: 'folder', folder: '' }, 'いちばん上', 'folder')}
        {list.map((f) => {
          const parts = f.split('/');
          return option(
            { kind: 'folder', folder: f },
            parts[parts.length - 1]!,
            'folder',
            parts.length - 1,
            f,
          );
        })}
      </div>
      <form
        className="folder-new"
        onSubmit={(e) => {
          e.preventDefault();
          if (!typedPath) return;
          setTarget({ kind: 'folder', folder: typedPath });
          setTyped('');
        }}
      >
        <label htmlFor="save-new-folder">新しいフォルダー</label>
        <div className="row">
          <input
            id="save-new-folder"
            className="input"
            value={typed}
            placeholder="例: Projects/新規"
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
          <button type="submit" className="btn" disabled={!typedPath}>
            選ぶ
          </button>
        </div>
      </form>
    </Modal>
  );
}
