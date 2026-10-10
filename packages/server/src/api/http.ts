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
import type { AppContext } from '../app.js';
import { AuthError } from '../auth/auth.js';
import { CalendarError } from '../calendar/calendar.js';
import { OAuthError } from '../auth/oauth.js';
import { capabilities, type Principal, type Scope } from '../auth/tokens.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../notes/service.js';
import type { Session } from '../auth/auth.js';

export const SESSION_COOKIE = 'gm_session';

export type Env = {
  Variables: {
    session: Session | null;
    principal: Principal | null;
    sessionToken: string | null;
  };
};

export function authMiddleware(ctx: AppContext): MiddlewareHandler<Env> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE) ?? null;
    const session = ctx.auth.session(token ?? undefined);
    c.set('session', session);
    c.set('sessionToken', session ? token : null);
    const authz = c.req.header('authorization');
    const bearer = authz?.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : undefined;
    c.set('principal', bearer ? ctx.tokens.verify(bearer) : null);
    if (bearer && !c.get('principal')) {
      return c.json({ error: 'invalid_token' }, 401, {
        'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${ctx.cfg.origin}/.well-known/oauth-protected-resource"`,
      });
    }
    // CSRF: cookie-authenticated writes must come from our own origin.
    if (session && !bearer && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin && origin !== ctx.cfg.origin)
        return c.json({ error: 'cross-origin request rejected' }, 403);
    }
    await next();
  };
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
  if (err instanceof AiUnavailableError)
    return c.json({ error: err.message, code: 'ai_unavailable' }, 503);
  console.error(err);
  return c.json({ error: 'internal error' }, 500);
}
