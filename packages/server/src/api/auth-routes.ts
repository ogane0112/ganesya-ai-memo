import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { AppContext } from '../app.js';
import { loadPrefs } from '../auth/prefs.js';
import { type Env, jsonBody, requireHuman, SESSION_COOKIE, str } from './http.js';

export function authRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  const secure = ctx.cfg.origin.startsWith('https://');

  const setSession = (
    c: Parameters<typeof setCookie>[0],
    token: string,
    days = ctx.cfg.sessionDays,
  ) =>
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: days * 86400,
    });

  app.get('/state', (c) => {
    const s = c.get('session');
    return c.json({
      needsSetup: ctx.auth.needsSetup(),
      user: s ? { username: s.username } : null,
      session: s ? { via: s.via, expiresAt: s.expiresAt } : null,
      rpId: ctx.cfg.rpId,
      origin: ctx.cfg.origin,
      recoveryCodesRemaining: s ? ctx.auth.remainingRecoveryCodes() : null,
      passkeyCount: s ? ctx.auth.passkeys().length : null,
      prefs: s ? loadPrefs(ctx.appDb) : null,
    });
  });

  app.post('/register/options', async (c) => {
    const b = await jsonBody<{ setupToken?: string; username?: string }>(c);
    return c.json(
      await ctx.auth.registrationOptions({
        session: c.get('session'),
        ...(b.setupToken ? { setupToken: b.setupToken } : {}),
        ...(b.username ? { username: b.username } : {}),
      }),
    );
  });

  app.post('/register/verify', async (c) => {
    const b = await jsonBody<{
      challengeId: string;
      response: never;
      name?: string;
      setupToken?: string;
    }>(c);
    const res = await ctx.auth.verifyRegistration({
      session: c.get('session'),
      challengeId: str(b.challengeId, 'challengeId'),
      response: b.response,
      ...(b.name ? { name: b.name } : {}),
      ...(b.setupToken ? { setupToken: b.setupToken } : {}),
    });
    if (res.sessionToken) setSession(c, res.sessionToken);
    return c.json({ passkey: res.passkey, recoveryCodes: res.recoveryCodes });
  });

  app.post('/login/options', async (c) => c.json(await ctx.auth.authenticationOptions()));

  app.post('/login/verify', async (c) => {
    const b = await jsonBody<{ challengeId: string; response: never }>(c);
    const token = await ctx.auth.verifyAuthentication(
      str(b.challengeId, 'challengeId'),
      b.response,
    );
    setSession(c, token);
    return c.json({ ok: true });
  });

  app.post('/recovery', async (c) => {
    const b = await jsonBody<{ code: string }>(c);
    const token = ctx.auth.loginWithRecoveryCode(str(b.code, 'code'));
    setSession(c, token, 1);
    return c.json({ ok: true, mustRegisterPasskey: true });
  });

  app.post('/logout', (c) => {
    const t = c.get('sessionToken');
    if (t) ctx.auth.logout(t);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.post('/logout-all', (c) => {
    requireHuman(c);
    ctx.auth.logoutEverywhere();
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/passkeys', (c) => {
    requireHuman(c);
    return c.json(ctx.auth.passkeys());
  });

  app.patch('/passkeys/:id', async (c) => {
    requireHuman(c);
    const b = await jsonBody<{ name: string }>(c);
    ctx.auth.renamePasskey(c.req.param('id'), str(b.name, 'name'));
    return c.json({ ok: true });
  });

  app.delete('/passkeys/:id', (c) => {
    requireHuman(c);
    ctx.auth.deletePasskey(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/recovery-codes', (c) => {
    requireHuman(c);
    return c.json({ codes: ctx.auth.replaceRecoveryCodes() });
  });

  return app;
}
