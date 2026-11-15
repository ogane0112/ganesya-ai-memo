import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, describeError } from '../../api/client';
import type { LinkableRepo, StorageSettings } from '../../api/types';
import { Badge, ErrorBox, Field, Loading, Segmented, Spinner } from '../../components/ui';
import { useAsync } from '../../lib/hooks';
import { useApp } from '../../state/app';
import { useToast } from '../../state/toast';

const TOKEN_URL =
  'https://github.com/settings/personal-access-tokens/new?name=AI%20Memo&description=AI%20Memo%20notes&contents=write';

const repoKey = (r: { owner: string; repo: string }) => `${r.owner}/${r.repo}`;

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
        <span className="hint">
          ({s.github.branch} ブランチ・
          {s.github.via === 'app' ? 'GitHub でログインして接続' : 'アクセストークンで接続'})
        </span>
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
  const { refreshNotes, refreshProposals, refreshStorage } = useApp();
  const [params, setParams] = useSearchParams();
  const settings = useAsync(() => api.storage(), []);
  const [mode, setMode] = useState<'builtin' | 'github'>('builtin');
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [token, setToken] = useState('');
  const [copy, setCopy] = useState(true);
  const [busy, setBusy] = useState(false);
  /** Repositories GitHub listed after "sign in with GitHub" (null: not signed in yet). */
  const [linked, setLinked] = useState<LinkableRepo[] | null>(null);
  /** The repository picked from `linked`. */
  const [picked, setPicked] = useState('');
  const [useToken, setUseToken] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const started = useRef(false);

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

  const signIn = async () => {
    setBusy(true);
    try {
      const { url } = await api.githubLogin();
      window.location.href = url;
    } catch (err) {
      toast.show(describeError(err), { kind: 'error' });
      setBusy(false);
    }
  };

  // Back from GitHub: ?github=linked (signed in), installed (App just installed:
  // sign in to see the new repositories), or error.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const g = params.get('github');
    if (g) {
      setMode('github');
      const next = new URLSearchParams(params);
      next.delete('github');
      next.delete('reason');
      next.delete('installation_id');
      next.delete('setup_action');
      setParams(next, { replace: true });
    }
    if (g === 'error') setLoginError(params.get('reason') ?? 'GitHub でのログインに失敗しました');
    if (g === 'installed') {
      void signIn();
      return;
    }
    void api
      .githubRepos()
      .then((r) => setLinked(r.repos))
      .catch(() => setLinked(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!linked?.length) return;
    const s = settings.data;
    const current = s?.github ? linked.find((r) => repoKey(r) === repoKey(s.github!)) : undefined;
    const first = current ?? linked[0]!;
    setPicked(repoKey(first));
    if (!current) setBranch(first.defaultBranch);
  }, [linked, settings.data]);

  if (settings.loading && !settings.data) return <Loading />;
  if (settings.error) return <ErrorBox error={settings.error} onRetry={settings.reload} />;
  const s = settings.data!;
  const appMode = mode === 'github' && !!s.githubApp && !useToken;
  const choice = appMode ? linked?.find((r) => repoKey(r) === picked) : undefined;
  const target = appMode
    ? choice
      ? { owner: choice.owner, repo: choice.repo }
      : s.github?.via === 'app'
        ? { owner: s.github.owner, repo: s.github.repo }
        : null
    : { owner: owner.trim(), repo: repo.trim() };
  const sameRepo =
    !!target &&
    s.github?.owner === target.owner &&
    s.github?.repo === target.repo &&
    s.github.hasToken &&
    // Switching from a token to the App (or back) is a change even for the same repository.
    (appMode ? !choice || s.github.via === 'app' : s.github.via === 'token' || !token.trim());
  const unchanged =
    mode === s.storage && (mode === 'builtin' || (sameRepo && s.github?.branch === branch.trim()));
  const canSubmit =
    mode === 'builtin' ||
    (s.githubAvailable &&
      !!target &&
      (appMode ? !!choice || sameRepo : sameRepo || !!token.trim()));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target && mode === 'github') return;
    const moving = mode !== s.storage || !sameRepo;
    if (
      moving &&
      !confirm(
        mode === 'github'
          ? `保存先を GitHub (${target!.owner}/${target!.repo}) に切り替えます。${copy ? '今のノートをリポジトリにコピーします。' : ''}変更履歴はコピーされません。未処理の提案は閉じられます。よろしいですか?`
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
                owner: target!.owner,
                repo: target!.repo,
                branch: branch.trim() || 'main',
                ...(appMode && choice ? { installationId: choice.installationId } : {}),
                ...(!appMode && token.trim() ? { token: token.trim() } : {}),
              },
              copy,
            }
          : { storage: 'builtin' },
      );
      setToken('');
      settings.setData({
        ...res.settings,
        githubAvailable: s.githubAvailable,
        githubApp: s.githubApp,
      });
      refreshNotes();
      refreshProposals();
      refreshStorage();
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

  const branchField = (
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
  );

  const copyBox = !sameRepo && (
    <label className="check">
      <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} />
      今のノートをこのリポジトリにコピーする(同じ名前のファイルは上書き)
    </label>
  );

  const appForm = s.githubApp && (
    <>
      {s.githubApp.problem && (
        <p className="notice notice-warn">
          サーバーの GitHub App の設定に問題があります(管理者向け): {s.githubApp.problem}
        </p>
      )}
      {loginError && <p className="notice notice-warn">{loginError}</p>}
      {linked === null ? (
        <>
          {s.github?.via === 'app' && (
            <div className="row wrap">
              <p className="grow">
                接続中: <strong>{repoKey(s.github)}</strong>
              </p>
              {branchField}
            </div>
          )}
          <p className="hint">
            GitHub でログインすると、このアプリ(GitHub
            App)を入れたリポジトリの一覧が出ます。トークンを作ったり貼ったりする必要はありません。
          </p>
          <div className="row">
            <button type="button" className="btn" disabled={busy} onClick={() => void signIn()}>
              {busy && <Spinner />}
              {s.github?.via === 'app'
                ? '別のリポジトリにする(GitHub でログイン)'
                : 'GitHub でログイン'}
            </button>
          </div>
        </>
      ) : linked.length === 0 ? (
        <>
          <p className="notice notice-warn">
            このアプリ(GitHub
            App)を入れたリポジトリがまだありません。下のボタンから、ノート用のリポジトリを選んでインストールしてください。終わると自動でこの画面に戻ります。
          </p>
          <div className="row">
            <a className="btn" href={s.githubApp.installUrl}>
              リポジトリにインストール
            </a>
          </div>
        </>
      ) : (
        <>
          <div className="row wrap">
            <div className="grow">
              <Field label="リポジトリ" htmlFor="gh-pick">
                <select
                  id="gh-pick"
                  className="input select"
                  value={picked}
                  onChange={(e) => {
                    setPicked(e.target.value);
                    const r = linked.find((x) => repoKey(x) === e.target.value);
                    if (r && repoKey(r) !== (s.github ? repoKey(s.github) : ''))
                      setBranch(r.defaultBranch);
                  }}
                >
                  {linked.map((r) => (
                    <option key={repoKey(r)} value={repoKey(r)}>
                      {repoKey(r)}
                      {r.private ? '' : '(公開リポジトリ)'}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {branchField}
          </div>
          {choice && !choice.private && (
            <p className="notice notice-warn">
              このリポジトリは公開されています。ノートは誰でも読めるようになります。
            </p>
          )}
          <p className="hint">
            一覧にないリポジトリを使うときは{' '}
            <a href={s.githubApp.installUrl}>インストール先にリポジトリを追加</a> してください。
          </p>
        </>
      )}
    </>
  );

  const tokenForm = (
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
        {branchField}
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
    </>
  );

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
            {appMode ? appForm : tokenForm}
            {(appMode ? !!choice || (linked === null && s.github?.via === 'app') : true) && copyBox}
            {s.githubApp && (
              <p className="hint">
                <button
                  type="button"
                  className="btn btn-text btn-small"
                  onClick={() => {
                    setUseToken(!useToken);
                    if (!useToken && s.github?.via !== 'token') {
                      setOwner('');
                      setRepo('');
                    }
                  }}
                >
                  {useToken
                    ? 'GitHub でログインして接続する'
                    : 'アクセストークンで接続する(GitHub Enterprise など)'}
                </button>
              </p>
            )}
            <p className="hint">
              空のリポジトリでも使えます。AIの提案は <code>gmemo/proposals/…</code>{' '}
              ブランチとして作られます。
            </p>
          </>
        )}
        <div className="row">
          {(mode === 'builtin' || !appMode || choice || s.github?.via === 'app') && (
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || unchanged || !canSubmit}
            >
              {busy && <Spinner />}
              {mode === 'github' ? '接続して切り替える' : 'このサービス内に戻す'}
            </button>
          )}
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
