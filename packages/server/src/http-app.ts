import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { adminRoutes } from './api/admin-routes.js';
import { authRoutes } from './api/auth-routes.js';
import {
  audit,
  authMiddleware,
  type Env,
  errorResponse,
  securityMiddleware,
  workspaceOf,
} from './api/http.js';
import { notesRoutes } from './api/notes-routes.js';
import { OAuthError } from './auth/oauth.js';
import { CalendarService } from './calendar/calendar.js';
import { handleMcp } from './mcp/mcp.js';
import type { Platform } from './platform.js';

/** Content-Security-Policy for the web app's HTML. */
export const HTML_CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'";

/**
 * The HTTP API, independent of the runtime. Entry points (node.ts, worker.ts)
 * add static file serving for the web app.
 */
export function createHttpApp(
  platform: Platform,
  opts: { serveStatic?: (req: Request) => Promise<Response | null> } = {},
) {
  const app = new Hono<Env>();
  const { cfg, oauth, tokens } = platform;

  app.onError((err, c) => errorResponse(err, c));

  app.use('*', async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'same-origin');
    if (!c.req.path.startsWith('/api/file')) c.header('x-frame-options', 'DENY');
  });

  app.use('*', securityMiddleware(platform));
  app.use('*', authMiddleware(platform));

  app.get('/api/health', (c) => c.json({ ok: true }));
  app.route('/api/auth', authRoutes(platform));
  app.route('/api/admin', adminRoutes(platform));
  app.route('/api', notesRoutes(platform));

  // ---- calendar feed (public, token in the URL) -------------------------------
  app.get('/cal/:file', async (c) => {
    const m = /^([A-Za-z0-9_-]{16,})\.ics$/.exec(c.req.param('file'));
    const owner = m ? await CalendarService.feedOwner(platform.db, m[1]!) : null;
    const body = owner ? await (await platform.workspace(owner)).calendar.renderFeed(m![1]!) : null;
    if (body === null) return c.text('not found', 404);
    return c.body(body, 200, {
      'content-type': 'text/calendar; charset=utf-8',
      'cache-control': 'private, max-age=300',
      'x-robots-tag': 'noindex',
    });
  });

  // ---- OAuth for MCP clients -------------------------------------------------
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  };
  app.get('/.well-known/oauth-authorization-server', (c) => c.json(oauth.metadata(), 200, cors));
  app.get('/.well-known/oauth-protected-resource', (c) =>
    c.json(oauth.resourceMetadata(), 200, cors),
  );
  app.get('/.well-known/oauth-protected-resource/mcp', (c) =>
    c.json(oauth.resourceMetadata(), 200, cors),
  );
  app.options('/oauth/*', (c) =>
    c.body(null, 204, { ...cors, 'access-control-allow-methods': 'POST, GET, OPTIONS' }),
  );
  app.options('/mcp', (c) =>
    c.body(null, 204, {
      ...cors,
      'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
      'access-control-expose-headers': 'mcp-session-id, www-authenticate',
    }),
  );

  app.post('/oauth/register', async (c) => {
    try {
      const reg = await oauth.register(await c.req.json().catch(() => ({})));
      await audit(platform, c, {
        action: 'oauth.client_register',
        target: String(reg['client_id']),
        userId: null,
        detail: { name: reg['client_name'], redirectUris: reg['redirect_uris'] },
      });
      return c.json(reg, 201, cors);
    } catch (e) {
      if (e instanceof OAuthError)
        return c.json({ error: e.error, error_description: e.description }, 400, cors);
      throw e;
    }
  });

  app.get('/oauth/authorize', async (c) => {
    const q = c.req.query();
    try {
      await oauth.validateAuthorize(q);
    } catch (e) {
      if (e instanceof OAuthError) return c.text(`Authorization error: ${e.description}`, 400);
      throw e;
    }
    // The web app renders the consent screen (and asks for a passkey sign-in first).
    return c.redirect(
      `/oauth/consent?${new URLSearchParams(q as Record<string, string>).toString()}`,
    );
  });

  app.post('/oauth/token', async (c) => {
    const ct = c.req.header('content-type') ?? '';
    const form: Record<string, string> = ct.includes('application/json')
      ? ((await c.req.json().catch(() => ({}))) as Record<string, string>)
      : Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
    try {
      const tok = await oauth.token(form);
      const principal = await platform.tokens.verify(tok.access_token);
      await audit(platform, c, {
        action:
          form['grant_type'] === 'refresh_token' ? 'oauth.token_refresh' : 'oauth.token_issue',
        actor: principal ? `agent:${principal.agent.id}` : 'anonymous',
        userId: principal?.userId ?? null,
        target: form['client_id'] ?? null,
        detail: { scope: tok.scope },
      });
      return c.json(tok, 200, { ...cors, 'cache-control': 'no-store' });
    } catch (e) {
      if (e instanceof OAuthError) {
        await audit(platform, c, {
          action: 'oauth.token_issue',
          outcome: 'failure',
          userId: null,
          target: form['client_id'] ?? null,
          detail: { grant: form['grant_type'] ?? null, error: e.error },
        });
      }
      if (e instanceof OAuthError)
        return c.json({ error: e.error, error_description: e.description }, e.status as 400, cors);
      throw e;
    }
  });

  app.post('/oauth/revoke', async (c) => {
    const form = await c.req.parseBody();
    if (typeof form['token'] === 'string') await tokens.revokeToken(form['token']);
    return c.body(null, 200, cors);
  });

  // ---- MCP -----------------------------------------------------------------
  app.all('/mcp', async (c) => {
    const principal = c.get('principal');
    if (!principal) {
      return c.json({ error: 'unauthorized' }, 401, {
        ...cors,
        'WWW-Authenticate': `Bearer resource_metadata="${cfg.origin}/.well-known/oauth-protected-resource"`,
      });
    }
    if (c.req.method === 'GET' || c.req.method === 'DELETE')
      return c.body(null, 405, { ...cors, allow: 'POST' });
    const res = await handleMcp(await workspaceOf(platform, c), principal, c.req.raw, (ev) =>
      audit(platform, c, ev),
    );
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  });

  // ---- web app ---------------------------------------------------------------
  app.all('*', async (c) => {
    if (c.req.path.startsWith('/api/')) throw new HTTPException(404, { message: 'not found' });
    const res = opts.serveStatic ? await opts.serveStatic(c.req.raw) : null;
    return (
      res ?? c.text('Web app is not built. Run `npm run build` (packages/web) or use the API.', 404)
    );
  });

  return app;
}
