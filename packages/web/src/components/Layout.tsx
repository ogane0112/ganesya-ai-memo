import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useIsPhone, useOnline } from '../lib/hooks';
import { displayPath } from '../lib/paths';
import { syncQueue } from '../lib/sync';
import { useApp } from '../state/app';
import { useDeleteFolder } from '../state/folders';
import { Icon } from './Icon';
import { NavDrawer } from './NavDrawer';
import { NoteTree } from './NoteTree';

const NAV = [
  { to: '/', label: '書く', icon: 'pen', end: true },
  { to: '/notes', label: 'ノート', icon: 'notes' },
  { to: '/search', label: '検索', icon: 'search' },
  { to: '/review', label: 'レビュー', icon: 'review' },
  { to: '/views', label: 'ビュー', icon: 'table', desktopOnly: true },
  { to: '/graph', label: 'グラフ', icon: 'graph', desktopOnly: true },
  { to: '/history', label: '履歴', icon: 'history', desktopOnly: true },
  { to: '/settings', label: '設定', icon: 'settings', desktopOnly: true },
  { to: '/more', label: 'その他', icon: 'more', phoneOnly: true },
] as const;

function SyncStatus() {
  const { queue } = useApp();
  const online = useOnline();
  const pending = queue.items.filter((i) => i.state !== 'failed').length;
  const failed = queue.items.filter((i) => i.state === 'failed');
  return (
    <>
      {!online && (
        <div className="statusbar statusbar-offline" role="status">
          <Icon name="offline" size={16} />
          オフラインです。書いた内容はこの端末に保存され、接続が戻ると同期されます。
          {pending > 0 && <strong>(未送信 {pending} 件)</strong>}
        </div>
      )}
      {online && pending > 0 && (
        <div className="statusbar" role="status">
          <Icon name="sync" size={16} />
          同期中… 未送信 {pending} 件
        </div>
      )}
      {failed.map((f) => (
        <div key={f.id} className="statusbar statusbar-error" role="alert">
          <span>
            保存に失敗しました({f.op.kind === 'save' ? f.op.path : 'メモ'}): {f.error}
          </span>
          <span className="row">
            <button type="button" className="btn btn-small" onClick={() => syncQueue.retry(f.id)}>
              再送
            </button>
            <button
              type="button"
              className="btn btn-small btn-danger-text"
              onClick={() => {
                if (confirm('この未送信の変更を破棄しますか?')) syncQueue.discard(f.id);
              }}
            >
              破棄
            </button>
          </span>
        </div>
      ))}
      {queue.conflicts.map((c) => (
        <div key={c.id} className="statusbar statusbar-warn" role="alert">
          <span>「{displayPath(c.path)}」は他の変更と自動で統合できませんでした。</span>
          <span className="row">
            <Link
              className="btn btn-small btn-primary"
              to={`/review/${encodeURIComponent(c.proposalId)}`}
              onClick={() => syncQueue.dismissConflict(c.id)}
            >
              競合を確認
            </Link>
            <button
              type="button"
              className="icon-btn"
              aria-label="閉じる"
              onClick={() => syncQueue.dismissConflict(c.id)}
            >
              <Icon name="x" size={16} />
            </button>
          </span>
        </div>
      ))}
    </>
  );
}

export function Layout() {
  const { openProposals, notes, notesLoaded, folders, auth } = useApp();
  const loc = useLocation();
  const [typing, setTyping] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const phone = useIsPhone();

  // Leaving the phone layout (rotating, resizing) or changing page closes the menu.
  useEffect(() => {
    if (!phone) setMenuOpen(false);
  }, [phone]);
  useEffect(() => setMenuOpen(false), [loc.pathname, loc.search]);

  const deleteFolder = useDeleteFolder();

  // Hide the phone tab bar while the keyboard is likely open (an input is focused).
  useEffect(() => {
    const isField = (el: EventTarget | null) =>
      el instanceof HTMLElement &&
      (el.isContentEditable ||
        el.tagName === 'TEXTAREA' ||
        (el.tagName === 'INPUT' &&
          !['checkbox', 'radio', 'button', 'submit', 'file'].includes(
            (el as HTMLInputElement).type,
          )));
    const onIn = (e: FocusEvent) => setTyping(isField(e.target));
    const onOut = () => setTimeout(() => setTyping(isField(document.activeElement)), 50);
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => {
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
    };
  }, []);

  // Move focus to the main region on navigation (screen readers / keyboard users).
  useEffect(() => {
    const main = document.getElementById('main');
    if (main && !main.contains(document.activeElement)) main.focus({ preventScroll: true });
  }, [loc.pathname]);

  return (
    <div className={typing ? 'app typing' : 'app'}>
      <a href="#main" className="skip-link">
        本文へ移動
      </a>
      <aside className="sidebar" aria-label="サイドバー">
        <Link to="/" className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span>AI Memo</span>
        </Link>
        <nav className="side-nav" aria-label="メイン">
          {NAV.filter((n) => !('phoneOnly' in n)).map((n) => (
            <NavLink key={n.to} to={n.to} end={'end' in n ? n.end : false} className="side-link">
              <Icon name={n.icon} />
              <span>{n.label}</span>
              {n.to === '/review' && openProposals > 0 && (
                <span className="count" aria-label={`未処理 ${openProposals} 件`}>
                  {openProposals}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="side-tree">
          <div className="side-tree-head">
            <span>ノート</span>
            <span className="row">
              <Link
                to="/notes?newFolder=1"
                className="icon-btn"
                aria-label="新しいフォルダー"
                title="新しいフォルダー"
              >
                <Icon name="folder" size={18} />
              </Link>
              <Link
                to="/notes?new=1"
                className="icon-btn"
                aria-label="新しいノート"
                title="新しいノート"
              >
                <Icon name="plus" size={18} />
              </Link>
            </span>
          </div>
          {notesLoaded && notes.length === 0 && folders.length === 0 ? (
            <p className="hint pad">まだノートがありません</p>
          ) : (
            <NoteTree
              notes={notes}
              folders={folders}
              onDeleteFolder={(path, opts) => void deleteFolder(path, opts)}
            />
          )}
        </div>
        <div className="side-foot">
          <span>{auth?.user?.username}</span>
          <Link to="/privacy">データの扱い</Link>
        </div>
      </aside>
      <div className="main-col">
        <header className="topbar">
          <button
            type="button"
            className="icon-btn"
            aria-label="フォルダーとノートを開く"
            aria-haspopup="dialog"
            onClick={() => setMenuOpen(true)}
          >
            <Icon name="menu" size={22} />
          </button>
          <Link to="/" className="topbar-brand">
            AI Memo
          </Link>
        </header>
        <SyncStatus />
        <main id="main" className="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      <NavDrawer
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        notes={notes}
        folders={folders}
        notesLoaded={notesLoaded}
        username={auth?.user?.username}
        onDeleteFolder={(path, opts) => void deleteFolder(path, opts)}
      />
      <nav className="tabbar" aria-label="メイン">
        {NAV.filter((n) => !('desktopOnly' in n)).map((n) => (
          <NavLink key={n.to} to={n.to} end={'end' in n ? n.end : false} className="tab">
            <span className="tab-icon">
              <Icon name={n.icon} size={22} />
              {n.to === '/review' && openProposals > 0 && (
                <span className="tab-badge">{openProposals > 99 ? '99+' : openProposals}</span>
              )}
            </span>
            <span className="tab-label">
              {n.label}
              {n.to === '/review' && openProposals > 0 && (
                <span className="visually-hidden">(未処理 {openProposals} 件)</span>
              )}
            </span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
