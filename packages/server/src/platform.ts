import { createLlmClient } from './ai/llm.js';
import { AuthService } from './auth/auth.js';
import { OAuthService } from './auth/oauth.js';
import { TokenService } from './auth/tokens.js';
import type { Config } from './config.js';
import { type Db, migrate, stmt } from './db/db.js';
import { type Embedder, HashingEmbedder, LocalModelEmbedder } from './search/embedder.js';
import { loadWorkspaceRow, Workspace, type WorkspaceDeps } from './workspace.js';

/** Recently used workspaces per isolate/process (their stores cache immutable git objects). */
const CACHE_SIZE = 32;

/**
 * Process-wide (or Workers-isolate-wide) services. Per-user state lives in
 * `Workspace`, opened per request with `workspace(userId)`.
 */
export class Platform {
  readonly auth: AuthService;
  readonly tokens: TokenService;
  readonly oauth: OAuthService;
  readonly deps: WorkspaceDeps;
  private cache = new Map<string, { key: string; ws: Workspace }>();

  private constructor(
    readonly cfg: Config,
    readonly db: Db,
    fts: boolean,
    embedder: Embedder,
    fetchImpl?: typeof fetch,
  ) {
    this.auth = new AuthService(db, cfg);
    this.tokens = new TokenService(db, cfg.accessTokenMinutes);
    this.oauth = new OAuthService(db, cfg, this.tokens);
    this.deps = {
      db,
      cfg,
      fts,
      embedder,
      llm: {
        local: cfg.llm.local ? createLlmClient(cfg.llm.local, 'local') : null,
        external: cfg.llm.external ? createLlmClient(cfg.llm.external, 'external') : null,
      },
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    };
  }

  static async create(
    cfg: Config,
    db: Db,
    opts: { embedder?: Embedder; fetch?: typeof fetch; migrateKey?: object } = {},
  ): Promise<Platform> {
    const { fts } = await migrate(db, opts.migrateKey ?? db);
    const embedder =
      opts.embedder ??
      (cfg.llm.local && cfg.llm.localEmbedModel
        ? new LocalModelEmbedder(cfg.llm.local, cfg.llm.localEmbedModel)
        : new HashingEmbedder());
    return new Platform(cfg, db, fts, embedder, opts.fetch);
  }

  /** Open a user's workspace (cached while its storage settings are unchanged). */
  async workspace(userId: string): Promise<Workspace> {
    const user = await this.auth.user(userId);
    if (!user) throw new Error('user not found');
    const row = await loadWorkspaceRow(this.db, userId);
    const key = `${row.updated_at}|${user.username}`;
    const hit = this.cache.get(userId);
    if (hit && hit.key === key) {
      this.cache.delete(userId);
      this.cache.set(userId, hit);
      return hit.ws;
    }
    const ws = await Workspace.open(this.deps, user, row);
    this.cache.set(userId, { key, ws });
    while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    return ws;
  }

  forget(userId: string): void {
    this.cache.delete(userId);
  }

  async deleteUser(userId: string): Promise<void> {
    this.forget(userId);
    await this.auth.deleteUser(
      userId,
      this.deps.fts
        ? [
            stmt(
              'DELETE FROM notes_fts WHERE rowid IN (SELECT rowid FROM notes WHERE user_id = ?)',
              userId,
            ),
          ]
        : [],
    );
  }
}
