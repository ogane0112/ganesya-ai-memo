import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, describeError } from '../api/client';
import { FolderPicker } from '../components/FolderPicker';
import { Icon } from '../components/Icon';
import { NoteCard } from '../components/NoteCard';
import { Badge, EmptyState, Loading, Modal, PageHeader } from '../components/ui';
import { useDocumentTitle } from '../lib/hooks';
import { primeKeyboard } from '../lib/keyboard';
import { displayPath, folderList, newNoteUrl, noteUrl, titleFromPath } from '../lib/paths';
import { useApp } from '../state/app';
import { useDeleteFolder } from '../state/folders';
import { useToast } from '../state/toast';

type Sort = 'updated' | 'title';

export function NotesListPage() {
  useDocumentTitle('ノート');
  const { notes, notesLoaded, queue, folders: created } = useApp();
  const [params, setParams] = useSearchParams();
  const folder = params.get('folder') ?? '';
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort>('updated');
  const [creatingFolder, setCreatingFolder] = useState(params.get('newFolder') === '1');
  const navigate = useNavigate();
  /** A new memo opens right away, ready to type (in this folder, if one is chosen). */
  const newNote = () => {
    primeKeyboard();
    navigate(newNoteUrl(folder));
  };

  useEffect(() => {
    // Old links (?new=1) open the new memo too.
    if (params.get('new') === '1') navigate(newNoteUrl(folder), { replace: true });
    if (params.get('newFolder') === '1') setCreatingFolder(true);
  }, [params, folder, navigate]);

  const folders = useMemo(
    () =>
      folderList(
        notes.map((n) => n.path),
        created,
      ),
    [notes, created],
  );

  const dropParam = (name: string) => {
    if (!params.get(name)) return;
    const next = new URLSearchParams(params);
    next.delete(name);
    setParams(next, { replace: true });
  };

  const pendingPaths = useMemo(
    () => new Set(queue.items.flatMap((i) => (i.op.kind === 'save' ? [i.op.path] : []))),
    [queue],
  );

  const list = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const out = notes.filter(
      (n) =>
        (!folder || n.path.startsWith(folder + '/')) &&
        (!f ||
          n.title.toLowerCase().includes(f) ||
          n.path.toLowerCase().includes(f) ||
          n.tags.some((t) => t.includes(f.replace(/^#/, '')))),
    );
    out.sort((a, b) =>
      sort === 'title'
        ? a.title.localeCompare(b.title, 'ja', { numeric: true })
        : (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
    );
    return out;
  }, [notes, folder, filter, sort]);

  const deleteFolder = useDeleteFolder();
  // The chosen folder holds no notes, not even in folders inside it: it can be deleted.
  const folderIsEmpty =
    !!folder &&
    !notes.some((n) => n.path.startsWith(`${folder}/`)) &&
    ![...pendingPaths].some((p) => p.startsWith(`${folder}/`));

  // Queued new notes that the server does not know yet.
  const unsynced = useMemo(
    () => [...pendingPaths].filter((p) => !notes.some((n) => n.path === p)),
    [pendingPaths, notes],
  );

  return (
    <div className="page">
      <PageHeader
        title="ノート"
        sub={`${notes.length} 件`}
        actions={
          <>
            <button type="button" className="btn" onClick={() => setCreatingFolder(true)}>
              <Icon name="folder" size={18} />
              フォルダー
            </button>
            <button type="button" className="btn btn-primary" onClick={newNote}>
              <Icon name="plus" size={18} />
              新規
            </button>
          </>
        }
      />
      <div className="toolbar-row">
        <label className="visually-hidden" htmlFor="notes-filter">
          絞り込み
        </label>
        <input
          id="notes-filter"
          className="input"
          type="search"
          placeholder="タイトル・タグで絞り込み"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="visually-hidden" htmlFor="notes-folder">
          フォルダ
        </label>
        <select
          id="notes-folder"
          className="input select"
          value={folder}
          onChange={(e) => {
            const next = new URLSearchParams(params);
            if (e.target.value) next.set('folder', e.target.value);
            else next.delete('folder');
            setParams(next, { replace: true });
          }}
        >
          <option value="">すべてのフォルダ</option>
          {folders.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <label className="visually-hidden" htmlFor="notes-sort">
          並び順
        </label>
        <select
          id="notes-sort"
          className="input select"
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
        >
          <option value="updated">更新順</option>
          <option value="title">名前順</option>
        </select>
      </div>
      {!notesLoaded ? (
        <Loading />
      ) : folderIsEmpty ? (
        <EmptyState icon="folder" title={`「${folder.split('/').join(' › ')}」は空です`}>
          <div className="row wrap">
            <button type="button" className="btn btn-primary" onClick={newNote}>
              <Icon name="plus" size={18} />
              ノートを追加
            </button>
            <button
              type="button"
              className="btn btn-danger-text"
              onClick={() =>
                void deleteFolder(folder, {
                  hasSubfolders: folders.some((f) => f.startsWith(`${folder}/`)),
                }).then((deleted) => {
                  if (!deleted) return;
                  const next = new URLSearchParams(params);
                  next.delete('folder');
                  setParams(next, { replace: true });
                })
              }
            >
              <Icon name="trash" size={18} />
              フォルダーを削除
            </button>
          </div>
        </EmptyState>
      ) : list.length === 0 && unsynced.length === 0 ? (
        <EmptyState title={notes.length ? '該当するノートがありません' : 'まだノートがありません'}>
          {!notes.length && (
            <button type="button" className="btn btn-primary" onClick={newNote}>
              最初のメモを書く
            </button>
          )}
        </EmptyState>
      ) : (
        <ul className="card-list">
          {unsynced.map((p) => (
            <li key={p}>
              <Link to={noteUrl(p)} className="note-card">
                <span className="note-card-title">{titleFromPath(p)}</span>
                <span className="note-card-meta">
                  <Badge tone="accent">未同期</Badge>
                  <span className="mono">{displayPath(p)}</span>
                </span>
              </Link>
            </li>
          ))}
          {list.map((n) => (
            <li key={n.path}>
              <NoteCard note={n} unsynced={pendingPaths.has(n.path)} />
            </li>
          ))}
        </ul>
      )}
      <NewFolderDialog
        open={creatingFolder}
        folders={folders}
        defaultParent={folder}
        onClose={() => {
          setCreatingFolder(false);
          dropParam('newFolder');
        }}
      />
    </div>
  );
}

/** Create a folder on its own. Notes can be added to it afterwards. */
export function NewFolderDialog({
  open,
  onClose,
  folders,
  defaultParent,
}: {
  open: boolean;
  onClose: () => void;
  folders: string[];
  defaultParent: string;
}) {
  const [name, setName] = useState('');
  const [parent, setParent] = useState(defaultParent);
  const [busy, setBusy] = useState(false);
  const { refreshNotes } = useApp();
  const toast = useToast();
  useEffect(() => {
    if (open) {
      setName('');
      setParent(defaultParent);
    }
  }, [open, defaultParent]);
  const path = [parent, name]
    .flatMap((s) => s.split(/[\\/]/))
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/');
  const shown = path.split('/').join(' › ');
  const exists = !!name.trim() && folders.some((f) => f.toLowerCase() === path.toLowerCase());
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    if (exists) return onClose();
    setBusy(true);
    try {
      await api.createFolder(path);
      refreshNotes();
      toast.show('フォルダーを作成しました', { kind: 'success', duration: 2000 });
      onClose();
    } catch (err) {
      toast.show(describeError(err), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="新しいフォルダー">
      <form onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label htmlFor="folder-name">フォルダー名</label>
          <input
            id="folder-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
          />
        </div>
        <div className="field">
          <span className="label">作成する場所</span>
          <FolderPicker
            label="フォルダーを作る場所"
            value={parent}
            onChange={setParent}
            folders={folders}
            emptyLabel="いちばん上"
          />
        </div>
        {name.trim() && (
          <p className="hint">{exists ? `「${shown}」はすでにあります` : `作成先: ${shown}`}</p>
        )}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy}>
            作成
          </button>
        </div>
      </form>
    </Modal>
  );
}
