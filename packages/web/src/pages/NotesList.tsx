import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { NoteCard } from '../components/NoteCard';
import { Badge, EmptyState, Loading, Modal, PageHeader } from '../components/ui';
import { useDocumentTitle } from '../lib/hooks';
import { noteUrl, toNotePath } from '../lib/paths';
import { useApp } from '../state/app';

type Sort = 'updated' | 'title';

export function NotesListPage() {
  useDocumentTitle('ノート');
  const { notes, notesLoaded, queue } = useApp();
  const [params, setParams] = useSearchParams();
  const folder = params.get('folder') ?? '';
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort>('updated');
  const [creating, setCreating] = useState(params.get('new') === '1');

  useEffect(() => {
    if (params.get('new') === '1') setCreating(true);
  }, [params]);

  const folders = useMemo(() => {
    const s = new Set<string>();
    for (const n of notes) {
      const i = n.path.lastIndexOf('/');
      if (i > 0) s.add(n.path.slice(0, i));
    }
    return [...s].sort((a, b) => a.localeCompare(b, 'ja'));
  }, [notes]);

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
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={18} />
            新規
          </button>
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
      ) : list.length === 0 && unsynced.length === 0 ? (
        <EmptyState title={notes.length ? '該当するノートがありません' : 'まだノートがありません'}>
          {!notes.length && (
            <Link to="/" className="btn btn-primary">
              最初のメモを書く
            </Link>
          )}
        </EmptyState>
      ) : (
        <ul className="card-list">
          {unsynced.map((p) => (
            <li key={p}>
              <Link to={noteUrl(p)} className="note-card">
                <span className="note-card-title">{p.split('/').pop()?.replace(/\.md$/, '')}</span>
                <span className="note-card-meta">
                  <Badge tone="accent">未同期</Badge>
                  <span className="mono">{p}</span>
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
      <NewNoteDialog
        open={creating}
        folders={folders}
        defaultFolder={folder}
        onClose={() => {
          setCreating(false);
          if (params.get('new')) {
            const next = new URLSearchParams(params);
            next.delete('new');
            setParams(next, { replace: true });
          }
        }}
      />
    </div>
  );
}

export function NewNoteDialog({
  open,
  onClose,
  folders,
  defaultFolder,
}: {
  open: boolean;
  onClose: () => void;
  folders: string[];
  defaultFolder: string;
}) {
  const [title, setTitle] = useState('');
  const [folder, setFolder] = useState(defaultFolder);
  const { notes } = useApp();
  const navigate = useNavigate();
  useEffect(() => {
    if (open) {
      setTitle('');
      setFolder(defaultFolder);
    }
  }, [open, defaultFolder]);
  const path = title.trim() ? toNotePath(title, folder.trim()) : '';
  const exists = !!path && notes.some((n) => n.path.toLowerCase() === path.toLowerCase());
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!path) return;
    onClose();
    navigate(noteUrl(path, { edit: !exists }));
  };
  return (
    <Modal open={open} onClose={onClose} title="新しいノート">
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="new-title">タイトル</label>
          <input
            id="new-title"
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            required
          />
        </div>
        <div className="field">
          <label htmlFor="new-folder">フォルダ(空欄 = ルート)</label>
          <input
            id="new-folder"
            className="input"
            list="new-folders"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
          />
          <datalist id="new-folders">
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </div>
        {path && (
          <p className="hint mono">{exists ? `${path} はすでにあります(開きます)` : path}</p>
        )}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" className="btn btn-primary" disabled={!path}>
            {exists ? '開く' : '作成'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
