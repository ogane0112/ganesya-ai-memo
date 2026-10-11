import { afterEach, describe, expect, it } from 'vitest';
import { clearAccessCertCache, verifyAccessToken } from '../src/auth/access.js';
import { sessionCookieName } from '../src/api/http.js';
import { SqliteDb } from '../src/db/sqlite.js';
import { createHttpApp } from '../src/http-app.js';
import { Platform } from '../src/platform.js';
import { HashingEmbedder } from '../src/search/embedder.js';
import { testConfig } from './helpers.js';

const ORIGIN = 'http://localhost:8787';
let db: SqliteDb | null = null;

afterEach(() => {
  db?.close();
  db = null;
  clearAccessCertCache();
});

async function make(env: Record<string, string> = {}, fetchImpl?: typeof fetch) {
  db = new SqliteDb(':memory:');
  const platform = await Platform.create(testConfig(env), db, {
    auditConsole: () => undefined,
    embedder: new HashingEmbedder(),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const app = createHttpApp(platform);
  const signIn = async (username: string, isAdmin = false) => {
    const id = `u_${username}`;
    await db!.run(
      'INSERT INTO users(id, username, is_admin, created_at) VALUES (?, ?, ?, ?)',
      id,
      username,
      isAdmin ? 1 : 0,
      new Date().toISOString(),
    );
    return `gm_session=${await platform.auth.createSession(id, 'passkey')}`;
  };
  const req = (
    path: string,
    init: RequestInit & { json?: unknown; cookie?: string; bearer?: string; ip?: string } = {},
  ) => {
    const headers = new Headers(init.headers);
    if (init.json !== undefined) headers.set('content-type', 'application/json');
    if (init.cookie) headers.set('cookie', init.cookie);
    if (init.bearer) headers.set('authorization', `Bearer ${init.bearer}`);
    headers.set('cf-connecting-ip', init.ip ?? '203.0.113.7');
    headers.set('user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/130.0');
    return app.request(`${ORIGIN}${path}`, {
      ...init,
      headers,
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    });
  };
  return { platform, app, signIn, req };
}

describe('security audit log', () => {
  it('records sign-in failures, agent activity and settings changes', async () => {
    const { platform, signIn, req } = await make();
    const me = await signIn('hanako', true);

    // A wrong recovery code is recorded with the attempted user name.
    expect(
      (
        await req('/api/auth/recovery', {
          method: 'POST',
          json: { username: 'hanako', code: 'XXXX' },
        })
      ).status,
    ).toBe(401);

    const agent = (await (
      await req('/api/admin/agents', { method: 'POST', cookie: me, json: { name: 'Claude' } })
    ).json()) as { id: string };
    const { token } = (await (
      await req(`/api/admin/agents/${agent.id}/tokens`, { method: 'POST', cookie: me, json: {} })
    ).json()) as { token: string };
    await req('/api/admin/policy', {
      method: 'PUT',
      cookie: me,
      json: { ai: { default: 'external', folders: { 'private/': 'none' } } },
    });
    await req('/api/note', {
      method: 'PUT',
      cookie: me,
      json: { path: 'work/a.md', content: 'a\n' },
    });
    await req('/api/note', {
      method: 'PUT',
      cookie: me,
      json: { path: 'private/b.md', content: 'b\n' },
    });
    expect((await req('/api/note?path=work/a.md', { bearer: token })).status).toBe(200);
    expect((await req('/api/note?path=private/b.md', { bearer: token })).status).toBe(403);
    expect((await req('/api/notes', { bearer: 'gma_not_a_real_token' })).status).toBe(401);

    const events = await platform.audit.list({ limit: 100 });
    const summary = events.map((e) => `${e.action}:${e.outcome}:${e.target ?? ''}`);
    expect(summary).toContain('auth.recovery_login:failure:');
    expect(summary).toContain(`agent.create:success:${agent.id}`);
    expect(summary).toContain(`token.create:success:${agent.id}`);
    expect(summary).toContain('policy.update:success:');
    expect(summary).toContain('agent.read:success:work/a.md');
    expect(summary).toContain('agent.read:denied:private/b.md');
    expect(summary).toContain('token.rejected:denied:/api/notes');

    const failure = events.find((e) => e.action === 'auth.recovery_login')!;
    expect(failure.detail['username']).toBe('hanako');
    expect(failure.userId).toBeNull();
    // The address is stored as a keyed hash by default, never in the clear.
    expect(failure.ip).toMatch(/^h:[0-9a-f]{16}$/);
    expect(JSON.stringify(events)).not.toContain('203.0.113.7');
    expect(failure.ua).toBe('Chrome / macOS');
    // Agent events carry the account they touched.
    expect(events.find((e) => e.action === 'agent.read')!.userId).toBe('u_hanako');
    // Note contents never end up in the log.
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it('shows users only their own events; the whole log is for admins', async () => {
    const { signIn, req } = await make();
    const admin = await signIn('admin', true);
    const user = await signIn('taro');
    await req('/api/admin/agents', { method: 'POST', cookie: admin, json: { name: 'A' } });
    await req('/api/admin/agents', { method: 'POST', cookie: user, json: { name: 'B' } });
    const mine = (await (await req('/api/admin/security-log', { cookie: user })).json()) as {
      userId: string;
    }[];
    expect(mine.length).toBe(1);
    expect(mine.every((e) => e.userId === 'u_taro')).toBe(true);
    expect((await req('/api/admin/security-log?scope=all', { cookie: user })).status).toBe(403);
    const all = (await (
      await req('/api/admin/security-log?scope=all', { cookie: admin })
    ).json()) as unknown[];
    expect(all.length).toBe(2);
  });

  it('detects edited and deleted events', async () => {
    const { platform, signIn, req } = await make();
    const admin = await signIn('admin', true);
    for (const n of ['a', 'b', 'c', 'd'])
      await req('/api/admin/agents', { method: 'POST', cookie: admin, json: { name: n } });
    const clean = (await (
      await req('/api/admin/security-log/verify', { method: 'POST', cookie: admin })
    ).json()) as { checked: number; tampered: number[]; missing: unknown[] };
    expect(clean).toMatchObject({ checked: 4, tampered: [], missing: [] });

    await db!.run(`UPDATE security_events SET detail = '{"name":"x"}' WHERE id = 2`);
    await db!.run('DELETE FROM security_events WHERE id = 3');
    const res = await platform.audit.verify();
    expect(res.tampered).toEqual([2]);
    expect(res.missing).toEqual([{ from: 3, to: 3 }]);
  });

  it('rate-limits sign-in attempts per address', async () => {
    const { req, platform } = await make();
    let last = 0;
    for (let i = 0; i < 31; i++)
      last = (
        await req('/api/auth/recovery', {
          method: 'POST',
          json: { username: 'x', code: 'y' },
          ip: '198.51.100.1',
        })
      ).status;
    expect(last).toBe(429);
    // Another address is not affected.
    expect(
      (
        await req('/api/auth/recovery', {
          method: 'POST',
          json: { username: 'x', code: 'y' },
          ip: '198.51.100.2',
        })
      ).status,
    ).toBe(401);
    expect((await platform.audit.list({ action: 'security.rate_limited' })).length).toBeGreaterThan(
      0,
    );
  });

  it('uses a __Host- session cookie over HTTPS', () => {
    expect(sessionCookieName('https://notes.example.com')).toBe('__Host-gm_session');
    expect(sessionCookieName('http://localhost:8787')).toBe('gm_session');
  });
});

// ---- Cloudflare Access ---------------------------------------------------------

const TEAM = 'myteam.cloudflareaccess.com';
const AUD = 'aud-1234';

async function accessKit() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as unknown as {
    publicKey: Parameters<typeof crypto.subtle.exportKey>[1];
    privateKey: Parameters<typeof crypto.subtle.sign>[1];
  };
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<string, unknown>;
  const b64 = (v: string | Uint8Array) =>
    Buffer.from(typeof v === 'string' ? v : v).toString('base64url');
  const sign = async (claims: Record<string, unknown>) => {
    const head = b64(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
    const body = b64(JSON.stringify(claims));
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        new TextEncoder().encode(`${head}.${body}`),
      ),
    );
    return `${head}.${body}.${b64(sig)}`;
  };
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u === `https://${TEAM}/cdn-cgi/access/certs`)
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1' }] }));
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const now = Math.floor(Date.now() / 1000);
  const good = {
    aud: [AUD],
    email: 'me@example.com',
    iss: `https://${TEAM}`,
    exp: now + 600,
    iat: now,
    sub: 'u1',
  };
  return { sign, fetchImpl, good };
}

describe('Cloudflare Access (staging)', () => {
  it('verifies Access tokens', async () => {
    const { sign, fetchImpl, good } = await accessKit();
    const cfg = { teamDomain: TEAM, aud: AUD };
    expect(await verifyAccessToken(await sign(good), cfg, fetchImpl)).toMatchObject({
      email: 'me@example.com',
    });
    expect(
      await verifyAccessToken(await sign({ ...good, aud: ['other'] }), cfg, fetchImpl),
    ).toBeNull();
    expect(await verifyAccessToken(await sign({ ...good, exp: 1 }), cfg, fetchImpl)).toBeNull();
    expect(
      await verifyAccessToken(
        await sign({ ...good, iss: 'https://evil.cloudflareaccess.com' }),
        cfg,
        fetchImpl,
      ),
    ).toBeNull();
    const t = await sign(good);
    expect(await verifyAccessToken(`${t.slice(0, -4)}AAAA`, cfg, fetchImpl)).toBeNull();
    expect(await verifyAccessToken(null, cfg, fetchImpl)).toBeNull();
  });

  it('refuses staging without Access, and requires a valid Access token when configured', async () => {
    const closed = await make({ GMEMO_ENV: 'staging' });
    expect((await closed.req('/api/health')).status).toBe(503);
    db!.close();
    db = null;

    const { sign, fetchImpl, good } = await accessKit();
    const stg = await make(
      { GMEMO_ENV: 'staging', GMEMO_ACCESS_TEAM_DOMAIN: TEAM, GMEMO_ACCESS_AUD: AUD },
      fetchImpl,
    );
    expect((await stg.req('/api/health')).status).toBe(403);
    const ok = await stg.req('/api/health', {
      headers: { 'cf-access-jwt-assertion': await sign(good) },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-robots-tag')).toContain('noindex');
    const state = (await (
      await stg.req('/api/auth/state', {
        headers: { cookie: `CF_Authorization=${await sign(good)}` },
      })
    ).json()) as { env: string };
    expect(state.env).toBe('staging');
  });
});

describe('secret key rotation', () => {
  it('keeps old audit events verifiable and old GitHub tokens readable', async () => {
    const before = await make({ GMEMO_SECRET_KEY: 'old-key' });
    const admin = await before.signIn('admin', true);
    await before.req('/api/admin/agents', { method: 'POST', cookie: admin, json: { name: 'a' } });
    const { encryptSecret, decryptSecret } = await import('../src/util/crypto.js');
    await db!.run(
      `INSERT INTO workspaces(user_id, storage, github_owner, github_repo, github_branch, github_token_enc, updated_at)
       VALUES ('u_admin', 'builtin', 'me', 'notes', 'main', ?, 'now')
       ON CONFLICT(user_id) DO UPDATE SET github_token_enc = excluded.github_token_enc`,
      await encryptSecret('ghp_secret', 'old-key'),
    );
    const { AuditLog } = await import('../src/audit/audit.js');
    const rotated = new AuditLog(
      db!,
      { secretKey: 'new-key', previousSecretKey: 'old-key', auditIp: 'hash', env: 'test' },
      () => undefined,
    );
    await rotated.record({ action: 'x.after', actor: 'system' });
    const res = await rotated.verify();
    expect(res.tampered).toEqual([]);
    expect(res.checked).toBe(2);
    // Without the previous key, the old event no longer verifies.
    const forgot = new AuditLog(
      db!,
      { secretKey: 'new-key', auditIp: 'hash', env: 'test' },
      () => undefined,
    );
    expect((await forgot.verify()).tampered).toEqual([1]);

    const enc = (await db!.first<{ github_token_enc: string }>(
      `SELECT github_token_enc FROM workspaces WHERE user_id = 'u_admin'`,
    ))!.github_token_enc;
    await expect(decryptSecret(enc, 'new-key')).rejects.toThrow();
    expect(await decryptSecret(enc, 'old-key')).toBe('ghp_secret');
  });
});

/** Regressions from the baseline review (security/vulnerabilities.yaml GM-2026-002…007). */
describe('agent access to notes', () => {
  async function setup() {
    const ctx = await make();
    const me = await ctx.signIn('hanako');
    const put = (path: string, content: string) =>
      ctx.req('/api/note', { method: 'PUT', cookie: me, json: { path, content } });
    await ctx.req('/api/admin/policy', {
      method: 'PUT',
      cookie: me,
      json: {
        ai: { default: 'external', folders: { 'Private/': 'none' } },
        sensitive: { mode: 'mask' },
      },
    });
    await put('Private/diary.md', '# Diary\n\nnobody may read this\n');
    await put('Pub/hidden.md', '---\nai: none\n---\n# Hidden\n\nnot for AI\n');
    await put('Pub/keys.md', '# Keys\n\npassword: Hunter2Secret!\n');
    const agent = (await (
      await ctx.req('/api/admin/agents', {
        method: 'POST',
        cookie: me,
        json: { name: 'gpt', location: 'external', writeMode: 'direct' },
      })
    ).json()) as { id: string };
    const { token } = (await (
      await ctx.req(`/api/admin/agents/${agent.id}/tokens`, {
        method: 'POST',
        cookie: me,
        json: { scope: ['notes:read', 'notes:write'] },
      })
    ).json()) as { token: string };
    return { ...ctx, me, token, put };
  }

  it('does not hand raw notes to agents through /api/file', async () => {
    const { req, token } = await setup();
    for (const path of ['Private/diary.md', 'Pub/keys.md', '/Pub/hidden.md'])
      expect(
        (await req(`/api/file?path=${encodeURIComponent(path)}`, { bearer: token })).status,
      ).toBe(403);
  });

  it('checks the normalized path for history and refuses blame to agents', async () => {
    const { req, token, me } = await setup();
    for (const path of ['/Private/diary.md', 'Private//diary.md', 'Pub//hidden.md'])
      expect(
        (await req(`/api/note/history?path=${encodeURIComponent(path)}`, { bearer: token })).status,
      ).toBe(403);
    expect((await req('/api/note/blame?path=Pub/keys.md', { bearer: token })).status).toBe(403);
    expect((await req('/api/note/blame?path=Pub/keys.md', { cookie: me })).status).toBe(200);
  });

  it('keeps secrets masked when an agent moves a placeholder into a new context', async () => {
    const { req, token } = await setup();
    const doc = (await (await req('/api/note?path=Pub/keys.md', { bearer: token })).json()) as {
      content: string;
    };
    expect(doc.content).not.toContain('Hunter2Secret!');
    const ph = /\[SECRET_[0-9a-f]{16}\]/.exec(doc.content)?.[0];
    expect(ph).toBeTruthy();
    // Random, not a hash of the value.
    expect(ph).not.toContain('df00f68a');

    await req('/api/note', {
      method: 'PUT',
      bearer: token,
      json: { path: 'Pub/leak.md', content: `# Leak\n\nx${ph}x\n` },
    });
    const back = (await (await req('/api/note?path=Pub/leak.md', { bearer: token })).json()) as {
      content: string;
    };
    expect(back.content).not.toContain('Hunter2Secret!');
    expect(back.content).toContain(ph);
  });

  it('does not let agents write where they cannot read', async () => {
    const { req, token } = await setup();
    for (const path of ['Private/new.md', 'Private/photo.png', 'Pub/hidden.md'])
      expect(
        (
          await req('/api/changes', {
            method: 'POST',
            bearer: token,
            json: { title: 't', changes: [{ path, content: 'x' }], mode: 'direct' },
          })
        ).status,
        path,
      ).toBe(403);
  });

  it('keeps capture inside the token’s folders and out of OAuth', async () => {
    const { platform, req, me } = await setup();
    const agent = (await (
      await req('/api/admin/agents', {
        method: 'POST',
        cookie: me,
        json: { name: 'phone', folders: ['Inbox/'] },
      })
    ).json()) as { id: string };
    const { token } = (await (
      await req(`/api/admin/agents/${agent.id}/tokens`, {
        method: 'POST',
        cookie: me,
        json: { scope: ['notes:capture'] },
      })
    ).json()) as { token: string };
    const capture = (json: unknown) => req('/api/capture', { method: 'POST', bearer: token, json });
    expect((await capture({ text: 'hello' })).status).toBe(200);
    expect((await capture({ text: 'x', folder: 'Private/journal' })).status).toBe(403);
    // Paths with .. are rejected as invalid before any folder check.
    expect((await capture({ text: 'x', folder: 'Inbox/../Private' })).status).toBe(400);

    const client = await platform.oauth.register({
      redirect_uris: ['https://client.example/cb'],
      client_name: 'c',
    });
    const r = await platform.oauth.validateAuthorize({
      client_id: String(client['client_id']),
      redirect_uri: 'https://client.example/cb',
      response_type: 'code',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
      scope: 'notes:read notes:capture',
    });
    expect(r.scope).toEqual(['notes:read']);
  });
});

describe('server-side fetches', () => {
  it('treats IPv4 addresses inside IPv6 and other special ranges as internal', async () => {
    const { isPrivateHost } = await import('../src/calendar/calendar.js');
    for (const h of [
      '[::ffff:7f00:1]',
      '[::ffff:127.0.0.1]',
      '[::]',
      '[::1]',
      '[64:ff9b::a9fe:a9fe]',
      '[fd00::1]',
      '[fe80::1]',
      '224.0.0.1',
      '0.0.0.0',
      '[not:an:ip::x]',
    ])
      expect(isPrivateHost(h), h).toBe(true);
    for (const h of ['calendar.google.com', '8.8.8.8', '[2606:4700::1111]'])
      expect(isPrivateHost(h), h).toBe(false);
  });

  it('refuses calendar URLs whose name resolves to an internal address', async () => {
    db = new SqliteDb(':memory:');
    let fetched = false;
    const platform = await Platform.create(testConfig(), db, {
      auditConsole: () => undefined,
      embedder: new HashingEmbedder(),
      resolveHost: async (host) => (host === 'evil.example' ? ['127.0.0.1'] : ['93.184.216.34']),
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response('BEGIN:VCALENDAR\nEND:VCALENDAR');
    }) as typeof fetch;
    try {
      await db.run(
        'INSERT INTO users(id, username, is_admin, created_at) VALUES (?, ?, 0, ?)',
        'u1',
        'taro',
        new Date().toISOString(),
      );
      const ws = await platform.workspace('u1');
      const sub = await ws.calendar.addSubscription({
        name: 'x',
        url: 'https://evil.example/cal.ics',
      });
      await ws.calendar.refresh(sub.id);
      const after = (await ws.calendar.subscriptions()).find((s) => s.id === sub.id);
      expect(after?.lastError).toBe('このURLは使えません');
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('serves the same CSP on Cloudflare and Node.js', async () => {
    const { readFile } = await import('node:fs/promises');
    const { HTML_CSP } = await import('../src/http-app.js');
    const headers = await readFile(new URL('../../web/public/_headers', import.meta.url), 'utf8');
    expect(headers).toContain(`Content-Security-Policy: ${HTML_CSP}`);
  });
});
