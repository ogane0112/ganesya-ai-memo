/**
 * Cloudflare deployment (cf CLI). Two environments, fully separate (own Worker,
 * own D1 database, own secrets). See docs/deploy-cloudflare.md and docs/operations.md.
 *
 *   npx cf deploy --mode staging      # gmemo-stg: only you, behind Cloudflare Access
 *   npx cf deploy --mode production   # gmemo: the real service
 *
 * Values can be overridden with environment variables at deploy time
 * (GMEMO_ORIGIN, GMEMO_STG_ORIGIN, GMEMO_ACCESS_TEAM_DOMAIN, GMEMO_STG_ACCESS_AUD, …).
 * Secrets are set per Worker, never here: GMEMO_SETUP_TOKEN and GMEMO_SECRET_KEY.
 */
import { bindings, defineConfig, triggers } from 'cf/config';

const env = (name: string, fallback = '') => process.env[name] || fallback;

export default defineConfig(({ mode }) => {
  const staging = mode === 'staging';
  const production = mode === 'production';
  // Without --mode (cf dev, or a forgotten flag) everything points at a separate
  // "gmemo-dev" Worker and database, so production is never overwritten by accident.
  const dev = !staging && !production;
  if (mode !== 'staging' && mode !== 'production' && mode !== undefined && mode !== 'development')
    throw new Error(`Unknown mode "${mode}": use --mode staging or --mode production`);

  const origin = staging
    ? env('GMEMO_STG_ORIGIN', 'http://localhost:8787')
    : env('GMEMO_ORIGIN', 'http://localhost:8787');
  // A deploy without the real URL would break every passkey: stop instead.
  if (!dev && !origin.startsWith('https://'))
    throw new Error(
      `${staging ? 'GMEMO_STG_ORIGIN' : 'GMEMO_ORIGIN'} must be set to the https:// URL of this environment`,
    );
  const accessTeam = env('GMEMO_ACCESS_TEAM_DOMAIN');
  const accessAud = staging ? env('GMEMO_STG_ACCESS_AUD') : env('GMEMO_ACCESS_AUD');

  return {
    worker: {
      name: staging ? 'gmemo-stg' : production ? env('GMEMO_WORKER_NAME', 'gmemo') : 'gmemo-dev',
      compatibilityDate: '2026-09-01',
      compatibilityFlags: ['nodejs_compat'],
      entrypoint: 'src/worker.ts',
      // Versioned preview URLs would bypass the per-environment Access setup.
      previewUrls: false,
      // The built web app (npm run build -w @gmemo/web, path in wrangler.config.ts).
      assets: {
        notFoundHandling: 'single-page-application',
        runWorkerFirst: ['/api/*', '/mcp', '/oauth/*', '/.well-known/*', '/cal/*'],
      },
      // Daily cleanup: expired sessions/tokens, and security events past retention.
      triggers: [triggers.scheduled({ schedule: '17 3 * * *' })],
      // Workers Logs keep a copy of every security event outside the database.
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
      env: {
        GMEMO_ENV: bindings.text(staging ? 'staging' : production ? 'production' : 'development'),
        GMEMO_ORIGIN: bindings.text(origin),
        // Staging: nobody else signs up. Production: invite-only unless overridden.
        GMEMO_SIGNUP: bindings.text(production ? env('GMEMO_SIGNUP', 'invite') : 'closed'),
        GMEMO_TIMEZONE: bindings.text(env('GMEMO_TIMEZONE', 'Asia/Tokyo')),
        GMEMO_AUDIT_IP: bindings.text(env('GMEMO_AUDIT_IP', 'hash')),
        GMEMO_AUDIT_RETENTION_DAYS: bindings.text(env('GMEMO_AUDIT_RETENTION_DAYS', '400')),
        // Cloudflare Access (required in staging; the app refuses requests without it).
        GMEMO_ACCESS_TEAM_DOMAIN: bindings.text(accessTeam),
        GMEMO_ACCESS_AUD: bindings.text(accessAud),
        GMEMO_SETUP_TOKEN: bindings.secret(),
        GMEMO_SECRET_KEY: bindings.secret(),
        DB: bindings.d1({
          name: staging ? 'gmemo-stg' : production ? env('GMEMO_D1_NAME', 'gmemo') : 'gmemo-dev',
        }),
        ASSETS: bindings.assets(),
        // Uploaded files go to R2 when GMEMO_R2=on (R2 has to be enabled on the
        // account first). Without it they are kept with the notes, 1.9 MB each.
        ...(env('GMEMO_R2') === 'on'
          ? {
              FILES: bindings.r2({
                name: staging
                  ? 'gmemo-stg-files'
                  : production
                    ? env('GMEMO_R2_NAME', 'gmemo-files')
                    : 'gmemo-dev-files',
              }),
            }
          : {}),
        // 30 attempts per minute per address on sign-in and token endpoints.
        AUTH_LIMITER: bindings.rateLimit({
          namespace: staging ? '7002' : production ? '7001' : '7003',
          simple: { limit: 30, period: 60 },
        }),
        // Write requests: 120 per minute per session or agent token…
        WRITE_LIMITER: bindings.rateLimit({
          namespace: staging ? '7012' : production ? '7011' : '7013',
          simple: { limit: 120, period: 60 },
        }),
        // …and 600 per minute per account, across all of its sessions and tokens.
        WRITE_ACCOUNT_LIMITER: bindings.rateLimit({
          namespace: staging ? '7022' : production ? '7021' : '7023',
          simple: { limit: 600, period: 60 },
        }),
      },
    },
  };
});
