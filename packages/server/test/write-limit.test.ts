import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDb } from '../src/db/sqlite.js';
import { createHttpApp } from '../src/http-app.js';
import { Platform } from '../src/platform.js';
import { HashingEmbedder } from '../src/search/embedder.js';
import { MemoryRateLimiter } from '../src/util/rate-limit.js';
import { testConfig } from './helpers.js';

const ORIGIN = 'http://localhost:8787';
let db: SqliteDb;
let platform: Platform;
let app: ReturnType<typeof createHttpApp>;

async function signIn(username: string): Promise<string> {
  await db.run(
    'INSERT INTO users(id, username, is_admin, created_at) VALUES (?, ?, 0, ?)',
    `u_${username}`,
    username,
    new Date().toISOString(),
  );
  return `gm_session=${await platform.auth.createSession(`u_${username}`, 'passkey')}`;
}

const put = (path: string, cookie: string, content = 'x') =>
  app.request(`${ORIGIN}/api/note`, {
    method: 'PUT',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });

beforeEach(async () => {
  db = new SqliteDb(':memory:');
  platform = await Platform.create(testConfig(), db, {
    auditConsole: () => undefined,
    embedder: new HashingEmbedder(),
    writeLimiter: new MemoryRateLimiter(5, 60_000), // tiny limit for the test
  });
  app = createHttpApp(platform);
});
afterEach(() => db.close());

describe('per-account write limit', () => {
  it('stops a signed-in account after the limit and answers 429 with Retry-After', async () => {
    const me = await signIn('me');
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await put(`n${i}.md`, me)).status);
    expect(codes.filter((s) => s === 200)).toHaveLength(5);
    const blocked = codes.filter((s) => s === 429);
    expect(blocked.length).toBe(3);
    const last = await put('again.md', me);
    expect(last.status).toBe(429);
    expect(last.headers.get('retry-after')).toBe('60');
  });

  it('limits each account on its own budget', async () => {
    const me = await signIn('me');
    const other = await signIn('other');
    for (let i = 0; i < 6; i++) await put(`n${i}.md`, me); // exhaust me
    expect((await put('mine.md', me)).status).toBe(429);
    // A different account is unaffected.
    expect((await put('theirs.md', other)).status).toBe(200);
  });

  it('does not limit reads', async () => {
    const me = await signIn('me');
    for (let i = 0; i < 6; i++) await put(`n${i}.md`, me); // exhaust writes
    for (let i = 0; i < 10; i++)
      expect((await app.request(`${ORIGIN}/api/notes`, { headers: { cookie: me } })).status).toBe(
        200,
      );
  });

  it('does not limit sign-in attempts through this limiter (they have their own)', async () => {
    // A write-limited account can still reach auth endpoints (limited separately by address).
    const me = await signIn('me');
    for (let i = 0; i < 6; i++) await put(`n${i}.md`, me);
    const state = await app.request(`${ORIGIN}/api/auth/state`, { headers: { cookie: me } });
    expect(state.status).toBe(200);
  });
});
