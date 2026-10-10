import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppContext, createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createHttpApp } from '../src/server.js';

let dir: string;
let ctx: AppContext;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gmemo-plugin-'));
  await cp(new URL('../../../examples/plugins', import.meta.url).pathname, join(dir, 'plugins'), { recursive: true });
  ctx = await createApp(loadConfig({ dataDir: dir, notesDir: join(dir, 'notes'), appDbFile: join(dir, 'app.db'), indexDbFile: join(dir, 'index.db'), pluginsDir: join(dir, 'plugins'), origin: 'http://localhost:8787', rpId: 'localhost' }));
});

afterAll(async () => {
  ctx.close();
  await rm(dir, { recursive: true, force: true });
});

describe('plugins', () => {
  it('loads the example plugin', async () => {
    const p = ctx.plugins.find((x) => x.name === 'inbox-tools');
    expect(p?.error).toBeUndefined();
    expect(p?.tools.map((t) => t.name)).toEqual(['inbox_overview']);
    expect(ctx.extraRules.map((r) => r.id)).toContain('internal-ticket');
    const policy = await ctx.notes.loadPolicy();
    const findings = await ctx.ai.scan('see SEC-1234', policy);
    expect(findings[0]?.rule).toBe('internal-ticket');
  });

  it('serves plugin routes to the signed-in user', async () => {
    ctx.appDb.prepare(`INSERT INTO users(id, username, created_at) VALUES ('u1', 'me', 'now')`).run();
    const cookie = `gm_session=${ctx.auth.createSession('u1', 'passkey')}`;
    await ctx.notes.capture('hello');
    const app = createHttpApp(ctx);
    const r = await app.request('http://localhost:8787/api/plugins/inbox-tools/count', { headers: { cookie } });
    expect(await r.json()).toEqual({ inbox: 1 });
  });
});
