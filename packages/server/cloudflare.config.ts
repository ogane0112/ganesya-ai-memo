/**
 * Cloudflare deployment (cf CLI). See docs/deploy-cloudflare.md.
 *
 *   GMEMO_ORIGIN=https://notes.example.com npx cf deploy
 *
 * The D1 database is created on the first deploy. Secrets are set separately
 * (never here): GMEMO_SETUP_TOKEN and GMEMO_SECRET_KEY.
 */
import { bindings, defineConfig, triggers } from 'cf/config';

const env = (name: string, fallback: string) => process.env[name] || fallback;

export default defineConfig({
  worker: {
    name: env('GMEMO_WORKER_NAME', 'gmemo'),
    compatibilityDate: '2026-09-01',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint: 'src/worker.ts',
    // The built web app (npm run build -w @gmemo/web, path in wrangler.config.ts).
    // API routes run the Worker first; everything else is the single-page app.
    assets: {
      notFoundHandling: 'single-page-application',
      runWorkerFirst: ['/api/*', '/mcp', '/oauth/*', '/.well-known/*', '/cal/*'],
    },
    // Daily cleanup of expired sessions, tokens and challenges.
    triggers: [triggers.scheduled({ schedule: '17 3 * * *' })],
    env: {
      // Your public URL (a workers.dev address or a custom domain). Passkeys are tied to it.
      GMEMO_ORIGIN: bindings.text(env('GMEMO_ORIGIN', 'http://localhost:8787')),
      // Who may create accounts after the first (admin) one: open | invite | closed
      GMEMO_SIGNUP: bindings.text(env('GMEMO_SIGNUP', 'invite')),
      GMEMO_TIMEZONE: bindings.text(env('GMEMO_TIMEZONE', 'Asia/Tokyo')),
      // Creates the first (admin) account.
      GMEMO_SETUP_TOKEN: bindings.secret(),
      // Encrypts users' GitHub tokens. Keep it once set.
      GMEMO_SECRET_KEY: bindings.secret(),
      DB: bindings.d1({ name: env('GMEMO_D1_NAME', 'gmemo') }),
      ASSETS: bindings.assets(),
    },
  },
});
