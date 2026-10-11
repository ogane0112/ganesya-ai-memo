import type { Context } from 'hono';
import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { loadPrefs } from '../auth/prefs.js';
import type { Platform } from '../platform.js';
import { audit, type Env, jsonBody, requireHuman, sessionCookieName, str } from './http.js';

export function authRoutes(platform: Platform) {
  const app = new Hono<Env>();
  const { auth, cfg } = platform;
  const secure = cfg.origin.startsWith('https://');
  const COOKIE = sessionCookieName(cfg.origin);

  const setSession = (c: Parameters<typeof setCookie>[0], token: string, days = cfg.sessionDays) =>
    setCookie(c, COOKIE, token, {
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: days * 86400,
    });

  /** Run a sign-in step; failures are recorded before the error goes back to the client. */
  const attempt = async <T>(
    c: Context<Env>,
    action: string,
    fn: () => Promise<T>,
    detail?: Record<string, unknown>,
  ): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      await audit(platform, c, {
        action,
        outcome: 'failure',
        userId: c.get('session')?.userId ?? null,
        detail: { ...detail, reason: (e as Error).message.slice(0, 120) },
      });
      throw e;
    }
  };

  app.get('/state', async (c) => {
    const s = c.get('session');
    return c.json({
      ...(await auth.signupState()),
      env: cfg.env,
      user: s ? { id: s.userId, username: s.username, isAdmin: s.isAdmin } : null,
      session: s ? { via: s.via, expiresAt: s.expiresAt } : null,
      rpId: cfg.rpId,
      origin: cfg.origin,
      recoveryCodesRemaining: s ? await auth.remainingRecoveryCodes(s.userId) : null,
      passkeyCount: s ? (await auth.passkeys(s.userId)).length : null,
      prefs: s ? await loadPrefs(platform.db, s.userId) : null,
    });
  });

  app.post('/register/options', async (c) => {
    const b = await jsonBody<{ setupToken?: string; username?: string; inviteCode?: string }>(c);
    const signingUp = !c.get('session');
    return c.json(
      await attempt(
        c,
        signingUp ? 'auth.signup' : 'auth.passkey_add',
        () =>
          auth.registrationOptions({
            session: c.get('session'),
            ...(b.setupToken ? { setupToken: b.setupToken } : {}),
            ...(b.username ? { username: b.username } : {}),
            ...(b.inviteCode ? { inviteCode: b.inviteCode } : {}),
          }),
        signingUp
          ? {
              username: b.username?.slice(0, 40),
              with: b.setupToken ? 'setup-token' : b.inviteCode ? 'invite' : 'open',
            }
          : undefined,
      ),
    );
  });

  app.post('/register/verify', async (c) => {
    const b = await jsonBody<{ challengeId: string; response: never; name?: string }>(c);
    const signingUp = !c.get('session');
    const res = await attempt(c, signingUp ? 'auth.signup' : 'auth.passkey_add', () =>
      auth.verifyRegistration({
        session: c.get('session'),
        challengeId: str(b.challengeId, 'challengeId'),
        response: b.response,
        ...(b.name ? { name: b.name } : {}),
      }),
    );
    if (res.sessionToken) setSession(c, res.sessionToken);
    await audit(platform, c, {
      action: signingUp ? 'auth.signup' : 'auth.passkey_add',
      actor: `user:${res.userId}`,
      userId: res.userId,
      target: res.passkey.id.slice(0, 16),
      detail: { passkey: res.passkey.name },
    });
    return c.json({ passkey: res.passkey, recoveryCodes: res.recoveryCodes });
  });

  app.post('/login/options', async (c) => c.json(await auth.authenticationOptions()));

  app.post('/login/verify', async (c) => {
    const b = await jsonBody<{ challengeId: string; response: { id?: string } }>(c);
    const res = await attempt(
      c,
      'auth.login',
      () => auth.verifyAuthentication(str(b.challengeId, 'challengeId'), b.response as never),
      { passkey: String(b.response?.id ?? '').slice(0, 16) },
    );
    setSession(c, res.token);
    await audit(platform, c, {
      action: 'auth.login',
      actor: `user:${res.userId}`,
      userId: res.userId,
      target: res.credentialId.slice(0, 16),
    });
    return c.json({ ok: true });
  });

  app.post('/recovery', async (c) => {
    const b = await jsonBody<{ username: string; code: string }>(c);
    const username = str(b.username, 'username');
    const res = await attempt(
      c,
      'auth.recovery_login',
      () => auth.loginWithRecoveryCode(username, str(b.code, 'code')),
      { username: username.slice(0, 40) },
    );
    setSession(c, res.token, 1);
    await audit(platform, c, {
      action: 'auth.recovery_login',
      actor: `user:${res.userId}`,
      userId: res.userId,
      detail: { remaining: await auth.remainingRecoveryCodes(res.userId) },
    });
    return c.json({ ok: true, mustRegisterPasskey: true });
  });

  app.post('/logout', async (c) => {
    const t = c.get('sessionToken');
    if (t) {
      await auth.logout(t);
      await audit(platform, c, { action: 'auth.logout' });
    }
    deleteCookie(c, COOKIE, { path: '/', secure });
    return c.json({ ok: true });
  });

  app.post('/logout-all', async (c) => {
    const s = requireHuman(c);
    await auth.logoutEverywhere(s.userId);
    await audit(platform, c, { action: 'auth.logout_all' });
    deleteCookie(c, COOKIE, { path: '/', secure });
    return c.json({ ok: true });
  });

  app.get('/passkeys', async (c) => c.json(await auth.passkeys(requireHuman(c).userId)));

  app.patch('/passkeys/:id', async (c) => {
    const s = requireHuman(c);
    const b = await jsonBody<{ name: string }>(c);
    await auth.renamePasskey(s.userId, c.req.param('id'), str(b.name, 'name'));
    return c.json({ ok: true });
  });

  app.delete('/passkeys/:id', async (c) => {
    const s = requireHuman(c);
    const id = c.req.param('id');
    const pk = await auth.passkey(s.userId, id);
    await auth.deletePasskey(s.userId, id);
    await audit(platform, c, {
      action: 'auth.passkey_delete',
      target: id.slice(0, 16),
      detail: { passkey: pk?.name ?? null },
    });
    return c.json({ ok: true });
  });

  app.post('/recovery-codes', async (c) => {
    const codes = await auth.replaceRecoveryCodes(requireHuman(c).userId);
    await audit(platform, c, { action: 'auth.recovery_codes_regenerated' });
    return c.json({ codes });
  });

  /** Delete your own account and every note stored here (GitHub repositories are untouched). */
  app.post('/delete-account', async (c) => {
    const s = requireHuman(c);
    const b = await jsonBody<{ username: string }>(c);
    if (b.username !== s.username)
      return c.json({ error: '確認のためユーザー名を正しく入力してください' }, 400);
    if (s.isAdmin) {
      const users = await auth.users();
      if (users.length > 1 && !users.some((u) => u.isAdmin && u.id !== s.userId))
        return c.json({ error: '他のユーザーがいる間は、管理者のアカウントは削除できません' }, 409);
    }
    await platform.deleteUser(s.userId);
    await audit(platform, c, { action: 'account.delete', detail: { username: s.username } });
    deleteCookie(c, COOKIE, { path: '/', secure });
    return c.json({ ok: true });
  });

  return app;
}
