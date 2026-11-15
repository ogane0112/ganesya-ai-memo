import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { Modal } from './ui';

/** `a//b/../c` → `a/b/c`: the folder a typed path means. */
export function cleanFolderPath(input: string): string {
  return input
    .split(/[\\/]/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
}

/**
 * Chooses a folder: the current one is shown as a button, and a tap opens the
 * folders as an indented list (a hierarchy is easier to see than a text box
 * with suggestions). A folder that does not exist yet can be typed as a path.
 */
export function FolderPicker({
  value,
  onChange,
  folders,
  label,
  emptyLabel = 'ルート',
  allowEmpty = true,
}: {
  value: string;
  onChange: (folder: string) => void;
  /** Every existing folder, as paths (`A`, `A/B`). */
  folders: readonly string[];
  /** What the field is for, for screen readers and the dialog title. */
  label: string;
  /** How "no folder" (the top level) is called. */
  emptyLabel?: string;
  /** Offer "no folder" as a choice. */
  allowEmpty?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const current = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setTyped('');
    // Show the chosen folder even when the list is long.
    requestAnimationFrame(() => current.current?.scrollIntoView?.({ block: 'center' }));
  }, [open]);

  const choose = (path: string) => {
    onChange(path);
    setOpen(false);
  };
  const typedPath = cleanFolderPath(typed);
  const isNew = !!typedPath && !folders.includes(typedPath);
  const shown = value ? value.split('/').join(' › ') : emptyLabel;

  return (
    <>
      <button
        type="button"
        className="folder-field"
        aria-haspopup="dialog"
        aria-label={`${label}: ${shown}(変更する)`}
        onClick={() => setOpen(true)}
      >
        <Icon name="folder" size={18} />
        <span className="folder-field-label">{shown}</span>
        <Icon name="down" size={16} />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={label}>
        <div className="folder-options" role="radiogroup" aria-label={label}>
          {allowEmpty && (
            <button
              type="button"
              role="radio"
              aria-checked={value === ''}
              className="folder-option"
              ref={value === '' ? current : null}
              onClick={() => choose('')}
            >
              <Icon name="folder" size={18} />
              <span className="folder-option-name">{emptyLabel}</span>
              {value === '' && <Icon name="check" size={18} />}
            </button>
          )}
          {folders.map((f) => {
            const parts = f.split('/');
            return (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={value === f}
                className="folder-option"
                style={{ paddingLeft: 12 + (parts.length - 1) * 18 }}
                title={f}
                ref={value === f ? current : null}
                onClick={() => choose(f)}
              >
                <Icon name="folder" size={18} />
                <span className="folder-option-name">{parts[parts.length - 1]}</span>
                {value === f && <Icon name="check" size={18} />}
              </button>
            );
          })}
          {folders.length === 0 && !allowEmpty && (
            <p className="hint">まだフォルダーがありません。下に名前を入力して作れます。</p>
          )}
        </div>
        <form
          className="folder-new"
          onSubmit={(e) => {
            e.preventDefault();
            if (typedPath) choose(typedPath);
          }}
        >
          <label htmlFor="folder-new-input">新しいフォルダー</label>
          <div className="row">
            <input
              id="folder-new-input"
              className="input"
              value={typed}
              placeholder="例: Projects/新規"
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
            />
            <button type="submit" className="btn btn-primary" disabled={!typedPath}>
              決定
            </button>
          </div>
          <p className="hint">
            {typedPath
              ? `${isNew ? '作成先' : 'すでにあります'}: ${typedPath.split('/').join(' › ')}`
              : '/ で区切ると、中のフォルダーも作れます。'}
          </p>
        </form>
      </Modal>
    </>
  );
}
