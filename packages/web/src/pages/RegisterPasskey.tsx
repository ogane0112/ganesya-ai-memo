import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Icon } from '../components/Icon';
import { SecretReveal, Spinner } from '../components/ui';
import { deviceName } from '../lib/device';
import { useDocumentTitle } from '../lib/hooks';
import { loginWithPasskey, passkeyErrorMessage, registerPasskey } from '../lib/webauthn';
import { useApp } from '../state/app';

/**
 * After signing in with a recovery code the user must register a new passkey,
 * then sign in again with it (the recovery session is short-lived and limited).
 */
export function RegisterPasskeyPage() {
  useDocumentTitle('新しいパスキーの登録');
  const { auth, refreshAuth } = useApp();
  const [name, setName] = useState(deviceName());
  const [step, setStep] = useState<'register' | 'login' | 'codes'>('register');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const navigate = useNavigate();

  const register = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await registerPasskey({ name: name.trim() });
      setStep('login');
    } catch (err) {
      setError(passkeyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const login = async () => {
    setBusy(true);
    setError(null);
    try {
      await loginWithPasskey();
      const s = await refreshAuth();
      // A recovery code was used up: offer a fresh set right away.
      if (s && (s.recoveryCodesRemaining ?? 0) < 5) {
        const r = await api.regenerateRecoveryCodes();
        setCodes(r.codes);
        setStep('codes');
      } else navigate('/', { replace: true });
    } catch (err) {
      setError(passkeyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card auth-card-wide">
        {step === 'register' && (
          <form onSubmit={(e) => void register(e)}>
            <h1>新しいパスキーを登録してください</h1>
            <p>
              リカバリーコードでログインしました。続けるには、この端末で新しいパスキーを登録する必要があります。
            </p>
            {auth?.recoveryCodesRemaining != null && (
              <p className="hint">残りのリカバリーコード: {auth.recoveryCodesRemaining} 個</p>
            )}
            <div className="field">
              <label htmlFor="pk-name">この端末の名前</label>
              <input
                id="pk-name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
              />
            </div>
            <button type="submit" className="btn btn-primary btn-block btn-large" disabled={busy}>
              {busy ? <Spinner /> : <Icon name="key" />}
              パスキーを登録
            </button>
          </form>
        )}
        {step === 'login' && (
          <>
            <h1>登録しました</h1>
            <p>新しいパスキーでサインインし直してください。</p>
            <button
              type="button"
              className="btn btn-primary btn-block btn-large"
              disabled={busy}
              onClick={() => void login()}
            >
              {busy ? <Spinner /> : <Icon name="key" />}
              新しいパスキーでサインイン
            </button>
          </>
        )}
        {step === 'codes' && codes && (
          <SecretReveal
            title="新しいリカバリーコード"
            lines={codes}
            filename="gmemo-recovery-codes.txt"
            note="リカバリーコードを使ったので、新しいセットを発行しました。古いコードはもう使えません。"
            onDone={() => navigate('/', { replace: true })}
          />
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
