import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { loadPrefs } from '../auth/prefs.js';
import type { Platform } from '../platform.js';
import { type Env, jsonBody, requireHuman, SESSION_COOKIE, str } from './http.js';

export function authRoutes(platform: Platform) {
  const app = new Hono<Env>();
  const { auth, cfg } = platform;
  const secure = cfg.origin.startsWith('https://');

  const setSession = (c: Parameters<typeof setCookie>[0], token: string, days = cfg.sessionDays) =>
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: days * 86400,
    });

  app.get('/state', async (c) => {
    const s = c.get('session');
    return c.json({
      ...(await auth.signupState()),
      user: s ? { username: s.username, isAdmin: s.isAdmin } : null,
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
    return c.json(
      await auth.registrationOptions({
        session: c.get('session'),
        ...(b.setupToken ? { setupToken: b.setupToken } : {}),
        ...(b.username ? { username: b.username } : {}),
        ...(b.inviteCode ? { inviteCode: b.inviteCode } : {}),
      }),
    );
  });

  app.post('/register/verify', async (c) => {
    const b = await jsonBody<{ challengeId: string; response: never; name?: string }>(c);
    const res = await auth.verifyRegistration({
      session: c.get('session'),
      challengeId: str(b.challengeId, 'challengeId'),
      response: b.response,
      ...(b.name ? { name: b.name } : {}),
    });
    if (res.sessionToken) setSession(c, res.sessionToken);
    return c.json({ passkey: res.passkey, recoveryCodes: res.recoveryCodes });
  });

  app.post('/login/options', async (c) => c.json(await auth.authenticationOptions()));

  app.post('/login/verify', async (c) => {
    const b = await jsonBody<{ challengeId: string; response: never }>(c);
    const token = await auth.verifyAuthentication(str(b.challengeId, 'challengeId'), b.response);
    setSession(c, token);
    return c.json({ ok: true });
  });

  app.post('/recovery', async (c) => {
    const b = await jsonBody<{ username: string; code: string }>(c);
    const token = await auth.loginWithRecoveryCode(
      str(b.username, 'username'),
      str(b.code, 'code'),
    );
    setSession(c, token, 1);
    return c.json({ ok: true, mustRegisterPasskey: true });
  });

  app.post('/logout', async (c) => {
    const t = c.get('sessionToken');
    if (t) await auth.logout(t);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.post('/logout-all', async (c) => {
    const s = requireHuman(c);
    await auth.logoutEverywhere(s.userId);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
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
    await auth.deletePasskey(requireHuman(c).userId, c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/recovery-codes', async (c) =>
    c.json({ codes: await auth.replaceRecoveryCodes(requireHuman(c).userId) }),
  );

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
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  return app;
}
