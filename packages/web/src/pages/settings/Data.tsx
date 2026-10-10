import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, describeError } from '../../api/client';
import { Spinner } from '../../components/ui';
import { deviceName, setDeviceName } from '../../lib/device';
import { useAsync } from '../../lib/hooks';
import { useApp } from '../../state/app';
import { useToast } from '../../state/toast';

export function DataSettings() {
  const toast = useToast();
  const navigate = useNavigate();
  const { refreshAuth, refreshNotes } = useApp();
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [device, setDevice] = useState(deviceName());
  const plugins = useAsync(() => api.plugins(), []);

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

  const backup = (e: React.FormEvent) => {
    e.preventDefault();
    if (pass !== pass2) {
      toast.show('パスフレーズが一致しません', { kind: 'error' });
      return;
    }
    void run('backup', async () => {
      const { blob, filename } = await api.backup(pass || undefined);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast.show('バックアップをダウンロードしました', { kind: 'success' });
      setPass('');
      setPass2('');
    });
  };

  return (
    <div className="stack">
      <section className="card">
        <h2>バックアップ</h2>
        <p className="hint">
          ノート(Git
          リポジトリ全体)と設定を1つのファイルにまとめてダウンロードします。パスフレーズを入れると暗号化されます。
        </p>
        <form onSubmit={backup}>
          <div className="row wrap">
            <div className="field grow">
              <label htmlFor="bk-pass">パスフレーズ(推奨)</label>
              <input
                id="bk-pass"
                className="input"
                type="password"
                autoComplete="new-password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
              />
            </div>
            <div className="field grow">
              <label htmlFor="bk-pass2">もう一度</label>
              <input
                id="bk-pass2"
                className="input"
                type="password"
                autoComplete="new-password"
                value={pass2}
                onChange={(e) => setPass2(e.target.value)}
              />
            </div>
          </div>
          {!pass && <p className="hint">パスフレーズなしの場合、ファイルは暗号化されません。</p>}
          <button type="submit" className="btn btn-primary" disabled={busy !== null}>
            {busy === 'backup' && <Spinner />}
            {pass ? '暗号化してダウンロード' : 'ダウンロード'}
          </button>
        </form>
        <p className="hint">
          復元はサーバーで <code>gmemo restore &lt;file&gt;</code> を実行します。
        </p>
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
                toast.show(
                  r.committed.length
                    ? `${r.committed.length} 件の外部の変更を取り込みました`
                    : '外部の変更はありません',
                  { kind: 'success' },
                );
              })
            }
          >
            {busy === 'sync' && <Spinner />}
            外部の変更を取り込む
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
          Obsidian
          などで直接ファイルを編集した場合、変更は自動で取り込まれます。すぐに反映したいときに使ってください。
        </p>
      </section>

      {plugins.data && plugins.data.length > 0 && (
        <section className="card">
          <h2>プラグイン</h2>
          <ul className="item-list">
            {plugins.data.map((p) => (
              <li key={p.name} className="item">
                <div className="item-main">
                  <strong>{p.name}</strong>
                  {p.error ? (
                    <span className="text-danger">{p.error}</span>
                  ) : (
                    <span className="hint">
                      {[...p.routes, ...p.tools.map((t) => `MCP: ${t}`)].join(' ・') || '—'}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>サインアウト</h2>
        <div className="row wrap">
          <button
            type="button"
            className="btn"
            onClick={() =>
              void run('logout', async () => {
                await api.logout();
                await refreshAuth();
                navigate('/login', { replace: true });
              })
            }
          >
            サインアウト
          </button>
          <button
            type="button"
            className="btn btn-danger-text"
            onClick={() => {
              if (!confirm('すべての端末からサインアウトしますか?')) return;
              void run('logoutAll', async () => {
                await api.logoutAll();
                await refreshAuth();
                navigate('/login', { replace: true });
              });
            }}
          >
            すべての端末からサインアウト
          </button>
        </div>
      </section>
    </div>
  );
}
