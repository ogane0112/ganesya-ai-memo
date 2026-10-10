import { normalizePolicy } from '@gmemo/core';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppContext } from '../app.js';
import { loadPrefs, savePrefs } from '../auth/prefs.js';
import type { AgentInput } from '../auth/agents.js';
import { parseScope, type Scope } from '../auth/tokens.js';
import { createBackup } from '../backup.js';
import { type Env, jsonBody, requireHuman, str } from './http.js';

function agentInput(b: Record<string, unknown>): Partial<AgentInput> {
  const out: Partial<AgentInput> = {};
  if (typeof b['name'] === 'string') out.name = b['name'];
  if (typeof b['description'] === 'string') out.description = b['description'];
  if (typeof b['canRead'] === 'boolean') out.canRead = b['canRead'];
  if (b['writeMode'] === 'none' || b['writeMode'] === 'propose' || b['writeMode'] === 'direct')
    out.writeMode = b['writeMode'];
  if (Array.isArray(b['folders']))
    out.folders = b['folders'].filter((x): x is string => typeof x === 'string');
  if (b['location'] === 'external' || b['location'] === 'local') out.location = b['location'];
  if (typeof b['autoMerge'] === 'boolean') out.autoMerge = b['autoMerge'];
  if (Array.isArray(b['autoMergeFolders']))
    out.autoMergeFolders = b['autoMergeFolders'].filter((x): x is string => typeof x === 'string');
  return out;
}

