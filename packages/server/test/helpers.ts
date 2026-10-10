import { configFromEnv } from '../src/config.js';
import { SqliteDb } from '../src/db/sqlite.js';
import { Platform } from '../src/platform.js';
import { HashingEmbedder } from '../src/search/embedder.js';
import { encryptSecret } from '../src/util/crypto.js';
import { fakeGitHub } from './fake-github.js';

export type StoreKind = 'builtin' | 'github';
export const STORE_KINDS: StoreKind[] = ['builtin', 'github'];

export const testConfig = (extra: Record<string, string> = {}) =>
  configFromEnv({
    GMEMO_ORIGIN: 'http://localhost:8787',
    GMEMO_SECRET_KEY: 'test-secret',
    GMEMO_TIMEZONE: 'Asia/Tokyo',
    GMEMO_GITHUB_API: 'https://api.github.test',
    GMEMO_GITHUB_CHECK_SECONDS: '0',
    ...extra,
  });

/** A platform on an in-memory database with one user, using the given store. */
export async function setup(
  kind: StoreKind = 'builtin',
  opts: { env?: Record<string, string> } = {},
) {
  const db = new SqliteDb(':memory:');
  const gh = fakeGitHub();
  const cfg = testConfig(opts.env);
  const platform = await Platform.create(cfg, db, {
    embedder: new HashingEmbedder(),
    fetch: gh.fetch,
  });
  const userId = await addUser(platform, 'me', kind, gh);
  const ws = await platform.workspace(userId);
  await ws.notes.init();
  return {
    db,
    gh,
    platform,
    userId,
    ws,
    service: ws.notes,
    indexer: ws.indexer,
    agents: ws.agents,
    cleanup: async () => db.close(),
  };
}

export async function addUser(
  platform: Platform,
  username: string,
  kind: StoreKind,
  gh: ReturnType<typeof fakeGitHub>,
): Promise<string> {
  const id = `u_${username}`;
  const now = new Date().toISOString();
  await platform.db.run(
    'INSERT INTO users(id, username, is_admin, created_at) VALUES (?, ?, 0, ?)',
    id,
    username,
    now,
  );
  if (kind === 'github') {
    await platform.db.run(
      `INSERT INTO workspaces(user_id, storage, github_owner, github_repo, github_branch, github_token_enc, updated_at)
       VALUES (?, 'github', ?, ?, 'main', ?, ?)`,
      id,
      gh.owner,
      gh.repo,
      await encryptSecret(gh.token, platform.cfg.secretKey!),
      now,
    );
  } else {
    await platform.db.run(
      `INSERT INTO workspaces(user_id, storage, updated_at) VALUES (?, 'builtin', ?)`,
      id,
      now,
    );
  }
  return id;
}
