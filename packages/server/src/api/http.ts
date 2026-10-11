import { FrontmatterError, PathError, ViewError } from '@gmemo/core';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import {
  AiUnavailableError,
  publicFinding,
  SensitiveBlockedError,
  SensitiveWarningError,
} from '../ai/gateway.js';
import { type AuditEvent, type RequestMeta, requestMeta } from '../audit/audit.js';
import { accessToken, verifyAccessToken } from '../auth/access.js';
import { AuthError } from '../auth/auth.js';
import { CalendarError } from '../calendar/calendar.js';
import { OAuthError } from '../auth/oauth.js';
import { capabilities, type Principal, type Scope } from '../auth/tokens.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../notes/service.js';
import type { Session } from '../auth/auth.js';
import type { Platform } from '../platform.js';
import { ConcurrentUpdateError, StoreError } from '../store/types.js';
import type { Workspace } from '../workspace.js';

/**
 * Session cookie. Over HTTPS the `__Host-` prefix makes the browser refuse it
 * unless it is Secure, host-only and Path=/ (no subdomain can plant or read it).
 */
export function sessionCookieName(origin: string): string {
  return origin.startsWith('https://') ? '__Host-gm_session' : 'gm_session';
}

export type Env = {
  Variables: {
    session: Session | null;
    principal: Principal | null;
    sessionToken: string | null;
    workspace: Workspace | null;
    meta: RequestMeta;
    /** Who Cloudflare Access let in (when Access is configured). */
    accessIdentity: string | null;
  };
};

/** Record a security event for this request; actor and account default to the caller. */
export async function audit(
  platform: Platform,
  c: Context<Env>,
  ev: Omit<AuditEvent, 'actor'> & { actor?: string },
): Promise<void> {
  const p = c.get('principal');
  const s = c.get('session');
  const actor = ev.actor ?? (p ? `agent:${p.agent.id}` : s ? `user:${s.userId}` : 'anonymous');
  const access = c.get('accessIdentity');
  await platform.audit.record(
    {
      ...ev,
      actor,
      userId: ev.userId === undefined ? (p?.userId ?? s?.userId ?? null) : ev.userId,
      ...(access ? { detail: { ...ev.detail, access } } : {}),
    },
    c.get('meta'),
  );
}

/** Paths whose attempts are rate-limited per client address. */
const LIMITED = [
  '/api/auth/login/',
  '/api/auth/register/',
  '/api/auth/recovery',
  '/oauth/token',
  '/oauth/register',
];

/**
 * First line of defence, before any session lookup:
 * - Cloudflare Access check (always in staging; fail closed if not configured)
 * - rate limits on sign-in and token endpoints
 * - security headers (HSTS, noindex for staging, no caching of account data)
 */
export function securityMiddleware(platform: Platform): MiddlewareHandler<Env> {
  const { cfg } = platform;
  const https = cfg.origin.startsWith('https://');
  return async (c, next) => {
    const meta = requestMeta(c.req.raw.headers);
    c.set('meta', meta);
    c.set('accessIdentity', null);

    const mustUseAccess = cfg.access || (cfg.env === 'staging' && !cfg.insecureDev);
    if (mustUseAccess) {
      if (!cfg.access) {
        console.error('[security] staging requires Cloudflare Access; refusing request');
        return c.text('This environment is not configured for access.', 503);
      }
      const identity = await verifyAccessToken(
        accessToken(c.req.raw),
        cfg.access,
        platform.fetch,
      ).catch((e: unknown) => {
        console.error('[security] Access verification failed', (e as Error).message);
        return null;
      });
      if (!identity) {
        platform.audit.note({ action: 'access.denied', path: c.req.path });
        return c.text('Forbidden', 403);
      }
      c.set('accessIdentity', identity.subject);
    }

    if (c.req.method === 'POST' && LIMITED.some((p) => c.req.path.startsWith(p))) {
      const key = `${meta.ip ?? 'unknown'}:${LIMITED.find((p) => c.req.path.startsWith(p))}`;
      if (!(await platform.authLimiter.allow(key))) {
        await platform.audit.record(
          {
            action: 'security.rate_limited',
            outcome: 'denied',
            actor: 'anonymous',
            target: c.req.path,
          },
          meta,
        );
        return c.json(
          { error: '試行回数が多すぎます。しばらく待ってからやり直してください' },
          429,
          {
            'retry-after': '60',
          },
        );
      }
    }

    await next();
    if (https) c.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (cfg.env !== 'production') c.header('x-robots-tag', 'noindex, nofollow');
    if (c.req.path.startsWith('/api/auth') || c.req.path.startsWith('/api/admin'))
      c.header('cache-control', 'no-store');
  };
}

/** Run work after the response (Workers: waitUntil; Node: just let it run). */
export function deferTo(c: Context): (p: Promise<unknown>) => void {
  return (p) => {
    const safe = p.catch((e: unknown) => console.error('[deferred]', e));
    try {
      c.executionCtx.waitUntil(safe);
    } catch {
      // No execution context outside Workers.
    }
  };
}