export function adminRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    requireHuman(c);
    await next();
  });

  // ---- agents & tokens -----------------------------------------------------

  app.get('/agents', (c) => {
    const clients = ctx.oauth.clients();
    return c.json(
      ctx.agents.list().map((a) => ({
        ...a,
        clients: clients
          .filter((cl) => cl.agentId === a.id)
          .map((cl) => ({
            clientId: cl.clientId,
            clientName: cl.clientName,
            createdAt: cl.createdAt,
          })),
        tokens: ctx.tokens
          .list(a.id)
          .filter((t) => !t.revokedAt && (!t.expiresAt || t.expiresAt > new Date().toISOString())),
      })),
    );
  });

  app.post('/agents', async (c) => {
    const b = await jsonBody(c);
    const input = agentInput(b);
    return c.json(ctx.agents.create({ ...input, name: str(input.name, 'name') }));
  });

  app.patch('/agents/:id', async (c) => {
    const a = ctx.agents.update(c.req.param('id'), agentInput(await jsonBody(c)));
    if (!a) throw new HTTPException(404, { message: 'agent not found' });
    return c.json(a);
  });

  app.delete('/agents/:id', (c) => {
    ctx.agents.revoke(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/agents/:id/tokens', async (c) => {
    const agent = ctx.agents.get(c.req.param('id'));
    if (!agent || agent.revokedAt) throw new HTTPException(404, { message: 'agent not found' });
    const b = await jsonBody<{ scope?: string | Scope[]; label?: string; expiresInDays?: number }>(
      c,
    );
    const scope = parseScope(Array.isArray(b.scope) ? b.scope.join(' ') : b.scope);
    const token = ctx.tokens.createPat(
      agent.id,
      scope,
      (b.label ?? '').slice(0, 60),
      b.expiresInDays && b.expiresInDays > 0 ? b.expiresInDays : undefined,
    );
    return c.json({ token, scope });
  });

  app.delete('/tokens/:id', (c) => {
    ctx.tokens.revokeToken(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.delete('/oauth-clients/:id', (c) => {
    ctx.oauth.deleteClient(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ---- OAuth consent (the web UI renders the screen) ------------------------

  app.get('/oauth/request', (c) => {
    const q = c.req.query();
    const req = ctx.oauth.validateAuthorize(q);
    const client = ctx.oauth.client(req.clientId)!;
    return c.json({
      request: req,
      client: {
        name: client.clientName,
        redirectUri: req.redirectUri,
        linkedAgentId: client.agentId,
      },
      agents: ctx.agents.list().filter((a) => !a.revokedAt),
    });
  });

  app.post('/oauth/consent', async (c) => {
    const b = await jsonBody<{
      query: Record<string, string>;
      approve: boolean;
      agentId?: string;
      newAgent?: Record<string, unknown>;
      scope?: Scope[];
    }>(c);
    const req = ctx.oauth.validateAuthorize(b.query ?? {});
    if (!b.approve) return c.json({ redirect: ctx.oauth.deny(req) });
    const newAgent = b.newAgent ? agentInput(b.newAgent) : undefined;
    const redirect = ctx.oauth.approve(req, {
      ...(b.agentId ? { agentId: b.agentId } : {}),
      ...(newAgent?.name ? { newAgent: newAgent as AgentInput } : {}),
      ...(b.scope ? { scope: b.scope } : {}),
    });
    return c.json({ redirect });
  });

  // ---- workspace policy ----------------------------------------------------

  // ---- display preferences --------------------------------------------------

  app.get('/preferences', (c) => c.json(loadPrefs(ctx.appDb)));
  app.put('/preferences', async (c) => c.json(savePrefs(ctx.appDb, await jsonBody(c))));

  app.get('/policy', async (c) => c.json(await ctx.notes.loadPolicy()));

  app.put('/policy', async (c) => {
    const policy = normalizePolicy(await jsonBody(c));
    await ctx.notes.savePolicy(policy);
    return c.json(policy);
  });

  /** Mark a finding as "not a problem" so it is ignored from now on. */
  app.post('/policy/allow', async (c) => {
    const b = await jsonBody<{ fingerprint: string }>(c);
    const policy = await ctx.notes.loadPolicy();
    const fp = str(b.fingerprint, 'fingerprint');
    if (!policy.sensitive.allow.includes(fp)) policy.sensitive.allow.push(fp);
    await ctx.notes.savePolicy(policy);
    return c.json({ ok: true });
  });

  // ---- maintenance ---------------------------------------------------------

  app.post('/reindex', async (c) => {
    await ctx.indexer.rebuild();
    return c.json({ ok: true });
  });

  app.post('/backup', async (c) => {
    const b = await jsonBody<{ passphrase?: string }>(c);
    const data = await createBackup(ctx.repo, ctx.appDb, b.passphrase || undefined);
    const name = `gmemo-backup-${new Date().toISOString().slice(0, 10)}${b.passphrase ? '.enc' : ''}.gmbk`;
    return new Response(new Uint8Array(data), {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${name}"`,
      },
    });
  });

  // ---- calendar --------------------------------------------------------------

  app.get('/calendar/feeds', (c) => c.json(ctx.calendar.feeds()));

  app.post('/calendar/feeds', async (c) => {
    const b = await jsonBody<{ viewId: string; label?: string; includeLinks?: boolean }>(c);
    return c.json(
      await ctx.calendar.createFeed(str(b.viewId, 'viewId'), {
        ...(b.label ? { label: b.label } : {}),
        includeLinks: b.includeLinks === true,
      }),
    );
  });

  app.delete('/calendar/feeds/:id', (c) => {
    ctx.calendar.revokeFeed(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/calendar/subscriptions', (c) => c.json(ctx.calendar.subscriptions()));

  app.post('/calendar/subscriptions', async (c) => {
    const b = await jsonBody<{ name?: string; url: string; color?: string }>(c);
    return c.json(
      await ctx.calendar.addSubscription({
        name: b.name ?? '',
        url: str(b.url, 'url'),
        ...(b.color ? { color: b.color } : {}),
      }),
    );
  });

  app.patch('/calendar/subscriptions/:id', async (c) => {
    const b = await jsonBody<{ name?: string; url?: string; color?: string; enabled?: boolean }>(c);
    return c.json(ctx.calendar.updateSubscription(c.req.param('id'), b));
  });

  app.post('/calendar/subscriptions/:id/refresh', async (c) => {
    await ctx.calendar.refresh(c.req.param('id'));
    return c.json(ctx.calendar.subscriptions().find((s) => s.id === c.req.param('id')) ?? null);
  });

  app.delete('/calendar/subscriptions/:id', (c) => {
    ctx.calendar.deleteSubscription(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/plugins', (c) =>
    c.json(
      ctx.plugins.map((p) => ({
        name: p.name,
        error: p.error ?? null,
        routes: p.routes.map((r) => `${r.method} ${r.path}`),
        tools: p.tools.map((t) => t.name),
      })),
    ),
  );

  return app;
}
