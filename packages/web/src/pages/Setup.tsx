import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { SecretReveal, Spinner } from '../components/ui';
import { deviceName } from '../lib/device';
import { useDocumentTitle } from '../lib/hooks';
import { browserSupportsWebAuthn, passkeyErrorMessage, registerPasskey } from '../lib/webauthn';
import { useApp } from '../state/app';

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="auth-page">
      <div className="auth-card auth-card-wide">
        <h1>アカウントを作成しました</h1>
        <p>
          次のリカバリーコードは、パスキーを使えなくなったときにログインするためのものです。ユーザー名と一緒に使います。
        </p>
        <SecretReveal
          title="リカバリーコード(各コード1回のみ使用可)"
          lines={codes}
          filename="gmemo-recovery-codes.txt"
          note="パスワードマネージャーや紙に控えて、安全な場所に保管してください。"
          onDone={onDone}
        />
        <p className="hint">
          おすすめ: スマホとPCなど、2台以上の端末でパスキーを登録しておくと安心です(設定 →
          パスキー)。
        </p>
      </div>
    </div>
  );
}

/**
 * Create an account with a passkey. `first` is the server's very first
 * (admin) account and needs the setup token; later accounts may need an invite.
 */
function CreateAccount({
  first,
  onCreated,
}: {
  first: boolean;
  onCreated: (codes: string[]) => void;
}) {
  const { auth, refreshAuth } = useApp();
  const [params] = useSearchParams();
  const [token, setToken] = useState(params.get('token') ?? '');
  const [invite, setInvite] = useState(params.get('invite') ?? '');
  const [username, setUsername] = useState('');
  const [name, setName] = useState(deviceName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsInvite = !first && auth?.signup === 'invite';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await registerPasskey({
        username: username.trim(),
        ...(first ? { setupToken: token.trim() } : {}),
        ...(needsInvite ? { inviteCode: invite.trim() } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      // Show the codes first: refreshing the session re-renders the parent page.
      onCreated(res.recoveryCodes ?? []);
      await refreshAuth();
    } catch (err) {
      setError(passkeyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const ready =
    username.trim().length >= 2 && (!first || token.trim()) && (!needsInvite || invite.trim());

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={(e) => void submit(e)}>
        <img src="/icons/icon-192.png" alt="" width={64} height={64} className="auth-logo" />
        <h1>{first ? 'はじめに: 管理者アカウントを作成' : 'アカウントを作成'}</h1>
        <p className="hint">
          AI Memo はパスワードを使いません。この端末の指紋・顔認証・PIN
          で守られた「パスキー」でサインインします。メールアドレスも不要です。
        </p>
        {!browserSupportsWebAuthn() && (
          <p className="notice notice-warn">
            このブラウザはパスキーに対応していません。別のブラウザで開いてください。
          </p>
        )}
        {first && (
          <div className="field">
            <label htmlFor="setup-token">セットアップトークン</label>
            <input
              id="setup-token"
              className="input mono"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              autoComplete="off"
              spellCheck={false}
            />
            <div className="hint">
              サーバーの起動ログ、または Cloudflare に設定した GMEMO_SETUP_TOKEN の値です。
            </div>
          </div>
        )}
        {needsInvite && (
          <div className="field">
            <label htmlFor="invite-code">招待コード</label>
            <input
              id="invite-code"
              className="input mono"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              required
              autoComplete="off"
              spellCheck={false}
            />
            <div className="hint">管理者から受け取った招待リンクを開くと自動で入ります。</div>
          </div>
        )}
        <div className="field">
          <label htmlFor="setup-user">ユーザー名</label>
          <input
            id="setup-user"
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="例: hanako"
            autoComplete="username"
            required
            minLength={2}
            maxLength={32}
          />
          <div className="hint">2〜32文字。リカバリーコードでログインするときに使います。</div>
        </div>
        <div className="field">
          <label htmlFor="setup-name">この端末の名前</label>
          <input
            id="setup-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
          />
        </div>
        <button
          type="submit"
          className="btn btn-primary btn-block btn-large"
          disabled={busy || !ready}
        >
          {busy ? <Spinner /> : <Icon name="key" />}
          パスキーを作成
        </button>
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        {!first && (
          <Link to="/login" className="btn btn-text btn-block">
            アカウントをお持ちの方はサインイン
          </Link>
        )}
      </form>
    </div>
  );
}

/** /setup: the first (admin) account. */
/** Keeps the new account's recovery codes on screen across the sign-in refresh. */
function useCreatedCodes() {
  const [codes, setCodes] = useState<string[] | null>(null);
  const navigate = useNavigate();
  const screen = codes ? (
    <RecoveryCodes
      codes={codes}
      onDone={() => {
        setCodes(null);
        navigate('/', { replace: true });
      }}
    />
  ) : null;
  return { screen, setCodes };
}

export function SetupPage() {
  useDocumentTitle('セットアップ');
  const { auth } = useApp();
  const created = useCreatedCodes();
  if (created.screen) return created.screen;
  if (auth && !auth.needsSetup) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>セットアップ済みです</h1>
          <p>このサーバーにはすでに管理者アカウントがあります。</p>
          <Link to="/login" className="btn btn-primary btn-block">
            サインインへ
          </Link>
          {auth.signup !== 'closed' && (
            <Link to="/signup" className="btn btn-text btn-block">
              新しくアカウントを作成
            </Link>
          )}
        </div>
      </div>
    );
  }
  return <CreateAccount first onCreated={created.setCodes} />;
}

/** /signup: later accounts (open sign-up or with an invite). */
export function SignupPage() {
  useDocumentTitle('アカウント作成');
  const { auth, signedIn } = useApp();
  const [params] = useSearchParams();
  const created = useCreatedCodes();
  if (created.screen) return created.screen;
  if (!auth) return null;
  if (auth.needsSetup) return <Navigate to={`/setup?${params.toString()}`} replace />;
  if (signedIn && auth.session?.via === 'passkey') return <Navigate to="/" replace />;
  if (auth.signup === 'closed') {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>新規登録は停止中です</h1>
          <p>このサーバーは現在、新しいアカウントを受け付けていません。</p>
          <Link to="/login" className="btn btn-primary btn-block">
            サインインへ
          </Link>
        </div>
      </div>
    );
  }
  return <CreateAccount first={false} onCreated={created.setCodes} />;
}

export function NeedsSetupPage() {
  useDocumentTitle('セットアップが必要です');
  return (
    <div className="auth-page">
      <div className="auth-card">
        <img src="/icons/icon-192.png" alt="" width={64} height={64} className="auth-logo" />
        <h1>セットアップが必要です</h1>
        <p>まだアカウントがありません。最初のアカウントが管理者になります。</p>
        <p className="hint">
          セットアップトークンは、Cloudflare では <code>GMEMO_SETUP_TOKEN</code>{' '}
          シークレットに設定した値、Node.js ではサーバー起動ログに表示された値です。
        </p>
        <Link to="/setup" className="btn btn-primary btn-block">
          アカウントを作成する
        </Link>
      </div>
    </div>
  );
}
