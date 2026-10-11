/**
 * Runtime-neutral async database access. The same SQL (SQLite dialect) runs on
 * Node (better-sqlite3, see sqlite.ts) and on Cloudflare Workers (D1, see d1.ts).
 *
 * D1 has no interactive transactions, so multi-statement atomic writes go
 * through `batch()`; code must not rely on reading inside a transaction.
 */
export type SqlValue = string | number | null | Uint8Array | ArrayBuffer;

export interface Stmt {
  sql: string;
  params: SqlValue[];
}

export interface Db {
  first<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | null>;
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  run(sql: string, ...params: SqlValue[]): Promise<{ changes: number }>;
  /** Run statements atomically, in order. Returns the rows changed by each one. */
  batch(stmts: Stmt[]): Promise<{ changes: number }[]>;
}

export function stmt(sql: string, ...params: SqlValue[]): Stmt {
  return { sql, params };
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Convert a BLOB column value (Buffer, Uint8Array or ArrayBuffer) to Uint8Array. */
export function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  throw new Error('expected binary column');
}

/**
 * Schema migrations. Each migration is a list of single statements (D1 cannot
 * run several statements in one prepared call). Never edit a published entry;
 * append new ones.
 */
export const MIGRATIONS: readonly (readonly string[])[] = [
  [
    // ---- accounts -------------------------------------------------------------
    `CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT NOT NULL DEFAULT '[]',
      device_type TEXT,
      backed_up INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    )`,
    `CREATE INDEX credentials_user ON credentials(user_id)`,
    `CREATE TABLE recovery_codes (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      used_at TEXT,
      PRIMARY KEY (user_id, hash)
    )`,
    `CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      via TEXT NOT NULL DEFAULT 'passkey'
    )`,
    `CREATE TABLE challenges (
      id TEXT PRIMARY KEY,
      challenge TEXT NOT NULL,
      kind TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      expires_at TEXT NOT NULL
    )`,
    `CREATE TABLE invites (
      code_hash TEXT PRIMARY KEY,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      used_by TEXT,
      used_at TEXT
    )`,
    `CREATE TABLE user_settings (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    )`,
    `CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    // ---- storage choice per user ------------------------------------------------
    `CREATE TABLE workspaces (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      storage TEXT NOT NULL DEFAULT 'builtin' CHECK (storage IN ('builtin','github')),
      github_owner TEXT,
      github_repo TEXT,
      github_branch TEXT,
      github_token_enc TEXT,
      updated_at TEXT NOT NULL
    )`,
    // ---- built-in git object store (notes + history for users without GitHub) ----
    `CREATE TABLE git_objects (
      user_id TEXT NOT NULL,
      sha TEXT NOT NULL,
      type TEXT NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (user_id, sha)
    )`,
    `CREATE TABLE git_commits (
      user_id TEXT NOT NULL,
      sha TEXT NOT NULL,
      tree TEXT NOT NULL,
      parents TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_email TEXT NOT NULL,
      date TEXT NOT NULL,
      message TEXT NOT NULL,
      changed TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (user_id, sha)
    )`,
    `CREATE TABLE git_refs (
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sha TEXT NOT NULL,
      PRIMARY KEY (user_id, name)
    )`,
    // ---- agents, tokens, OAuth ---------------------------------------------------
    `CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      can_read INTEGER NOT NULL DEFAULT 1,
      write_mode TEXT NOT NULL DEFAULT 'propose' CHECK (write_mode IN ('none','propose','direct')),
      folders TEXT NOT NULL DEFAULT '[]',
      auto_merge INTEGER NOT NULL DEFAULT 0,
      auto_merge_folders TEXT NOT NULL DEFAULT '[]',
      location TEXT NOT NULL DEFAULT 'external' CHECK (location IN ('external','local')),
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      UNIQUE (user_id, name)
    )`,
    `CREATE TABLE oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL,
      redirect_uris TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE oauth_client_agents (
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      PRIMARY KEY (client_id, user_id)
    )`,
    `CREATE TABLE oauth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      scope TEXT NOT NULL,
      resource TEXT,
      expires_at TEXT NOT NULL
    )`,
    `CREATE TABLE tokens (
      hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('access','refresh','pat')),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      client_id TEXT,
      scope TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      last_used_at TEXT
    )`,
    `CREATE INDEX tokens_agent ON tokens(agent_id)`,
    // ---- proposals, presence, audit -----------------------------------------------
    `CREATE TABLE proposals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id TEXT,
      author_name TEXT NOT NULL,
      author_kind TEXT NOT NULL CHECK (author_kind IN ('ai','human')),
      source TEXT NOT NULL DEFAULT 'agent',
      branch TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('open','merged','rejected')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      merged_commit TEXT
    )`,
    `CREATE INDEX proposals_user_status ON proposals(user_id, status)`,
    `CREATE TABLE editing (
      user_id TEXT NOT NULL,
      path TEXT NOT NULL,
      until TEXT NOT NULL,
      PRIMARY KEY (user_id, path)
    )`,
    `CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      actor TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '{}'
    )`,
    `CREATE INDEX audit_user ON audit(user_id, id)`,
    `CREATE TABLE secret_placeholders (
      user_id TEXT NOT NULL,
      placeholder TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, placeholder)
    )`,
    // ---- calendar -------------------------------------------------------------------
    `CREATE TABLE calendar_feeds (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      view_id TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      include_links INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_fetched_at TEXT,
      revoked_at TEXT
    )`,
    `CREATE TABLE calendar_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#4f7cff',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      fetched_at TEXT,
      etag TEXT,
      body TEXT,
      last_error TEXT
    )`,
    // ---- derived index (rebuildable from the note store) ------------------------------
    `CREATE TABLE notes (
      user_id TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      frontmatter TEXT NOT NULL,
      body TEXT NOT NULL,
      sha TEXT NOT NULL,
      created_by TEXT,
      ai_agent TEXT,
      updated_at TEXT,
      PRIMARY KEY (user_id, path)
    )`,
    `CREATE TABLE links (
      user_id TEXT NOT NULL,
      src TEXT NOT NULL,
      target TEXT NOT NULL,
      target_path TEXT
    )`,
    `CREATE INDEX links_src ON links(user_id, src)`,
    `CREATE INDEX links_target ON links(user_id, target_path)`,
    `CREATE TABLE tags (
      user_id TEXT NOT NULL,
      path TEXT NOT NULL,
      tag TEXT NOT NULL
    )`,
    `CREATE INDEX tags_path ON tags(user_id, path)`,
    `CREATE TABLE chunks (
      user_id TEXT NOT NULL,
      path TEXT NOT NULL,
      idx INTEGER NOT NULL,
      text TEXT NOT NULL,
      model TEXT NOT NULL,
      vector BLOB NOT NULL,
      PRIMARY KEY (user_id, path, idx)
    )`,
    `CREATE TABLE index_state (
      user_id TEXT PRIMARY KEY,
      commit_sha TEXT,
      checked_at TEXT
    )`,
  ],
  [
    // ---- security audit log (append-only; each row carries an HMAC) -------------
    `CREATE TABLE security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      user_id TEXT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','denied')),
      target TEXT,
      ip TEXT,
      ua TEXT,
      detail TEXT NOT NULL DEFAULT '{}',
      mac TEXT NOT NULL
    )`,
    `CREATE INDEX security_events_user ON security_events(user_id, id)`,
    `CREATE INDEX security_events_action ON security_events(action, id)`,
    `CREATE INDEX security_events_at ON security_events(at)`,
  ],
  [
    // ---- folders created on their own (a folder with notes needs no row) -------
    `CREATE TABLE folders (
      user_id TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, path)
    )`,
  ],
];

/** Full-text index; created separately because some SQLite builds lack trigram. */
export const FTS_STATEMENTS = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(user_id UNINDEXED, path UNINDEXED, title, body, tokenize = 'trigram')`,
];

let migrated = new WeakSet<object>();

/** Apply pending migrations (tracked in schema_migrations). Safe to call often. */
export async function migrate(db: Db, key: object = db): Promise<{ fts: boolean }> {
  if (migrated.has(key)) return { fts: await hasFts(db) };
  await db.run(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const done = new Set(
    (await db.all<{ version: number }>('SELECT version FROM schema_migrations')).map(
      (r) => r.version,
    ),
  );
  for (let v = 0; v < MIGRATIONS.length; v++) {
    if (done.has(v + 1)) continue;
    await db.batch([
      ...MIGRATIONS[v]!.map((sql) => stmt(sql)),
      stmt('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', v + 1, nowIso()),
    ]);
  }
  let fts = true;
  try {
    for (const sql of FTS_STATEMENTS) await db.run(sql);
  } catch {
    fts = false; // falls back to LIKE search
  }
  migrated.add(key);
  return { fts };
}

async function hasFts(db: Db): Promise<boolean> {
  const r = await db.first(`SELECT name FROM sqlite_master WHERE name = 'notes_fts'`);
  return r !== null;
}

/** Test helper: forget which databases were migrated. */
export function resetMigrationCache(): void {
  migrated = new WeakSet();
}
