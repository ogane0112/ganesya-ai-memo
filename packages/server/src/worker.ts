/**
 * Cloudflare Workers entry. Notes, history and the index live in D1 (or in
 * each user's GitHub repository); the web app is served from static assets.
 */
import { configFromEnv, type EnvRecord } from './config.js';
import { D1Db, type D1DatabaseLike } from './db/d1.js';
import { type R2BucketLike, R2FileStore } from './files/file-store.js';
import { createHttpApp } from './http-app.js';
import { Platform } from './platform.js';
import { type WorkersRateLimitBinding, workersRateLimiter } from './util/rate-limit.js';

interface WorkerEnv {
  DB: D1DatabaseLike & object;
  ASSETS?: { fetch(req: Request): Promise<Response> };
  /** Workers Rate Limiting binding for sign-in and token endpoints. */
  AUTH_LIMITER?: WorkersRateLimitBinding;
  /** Workers Rate Limiting binding for mutating requests, per account. */
  WRITE_LIMITER?: WorkersRateLimitBinding;
  /** R2 bucket for uploaded files. Without it, files go into the note store. */
  FILES?: R2BucketLike;
}

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

let cached: { env: object; app: ReturnType<typeof createHttpApp>; platform: Platform } | null =
  null;

async function appFor(env: WorkerEnv) {
  if (cached?.env === env) return cached;
  const cfg = configFromEnv(env as unknown as EnvRecord);
  const platform = await Platform.create(cfg, new D1Db(env.DB), {
    migrateKey: env.DB,
    ...(env.AUTH_LIMITER ? { authLimiter: workersRateLimiter(env.AUTH_LIMITER) } : {}),
    ...(env.WRITE_LIMITER ? { writeLimiter: workersRateLimiter(env.WRITE_LIMITER) } : {}),
    ...(env.FILES ? { files: new R2FileStore(env.FILES) } : {}),
  });
  const app = createHttpApp(platform, {
    ...(env.ASSETS
      ? {
          serveStatic: async (req: Request) => {
            const res = await env.ASSETS!.fetch(req);
            return res.status === 404 ? null : res;
          },
        }
      : {}),
  });
  cached = { env, app, platform };
  return cached;
}

export default {
  async fetch(req: Request, env: WorkerEnv, ctx: Ctx): Promise<Response> {
    const { app } = await appFor(env);
    return app.fetch(req, env, ctx as never);
  },

  /** Daily housekeeping (configure a cron trigger in wrangler.toml). */
  async scheduled(_event: unknown, env: WorkerEnv, ctx: Ctx): Promise<void> {
    const { platform } = await appFor(env);
    ctx.waitUntil(
      Promise.all([
        platform.tokens.prune(),
        platform.db.run('DELETE FROM challenges WHERE expires_at < ?', new Date().toISOString()),
        platform.db.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString()),
        platform.db.run('DELETE FROM editing WHERE until < ?', new Date().toISOString()),
        platform.audit.purge(platform.cfg.audit.retentionDays).then((n) =>
          platform.audit.record({
            action: 'audit.retention_purge',
            actor: 'system',
            detail: { removed: n, days: platform.cfg.audit.retentionDays },
          }),
        ),
      ]),
    );
  },
};
