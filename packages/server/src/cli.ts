#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { configWarnings } from './config.js';
import { createNodeHttpApp, createNodePlatform, loadNodeConfig } from './node.js';

const HELP = `gmemo — AI notes server (Node). For Cloudflare Workers see docs/deploy-cloudflare.md.

Usage:
  gmemo serve                          Start the server
  gmemo admin setup-token              Print a one-time token for creating the first account
  gmemo admin users                    List accounts
  gmemo admin reset-user <username>    Sign a user out and print new recovery codes
  gmemo admin make-admin <username>    Give a user the admin role
  gmemo reindex [<username>]           Rebuild the search index (all users by default)
  gmemo audit verify                   Check that no security event was edited or deleted
  gmemo audit export [--days N]        Print security events as JSON lines (default: 30 days)

Configuration is read from environment variables (see docs/configuration.md).`;

async function main(argv: string[]) {
  const [cmd, ...args] = argv;
  const cfg = loadNodeConfig();
  switch (cmd) {
    case 'serve': {
      // After the platform exists: it fills in a generated GMEMO_SECRET_KEY.
      const { platform, db } = await createNodePlatform(cfg);
      for (const w of configWarnings(cfg)) console.warn(`[warn] ${w}`);
      if ((await platform.auth.needsSetup()) && !cfg.setupToken) {
        const token = await platform.auth.issueSetupToken();
        console.log(
          '\n  No account exists yet. Create the first (admin) account with this token:\n',
        );
        console.log(`    ${token}\n`);
        console.log(`    ${cfg.origin}/setup?token=${encodeURIComponent(token)}\n`);
      }
      const http = createNodeHttpApp(platform, cfg);
      serve({ fetch: http.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
        console.log(`gmemo listening on ${cfg.host}:${info.port} (origin ${cfg.origin})`);
      });
      setInterval(
        () => {
          void platform.tokens.prune();
          void platform.audit.purge(cfg.audit.retentionDays);
        },
        24 * 3600 * 1000,
      ).unref();
      const shutdown = () => {
        db.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return;
    }
    case 'admin': {
      const { platform, db } = await createNodePlatform(cfg);
      try {
        const sub = args[0];
        const byName = async () => {
          const u = await platform.auth.userByName(args[1] ?? '');
          if (!u) throw new Error(`no user named ${args[1]}`);
          return u;
        };
        if (sub === 'setup-token') {
          if (!(await platform.auth.needsSetup()))
            console.log('Note: accounts already exist; the token is only used for the first one.');
          console.log(await platform.auth.issueSetupToken());
        } else if (sub === 'users') {
          for (const u of await platform.auth.users())
            console.log(`${u.username}\t${u.isAdmin ? 'admin' : ''}\t${u.createdAt}`);
        } else if (sub === 'reset-user') {
          const u = await byName();
          console.log((await platform.auth.adminResetUser(u.id)).join('\n'));
        } else if (sub === 'make-admin') {
          const u = await byName();
          await db.run('UPDATE users SET is_admin = 1 WHERE id = ?', u.id);
          console.log(`${u.username} is now an admin`);
        } else {
          console.log(HELP);
          process.exitCode = 1;
        }
      } finally {
        db.close();
      }
      return;
    }
    case 'audit': {
      const { platform, db } = await createNodePlatform(cfg);
      try {
        if (args[0] === 'verify') {
          const r = await platform.audit.verify();
          console.log(JSON.stringify(r, null, 2));
          if (r.tampered.length || r.missing.length) process.exitCode = 2;
        } else if (args[0] === 'export') {
          const i = args.indexOf('--days');
          const days = i >= 0 ? Number(args[i + 1]) : 30;
          const since = new Date(Date.now() - days * 86400_000).toISOString();
          let before: number | undefined;
          for (;;) {
            const page = await platform.audit.list({ limit: 500, ...(before ? { before } : {}) });
            for (const e of page) if (e.at >= since) console.log(JSON.stringify(e));
            if (page.length < 500 || page[page.length - 1]!.at < since) break;
            before = page[page.length - 1]!.id;
          }
        } else {
          console.log(HELP);
          process.exitCode = 1;
        }
      } finally {
        db.close();
      }
      return;
    }
    case 'reindex': {
      const { platform, db } = await createNodePlatform(cfg);
      const users = args[0]
        ? [await platform.auth.userByName(args[0])].filter((u) => u !== null)
        : await platform.auth.users();
      for (const u of users) {
        const ws = await platform.workspace(u.id);
        await ws.indexer.rebuild();
        console.log(`${u.username}: indexed ${(await ws.indexer.allPaths()).length} notes`);
      }
      db.close();
      return;
    }
    default:
      console.log(HELP);
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
