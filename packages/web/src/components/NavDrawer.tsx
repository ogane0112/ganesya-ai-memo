import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { NoteSummary } from '../api/types';
import { Icon } from './Icon';
import { NoteTree } from './NoteTree';

/**
 * The folder tree as a menu that slides in from the left on phones (the
 * desktop sidebar shows the same tree). A modal dialog: the browser keeps
 * focus inside it, closes it on Escape and ignores the page behind it.
 */
export function NavDrawer({
  open,
  onClose,
  notes,
  folders,
  notesLoaded,
  username,
  onDeleteFolder,
}: {
  open: boolean;
  onClose: () => void;
  notes: NoteSummary[];
  /** Folders created on their own (shown even when empty). */
  folders: string[];
  notesLoaded: boolean;
  username?: string | undefined;
  onDeleteFolder: (path: string, opts: { hasSubfolders: boolean }) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-label="フォルダーとノート"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // A tap on the dimmed area lands on the dialog itself, not on what is inside it.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open && (
        <div className="drawer-inner">
          <div className="drawer-head">
            <span>ノート</span>
            <span className="row">
              <Link
                to="/notes?newFolder=1"
                className="icon-btn"
                aria-label="新しいフォルダー"
                onClick={onClose}
              >
                <Icon name="folder" size={20} />
              </Link>
              <Link
                to="/notes?new=1"
                className="icon-btn"
                aria-label="新しいノート"
                onClick={onClose}
              >
                <Icon name="plus" size={20} />
              </Link>
              <button type="button" className="icon-btn" aria-label="閉じる" onClick={onClose}>
                <Icon name="x" size={20} />
              </button>
            </span>
          </div>
          <div className="drawer-body">
            {notesLoaded && notes.length === 0 && folders.length === 0 ? (
              <p className="hint pad">まだノートがありません</p>
            ) : (
              <NoteTree
                notes={notes}
                folders={folders}
                onNavigate={onClose}
                onDeleteFolder={onDeleteFolder}
              />
            )}
          </div>
          <div className="drawer-foot">
            <span>{username}</span>
            <Link to="/privacy" onClick={onClose}>
              データの扱い
            </Link>
          </div>
        </div>
      )}
    </dialog>
  );
}
