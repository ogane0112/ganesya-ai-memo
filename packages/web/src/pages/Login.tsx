import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api, describeError } from '../api/client';
import { Icon } from '../components/Icon';
import { Spinner } from '../components/ui';
import { useDocumentTitle } from '../lib/hooks';
import { safeNext } from '../lib/paths';
import { browserSupportsWebAuthn, loginWithPasskey, passkeyErrorMessage } from '../lib/webauthn';
import { useApp } from '../state/app';

export function LoginPage() {
  useDocumentTitle('サインイン');
  const { auth, refreshAuth, signedIn, offlineAuth } = useApp();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'passkey' | 'recovery'>('passkey');
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');

  if (signedIn && auth?.session?.via === 'passkey') return <Navigate to={next} replace />;
  if (auth?.needsSetup && !auth.user) return <Navigate to="/setup" replace />;

  const passkey = async () => {
    setBusy(true);
    setError(null);
    try {
      await loginWithPasskey();
      await refreshAuth();
      navigate(next, { replace: true });
    } catch (e) {
      setError(passkeyErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const recovery = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.recoveryLogin(username.trim(), code.trim());
      await refreshAuth();
      navigate('/register-passkey', { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <img src="/icons/icon-192.png" alt="" width={64} height={64} className="auth-logo" />
        <h1>AI Memo にサインイン</h1>
        {offlineAuth && (
          <p className="notice notice-warn">
            サーバーに接続できません。オンラインになってからサインインしてください。
          </p>
        )}
        {mode === 'passkey' ? (
          <>
            <p className="hint">
              この端末に保存したパスキー(指紋・顔認証・PIN)でサインインします。
            </p>
            {!browserSupportsWebAuthn() && (
              <p className="notice notice-warn">このブラウザはパスキーに対応していません。</p>
            )}
            <button
              type="button"
              className="btn btn-primary btn-block btn-large"
              onClick={() => void passkey()}
              disabled={busy || offlineAuth}
            >
              {busy ? <Spinner /> : <Icon name="key" />}
              パスキーでサインイン
            </button>
            <button
              type="button"
              className="btn btn-text btn-block"
              onClick={() => setMode('recovery')}
            >
              リカバリーコードでログイン
            </button>
            {auth && auth.signup !== 'closed' && (
              <Link to="/signup" className="btn btn-text btn-block">
                アカウントを作成
              </Link>
            )}
          </>
        ) : (
          <form onSubmit={(e) => void recovery(e)}>
            <p className="hint">
              パスキーを使えなくなったときは、ユーザー名と、アカウント作成時に保存したリカバリーコードを1つ入力してください。ログイン後、新しいパスキーの登録が必要です。
            </p>
            <div className="field">
              <label htmlFor="recovery-user">ユーザー名</label>
              <input
                id="recovery-user"
                className="input"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="recovery-code">リカバリーコード</label>
              <input
                id="recovery-code"
                className="input mono"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary btn-block btn-large"
              disabled={busy || !code.trim() || !username.trim()}
            >
              {busy && <Spinner />}
              ログイン
            </button>
            <button
              type="button"
              className="btn btn-text btn-block"
              onClick={() => setMode('passkey')}
            >
              パスキーに戻る
            </button>
          </form>
        )}
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
