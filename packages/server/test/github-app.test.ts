import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDb } from '../src/db/sqlite.js';
import { createHttpApp } from '../src/http-app.js';
import { Platform } from '../src/platform.js';
import { HashingEmbedder } from '../src/search/embedder.js';
import { appJwt, forgetInstallationTokens, parsePrivateKey } from '../src/store/github-app.js';
import { fakeGitHub } from './fake-github.js';
import { testConfig } from './helpers.js';

const ORIGIN = 'http://localhost:8787';
// GitHub hands out PKCS#1 keys ("BEGIN RSA PRIVATE KEY"); the server must take those as is.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const APP = { clientId: 'Iv1.test', clientSecret: 'shh', installationId: 42, publicKey };
const APP_ENV = {
  GMEMO_GITHUB_APP_SLUG: 'gmemo-test',
  GMEMO_GITHUB_APP_CLIENT_ID: APP.clientId,
  GMEMO_GITHUB_APP_CLIENT_SECRET: APP.clientSecret,
  // As it often arrives from a one-line env file.
  GMEMO_GITHUB_APP_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
};

let db: SqliteDb;
let gh: ReturnType<typeof fakeGitHub>;
let app: ReturnType<typeof createHttpApp>;
let cookie: string;

async function req(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  if (cookie) headers.set('cookie', cookie);
  return app.request(`${ORIGIN}${path}`, {
    ...init,
    headers,
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  });
}

async function makeApp(env: Record<string, string>) {
  db = new SqliteDb(':memory:');
  gh = fakeGitHub({ app: APP });
  const platform = await Platform.create(testConfig(env), db, {
    auditConsole: () => undefined,
    embedder: new HashingEmbedder(),
    fetch: gh.fetch,
  });
  app = createHttpApp(platform);
  await db.run(
    `INSERT INTO users(id, username, is_admin, created_at) VALUES ('u_me', 'me', 1, ?)`,
    new Date().toISOString(),
  );
  cookie = `gm_session=${await platform.auth.createSession('u_me', 'passkey')}`;
}

/** Click "sign in with GitHub" and come back from GitHub with `code`. */
async function signInWithGitHub(code = 'good-code') {
  const { url } = (await (
    await req('/api/admin/storage/github/login', { method: 'POST' })
  ).json()) as { url: string };
  const state = new URL(url).searchParams.get('state')!;
  const back = await req(
    `/api/admin/storage/github/callback?code=${code}&state=${encodeURIComponent(state)}`,
  );
  return { url, back };
}

beforeEach(async () => {
  forgetInstallationTokens();
  await makeApp(APP_ENV);
});
afterEach(() => db.close());

describe('GitHub storage through the GitHub App', () => {
  it('reads PKCS#1 keys and signs a JWT GitHub accepts', async () => {
    expect(parsePrivateKey(privateKey).pkcs1).toBe(true);
    const jwt = await appJwt({ ...APP, slug: 's', privateKey });
    expect(jwt.split('.')).toHaveLength(3);
  });

  it('signs in with GitHub, lists the repositories, and connects without a token', async () => {
    const settings = (await (await req('/api/admin/storage')).json()) as {
      githubApp: { installUrl: string } | null;
    };
    expect(settings.githubApp?.installUrl).toBe(
      'https://github.com/apps/gmemo-test/installations/new',
    );
    expect(
      ((await (await req('/api/admin/storage/github/repos')).json()) as { repos: unknown }).repos,
    ).toBeNull();

    const { url, back } = await signInWithGitHub();
    expect(url).toContain('https://github.com/login/oauth/authorize?client_id=Iv1.test');
    expect(url).toContain(encodeURIComponent(`${ORIGIN}/api/admin/storage/github/callback`));
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/settings/storage?github=linked');

    const { repos } = (await (await req('/api/admin/storage/github/repos')).json()) as {
      repos: { installationId: number; owner: string; repo: string }[];
    };
    expect(repos).toEqual([
      { installationId: 42, owner: 'me', repo: 'notes', private: true, defaultBranch: 'main' },
    ]);

    await req('/api/note', { method: 'PUT', json: { path: 'keep.md', content: 'keep me\n' } });
    const res = await req('/api/admin/storage', {
      method: 'PUT',
      json: { storage: 'github', github: { owner: 'me', repo: 'notes', installationId: 42 } },
    });
    expect(res.status).toBe(200);
    const ok = (await res.json()) as {
      settings: { storage: string; github: { via: string; hasToken: boolean } };
    };
    expect(ok.settings.storage).toBe('github');
    expect(ok.settings.github).toMatchObject({ via: 'app', hasToken: true });

    // Writes go to GitHub with a short-lived installation token for that one repository.
    await req('/api/note', { method: 'PUT', json: { path: 'gh.md', content: 'on github\n' } });
    expect(gh.calls.some((c) => c.startsWith('POST /repos/me/notes/git/commits'))).toBe(true);
    expect([...gh.installationTokens.values()]).toEqual([['notes']]);
    const doc = (await (await req('/api/note?path=keep.md')).json()) as { content: string };
    expect(doc.content).toContain('keep me');
  });

  it('refuses a repository GitHub did not list for this user', async () => {
    await signInWithGitHub();
    const res = await req('/api/admin/storage', {
      method: 'PUT',
      json: { storage: 'github', github: { owner: 'someone', repo: 'secret', installationId: 42 } },
    });
    // Storage refusals are 409, never 401/403, so the app does not mistake them for a lost session.
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/アクセスを確認できません/);
  });

  it('refuses a callback whose state was not issued for this session', async () => {
    const back = await req('/api/admin/storage/github/callback?code=good-code&state=forged');
    expect(back.headers.get('location')).toMatch(/^\/settings\/storage\?github=error/);
    expect(
      ((await (await req('/api/admin/storage/github/repos')).json()) as { repos: unknown }).repos,
    ).toBeNull();
    // A state is single use.
    const first = await signInWithGitHub();
    expect(first.back.headers.get('location')).toBe('/settings/storage?github=linked');
    const state = new URL(first.url).searchParams.get('state')!;
    gh.codes.add('again');
    const replay = await req(`/api/admin/storage/github/callback?code=again&state=${state}`);
    expect(replay.headers.get('location')).toMatch(/github=error/);
  });

  it('explains when the App was removed from the repository', async () => {
    await signInWithGitHub();
    await req('/api/admin/storage', {
      method: 'PUT',
      json: { storage: 'github', github: { owner: 'me', repo: 'notes', installationId: 42 } },
    });
    gh.installedRepos.length = 0;
    forgetInstallationTokens();
    const res = await req('/api/note', { method: 'PUT', json: { path: 'x.md', content: 'x\n' } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/GitHub App/);
  });

  it('keeps working with a personal access token, and offers no App when none is set', async () => {
    db.close();
    await makeApp({});
    const s = (await (await req('/api/admin/storage')).json()) as { githubApp: unknown };
    expect(s.githubApp).toBeNull();
    expect((await req('/api/admin/storage/github/login', { method: 'POST' })).status).toBe(400);
    const res = await req('/api/admin/storage', {
      method: 'PUT',
      json: { storage: 'github', github: { owner: 'me', repo: 'notes', token: gh.token } },
    });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { settings: { github: { via: string } } }).settings.github.via,
    ).toBe('token');
  });
});
