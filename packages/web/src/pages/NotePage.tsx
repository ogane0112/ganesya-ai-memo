import { parseNoteLenient, replaceInlineView } from '@gmemo/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, describeError } from '../api/client';
import type { BlockAttribution, HistoryEntry } from '../api/types';
import { Icon } from '../components/Icon';
import { InlineView } from '../components/InlineView';
import { BlameView } from '../components/MarkdownView';
import { NoteEditor } from '../components/NoteEditor';
import { Badge, EmptyState, ErrorBox, Loading, Modal } from '../components/ui';
import { displayValue, formatDateTime, relativeTime } from '../lib/format';
import { useAsync, useDocumentTitle, useOnline } from '../lib/hooks';
import { linkKindLabel } from '../lib/links';
import {
  displayPath,
  folderOf,
  noteUrl,
  pathFromSplat,
  titleFromPath,
  toNotePath,
} from '../lib/paths';
import { pendingFor } from '../lib/queue';
import { syncQueue } from '../lib/sync';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';

const HIDDEN_PROPS = new Set(['title', 'tags', 'created_by', 'ai_agent']);
const ACCESS_LABEL: Record<string, string> = {
  external: '外部AI可',
  local: 'ローカルAIのみ',
  none: 'AI送信なし',
};

export function NotePage() {
  const params = useParams();
  const path = pathFromSplat(params['*'] ?? '');
  const [search, setSearch] = useSearchParams();
  const editing = search.get('edit') === '1';
  const commit = search.get('commit') ?? undefined;
  const { paths, notesLoaded, lastChange, refreshNotes, queue } = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const online = useOnline();

  // Skip the request for notes the index does not know (new notes, unresolved [[links]]).
  const known = !notesLoaded || !!commit || paths.includes(path) || syncQueue.wasSaved(path);
  const note = useAsync(async () => {
    if (!known) return null;
    try {
      return await api.note(path, commit);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }, [path, commit, known]);
  const blame = useAsync<BlockAttribution[]>(
    () => (commit || !known ? Promise.resolve([]) : api.blame(path).catch(() => [])),
    [path, commit, known],
  );
  const links = useAsync(
    () =>
      known
        ? api.backlinks(path).catch(() => ({ backlinks: [], outgoing: [] }))
        : Promise.resolve({ backlinks: [], outgoing: [] }),
    [path, known],
  );
  const [tab, setTab] = useState<'note' | 'history'>('note');
  const [renaming, setRenaming] = useState(false);

  const doc = note.data;
  const pending = pendingFor(queue, path);
  const pendingContent = pending?.op.kind === 'save' ? pending.op.content : null;
  const content = pendingContent ?? doc?.content ?? '';
  const parsed = useMemo(() => parseNoteLenient(content), [content]);
  const heading = /^#\s+(.+)$/m.exec(parsed.body)?.[1]?.trim();
  const title =
    (typeof parsed.frontmatter['title'] === 'string'
      ? (parsed.frontmatter['title'] as string)
      : undefined) ??
    heading ??
    titleFromPath(path);
  useDocumentTitle(title);

  // Someone else changed this note: reload (unless we are editing).
  useEffect(() => {
    if (
      !lastChange ||
      editing ||
      commit ||
      !(lastChange.paths.includes(path) || lastChange.paths.includes('*'))
    )
      return;
    note.reload();
    blame.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastChange]);

  // A save of this note reached the server: show exactly what was saved without
  // waiting, then fetch the rest (who wrote what, links) behind it.
  const docRef = useRef(doc);
  docRef.current = doc;
  useEffect(() => {
    if (commit) return;
    return syncQueue.onResult((item, outcome) => {
      if (item.op.kind !== 'save' || item.op.path !== path || outcome.type !== 'committed') return;
      const saved = { content: item.op.content, sha: outcome.sha, commit: outcome.commit };
      note.setData({ path, frontmatter: {}, ...docRef.current, ...saved });
      note.reload();
      blame.reload();
      links.reload();
      refreshNotes();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, commit]);

  const setEditing = (on: boolean) => {
    const next = new URLSearchParams(search);
    if (on) next.set('edit', '1');
    else next.delete('edit');
    setSearch(next, { replace: !on });
  };

  if (note.loading && !doc) return <Loading />;
  if (note.error && !pendingContent) return <ErrorBox error={note.error} onRetry={note.reload} />;

  if (editing && !commit) {
    return (
      <NoteEditor
        key={path}
        path={path}
        content={doc?.content ?? pendingContent}
        sha={doc ? doc.sha : null}
        {...(doc?.commit ? { commit: doc.commit } : {})}
        onDone={() => {
          setEditing(false);
          note.reload();
          blame.reload();
          refreshNotes();
        }}
      />
    );
  }

  if (doc === null && !pendingContent) {
    return (
      <div className="page">
        <EmptyState icon="file" title="このノートはまだありません">
          <p>{displayPath(path)}</p>
          <button type="button" className="btn btn-primary" onClick={() => setEditing(true)}>
            <Icon name="plus" />
            作成する
          </button>
        </EmptyState>
      </div>
    );
  }

  const props = Object.entries(parsed.frontmatter).filter(([k]) => !HIDDEN_PROPS.has(k));
  const tags = Array.isArray(parsed.frontmatter['tags'])
    ? (parsed.frontmatter['tags'] as unknown[]).map(String)
    : [];
  const aiBlocks = (blame.data ?? []).filter((b) => b.author.kind === 'ai');
  const agents = [...new Set(aiBlocks.map((b) => b.author.name))];

  // An inline view's tabs and settings rewrite its block in this note, saved like an edit.
  const changeView = async (index: number, next: string) => {
    try {
      const queued = pendingFor(syncQueue.snapshot, path);
      if (queued?.op.kind === 'save') {
        await syncQueue.enqueue({
          ...queued.op,
          content: replaceInlineView(queued.op.content, index, next),
        });
        return;
      }
      const fresh = await api.note(path);
      const content = replaceInlineView(fresh.content, index, next);
      if (content !== fresh.content)
        await syncQueue.enqueue({
          kind: 'save',
          path,
          content,
          baseSha: fresh.sha,
          baseCommit: fresh.commit,
        });
    } catch (e) {
      toast.show(`一覧の設定を保存できませんでした: ${describeError(e)}`, { kind: 'error' });
    }
  };

  const remove = async () => {
    if (!confirm(`「${title}」を削除しますか?(履歴からは復元できます)`)) return;
    try {
      await api.deleteNote(path);
      refreshNotes();
      toast.show('削除しました');
      navigate('/notes', { replace: true });
    } catch (e) {
      toast.show(describeError(e), { kind: 'error' });
    }
  };

  return (
    <article className="page note-page">
      {commit && (
        <div className="banner banner-info">
          <span>過去の版({commit.slice(0, 8)})を表示しています。</span>
          <Link to={noteUrl(path)} className="btn btn-small">
            最新を表示
          </Link>
        </div>
      )}
      <header className="note-head">
        <div className="crumbs">
          {folderOf(path) ? (
            <Link to={`/notes?folder=${encodeURIComponent(folderOf(path))}`} className="crumb">
              {folderOf(path)}
            </Link>
          ) : (
            <span className="crumb">ルート</span>
          )}
          {doc?.access && (
            <Badge
              tone={
                doc.access === 'external' ? 'warn' : doc.access === 'none' ? 'danger' : 'neutral'
              }
            >
              {ACCESS_LABEL[doc.access]}
            </Badge>
          )}
          {parsed.frontmatter['created_by'] === 'ai' && (
            <Badge tone="ai">
              AI作成
              {parsed.frontmatter['ai_agent']
                ? `: ${displayValue(parsed.frontmatter['ai_agent'])}`
                : ''}
            </Badge>
          )}
          {pendingContent !== null && <Badge tone="accent">未同期</Badge>}
        </div>
        <h1 className="note-title">{title}</h1>
        <div className="note-actions">
          {!commit && (
            <button type="button" className="btn btn-primary" onClick={() => setEditing(true)}>
              <Icon name="edit" size={18} />
              編集
            </button>
          )}
          <Link className="btn" to={`/search?tab=ask&path=${encodeURIComponent(path)}`}>
            <Icon name="ask" size={18} />
            質問
          </Link>
          <button
            type="button"
            className={tab === 'history' ? 'btn active' : 'btn'}
            aria-pressed={tab === 'history'}
            onClick={() => setTab(tab === 'history' ? 'note' : 'history')}
          >
            <Icon name="history" size={18} />
            履歴
          </button>
          <details className="menu">
            <summary className="btn" aria-label="その他の操作">
              <Icon name="more" size={18} />
            </summary>
            <div className="menu-list">
              <button type="button" onClick={() => setRenaming(true)} disabled={!online}>
                名前・場所を変更
              </button>
              <button type="button" onClick={() => void navigator.clipboard?.writeText(content)}>
                Markdown をコピー
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => void remove()}
                disabled={!online}
              >
                削除
              </button>
            </div>
          </details>
        </div>
      </header>

      {tab === 'history' ? (
        <NoteHistory path={path} onClose={() => setTab('note')} />
      ) : (
        <>
          {(tags.length > 0 || props.length > 0) && (
            <section className="props" aria-label="プロパティ">
              {tags.length > 0 && (
                <div className="tags">
                  {tags.map((t) => (
                    <Link key={t} className="tag" to={`/search?q=${encodeURIComponent('#' + t)}`}>
                      #{t}
                    </Link>
                  ))}
                </div>
              )}
              {props.length > 0 && (
                <dl className="prop-list">
                  {props.map(([k, v]) => (
                    <div key={k} className="prop">
                      <dt>{k}</dt>
                      <dd>{displayValue(v)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
          )}
          {agents.length > 0 && (
            <p className="ai-legend">
              <span className="ai-swatch" aria-hidden="true" />
              色付きの段落は AI({agents.join('、')})が書いた部分です。タップすると詳細を表示します。
            </p>
          )}
          <BlameView
            body={parsed.body}
            blame={pendingContent !== null ? [] : (blame.data ?? [])}
            paths={paths}
            hideTitle={heading === title ? title : undefined}
            renderView={(src, i) => (
              <InlineView
                source={src}
                {...(commit ? {} : { onChange: (next: string) => void changeView(i, next) })}
              />
            )}
          />

          <section className="links-section" aria-labelledby="backlinks-h">
            <h2 id="backlinks-h">このノートへのリンク</h2>
            {links.loading ? (
              <Loading />
            ) : links.data?.backlinks.length ? (
              <ul className="link-list">
                {links.data.backlinks.map((b) => (
                  <li key={b.path}>
                    <Link to={noteUrl(b.path)}>{b.title}</Link>{' '}
                    <span className="hint">({b.kinds.map(linkKindLabel).join('・')})</span>
                    {b.context && <p className="hint">{b.context}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">
                まだありません。他のノートから [[{titleFromPath(path)}]] と書くか、Markdownリンクや
                frontmatter の related に {path} を書くとリンクできます。
              </p>
            )}
            {links.data && links.data.outgoing.some((o) => !o.path) && (
              <>
                <h3>まだ存在しないリンク先</h3>
                <ul className="chip-list">
                  {links.data.outgoing
                    .filter((o) => !o.path)
                    .map((o) => (
                      <li key={o.target}>
                        <Link className="chip" to={noteUrl(toNotePath(o.target), { edit: true })}>
                          {o.target} を作成
                        </Link>
                      </li>
                    ))}
                </ul>
              </>
            )}
          </section>
          {doc && (
            <p className="hint note-foot">
              最終更新{' '}
              {formatDateTime(
                blame.data?.reduce((d, b) => (b.date > d ? b.date : d), '') || null,
              ) || '—'}
            </p>
          )}
        </>
      )}
      <RenameDialog
        open={renaming}
        path={path}
        onClose={() => setRenaming(false)}
        onRenamed={(to) => {
          setRenaming(false);
          refreshNotes();
          navigate(noteUrl(to), { replace: true });
        }}
      />
    </article>
  );
}

function RenameDialog({
  open,
  path,
  onClose,
  onRenamed,
}: {
  open: boolean;
  path: string;
  onClose: () => void;
  onRenamed: (to: string) => void;
}) {
  const [value, setValue] = useState(path.replace(/\.md$/, ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => {
    if (open) {
      setValue(path.replace(/\.md$/, ''));
      setError(null);
    }
  }, [open, path]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const to = toNotePath(value);
    if (!to || to === path) return onClose();
    setBusy(true);
    try {
      await api.renameNote(path, to);
      toast.show('名前を変更しました(リンクも更新しました)', { kind: 'success' });
      onRenamed(to);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="名前・場所を変更">
      <form onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label htmlFor="rename-to">新しいパス(フォルダ/名前)</label>
          <input
            id="rename-to"
            className="input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
          <div className="hint">このノートへの [[リンク]] も自動で書き換えます。</div>
        </div>
        {error && <p className="notice notice-error">{error}</p>}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            変更
          </button>
        </div>
      </form>
    </Modal>
  );
}

function NoteHistory({ path, onClose }: { path: string; onClose: () => void }) {
  const hist = useAsync<HistoryEntry[]>(() => api.noteHistory(path), [path]);
  const toast = useToast();
  const navigate = useNavigate();
  const revert = async (h: HistoryEntry) => {
    if (!confirm(`「${h.subject}」の変更を取り消しますか?`)) return;
    try {
      const r = await api.revert(h.sha);
      if (r.status === 'proposed' && !r.merged) {
        toast.show('後の変更とぶつかるため、取り消しを提案として作成しました', {
          kind: 'info',
          action: {
            label: '確認',
            onClick: () => navigate(`/review/${encodeURIComponent(r.proposalId)}`),
          },
        });
      } else toast.show('取り消しました', { kind: 'success' });
      hist.reload();
      onClose();
    } catch (e) {
      toast.show(describeError(e), { kind: 'error' });
    }
  };
  if (hist.loading) return <Loading />;
  if (hist.error) return <ErrorBox error={hist.error} onRetry={hist.reload} />;
  if (!hist.data?.length) return <EmptyState icon="history" title="履歴はまだありません" />;
  return (
    <ol className="history-list">
      {hist.data.map((h, i) => (
        <li key={h.sha} className="history-item">
          <div className="history-main">
            <span className={h.authorKind === 'ai' ? 'who who-ai' : 'who'}>
              {h.authorKind === 'ai' && <Icon name="bot" size={14} />}
              {h.author}
            </span>
            <span className="history-subject">{h.subject}</span>
            <time className="hint" dateTime={h.date} title={formatDateTime(h.date)}>
              {relativeTime(h.date)}
            </time>
          </div>
          <div className="row">
            {i > 0 && (
              <Link className="btn btn-small" to={noteUrl(path, { commit: h.sha })}>
                この版を見る
              </Link>
            )}
            <button type="button" className="btn btn-small" onClick={() => void revert(h)}>
              取り消す
            </button>
          </div>
        </li>
      ))}
    </ol>
  );
}
