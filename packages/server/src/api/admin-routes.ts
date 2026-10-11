import { normalizePolicy } from '@gmemo/core';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AgentInput } from '../auth/agents.js';
import { loadPrefs, savePrefs } from '../auth/prefs.js';
import { parseScope, type Scope } from '../auth/tokens.js';
import type { Platform } from '../platform.js';
import { MAIN } from '../store/types.js';
import { gzip, tar } from '../util/tar.js';
import { disconnectGitHub, switchStorage } from '../workspace.js';
import { audit, type Env, jsonBody, requireAdmin, requireHuman, str, workspaceOf } from './http.js';

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

/** The signed-in user's settings (agents, tokens, policy, storage, calendar) plus server admin. */
export function adminRoutes(platform: Platform) {
  const app = new Hono<Env>();
  const { db, oauth, tokens, auth } = platform;
  app.use('*', async (c, next) => {
    requireHuman(c);
    await next();
  });
  const ws = (c: Parameters<typeof workspaceOf>[1]) => workspaceOf(platform, c);
  const log = (c: Parameters<typeof workspaceOf>[1], ev: Parameters<typeof audit>[2]) =>
    audit(platform, c, ev);

  // ---- security log ----------------------------------------------------------

  /** Your own security events; admins can pass scope=all for the whole server. */
  app.get('/security-log', async (c) => {
    const s = requireHuman(c);
    const all = c.req.query('scope') === 'all';
    if (all && !s.isAdmin) throw new HTTPException(403, { message: 'admin only' });
    const outcome = c.req.query('outcome');
    return c.json(
      await platform.audit.list({
        ...(all ? {} : { userId: s.userId }),
        ...(c.req.query('action') ? { action: c.req.query('action')! } : {}),
        ...(outcome === 'success' || outcome === 'failure' || outcome === 'denied'
          ? { outcome }
          : {}),
        ...(c.req.query('before') ? { before: Number(c.req.query('before')) } : {}),
        limit: Number(c.req.query('limit') ?? 100),
      }),
    );
  });

  /** Check that no security event was edited or removed (admin). */
  app.post('/security-log/verify', async (c) => {
    requireAdmin(c);
    const res = await platform.audit.verify();
    await log(c, {
      action: 'audit.verify',
      outcome: res.tampered.length || res.missing.length ? 'failure' : 'success',
      userId: null,
      detail: { checked: res.checked, tampered: res.tampered.length, missing: res.missing.length },
    });
    return c.json(res);
  });

  // ---- agents & tokens -----------------------------------------------------

  app.get('/agents', async (c) => {
    const w = await ws(c);
    const clients = await oauth.clients(w.userId);
    const now = new Date().toISOString();
    const active = (await tokens.list(w.userId)).filter(
      (t) => !t.revokedAt && (!t.expiresAt || t.expiresAt > now),
    );
    return c.json(
      (await w.agents.list()).map((a) => ({
        ...a,
        clients: clients
          .filter((cl) => cl.agentId === a.id)
          .map((cl) => ({
            clientId: cl.clientId,
            clientName: cl.clientName,
            createdAt: cl.createdAt,
          })),
        tokens: active.filter((t) => t.agentId === a.id),
      })),
    );
  });

  app.post('/agents', async (c) => {
    const input = agentInput(await jsonBody(c));
    const agent = await (await ws(c)).agents.create({ ...input, name: str(input.name, 'name') });
    await log(c, {
      action: 'agent.create',
      target: agent.id,
      detail: { name: agent.name, writeMode: agent.writeMode, folders: agent.folders },
    });
    return c.json(agent);
  });

  app.patch('/agents/:id', async (c) => {
    const patch = agentInput(await jsonBody(c));
    const a = await (await ws(c)).agents.update(c.req.param('id'), patch);
    if (!a) throw new HTTPException(404, { message: 'agent not found' });
    await log(c, { action: 'agent.update', target: a.id, detail: { changed: Object.keys(patch) } });
    return c.json(a);
  });

  app.delete('/agents/:id', async (c) => {
    await (await ws(c)).agents.revoke(c.req.param('id'));
    await log(c, { action: 'agent.revoke', target: c.req.param('id') });
    return c.json({ ok: true });
  });

  app.post('/agents/:id/tokens', async (c) => {
    const w = await ws(c);
    const agent = await w.agents.get(c.req.param('id'));
    if (!agent || agent.revokedAt) throw new HTTPException(404, { message: 'agent not found' });
    const b = await jsonBody<{ scope?: string | Scope[]; label?: string; expiresInDays?: number }>(
      c,
    );
    const scope = parseScope(Array.isArray(b.scope) ? b.scope.join(' ') : b.scope);
    const token = await tokens.createPat(
      w.userId,
      agent.id,
      scope,
      (b.label ?? '').slice(0, 60),
      b.expiresInDays && b.expiresInDays > 0 ? b.expiresInDays : undefined,
    );
    await log(c, {
      action: 'token.create',
      target: agent.id,
      detail: { scope, label: b.label ?? '', expiresInDays: b.expiresInDays ?? null },
    });
    return c.json({ token, scope });
  });

  app.delete('/tokens/:id', async (c) => {
    await tokens.revokeToken(c.req.param('id'), requireHuman(c).userId);
    await log(c, { action: 'token.revoke', target: c.req.param('id') });
    return c.json({ ok: true });
  });

  app.delete('/oauth-clients/:id', async (c) => {
    await oauth.disconnectClient(requireHuman(c).userId, c.req.param('id'));
    await log(c, { action: 'oauth.client_disconnect', target: c.req.param('id') });
    return c.json({ ok: true });
  });

  // ---- OAuth consent (the web UI renders the screen) ------------------------

  app.get('/oauth/request', async (c) => {
    const w = await ws(c);
    const req = await oauth.validateAuthorize(c.req.query());
    const client = (await oauth.client(req.clientId))!;
    return c.json({
      request: req,
      client: {
        name: client.clientName,
        redirectUri: req.redirectUri,
        linkedAgentId: await oauth.linkedAgent(req.clientId, w.userId),
      },
      agents: (await w.agents.list()).filter((a) => !a.revokedAt),
    });
  });

  app.post('/oauth/consent', async (c) => {
    const w = await ws(c);
    const b = await jsonBody<{
      query: Record<string, string>;
      approve: boolean;
      agentId?: string;
      newAgent?: Record<string, unknown>;
      scope?: Scope[];
    }>(c);
    const req = await oauth.validateAuthorize(b.query ?? {});
    if (!b.approve) {
      await log(c, { action: 'oauth.consent', outcome: 'denied', target: req.clientId });
      return c.json({ redirect: oauth.deny(req) });
    }
    const newAgent = b.newAgent ? agentInput(b.newAgent) : undefined;
    const redirect = await oauth.approve(w.userId, w.agents, req, {
      ...(b.agentId ? { agentId: b.agentId } : {}),
      ...(newAgent?.name ? { newAgent: newAgent as AgentInput } : {}),
      ...(b.scope ? { scope: b.scope } : {}),
    });
    await log(c, {
      action: 'oauth.consent',
      target: req.clientId,
      detail: {
        client: (await oauth.client(req.clientId))?.clientName ?? null,
        agentId: await oauth.linkedAgent(req.clientId, w.userId),
        scope: b.scope ?? req.scope,
      },
    });
    return c.json({ redirect });
  });

  // ---- display preferences --------------------------------------------------

  app.get('/preferences', async (c) => c.json(await loadPrefs(db, requireHuman(c).userId)));
  app.put('/preferences', async (c) =>
    c.json(await savePrefs(db, requireHuman(c).userId, await jsonBody(c))),
  );

  // ---- workspace policy ----------------------------------------------------

  app.get('/policy', async (c) => c.json(await (await ws(c)).notes.loadPolicy()));

  app.put('/policy', async (c) => {
    const policy = normalizePolicy(await jsonBody(c));
    await (await ws(c)).notes.savePolicy(policy);
    await log(c, {
      action: 'policy.update',
      detail: {
        default: policy.ai.default,
        folders: policy.ai.folders,
        sensitiveMode: policy.sensitive.mode,
        externalAcknowledged: policy.externalAcknowledged,
      },
    });
    return c.json(policy);
  });

  /** Mark a finding as "not a problem" so it is ignored from now on. */
  app.post('/policy/allow', async (c) => {
    const w = await ws(c);
    const b = await jsonBody<{ fingerprint: string }>(c);
    const policy = await w.notes.loadPolicy();
    const fp = str(b.fingerprint, 'fingerprint');
    if (!policy.sensitive.allow.includes(fp)) policy.sensitive.allow.push(fp);
    await w.notes.savePolicy(policy);
    await log(c, { action: 'policy.allow_finding', target: fp.slice(0, 16) });
    return c.json({ ok: true });
  });

  // ---- storage (built-in or GitHub) -------------------------------------------

  app.get('/storage', async (c) => {
    const w = await ws(c);
    return c.json({ ...w.settings, githubAvailable: !!platform.cfg.secretKey });
  });

  app.put('/storage', async (c) => {
    const w = await ws(c);
    const b = await jsonBody<{
      storage: 'builtin' | 'github';
      github?: { owner?: string; repo?: string; branch?: string; token?: string };
      copy?: boolean;
    }>(c);
    const res = await switchStorage(
      platform.deps,
      w,
      b.storage === 'github'
        ? {
            storage: 'github',
            github: {
              owner: str(b.github?.owner, 'github.owner'),
              repo: str(b.github?.repo, 'github.repo'),
              ...(b.github?.branch ? { branch: b.github.branch } : {}),
              ...(b.github?.token ? { token: b.github.token } : {}),
            },
            copy: b.copy !== false,
          }
        : { storage: 'builtin' },
    );
    platform.forget(w.userId);
    const next = await platform.workspace(w.userId);
    await log(c, {
      action: 'storage.change',
      detail: {
        from: w.settings.storage,
        to: next.settings.storage,
        repo: next.settings.github
          ? `${next.settings.github.owner}/${next.settings.github.repo}`
          : null,
        copied: res.copied,
        tokenChanged: !!b.github?.token,
      },
    });
    await next.notes.currentHead();
    return c.json({ ...res, settings: next.settings });
  });

  app.delete('/storage/github', async (c) => {
    const s = requireHuman(c);
    await disconnectGitHub(db, s.userId);
    platform.forget(s.userId);
    await log(c, { action: 'storage.github_forget' });
    return c.json({ ok: true });
  });

  // ---- maintenance ---------------------------------------------------------

  app.post('/reindex', async (c) => {
    await (await ws(c)).indexer.rebuild();
    return c.json({ ok: true });
  });

  /** Download the current notes (latest version of every file) as .tar.gz. */
  app.get('/export', async (c) => {
    const w = await ws(c);
    const head = await w.store.head(MAIN);
    const files = head ? await w.store.snapshot(head) : new Map<string, Uint8Array>();
    const root = `notes-${new Date().toISOString().slice(0, 10)}`;
    const data = await gzip(
      tar([...files].map(([path, bytes]) => ({ path: `${root}/${path}`, data: bytes }))),
    );
    await log(c, { action: 'data.export', detail: { files: files.size, bytes: data.length } });
    return new Response(data as unknown as ConstructorParameters<typeof Response>[0], {
      headers: {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename="${root}.tar.gz"`,
        'cache-control': 'no-store',
      },
    });
  });

  // ---- calendar --------------------------------------------------------------

  app.get('/calendar/feeds', async (c) => c.json(await (await ws(c)).calendar.feeds()));

  app.post('/calendar/feeds', async (c) => {
    const b = await jsonBody<{ viewId: string; label?: string; includeLinks?: boolean }>(c);
    const res = await (
      await ws(c)
    ).calendar.createFeed(str(b.viewId, 'viewId'), {
      ...(b.label ? { label: b.label } : {}),
      includeLinks: b.includeLinks === true,
    });
    // A feed URL publishes note titles to whoever has the link.
    await log(c, {
      action: 'calendar.feed_create',
      target: res.feed.id,
      detail: { viewId: b.viewId, includeLinks: b.includeLinks === true },
    });
    return c.json(res);
  });

  app.delete('/calendar/feeds/:id', async (c) => {
    await (await ws(c)).calendar.revokeFeed(c.req.param('id'));
    await log(c, { action: 'calendar.feed_revoke', target: c.req.param('id') });
    return c.json({ ok: true });
  });

  app.get('/calendar/subscriptions', async (c) =>
    c.json(await (await ws(c)).calendar.subscriptions()),
  );

  app.post('/calendar/subscriptions', async (c) => {
    const b = await jsonBody<{ name?: string; url: string; color?: string }>(c);
    return c.json(
      await (
        await ws(c)
      ).calendar.addSubscription({
        name: b.name ?? '',
        url: str(b.url, 'url'),
        ...(b.color ? { color: b.color } : {}),
      }),
    );
  });

  app.patch('/calendar/subscriptions/:id', async (c) => {
    const b = await jsonBody<{ name?: string; url?: string; color?: string; enabled?: boolean }>(c);
    return c.json(await (await ws(c)).calendar.updateSubscription(c.req.param('id'), b));
  });

  app.post('/calendar/subscriptions/:id/refresh', async (c) => {
    const w = await ws(c);
    await w.calendar.refresh(c.req.param('id'));
    return c.json(
      (await w.calendar.subscriptions()).find((s) => s.id === c.req.param('id')) ?? null,
    );
  });

  app.delete('/calendar/subscriptions/:id', async (c) => {
    await (await ws(c)).calendar.deleteSubscription(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ---- server administration (admin account only) -------------------------------

  app.get('/users', async (c) => {
    requireAdmin(c);
    return c.json({ users: await auth.users(), signup: platform.cfg.signup });
  });

  app.delete('/users/:id', async (c) => {
    const s = requireAdmin(c);
    if (c.req.param('id') === s.userId)
      throw new HTTPException(400, { message: '自分のアカウントはここでは削除できません' });
    const target = await auth.user(c.req.param('id'));
    await platform.deleteUser(c.req.param('id'));
    await log(c, {
      action: 'admin.user_delete',
      userId: c.req.param('id'),
      target: c.req.param('id'),
      detail: { username: target?.username ?? null },
    });
    return c.json({ ok: true });
  });

  /** A user lost all passkeys and recovery codes: new recovery codes to hand over in person. */
  app.post('/users/:id/reset', async (c) => {
    requireAdmin(c);
    if (!(await auth.user(c.req.param('id'))))
      throw new HTTPException(404, { message: 'user not found' });
    const codes = await auth.adminResetUser(c.req.param('id'));
    await log(c, {
      action: 'admin.user_reset',
      userId: c.req.param('id'),
      target: c.req.param('id'),
    });
    return c.json({ codes });
  });

  app.get('/invites', async (c) => {
    requireAdmin(c);
    return c.json(await auth.invites());
  });

  app.post('/invites', async (c) => {
    const s = requireAdmin(c);
    const b = await jsonBody<{ days?: number }>(c).catch(() => ({ days: 7 }));
    const days = Math.min(Math.max(Number(b.days) || 7, 1), 90);
    const { code, invite } = await auth.createInvite(s.userId, days);
    await log(c, { action: 'admin.invite_create', target: invite.id, detail: { days } });
    return c.json({ code, url: `${platform.cfg.origin}/signup?invite=${code}`, invite });
  });

  app.delete('/invites/:id', async (c) => {
    requireAdmin(c);
    await auth.deleteInvite(c.req.param('id'));
    await log(c, { action: 'admin.invite_delete', target: c.req.param('id') });
    return c.json({ ok: true });
  });

  return app;
}
