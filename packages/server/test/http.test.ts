import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmClient } from '../src/ai/llm.js';
import { SqliteDb } from '../src/db/sqlite.js';
import { createHttpApp } from '../src/http-app.js';
import { Platform } from '../src/platform.js';
import { HashingEmbedder } from '../src/search/embedder.js';
import { gunzip, untar } from '../src/util/tar.js';
import { fakeGitHub } from './fake-github.js';
import { testConfig } from './helpers.js';

let db: SqliteDb;
let platform: Platform;
let gh: ReturnType<typeof fakeGitHub>;
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

/** Simulate a registered user with a session (the passkey ceremony needs a real authenticator). */
async function signIn(username: string, isAdmin = false): Promise<string> {
  const id = `u_${username}`;
  await db.run(
    'INSERT INTO users(id, username, is_admin, created_at) VALUES (?, ?, ?, ?)',
    id,
    username,
    isAdmin ? 1 : 0,
    new Date().toISOString(),
  );
  return `gm_session=${await platform.auth.createSession(id, 'passkey')}`;
}

async function makeApp(env: Record<string, string> = {}) {
  db = new SqliteDb(':memory:');
  gh = fakeGitHub();
  platform = await Platform.create(testConfig(env), db, {
    embedder: new HashingEmbedder(),
    fetch: gh.fetch,
  });
  platform.deps.llm = { local: fakeLlm('local'), external: fakeLlm('external') };
  app = createHttpApp(platform);
}

beforeEach(async () => {
  await makeApp();
  cookie = await signIn('me', true);
  sent.length = 0;
});

afterEach(() => {
  db.close();
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

  it('exports the current notes as tar.gz', async () => {
    await req('/api/note', { method: 'PUT', json: { path: 'a/b.md', content: 'hello\n' } });
    const r = await req('/api/admin/export');
    expect(r.headers.get('content-type')).toBe('application/gzip');
    const files = untar(await gunzip(new Uint8Array(await r.arrayBuffer())), 1);
    expect(files.map((f) => f.path).sort()).toEqual(['Welcome.md', 'a/b.md']);
  });

  it('keeps accounts apart, including agent tokens', async () => {
    await req('/api/note', { method: 'PUT', json: { path: 'mine.md', content: 'my diary\n' } });
    const mine = cookie;
    cookie = await signIn('other');
    expect(
      ((await (await req('/api/notes')).json()) as { path: string }[]).map((n) => n.path),
    ).toEqual(['Welcome.md']);
    expect((await req('/api/note?path=mine.md')).status).toBe(404);
    expect(((await (await req('/api/search?q=diary')).json()) as unknown[]).length).toBe(0);
    // An agent of the other user only sees the other user's notes.
    const agent = (await (
      await req('/api/admin/agents', { method: 'POST', json: { name: 'bot' } })
    ).json()) as { id: string };
    const { token } = (await (
      await req(`/api/admin/agents/${agent.id}/tokens`, { method: 'POST', json: {} })
    ).json()) as { token: string };
    expect((await req('/api/note?path=mine.md', { bearer: token })).status).toBe(404);
    // ...and cannot touch the first user's agents or tokens.
    cookie = mine;
    expect(
      (await req(`/api/admin/agents/${agent.id}`, { method: 'PATCH', json: { name: 'x' } })).status,
    ).toBe(404);
    expect((await req('/api/admin/users')).status).toBe(200);
    cookie = await signIn('third');
    expect((await req('/api/admin/users')).status).toBe(403);
  });

  it('polls for changes instead of streaming events', async () => {
    const p0 = (await (await req('/api/poll')).json()) as { head: string; openProposals: number };
    await req('/api/note', { method: 'PUT', json: { path: 'x.md', content: 'x\n' } });
    const p1 = (await (await req('/api/poll')).json()) as { head: string; openProposals: number };
    expect(p1.head).not.toBe(p0.head);
    expect(p1.openProposals).toBe(0);
  });

  it('switches storage to GitHub, copying the notes, and back', async () => {
    await req('/api/note', { method: 'PUT', json: { path: 'keep.md', content: 'keep me\n' } });
    const bad = await req('/api/admin/storage', {
      method: 'PUT',
      json: { storage: 'github', github: { owner: gh.owner, repo: gh.repo, token: 'wrong' } },
    });
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { error: string }).error).toMatch(/トークン/);
    const ok = (await (
      await req('/api/admin/storage', {
        method: 'PUT',
        json: { storage: 'github', github: { owner: gh.owner, repo: gh.repo, token: gh.token } },
      })
    ).json()) as { copied: number; settings: { storage: string; github: { hasToken: boolean } } };
    expect(ok.settings.storage).toBe('github');
    expect(ok.settings.github.hasToken).toBe(true);
    expect(ok.copied).toBe(2);
    const doc = (await (await req('/api/note?path=keep.md')).json()) as { content: string };
    expect(doc.content).toContain('keep me');
    // The token never comes back out.
    expect(JSON.stringify(await (await req('/api/admin/storage')).json())).not.toContain(gh.token);

    await req('/api/note', { method: 'PUT', json: { path: 'gh.md', content: 'on github\n' } });
    expect(gh.calls.some((c) => c.startsWith('POST /repos/me/notes/git/commits'))).toBe(true);
    const back = (await (
      await req('/api/admin/storage', { method: 'PUT', json: { storage: 'builtin' } })
    ).json()) as { settings: { storage: string } };
    expect(back.settings.storage).toBe('builtin');
    expect(
      ((await (await req('/api/notes')).json()) as { path: string }[]).map((n) => n.path),
    ).toContain('gh.md');
  });
});

