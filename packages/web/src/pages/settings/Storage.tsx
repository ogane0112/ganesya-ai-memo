import { useEffect, useState } from 'react';
import { api, describeError } from '../../api/client';
import type { StorageSettings } from '../../api/types';
import { Badge, ErrorBox, Field, Loading, Segmented, Spinner } from '../../components/ui';
import { useAsync } from '../../lib/hooks';
import { useApp } from '../../state/app';
import { useToast } from '../../state/toast';

const TOKEN_URL =
  'https://github.com/settings/personal-access-tokens/new?name=AI%20Memo&description=AI%20Memo%20notes&contents=write';

function Current({ s }: { s: StorageSettings }) {
  if (s.storage === 'github' && s.github)
    return (
      <p>
        <Badge tone="accent">GitHub</Badge>{' '}
        <a
          href={`https://github.com/${s.github.owner}/${s.github.repo}/tree/${s.github.branch}`}
          target="_blank"
          rel="noreferrer"
        >
          {s.github.owner}/{s.github.repo}
        </a>{' '}
        <span className="hint">({s.github.branch} ブランチ)</span>
      </p>
    );
  return (
    <p>
      <Badge tone="ok">このサービス内</Badge>{' '}
      <span className="hint">ノートと変更履歴はサーバーのデータベースに保存されています。</span>
    </p>
  );
}

/** Where notes and their history live: inside the service, or in the user's own GitHub repository. */
export function StorageSettings() {
  const toast = useToast();
  const { refreshNotes, refreshProposals } = useApp();
  const settings = useAsync(() => api.storage(), []);
  const [mode, setMode] = useState<'builtin' | 'github'>('builtin');
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [token, setToken] = useState('');
  const [copy, setCopy] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const s = settings.data;
    if (!s) return;
    setMode(s.storage);
    if (s.github) {
      setOwner(s.github.owner);
      setRepo(s.github.repo);
      setBranch(s.github.branch);
    }
  }, [settings.data]);

  if (settings.loading && !settings.data) return <Loading />;
  if (settings.error) return <ErrorBox error={settings.error} onRetry={settings.reload} />;
  const s = settings.data!;
  const sameRepo =
    s.github?.owner === owner.trim() && s.github?.repo === repo.trim() && s.github.hasToken;
  const unchanged =
    mode === s.storage && (mode === 'builtin' || (sameRepo && s.github?.branch === branch.trim()));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const moving = mode !== s.storage || !sameRepo;
    if (
      moving &&
      !confirm(
        mode === 'github'
          ? `保存先を GitHub (${owner}/${repo}) に切り替えます。${copy ? '今のノートをリポジトリにコピーします。' : ''}変更履歴はコピーされません。未処理の提案は閉じられます。よろしいですか?`
          : 'このサービス内の保存に戻します。今のノート(最新の状態)をコピーします。未処理の提案は閉じられます。よろしいですか?',
      )
    )
      return;
    setBusy(true);
    try {
      const res = await api.saveStorage(
        mode === 'github'
          ? {
              storage: 'github',
              github: {
                owner: owner.trim(),
                repo: repo.trim(),
                branch: branch.trim() || 'main',
                ...(token.trim() ? { token: token.trim() } : {}),
              },
              copy,
            }
          : { storage: 'builtin' },
      );
      setToken('');
      settings.setData({ ...res.settings, githubAvailable: s.githubAvailable });
      refreshNotes();
      refreshProposals();
      toast.show(
        res.copied
          ? `${res.copied} 個のファイルをコピーして切り替えました`
          : '保存先を更新しました',
        { kind: 'success' },
      );
    } catch (err) {
      toast.show(describeError(err), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <section className="card">
        <h2>ノートの保存先</h2>
        <Current s={s} />
        <p className="hint">
          どちらでも、ノートはMarkdownファイルとしてGitの形式で保存され、誰(人かAIか)がいつ何を変えたかの履歴が残ります。GitHub
          を選ぶと、自分のリポジトリに直接コミットされるので、他のツールからも読み書きできます。
        </p>
      </section>

      <form className="card" onSubmit={(e) => void save(e)}>
        <h2>保存先を変更</h2>
        <Segmented
          label="保存先"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'builtin', label: 'このサービス内' },
            { value: 'github', label: '自分のGitHub' },
          ]}
        />
        {mode === 'github' && !s.githubAvailable && (
          <p className="notice notice-warn">
            このサーバーには暗号化キー(GMEMO_SECRET_KEY)が設定されていないため、GitHub
            は使えません。管理者に連絡してください。
          </p>
        )}
        {mode === 'github' && s.githubAvailable && (
          <>
            <div className="row wrap">
              <div className="grow">
                <Field label="オーナー(ユーザー名または組織)" htmlFor="gh-owner">
                  <input
                    id="gh-owner"
                    className="input"
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                    placeholder="octocat"
                    required
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              </div>
              <div className="grow">
                <Field label="リポジトリ" htmlFor="gh-repo">
                  <input
                    id="gh-repo"
                    className="input"
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                    placeholder="notes"
                    required
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              </div>
              <div>
                <Field label="ブランチ" htmlFor="gh-branch">
                  <input
                    id="gh-branch"
                    className="input"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              </div>
            </div>
            <Field
              label={sameRepo ? 'アクセストークン(変更する場合のみ)' : 'アクセストークン'}
              htmlFor="gh-token"
              hint={
                <>
                  GitHub の{' '}
                  <a href={TOKEN_URL} target="_blank" rel="noreferrer">
                    Fine-grained personal access token
                  </a>{' '}
                  を作成し、対象リポジトリだけを選んで「Contents: Read and
                  write」を許可してください。トークンはサーバーで暗号化して保存され、画面には二度と表示されません。
                </>
              }
            >
              <input
                id="gh-token"
                className="input mono"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="github_pat_…"
                autoComplete="off"
                spellCheck={false}
                required={!sameRepo}
              />
            </Field>
            {!sameRepo && (
              <label className="check">
                <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} />
                今のノートをこのリポジトリにコピーする(同じ名前のファイルは上書き)
              </label>
            )}
            <p className="hint">
              空のリポジトリでも使えます。AIの提案は <code>gmemo/proposals/…</code>{' '}
              ブランチとして作られます。
            </p>
          </>
        )}
        <div className="row">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || unchanged || (mode === 'github' && !s.githubAvailable)}
          >
            {busy && <Spinner />}
            {mode === 'github' ? '接続して切り替える' : 'このサービス内に戻す'}
          </button>
          {s.storage === 'builtin' && s.github && (
            <button
              type="button"
              className="btn btn-danger-text"
              disabled={busy}
              onClick={() =>
                void api
                  .forgetGitHub()
                  .then(() => {
                    settings.reload();
                    setOwner('');
                    setRepo('');
                    toast.show('GitHubの接続情報を削除しました', { kind: 'success' });
                  })
                  .catch((err: unknown) => toast.show(describeError(err), { kind: 'error' }))
              }
            >
              保存したGitHub接続を削除
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
