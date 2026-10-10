import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, normalize, relative } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { AgentLens } from './ai/agent-lens.js';
import { adminRoutes } from './api/admin-routes.js';
import { AgentOps } from './api/agent-ops.js';
import { authRoutes } from './api/auth-routes.js';
import { authMiddleware, type Env, errorResponse, requireHuman } from './api/http.js';
import { notesRoutes } from './api/notes-routes.js';
import type { AppContext } from './app.js';
import { OAuthError } from './auth/oauth.js';
import { handleMcp } from './mcp/mcp.js';

const STATIC_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
};

export function createHttpApp(ctx: AppContext) {
  const app = new Hono<Env>();
  const ops = new AgentOps(ctx, new AgentLens(ctx.appDb, () => ctx.extraRules));

  app.onError((err, c) => errorResponse(err, c));

  app.use('*', async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'same-origin');
    if (!c.req.path.startsWith('/api/file')) c.header('x-frame-options', 'DENY');
  });

  app.use('*', authMiddleware(ctx));

  app.get('/api/health', (c) => c.json({ ok: true }));
  app.route('/api/auth', authRoutes(ctx));
  app.route('/api/admin', adminRoutes(ctx));
  app.route('/api', notesRoutes(ctx, ops));

  // ---- plugin routes -------------------------------------------------------
  app.all('/api/plugins/:plugin/*', async (c) => {
    requireHuman(c);
    const plugin = ctx.plugins.find((p) => p.name === c.req.param('plugin'));
    const sub = c.req.path.slice(`/api/plugins/${c.req.param('plugin')}`.length) || '/';
    const route = plugin?.routes.find((r) => r.method === c.req.method && r.path === sub);
    if (!route) throw new HTTPException(404, { message: 'not found' });
    return route.handler(c.req.raw);
  });

  // ---- OAuth for MCP clients -------------------------------------------------
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version' };
  app.get('/.well-known/oauth-authorization-server', (c) => c.json(ctx.oauth.metadata(), 200, cors));
  app.get('/.well-known/oauth-protected-resource', (c) => c.json(ctx.oauth.resourceMetadata(), 200, cors));
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(ctx.oauth.resourceMetadata(), 200, cors));
  app.options('/oauth/*', (c) => c.body(null, 204, { ...cors, 'access-control-allow-methods': 'POST, GET, OPTIONS' }));
  app.options('/mcp', (c) => c.body(null, 204, { ...cors, 'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS', 'access-control-expose-headers': 'mcp-session-id, www-authenticate' }));

  app.post('/oauth/register', async (c) => {
    try {
      return c.json(ctx.oauth.register(await c.req.json().catch(() => ({}))), 201, cors);
    } catch (e) {
      if (e instanceof OAuthError) return c.json({ error: e.error, error_description: e.description }, 400, cors);
      throw e;
    }
  });

  app.get('/oauth/authorize', (c) => {
    const q = c.req.query();
    try {
      ctx.oauth.validateAuthorize(q);
    } catch (e) {
      if (e instanceof OAuthError) return c.text(`Authorization error: ${e.description}`, 400);
      throw e;
    }
    // The web app renders the consent screen (and asks for a passkey sign-in first).
    return c.redirect(`/oauth/consent?${new URLSearchParams(q as Record<string, string>).toString()}`);
  });

  app.post('/oauth/token', async (c) => {
    const ct = c.req.header('content-type') ?? '';
    const form: Record<string, string> = ct.includes('application/json')
      ? ((await c.req.json().catch(() => ({}))) as Record<string, string>)
      : Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
    try {
      return c.json(ctx.oauth.token(form), 200, { ...cors, 'cache-control': 'no-store' });
    } catch (e) {
      if (e instanceof OAuthError) return c.json({ error: e.error, error_description: e.description }, e.status as 400, cors);
      throw e;
    }
  });

  app.post('/oauth/revoke', async (c) => {
    const form = await c.req.parseBody();
    if (typeof form['token'] === 'string') ctx.tokens.revokeToken(form['token']);
    return c.body(null, 200, cors);
  });

  // ---- MCP -----------------------------------------------------------------
  app.all('/mcp', async (c) => {
    const principal = c.get('principal');
    if (!principal) {
      return c.json({ error: 'unauthorized' }, 401, {
        ...cors,
        'WWW-Authenticate': `Bearer resource_metadata="${ctx.cfg.origin}/.well-known/oauth-protected-resource"`,
      });
    }
    if (c.req.method === 'GET' || c.req.method === 'DELETE') return c.body(null, 405, { ...cors, allow: 'POST' });
    const res = await handleMcp(ctx, ops, principal, c.req.raw);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  });

  // ---- web app (static, SPA fallback) ----------------------------------------
  const webDir = ctx.cfg.webDir;
  if (existsSync(join(webDir, 'index.html'))) {
    app.get('*', async (c) => {
      if (c.req.path.startsWith('/api/')) throw new HTTPException(404, { message: 'not found' });
      const rel = normalize(decodeURIComponent(c.req.path)).replace(/^[/\\]+/, '');
      const file = join(webDir, rel);
      const inside = !relative(webDir, file).startsWith('..');
      const target = inside && rel && existsSync(file) && !file.endsWith('/') ? file : join(webDir, 'index.html');
      const data = await readFile(target).catch(() => readFile(join(webDir, 'index.html')));
      const ext = target.slice(target.lastIndexOf('.') + 1);
      const immutable = rel.startsWith('assets/');
      return new Response(new Uint8Array(data), {
        headers: {
          'content-type': STATIC_TYPES[ext] ?? 'application/octet-stream',
          'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
          ...(ext === 'html'
            ? {
                'content-security-policy':
                  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
              }
            : {}),
        },
      });
    });
  } else {
    app.get('/', (c) => c.text('Web app is not built. Run `npm run build` (packages/web) or use the API.'));
  }

  return app;
}