describe('sign-up', () => {
  const regOptions = (json: Record<string, string>) =>
    req('/api/auth/register/options', { method: 'POST', json });

  it('needs the setup token for the first account', async () => {
    db.close();
    await makeApp({ GMEMO_SETUP_TOKEN: 'let-me-in', GMEMO_SIGNUP: 'invite' });
    cookie = '';
    const st = (await (await req('/api/auth/state')).json()) as { needsSetup: boolean };
    expect(st.needsSetup).toBe(true);
    expect((await regOptions({ username: 'alice', setupToken: 'nope' })).status).toBe(403);
    expect((await regOptions({ username: 'a', setupToken: 'let-me-in' })).status).toBe(400);
    expect((await regOptions({ username: 'alice', setupToken: 'let-me-in' })).status).toBe(200);
  });

  it('invite mode needs an unused invite; closed mode refuses', async () => {
    const admin = cookie;
    const { code } = (await (
      await req('/api/admin/invites', { method: 'POST', json: {} })
    ).json()) as {
      code: string;
    };
    cookie = '';
    expect((await regOptions({ username: 'bob' })).status).toBe(403);
    expect((await regOptions({ username: 'bob', inviteCode: 'bad' })).status).toBe(403);
    expect((await regOptions({ username: 'me', inviteCode: code })).status).toBe(409);
    expect((await regOptions({ username: 'bob', inviteCode: code })).status).toBe(200);
    cookie = admin;
    expect(((await (await req('/api/admin/invites')).json()) as unknown[]).length).toBe(1);

    db.close();
    await makeApp({ GMEMO_SIGNUP: 'closed' });
    await signIn('admin', true);
    cookie = '';
    expect((await regOptions({ username: 'carol' })).status).toBe(403);
  });

  it('recovery codes are per user', async () => {
    const codes = await platform.auth.replaceRecoveryCodes('u_me');
    await signIn('other');
    cookie = '';
    const wrongUser = await req('/api/auth/recovery', {
      method: 'POST',
      json: { username: 'other', code: codes[0] },
    });
    expect(wrongUser.status).toBe(401);
    const ok = await req('/api/auth/recovery', {
      method: 'POST',
      json: { username: 'me', code: codes[0] },
    });
    expect(ok.status).toBe(200);
    const again = await req('/api/auth/recovery', {
      method: 'POST',
      json: { username: 'me', code: codes[0] },
    });
    expect(again.status).toBe(401);
  });
});
