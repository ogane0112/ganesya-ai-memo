import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, describeError } from '../../api/client';
import { Spinner } from '../../components/ui';
import { deviceName, setDeviceName } from '../../lib/device';
import { clearLocalData } from '../../lib/localData';
import { syncQueue } from '../../lib/sync';
import { useApp } from '../../state/app';
import { useToast } from '../../state/toast';

/** Signing out removes this device's copies, including writes not sent yet: ask first. */
function confirmDiscardUnsent(): boolean {
  const n = syncQueue.snapshot.items.length;
  return (
    n === 0 ||
    confirm(
      `まだ送信していない変更が${n}件あります。サインアウトすると、この端末から削除されます。続けますか?`,
    )
  );
}

export function DataSettings() {
  const toast = useToast();
  const navigate = useNavigate();
  const { auth, refreshAuth, refreshNotes } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [device, setDevice] = useState(deviceName());

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.show(describeError(e), { kind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      <section className="card">
        <h2>エクスポート</h2>
        <p className="hint">
          すべてのノート(最新の状態)と添付ファイルを .tar.gz
          にまとめてダウンロードします。Markdownのままなので、他のアプリでも開けます。
        </p>
        <a className="btn btn-primary" href={api.exportUrl} download>
          ダウンロード
        </a>
      </section>

      <section className="card">
        <h2>この端末</h2>
        <div className="field">
          <label htmlFor="dev-name">
            端末名(競合したときに「どの端末の編集か」の表示に使います)
          </label>
          <div className="row">
            <input
              id="dev-name"
              className="input grow"
              value={device}
              onChange={(e) => setDevice(e.target.value)}
              maxLength={40}
            />
            <button
              type="button"
              className="btn"
              onClick={() => {
                setDeviceName(device);
                toast.show('保存しました', { kind: 'success' });
              }}
            >
              保存
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>メンテナンス</h2>
        <div className="row wrap">
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() =>
              void run('sync', async () => {
                const r = await api.sync();
                refreshNotes();
                toast.show(r.changed ? '最新の変更を取り込みました' : '変更はありません', {
                  kind: 'success',
                });
              })
            }
          >
            {busy === 'sync' && <Spinner />}
            今すぐ同期
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() =>
              void run('reindex', async () => {
                await api.reindex();
                refreshNotes();
                toast.show('検索インデックスを作り直しました', { kind: 'success' });
              })
            }
          >
            {busy === 'reindex' && <Spinner />}
            検索インデックスを再構築
          </button>
        </div>
        <p className="hint">
          GitHub に保存している場合、他の場所からの push
          は自動で取り込まれます(数十秒ごと)。すぐに反映したいときは「今すぐ同期」を使ってください。
        </p>
      </section>

      <section className="card">
        <h2>サインアウト</h2>
        <div className="row wrap">
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (!confirmDiscardUnsent()) return;
              void run('logout', async () => {
                await api.logout();
                await clearLocalData();
                await refreshAuth();
                navigate('/login', { replace: true });
              });
            }}
          >
            サインアウト
          </button>
          <button
            type="button"
            className="btn btn-danger-text"
            onClick={() => {
              if (!confirm('すべての端末からサインアウトしますか?')) return;
              if (!confirmDiscardUnsent()) return;
              void run('logoutAll', async () => {
                await api.logoutAll();
                await clearLocalData();
                await refreshAuth();
                navigate('/login', { replace: true });
              });
            }}
          >
            すべての端末からサインアウト
          </button>
        </div>
      </section>

      <section className="card">
        <h2>アカウントの削除</h2>
        <p className="hint">
          アカウントと、このサービス内に保存したノート・履歴・AIエージェントをすべて削除します。GitHub
          のリポジトリは削除されません。先にエクスポートしておくことをおすすめします。
        </p>
        <button
          type="button"
          className="btn btn-danger-text"
          disabled={busy !== null}
          onClick={() => {
            const name = prompt('本当に削除しますか?確認のためユーザー名を入力してください。');
            if (!name) return;
            void run('delete', async () => {
              await api.deleteAccount(name);
              await clearLocalData();
              await refreshAuth();
              navigate('/login', { replace: true });
            });
          }}
        >
          {auth?.user ? `${auth.user.username} を削除` : 'アカウントを削除'}
        </button>
      </section>
    </div>
  );
}