export function authMiddleware(platform: Platform): MiddlewareHandler<Env> {
  return async (c, next) => {
    const token = getCookie(c, sessionCookieName(platform.cfg.origin)) ?? null;
    const session = await platform.auth.session(token ?? undefined);
    c.set('session', session);
    c.set('sessionToken', session ? token : null);
    c.set('workspace', null);
    const authz = c.req.header('authorization');
    const bearer = authz?.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : undefined;
    c.set('principal', bearer ? await platform.tokens.verify(bearer) : null);
    if (bearer && !c.get('principal')) {
      // A rejected token can be a leaked or revoked one being tried: keep a record.
      await platform.audit.record(
        {
          action: 'token.rejected',
          outcome: 'denied',
          actor: 'anonymous',
          target: c.req.path,
          detail: { prefix: bearer.slice(0, 4) },
        },
        c.get('meta'),
      );
      return c.json({ error: 'invalid_token' }, 401, {
        'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${platform.cfg.origin}/.well-known/oauth-protected-resource"`,
      });
    }
    // CSRF: cookie-authenticated writes must come from our own origin.
    if (session && !bearer && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin && origin !== platform.cfg.origin) {
        await audit(platform, c, {
          action: 'security.cross_origin_rejected',
          outcome: 'denied',
          target: c.req.path,
          detail: { origin: origin.slice(0, 100) },
        });
        return c.json({ error: 'cross-origin request rejected' }, 403);
      }
    }
    await next();
  };
}

/** The workspace of whoever is calling (the signed-in user, or the token's owner). */
export async function workspaceOf(platform: Platform, c: Context<Env>): Promise<Workspace> {
  const cached = c.get('workspace');
  if (cached) return cached;
  const userId = c.get('principal')?.userId ?? c.get('session')?.userId;
  if (!userId) throw new HTTPException(401, { message: 'sign in required' });
  const session = c.get('principal') ? null : c.get('session');
  const ws = await platform.workspace(userId, session?.username);
  c.set('workspace', ws);
  return ws;
}

export function requireAdmin(c: Context<Env>): Session {
  const s = requireHuman(c);
  if (!s.isAdmin) throw new HTTPException(403, { message: 'admin only' });
  return s;
}

export function requireHuman(c: Context<Env>): Session {
  const s = c.get('session');
  if (!s) throw new HTTPException(401, { message: 'sign in required' });
  return s;
}

/** Either the human or an agent token with the given capability. */
export function requireReader(c: Context<Env>): {
  human: Session | null;
  principal: Principal | null;
} {
  const human = c.get('session');
  const principal = c.get('principal');
  if (principal) {
    if (!capabilities(principal).canRead)
      throw new HTTPException(403, { message: 'token lacks notes:read' });
    return { human: null, principal };
  }
  if (!human) throw new HTTPException(401, { message: 'sign in required' });
  return { human, principal: null };
}

export function requireScope(c: Context<Env>, scope: Scope): Principal {
  const p = c.get('principal');
  if (!p || !p.scope.has(scope)) throw new HTTPException(403, { message: `token lacks ${scope}` });
  return p;
}

export async function jsonBody<T = Record<string, unknown>>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HTTPException(400, { message: 'invalid JSON body' });
  }
}

export function str(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new HTTPException(400, { message: `${name} is required` });
  return v;
}

export function errorResponse(err: Error, c: Context): Response {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
  if (err instanceof OAuthError)
    return c.json({ error: err.error, error_description: err.description }, err.status as 400);
  if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
  if (err instanceof ForbiddenError) return c.json({ error: err.message }, 403);
  if (err instanceof ConflictError)
    return c.json({ error: err.message, details: err.details }, 409);
  if (err instanceof PathError || err instanceof FrontmatterError || err instanceof ViewError)
    return c.json({ error: err.message }, 400);
  if (err instanceof SensitiveBlockedError)
    return c.json(
      { error: err.message, code: 'sensitive_blocked', findings: err.findings.map(publicFinding) },
      422,
    );
  if (err instanceof SensitiveWarningError)
    return c.json(
      { error: err.message, code: 'sensitive_confirm', findings: err.findings.map(publicFinding) },
      428,
    );
  if (err instanceof CalendarError) return c.json({ error: err.message }, 400);
  if (err instanceof StoreError)
    // A rejected GitHub token is not a rejected session: never answer 401 for it.
    return c.json(
      { error: err.message, code: 'storage' },
      (err.status === 401 || err.status === 403 ? 409 : err.status) as 400,
    );
  if (err instanceof ConcurrentUpdateError)
    return c.json({ error: '同時に更新されました。もう一度お試しください' }, 409);
  if (err instanceof AiUnavailableError)
    return c.json({ error: err.message, code: 'ai_unavailable' }, 503);
  console.error(err);
  return c.json({ error: 'internal error' }, 500);
}
