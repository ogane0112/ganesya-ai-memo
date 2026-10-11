import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, normalize, relative, resolve } from 'node:path';
import { type Config, configFromEnv } from './config.js';
import { SqliteDb } from './db/sqlite.js';
import { createHttpApp, HTML_CSP } from './http-app.js';
import { Platform } from './platform.js';
import type { Embedder } from './search/embedder.js';
import { randomToken } from './util/crypto.js';

/** Node-only settings on top of the shared configuration. */
export interface NodeConfig extends Config {
  dataDir: string;
  dbFile: string;
  port: number;
  host: string;
  /** Directory with the built web app (served when present). */
  webDir: string;
}

export function loadNodeConfig(overrides: Partial<NodeConfig> = {}): NodeConfig {
  const env = process.env;
  const dataDir = resolve(overrides.dataDir ?? env['GMEMO_DATA_DIR'] ?? './data');
  const port = Number(env['GMEMO_PORT'] || 8787);
  const base = configFromEnv({
    ...env,
    GMEMO_ORIGIN: env['GMEMO_ORIGIN'] || `http://localhost:${port}`,
    GMEMO_TIMEZONE:
      env['GMEMO_TIMEZONE'] || env['TZ'] || Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  return {
    ...base,
    dataDir,
    dbFile: join(dataDir, 'gmemo.db'),
    port,
    host: env['GMEMO_HOST'] || '0.0.0.0',
    webDir: env['GMEMO_WEB_DIR'] || resolve(import.meta.dirname, '../../web/dist'),
    ...overrides,
  };
}

/** GMEMO_SECRET_KEY, or a key generated once and kept in the data directory. */
async function ensureSecretKey(cfg: NodeConfig): Promise<void> {
  if (cfg.secretKey) return;
  const file = join(cfg.dataDir, 'secret.key');
  if (existsSync(file)) {
    cfg.secretKey = (await readFile(file, 'utf8')).trim();
    return;
  }
  cfg.secretKey = randomToken(32);
  await writeFile(file, cfg.secretKey + '\n', { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function createNodePlatform(
  cfg: NodeConfig,
  opts: { embedder?: Embedder; fetch?: typeof fetch } = {},
): Promise<{ platform: Platform; db: SqliteDb }> {
  await mkdir(cfg.dataDir, { recursive: true });
  await ensureSecretKey(cfg);
  const db = new SqliteDb(cfg.dbFile);
  const platform = await Platform.create(cfg, db, {
    resolveHost: async (host) =>
      (await lookup(host, { all: true, verbatim: true })).map((a) => a.address),
    ...opts,
  });
  return { platform, db };
}

const STATIC_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
};

/** Serve the built web app with an SPA fallback to index.html. */
export function staticFiles(webDir: string) {
  if (!existsSync(join(webDir, 'index.html'))) return undefined;
  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    const rel = normalize(decodeURIComponent(path)).replace(/^[/\\]+/, '');
    const file = join(webDir, rel);
    const inside = !relative(webDir, file).startsWith('..');
    const target =
      inside && rel && existsSync(file) && !file.endsWith('/') ? file : join(webDir, 'index.html');
    const data = await readFile(target).catch(() => readFile(join(webDir, 'index.html')));
    const ext = target.slice(target.lastIndexOf('.') + 1);
    return new Response(new Uint8Array(data), {
      headers: {
        'content-type': STATIC_TYPES[ext] ?? 'application/octet-stream',
        'cache-control': rel.startsWith('assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
        ...(ext === 'html' ? { 'content-security-policy': HTML_CSP } : {}),
      },
    });
  };
}

export function createNodeHttpApp(platform: Platform, cfg: NodeConfig) {
  const serveStatic = staticFiles(cfg.webDir);
  return createHttpApp(platform, serveStatic ? { serveStatic } : {});
}
