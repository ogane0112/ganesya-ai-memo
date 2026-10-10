import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { SecretReveal, Spinner } from '../components/ui';
import { deviceName } from '../lib/device';
import { useDocumentTitle } from '../lib/hooks';
import { browserSupportsWebAuthn, passkeyErrorMessage, registerPasskey } from '../lib/webauthn';
import { useApp } from '../state/app';

export function SetupPage() {
  useDocumentTitle('セットアップ');
  const { auth, refreshAuth } = useApp();
  const [params] = useSearchParams();
  const [token, setToken] = useState(params.get('token') ?? '');
  const [username, setUsername] = useState('');
  const [name, setName] = useState(deviceName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const navigate = useNavigate();

  if (codes) {
    return (
      <div className="auth-page">
        <div className="auth-card auth-card-wide">
          <h1>セットアップ完了</h1>
          <p>
            パスキーを登録しました。次のリカバリーコードは、パスキーを使えなくなったときにログインするためのものです。
          </p>
          <SecretReveal
            title="リカバリーコード(各コード1回のみ使用可)"
            lines={codes}
            filename="gmemo-recovery-codes.txt"
            note="パスワードマネージャーや紙に控えて、安全な場所に保管してください。"
            onDone={() => {
              setCodes(null);
              navigate('/', { replace: true });
            }}
          />
          <p className="hint">
            おすすめ: スマホとPCなど、2台以上の端末でパスキーを登録しておくと安心です(設定 →
            パスキー)。
          </p>
        </div>
      </div>
    );
  }

  if (auth && !auth.needsSetup) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>セットアップ済みです</h1>
          <p>このサーバーにはすでにパスキーが登録されています。</p>
          <Link to="/login" className="btn btn-primary btn-block">
            サインインへ
          </Link>
        </div>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await registerPasskey({
        setupToken: token.trim(),
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      await refreshAuth();
      setCodes(res.recoveryCodes ?? []);
    } catch (err) {
      setError(passkeyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={(e) => void submit(e)}>
        <img src="/icons/icon-192.png" alt="" width={64} height={64} className="auth-logo" />
        <h1>はじめに: パスキーを登録</h1>
        <p className="hint">
          AI Memo はパスワードを使いません。この端末の指紋・顔認証・PIN
          で守られた「パスキー」でサインインします。
        </p>
        {!browserSupportsWebAuthn() && (
          <p className="notice notice-warn">
            このブラウザはパスキーに対応していません。別のブラウザで開いてください。
          </p>
        )}
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
          <div className="hint">サーバー起動時にコンソールへ表示された1回限りのトークンです。</div>
        </div>
        <div className="field">
          <label htmlFor="setup-user">ユーザー名(任意)</label>
          <input
            id="setup-user"
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="me"
            autoComplete="username"
            maxLength={40}
          />
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
          disabled={busy || !token.trim()}
        >
          {busy ? <Spinner /> : <Icon name="key" />}
          パスキーを作成
        </button>
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}

export function NeedsSetupPage() {
  useDocumentTitle('セットアップが必要です');
  return (
    <div className="auth-page">
      <div className="auth-card">
        <img src="/icons/icon-192.png" alt="" width={64} height={64} className="auth-logo" />
        <h1>セットアップが必要です</h1>
        <p>
          まだパスキーが登録されていません。サーバーの起動ログに表示された URL(
          <code>/setup?token=…</code>)を開いてください。
        </p>
        <p className="hint">
          トークンを見失った場合は、サーバーで <code>gmemo admin setup-token</code>{' '}
          を実行すると新しいトークンが発行されます。
        </p>
        <Link to="/setup" className="btn btn-block">
          トークンを入力する
        </Link>
      </div>
    </div>
  );
}
