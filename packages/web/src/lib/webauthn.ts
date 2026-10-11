import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from '@simplewebauthn/browser';
import { api, describeError } from '../api/client';
import type { PasskeyInfo } from '../api/types';

export { browserSupportsWebAuthn };

/**
 * Register a passkey. Signed out, this creates a new account (`username`, plus
 * the setup token for the first account or an invite code); signed in, it adds
 * another passkey to the current account.
 */
export async function registerPasskey(
  opts: { setupToken?: string; inviteCode?: string; username?: string; name?: string } = {},
): Promise<{ passkey: PasskeyInfo; recoveryCodes: string[] | null }> {
  const { challengeId, options } = await api.registerOptions({
    ...(opts.setupToken ? { setupToken: opts.setupToken } : {}),
    ...(opts.inviteCode ? { inviteCode: opts.inviteCode } : {}),
    ...(opts.username ? { username: opts.username } : {}),
  });
  const response = await startRegistration({
    optionsJSON: options as Parameters<typeof startRegistration>[0]['optionsJSON'],
  });
  return api.registerVerify({
    challengeId,
    response,
    ...(opts.name ? { name: opts.name } : {}),
  });
}

export async function loginWithPasskey(): Promise<void> {
  const { challengeId, options } = await api.loginOptions();
  const response = await startAuthentication({
    optionsJSON: options as Parameters<typeof startAuthentication>[0]['optionsJSON'],
  });
  await api.loginVerify({ challengeId, response });
}

/** Japanese message for WebAuthn failures (cancelled, not allowed, already registered…). */
export function passkeyErrorMessage(e: unknown): string {
  return webauthnMessage(e) ?? describeError(e);
}

function webauthnMessage(e: unknown): string | null {
  if (e instanceof WebAuthnError) {
    switch (e.code) {
      case 'ERROR_CEREMONY_ABORTED':
        return '操作がキャンセルされました。';
      case 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED':
        return 'このデバイスのパスキーはすでに登録されています。';
      case 'ERROR_INVALID_DOMAIN':
      case 'ERROR_INVALID_RP_ID':
        return 'このアドレスではパスキーを使えません(HTTPS とドメイン設定を確認してください)。';
      default:
        break;
    }
  }
  const name = (e as Error)?.name;
  if (name === 'NotAllowedError')
    return 'パスキーの操作がキャンセルされたか、時間切れになりました。';
  if (name === 'InvalidStateError') return 'このデバイスのパスキーはすでに登録されています。';
  if (name === 'SecurityError')
    return 'このアドレスではパスキーを使えません(HTTPS とドメイン設定を確認してください)。';
  return null;
}
