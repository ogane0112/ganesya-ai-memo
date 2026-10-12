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

async function addUser(username: string): Promise<string> {
  await db.run(
    'INSERT INTO users(id, username, is_admin, created_at) VALUES (?, ?, 0, ?)',
    `u_${username}`,
    username,
    new Date().toISOString(),
  );
  return `u_${username}`;
}

async function session(userId: string): Promise<string> {
  return `gm_session=${await platform.auth.createSession(userId, 'passkey')}`;
}

async function agentToken(userId: string, name: string): Promise<string> {
  const ws = await platform.workspace(userId);
  const agent = await ws.agents.create({ name, writeMode: 'direct' });
  return platform.tokens.createPat(userId, agent.id, ['notes:read', 'notes:write'], name);
}

const put = (path: string, cookie: string) =>
  app.request(`${ORIGIN}/api/note`, {
    method: 'PUT',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: 'x' }),
  });

const mcp = (token: string) =>
  app.request(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

async function times(n: number, f: () => Response | Promise<Response>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await f()).status);
  return out;
}

beforeEach(async () => {
  db = new SqliteDb(':memory:');
  platform = await Platform.create(testConfig(), db, {
    auditConsole: () => undefined,
    embedder: new HashingEmbedder(),
    // Tiny limits for the test: 5 per caller, 8 per account.
    writeLimiter: new MemoryRateLimiter(5, 60_000),
    accountWriteLimiter: new MemoryRateLimiter(8, 60_000),
  });
  app = createHttpApp(platform);
});
afterEach(() => db.close());

describe('write limits', () => {
  it('stops a session after its budget with 429 and Retry-After', async () => {
    const me = await session(await addUser('me'));
    let i = 0;
    const codes = await times(7, () => put(`n${i++}.md`, me));
    expect(codes.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
    expect((await put('again.md', me)).headers.get('retry-after')).toBe('60');
  });

  it('limits agent writes through /mcp per token', async () => {
    const userId = await addUser('me');
    const token = await agentToken(userId, 'claude');
    const codes = await times(7, () => mcp(token));
    expect(codes.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it('an agent using up its budget does not block the person or another agent', async () => {
    const userId = await addUser('me');
    const busy = await agentToken(userId, 'busy');
    const quiet = await agentToken(userId, 'quiet');
    await times(6, () => mcp(busy)); // busy is now over its own budget
    expect((await mcp(busy)).status).toBe(429);
    expect((await put('mine.md', await session(userId))).status).toBe(200);
    expect((await mcp(quiet)).status).not.toBe(429);
  });

  it('caps the account as a whole, so signing in again buys nothing', async () => {
    const userId = await addUser('me');
    let i = 0;
    const first = await session(userId);
    await times(5, () => put(`a${i++}.md`, first)); // 5 of the account's 8
    const second = await session(userId);
    const codes = await times(5, () => put(`b${i++}.md`, second));
    // The fresh session has its own budget of 5, but only 3 remain for the account.
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });

  it('keeps each account separate and leaves reads and sign-in alone', async () => {
    const me = await session(await addUser('me'));
    let i = 0;
    await times(6, () => put(`n${i++}.md`, me));
    expect((await put('x.md', me)).status).toBe(429);
    expect((await put('theirs.md', await session(await addUser('other')))).status).toBe(200);
    expect((await app.request(`${ORIGIN}/api/notes`, { headers: { cookie: me } })).status).toBe(
      200,
    );
    expect(
      (await app.request(`${ORIGIN}/api/auth/state`, { headers: { cookie: me } })).status,
    ).toBe(200);
  });
});
