import Database from 'better-sqlite3';

export type DB = Database.Database;

/**
 * Open a SQLite database and bring it up to date. Each migration runs once,
 * tracked with `PRAGMA user_version`, inside a transaction.
 */
export function openDatabase(file: string, migrations: readonly string[]): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, migrations);
  return db;
}

export function migrate(db: DB, migrations: readonly string[]): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export const APP_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE credentials (
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
  );
  CREATE TABLE recovery_codes (
    hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    via TEXT NOT NULL DEFAULT 'passkey'
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    can_read INTEGER NOT NULL DEFAULT 1,
    write_mode TEXT NOT NULL DEFAULT 'propose' CHECK (write_mode IN ('none','propose','direct')),
    folders TEXT NOT NULL DEFAULT '[]',
    auto_merge INTEGER NOT NULL DEFAULT 0,
    auto_merge_folders TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE TABLE oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at TEXT NOT NULL,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL
  );
  CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scope TEXT NOT NULL,
    resource TEXT,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE tokens (
    hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('access','refresh','pat')),
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    client_id TEXT,
    scope TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    last_used_at TEXT
  );
  CREATE INDEX tokens_agent ON tokens(agent_id);
  CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
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
  );
  CREATE INDEX proposals_status ON proposals(status);
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    actor TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}'
  );
  `,
  // v2: where an agent's model runs (governs folder AI policy and masking), and
  // placeholders handed to external agents in place of detected secrets.
  `
  ALTER TABLE agents ADD COLUMN location TEXT NOT NULL DEFAULT 'external' CHECK (location IN ('external','local'));
  CREATE TABLE secret_placeholders (
    placeholder TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
];

export const INDEX_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE notes (
    path TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    frontmatter TEXT NOT NULL,
    body TEXT NOT NULL,
    sha TEXT NOT NULL,
    created_by TEXT,
    ai_agent TEXT,
    updated_at TEXT
  );
  CREATE VIRTUAL TABLE notes_fts USING fts5(path UNINDEXED, title, body, tokenize = 'trigram');
  CREATE TABLE links (
    src TEXT NOT NULL,
    target TEXT NOT NULL,
    target_path TEXT
  );
  CREATE INDEX links_src ON links(src);
  CREATE INDEX links_target_path ON links(target_path);
  CREATE TABLE tags (
    path TEXT NOT NULL,
    tag TEXT NOT NULL
  );
  CREATE INDEX tags_tag ON tags(tag);
  CREATE INDEX tags_path ON tags(path);
  CREATE TABLE chunks (
    path TEXT NOT NULL,
    idx INTEGER NOT NULL,
    text TEXT NOT NULL,
    model TEXT NOT NULL,
    vector BLOB NOT NULL,
    PRIMARY KEY (path, idx)
  );
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export function nowIso(): string {
  return new Date().toISOString();
}
