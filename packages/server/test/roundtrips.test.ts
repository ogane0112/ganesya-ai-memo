import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDb } from '../src/db/sqlite.js';
import { createHttpApp } from '../src/http-app.js';
import { Platform } from '../src/platform.js';
import { HashingEmbedder } from '../src/search/embedder.js';
import { testConfig } from './helpers.js';

/**
 * On D1 every statement (or batch) is a network round trip, so the number of
 * them per request is what a save costs. These limits keep it from creeping up.
 */
describe('database round trips per save', () => {
  let db: SqliteDb;
  let app: ReturnType<typeof createHttpApp>;
  let cookie: string;
  let calls: string[] = [];

  beforeEach(async () => {
    db = new SqliteDb(':memory:');
    const counted = new Proxy(db, {
      get(target, key) {
        const value = (target as unknown as Record<string | symbol, unknown>)[key];
        if (typeof value !== 'function') return value;
        const fn = value as (...a: unknown[]) => unknown;
        if (!['first', 'all', 'run', 'batch'].includes(String(key))) return fn.bind(target);
        return (...args: unknown[]) => {
          calls.push(key === 'batch' ? 'batch' : String(args[0]).replace(/\s+/g, ' '));
          return fn.apply(target, args);
        };
      },
    });
    const platform = await Platform.create(testConfig({}), counted, {
      auditConsole: () => undefined,
      embedder: new HashingEmbedder(),
    });
    app = createHttpApp(platform);
    await db.run(
      'INSERT INTO users(id, username, is_admin, created_at) VALUES (?, ?, ?, ?)',
      'u_me',
      'me',
      1,
      new Date().toISOString(),
    );
    cookie = `gm_session=${await platform.auth.createSession('u_me', 'passkey')}`;
    await put('Folder/Other.md', '# Other\n');
  });
  afterEach(() => db.close());

  async function put(path: string, content: string, baseSha?: string | null) {
    calls = [];
    const res = await app.request('http://localhost:8787/api/note', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path, content, ...(baseSha !== undefined ? { baseSha } : {}) }),
    });
    expect(res.status).toBe(200);
    return { body: (await res.json()) as { sha: string; status: string }, calls: [...calls] };
  }

  it('edits an existing note in 6 round trips (5 waits), without reading every note or link', async () => {
    const created = await put('Plan.md', '# Plan\n\nfirst\n', null);
    const edit = await put('Plan.md', '# Plan\n\nfirst\n\nsecond\n', created.body.sha);
    expect(edit.body.status).toBe('committed');
    expect(edit.calls).toHaveLength(6);
    expect(edit.calls.filter((c) => c === 'batch')).toHaveLength(2);
    expect(edit.calls.some((c) => /FROM (notes|links) WHERE user_id/.test(c))).toBe(false);
  });

  it('still resolves links when the edited note has some', async () => {
    const created = await put('Plan.md', '# Plan\n', null);
    const edit = await put('Plan.md', '# Plan\n\nsee [[Other]]\n', created.body.sha);
    expect(edit.calls).toHaveLength(7);
    const row = await db.first<{ target_path: string }>(
      `SELECT target_path FROM links WHERE src = 'Plan.md'`,
    );
    expect(row?.target_path).toBe('Folder/Other.md');
  });

  it('a new note makes links that were waiting for it resolve', async () => {
    await put('Plan.md', '# Plan\n\nsee [[Later]]\n', null);
    const created = await put('Later.md', '# Later\n', null);
    expect(created.calls.length).toBeLessThanOrEqual(8);
    const row = await db.first<{ target_path: string }>(
      `SELECT target_path FROM links WHERE src = 'Plan.md'`,
    );
    expect(row?.target_path).toBe('Later.md');
  });

  it('a save from a stale base is still merged, not lost', async () => {
    const created = await put('Plan.md', '# Plan\n\none\n\ntwo\n', null);
    await put('Plan.md', '# Plan\n\none changed\n\ntwo\n', created.body.sha);
    const stale = await put('Plan.md', '# Plan\n\none\n\ntwo changed\n', created.body.sha);
    expect(stale.body.status).toBe('committed');
    const res = await app.request('http://localhost:8787/api/note?path=Plan.md', {
      headers: { cookie },
    });
    const { content } = (await res.json()) as { content: string };
    expect(content).toContain('one changed');
    expect(content).toContain('two changed');
  });
});
