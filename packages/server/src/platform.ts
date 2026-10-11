import { createLlmClient } from './ai/llm.js';
import { AuditLog } from './audit/audit.js';
import { AuthService } from './auth/auth.js';
import { OAuthService } from './auth/oauth.js';
import { TokenService } from './auth/tokens.js';
import type { Config } from './config.js';
import { type Db, migrate, stmt } from './db/db.js';
import { type Embedder, HashingEmbedder, LocalModelEmbedder } from './search/embedder.js';
import { MemoryRateLimiter, type RateLimiter } from './util/rate-limit.js';
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
  readonly audit: AuditLog;
  /** Sign-in and token endpoints: attempts per client address per minute. */
  readonly authLimiter: RateLimiter;
  readonly deps: WorkspaceDeps;
  private cache = new Map<string, { key: string; ws: Workspace }>();

  private constructor(
    readonly cfg: Config,
    readonly db: Db,
    fts: boolean,
    embedder: Embedder,
    fetchImpl?: typeof fetch,
    authLimiter?: RateLimiter,
    auditConsole?: (line: string) => void,
    resolveHost?: (host: string) => Promise<string[]>,
  ) {
    this.auth = new AuthService(db, cfg);
    this.audit = new AuditLog(
      db,
      {
        ...(cfg.secretKey ? { secretKey: cfg.secretKey } : {}),
        ...(cfg.previousSecretKey ? { previousSecretKey: cfg.previousSecretKey } : {}),
        auditIp: cfg.audit.ip,
        env: cfg.env,
      },
      auditConsole,
    );
    this.authLimiter = authLimiter ?? new MemoryRateLimiter(30, 60_000);
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
      ...(resolveHost ? { resolveHost } : {}),
    };
  }

  /** The fetch used for outside calls (GitHub, Cloudflare Access keys). */
  get fetch(): typeof fetch {
    return this.deps.fetch ?? fetch.bind(globalThis);
  }

  static async create(
    cfg: Config,
    db: Db,
    opts: {
      embedder?: Embedder;
      fetch?: typeof fetch;
      migrateKey?: object;
      authLimiter?: RateLimiter;
      /** Where audit lines are printed (default: console.log, i.e. Workers Logs). */
      auditConsole?: (line: string) => void;
      /** Host name → addresses (Node.js), so calendar URLs cannot point inside by name. */
      resolveHost?: (host: string) => Promise<string[]>;
    } = {},
  ): Promise<Platform> {
    const { fts } = await migrate(db, opts.migrateKey ?? db);
    const embedder =
      opts.embedder ??
      (cfg.llm.local && cfg.llm.localEmbedModel
        ? new LocalModelEmbedder(cfg.llm.local, cfg.llm.localEmbedModel)
        : new HashingEmbedder());
    return new Platform(
      cfg,
      db,
      fts,
      embedder,
      opts.fetch,
      opts.authLimiter,
      opts.auditConsole,
      opts.resolveHost,
    );
  }

  /** Open a user's workspace (cached while its storage settings are unchanged). */
  async workspace(userId: string, username?: string): Promise<Workspace> {
    // A session already names its user; anything else looks the name up.
    const [user, row] = await Promise.all([
      username ? { id: userId, username } : this.auth.user(userId),
      loadWorkspaceRow(this.db, userId),
    ]);
    if (!user) throw new Error('user not found');
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
