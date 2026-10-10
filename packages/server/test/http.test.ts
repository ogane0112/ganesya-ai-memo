import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiGateway } from '../src/ai/gateway.js';
import type { LlmClient } from '../src/ai/llm.js';
import { type AppContext, createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { readBackup } from '../src/backup.js';
import { createHttpApp } from '../src/server.js';

let dir: string;
let ctx: AppContext;
let app: ReturnType<typeof createHttpApp>;
let cookie: string;
const ORIGIN = 'http://localhost:8787';
const sent: string[] = [];

function fakeLlm(location: 'local' | 'external'): LlmClient {
  return {
    location,
    label: `fake-${location}`,
    async chat(req) {
      sent.push(req.system + '\n' + req.messages.map((m) => m.content).join('\n'));
      return `answer from ${location} mentioning [SECRET_1]`;
    },
  };
}

async function req(path: string, init: RequestInit & { json?: unknown; bearer?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  if (init.bearer) headers.set('authorization', `Bearer ${init.bearer}`);
  else if (cookie) headers.set('cookie', cookie);
  return app.request(`${ORIGIN}${path}`, {
    ...init,
    headers,
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gmemo-http-'));
  ctx = await createApp(
    loadConfig({
      dataDir: dir,
      notesDir: join(dir, 'notes'),
      appDbFile: join(dir, 'app.db'),
      indexDbFile: join(dir, 'index.db'),
      origin: ORIGIN,
      rpId: 'localhost',
      pluginsDir: join(dir, 'plugins'),
      webDir: join(dir, 'noweb'),
    }),
    { loadPlugins: false },
  );
  ctx.ai = new AiGateway(ctx.appDb, fakeLlm('local'), fakeLlm('external'));
  app = createHttpApp(ctx);
  // Simulate a registered user with a session (passkey ceremony needs a real authenticator).
  ctx.appDb.prepare(`INSERT INTO users(id, username, created_at) VALUES ('u1', 'me', 'now')`).run();
  cookie = `gm_session=${ctx.auth.createSession('u1', 'passkey')}`;
  sent.length = 0;
});

afterEach(async () => {
  ctx.close();
  await rm(dir, { recursive: true, force: true });
});

describe('HTTP API', () => {
  it('requires a session', async () => {
    const saved = cookie;
    cookie = '';
    expect((await req('/api/notes')).status).toBe(401);
    expect((await req('/api/auth/state')).status).toBe(200);
    cookie = saved;
  });

  it('rejects cross-origin cookie writes', async () => {
    const r = await req('/api/note', {
      method: 'PUT',
      json: { path: 'x.md', content: 'x' },
      headers: { origin: 'https://evil.example' },
    });
    expect(r.status).toBe(403);
  });

  it('saves, reads, searches and lists notes', async () => {
    const put = await req('/api/note', {
      method: 'PUT',
      json: { path: 'Projects/Plan.md', content: '# Plan\n\nlaunch the rocket [[Welcome]]\n' },
    });
    expect(put.status).toBe(200);
    const note = (await (await req('/api/note?path=Projects/Plan.md')).json()) as {
      content: string;
      sha: string;
      frontmatter: Record<string, unknown>;
    };
    expect(note.frontmatter['created_by']).toBe('human');
    const search = (await (await req('/api/search?q=rocket')).json()) as { path: string }[];
    expect(search[0]?.path).toBe('Projects/Plan.md');
    const bl = (await (await req('/api/note/backlinks?path=Welcome.md')).json()) as {
      backlinks: { path: string }[];
    };
    expect(bl.backlinks.map((b) => b.path)).toContain('Projects/Plan.md');
    expect((await req('/api/note?path=../etc/passwd')).status).toBe(400);
  });

  it('views', async () => {
    await req('/api/note', {
      method: 'PUT',
      json: { path: 't/a.md', content: '---\nstatus: todo\n---\n# A\n' },
    });
    await req('/api/note', {
      method: 'PUT',
      json: { path: 't/b.md', content: '---\nstatus: done\n---\n# B\n' },
    });
    expect(
      (
        await req('/api/views/tasks', {
          method: 'PUT',
          json: { source: 'name: Tasks\ntype: kanban\nfolder: t\ngroups: [todo, done]\n' },
        })
      ).status,
    ).toBe(200);
    const rows = (await (await req('/api/views/tasks/rows')).json()) as {
      groups: { key: string; rows: unknown[] }[];
    };
    expect(rows.groups.map((g) => [g.key, g.rows.length])).toEqual([
      ['todo', 1],
      ['done', 1],
    ]);
  });

  it('OAuth + PKCE + MCP end to end', async () => {
    const meta = (await (await req('/.well-known/oauth-authorization-server')).json()) as {
      token_endpoint: string;
    };
    expect(meta.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    const unauth = await req('/mcp', { method: 'POST', json: {}, headers: { cookie: '' } });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toContain('resource_metadata');

    const reg = (await (
      await req('/oauth/register', {
        method: 'POST',
        json: { client_name: 'Claude', redirect_uris: ['http://localhost:9999/cb'] },
      })
    ).json()) as { client_id: string };
    const verifier = 'v'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const query = {
      response_type: 'code',
      client_id: reg.client_id,
      redirect_uri: 'http://localhost:9999/cb',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      scope: 'notes:read notes:propose',
    };
    const authz = await req(`/oauth/authorize?${new URLSearchParams(query)}`);
    expect(authz.status).toBe(302);
    expect(authz.headers.get('location')).toContain('/oauth/consent?');
    const consent = (await (
      await req('/api/admin/oauth/consent', {
        method: 'POST',
        json: { query, approve: true, newAgent: { name: 'Claude', folders: ['work'] } },
      })
    ).json()) as { redirect: string };
    const code = new URL(consent.redirect).searchParams.get('code')!;
    expect(new URL(consent.redirect).searchParams.get('state')).toBe('xyz');

    const bad = await req('/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: reg.client_id,
        code_verifier: 'wrong',
        redirect_uri: query.redirect_uri,
      }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(bad.status).toBe(400);
    // Codes are single use, so get a fresh one.
    const consent2 = (await (
      await req('/api/admin/oauth/consent', { method: 'POST', json: { query, approve: true } })
    ).json()) as { redirect: string };
    const code2 = new URL(consent2.redirect).searchParams.get('code')!;
    const tok = (await (
      await req('/oauth/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code2,
          client_id: reg.client_id,
          code_verifier: verifier,
          redirect_uri: query.redirect_uri,
        }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })
    ).json()) as { access_token: string; refresh_token: string };
    expect(tok.access_token).toMatch(/^gma_/);

    // Default policy is local-only: external agents see nothing until the user allows it.
    await req('/api/admin/policy', { method: 'PUT', json: { ai: { default: 'external' } } });
    await req('/api/note', {
      method: 'PUT',
      json: { path: 'work/Todo.md', content: '# Todo\n\n- write docs\n' },
    });
    await req('/api/note', {
      method: 'PUT',
      json: { path: 'private/Diary.md', content: '# Diary\n' },
    });

    const mcp = async (method: string, params: unknown, id = 1) => {
      const r = await app.request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tok.access_token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      return (await r.json()) as {
        result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean };
        error?: unknown;
      };
    };
    const init = await mcp('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(init.result).toBeDefined();
    const tools = await mcp('tools/list', {});
    const names = tools.result!.tools!.map((t) => t.name);
    expect(names).toContain('propose_changes');
    expect(names).toContain('read_note');

    const list = await mcp('tools/call', { name: 'list_notes', arguments: {} });
    const listed = JSON.parse(list.result!.content![0]!.text) as { path: string }[];
    expect(listed.map((n) => n.path)).toEqual(['work/Todo.md']);
    const hidden = await mcp('tools/call', {
      name: 'read_note',
      arguments: { path: 'private/Diary.md' },
    });
    expect(hidden.result!.isError).toBe(true);

    const read = await mcp('tools/call', {
      name: 'read_note',
      arguments: { path: 'work/Todo.md' },
    });
    const doc = JSON.parse(read.result!.content![0]!.text) as { content: string; sha: string };
    const prop = await mcp('tools/call', {
      name: 'propose_changes',
      arguments: {
        title: 'Add item',
        changes: [{ path: 'work/Todo.md', content: doc.content + '- review PR\n' }],
        base_shas: { 'work/Todo.md': doc.sha },
      },
    });
    const res = JSON.parse(prop.result!.content![0]!.text) as {
      status: string;
      proposalId: string;
    };
    expect(res.status).toBe('proposed');

    const proposals = (await (await req('/api/proposals?status=open')).json()) as {
      id: string;
      author_name: string;
    }[];
    expect(proposals[0]).toMatchObject({ id: res.proposalId, author_name: 'Claude' });
    const detail = (await (await req(`/api/proposals/${res.proposalId}`)).json()) as {
      files: { path: string; diff: unknown[] }[];
    };
    expect(detail.files[0]!.path).toBe('work/Todo.md');
    expect(
      (await req(`/api/proposals/${res.proposalId}/merge`, { method: 'POST', json: {} })).status,
    ).toBe(200);
    const merged = (await (await req('/api/note?path=work/Todo.md')).json()) as { content: string };
    expect(merged.content).toContain('review PR');

    const refreshed = await req('/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tok.refresh_token,
        client_id: reg.client_id,
      }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(refreshed.status).toBe(200);
    const reuse = await req('/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tok.refresh_token,
        client_id: reg.client_id,
      }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(reuse.status).toBe(400);
  });

  it('external agents get masked secrets and placeholders round-trip', async () => {
    const agent = (await (
      await req('/api/admin/agents', { method: 'POST', json: { name: 'gpt', writeMode: 'direct' } })
    ).json()) as { id: string };
    const { token } = (await (
      await req(`/api/admin/agents/${agent.id}/tokens`, {
        method: 'POST',
        json: { scope: ['notes:read', 'notes:write'] },
      })
    ).json()) as { token: string };
    await req('/api/admin/policy', {
      method: 'PUT',
      json: {
        ai: { default: 'external', folders: { 'secret/': 'local' } },
        sensitive: { mode: 'mask' },
      },
    });
    await req('/api/note', {
      method: 'PUT',
      json: { path: 'k.md', content: '# Keys\n\nkey AKIAIOSFODNN7EXAMPLE here\n' },
    });
    await req('/api/note', { method: 'PUT', json: { path: 'secret/s.md', content: 'x\n' } });

    const doc = (await (await req('/api/note?path=k.md', { bearer: token })).json()) as {
      content: string;
      sha: string;
    };
    expect(doc.content).not.toContain('AKIA');
    expect(doc.content).toMatch(/\[SECRET_[0-9a-f]{8}\]/);
    expect((await req('/api/note?path=secret/s.md', { bearer: token })).status).toBe(403);

    const w = (await (
      await req('/api/note', {
        method: 'PUT',
        bearer: token,
        json: { path: 'k.md', content: doc.content + '\nnew para\n', baseSha: doc.sha },
      })
    ).json()) as { status: string };
    expect(w.status).toBe('committed');
    const after = (await (await req('/api/note?path=k.md')).json()) as { content: string };
    expect(after.content).toContain('AKIAIOSFODNN7EXAMPLE');
    expect(after.content).toContain('new para');

    await req('/api/admin/policy', {
      method: 'PUT',
      json: { ai: { default: 'external' }, sensitive: { mode: 'block' } },
    });
    expect((await req('/api/note?path=k.md', { bearer: token })).status).toBe(403);
  });

  it('ask: policy gating, masking and audit', async () => {
    await req('/api/note', {
      method: 'PUT',
      json: {
        path: 'pub.md',
        content: '# Rocket\n\nThe rocket password: hunter2xyz launches friday\n',
      },
    });
    await req('/api/note', {
      method: 'PUT',
      json: { path: 'priv/p.md', content: '# Rocket private\n\nrocket internal codename\n' },
    });
    await req('/api/admin/policy', {
      method: 'PUT',
      json: {
        ai: { default: 'external', folders: { priv: 'local' } },
        sensitive: { mode: 'mask' },
        externalAcknowledged: true,
      },
    });
    const r = (await (
      await req('/api/ask', { method: 'POST', json: { question: 'rocket', prefer: 'external' } })
    ).json()) as {
      target: string;
      used: string[];
      excluded: string[];
      answer: string;
      masked: boolean;
    };
    expect(r.target).toBe('external');
    expect(r.used).toContain('pub.md');
    expect(r.excluded).toContain('priv/p.md');
    expect(r.masked).toBe(true);
    expect(sent.join('\n')).not.toContain('hunter2xyz');
    expect(sent.join('\n')).not.toContain('internal codename');
    expect(r.answer).toContain('hunter2xyz'); // placeholder restored locally

    await req('/api/admin/policy', {
      method: 'PUT',
      json: {
        ai: { default: 'external' },
        sensitive: { mode: 'warn' },
        externalAcknowledged: true,
      },
    });
    expect(
      (await req('/api/ask', { method: 'POST', json: { question: 'rocket', prefer: 'external' } }))
        .status,
    ).toBe(428);
    expect(
      (
        await req('/api/ask', {
          method: 'POST',
          json: { question: 'rocket', prefer: 'external', confirm: true },
        })
      ).status,
    ).toBe(200);
    await req('/api/admin/policy', {
      method: 'PUT',
      json: {
        ai: { default: 'external' },
        sensitive: { mode: 'block' },
        externalAcknowledged: true,
      },
    });
    expect(
      (await req('/api/ask', { method: 'POST', json: { question: 'rocket', prefer: 'external' } }))
        .status,
    ).toBe(422);
    const local = await req('/api/ask', {
      method: 'POST',
      json: { question: 'rocket', prefer: 'local' },
    });
    expect(local.status).toBe(200);
    const audit = (await (await req('/api/ai/audit')).json()) as { kind: string }[];
    expect(audit.map((a) => a.kind)).toContain('egress-blocked');
  });

  it('capture tokens record the human as author', async () => {
    const agent = (await (
      await req('/api/admin/agents', { method: 'POST', json: { name: 'iPhone Shortcut' } })
    ).json()) as { id: string };
    const { token } = (await (
      await req(`/api/admin/agents/${agent.id}/tokens`, {
        method: 'POST',
        json: { scope: ['notes:capture'] },
      })
    ).json()) as { token: string };
    const r = (await (
      await req('/api/capture', { method: 'POST', bearer: token, json: { text: 'buy milk' } })
    ).json()) as { path: string };
    const hist = (await (
      await req(`/api/note/history?path=${encodeURIComponent(r.path)}`)
    ).json()) as { authorKind: string }[];
    expect(hist[0]!.authorKind).toBe('human');
    expect((await req('/api/notes', { bearer: token })).status).toBe(403);
  });

  it('stores display preferences for all devices', async () => {
    const state0 = (await (await req('/api/auth/state')).json()) as {
      prefs: { accent: string; mode: string };
    };
    expect(state0.prefs).toEqual({ accent: 'green', mode: 'system' });
    const saved = (await (
      await req('/api/admin/preferences', {
        method: 'PUT',
        json: { accent: 'sakura', mode: 'dark', evil: 1 },
      })
    ).json()) as Record<string, unknown>;
    expect(saved).toEqual({ accent: 'sakura', mode: 'dark' });
    const bad = (await (
      await req('/api/admin/preferences', {
        method: 'PUT',
        json: { accent: 'red;x', mode: 'neon' },
      })
    ).json()) as Record<string, unknown>;
    expect(bad).toEqual({ accent: 'green', mode: 'system' });
  });

  it('creates an encrypted backup', async () => {
    const r = await req('/api/admin/backup', {
      method: 'POST',
      json: { passphrase: 'correct horse' },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    expect(() => readBackup(buf, 'wrong')).toThrow();
    const { files } = readBackup(buf, 'correct horse');
    expect([...files.keys()]).toEqual(['notes.bundle', 'app.db']);
  });
});
