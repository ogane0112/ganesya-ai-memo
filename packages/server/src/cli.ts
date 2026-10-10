#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { mergeNotes, renderWithMarkers } from '@gmemo/core';
import { createApp } from './app.js';
import { createBackup, restoreBackup } from './backup.js';
import { configWarnings, loadConfig } from './config.js';
import { createHttpApp } from './server.js';

const HELP = `gmemo — self-hosted AI notes

Usage:
  gmemo serve                       Start the server
  gmemo admin reset-passkeys        Remove all passkeys and print a new setup token
  gmemo admin setup-token           Print a new one-time setup token
  gmemo admin recovery-codes        Replace recovery codes and print them
  gmemo admin revoke-agent <name>   Revoke an agent and all its tokens
  gmemo reindex                     Rebuild the search index from the repository
  gmemo backup <file> [--passphrase-env VAR]   Write a backup (encrypted when a passphrase is given)
  gmemo restore <file> [--passphrase-env VAR]  Restore a backup into an empty GMEMO_DATA_DIR
  gmemo merge-driver %O %A %B %P    Git merge driver (configured automatically)

Configuration is read from environment variables (see docs/configuration.md).`;

function passphraseFrom(args: string[]): string | undefined {
  const i = args.indexOf('--passphrase-env');
  if (i < 0) return undefined;
  const v = process.env[args[i + 1] ?? ''];
  if (!v) throw new Error(`environment variable ${args[i + 1]} is empty`);
  return v;
}

async function main(argv: string[]) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'serve': {
      const cfg = loadConfig();
      for (const w of configWarnings(cfg)) console.warn(`[warn] ${w}`);
      const ctx = await createApp(cfg);
      if (ctx.auth.needsSetup()) {
        const token = ctx.auth.issueSetupToken();
        console.log(
          '\n  No passkey is registered yet. Open the app and use this one-time setup token:\n',
        );
        console.log(`    ${token}\n`);
        console.log(`    ${cfg.origin}/setup?token=${encodeURIComponent(token)}\n`);
      }
      const http = createHttpApp(ctx);
      serve({ fetch: http.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
        console.log(`gmemo listening on ${cfg.host}:${info.port} (origin ${cfg.origin})`);
      });
      if (cfg.externalScanSeconds > 0) {
        setInterval(() => {
          ctx.notes.syncExternal().catch((e: Error) => console.error('[sync]', e.message));
        }, cfg.externalScanSeconds * 1000).unref();
      }
      setInterval(() => ctx.tokens.prune(), 24 * 3600 * 1000).unref();
      const shutdown = () => {
        ctx.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return;
    }
    case 'admin': {
      const ctx = await createApp(loadConfig(), { loadPlugins: false });
      try {
        const sub = args[0];
        if (sub === 'reset-passkeys') {
          const token = ctx.auth.adminReset();
          console.log(
            'All passkeys and sessions were removed. Register a new passkey with this setup token:',
          );
          console.log(`  ${token}\n  ${ctx.cfg.origin}/setup?token=${encodeURIComponent(token)}`);
        } else if (sub === 'setup-token') {
          if (!ctx.auth.needsSetup())
            console.log(
              'Note: a passkey already exists; the token is only accepted after reset-passkeys.',
            );
          console.log(ctx.auth.issueSetupToken());
        } else if (sub === 'recovery-codes') {
          console.log(ctx.auth.replaceRecoveryCodes().join('\n'));
        } else if (sub === 'revoke-agent') {
          const agent = ctx.agents.getByName(args[1] ?? '');
          if (!agent) throw new Error(`no agent named ${args[1]}`);
          ctx.agents.revoke(agent.id);
          console.log(`revoked ${agent.name}`);
        } else {
          console.log(HELP);
          process.exitCode = 1;
        }
      } finally {
        ctx.close();
      }
      return;
    }
    case 'reindex': {
      const ctx = await createApp(loadConfig(), { loadPlugins: false });
      await ctx.indexer.rebuild();
      await ctx.indexer.flushEmbeddings();
      console.log(`indexed ${ctx.indexer.allPaths().length} notes`);
      ctx.close();
      return;
    }
    case 'backup': {
      const file = args[0];
      if (!file) throw new Error('usage: gmemo backup <file>');
      const ctx = await createApp(loadConfig(), { loadPlugins: false });
      await writeFile(file, await createBackup(ctx.repo, ctx.appDb, passphraseFrom(args)));
      console.log(`backup written to ${file}`);
      ctx.close();
      return;
    }
    case 'restore': {
      const file = args[0];
      if (!file) throw new Error('usage: gmemo restore <file>');
      const cfg = loadConfig();
      await restoreBackup(await readFile(file), cfg.dataDir, passphraseFrom(args));
      const ctx = await createApp(cfg, { loadPlugins: false });
      await ctx.indexer.rebuild();
      ctx.close();
      console.log(`restored into ${cfg.dataDir}`);
      return;
    }
    case 'merge-driver': {
      // git calls: driver %O(base) %A(ours, result is written here) %B(theirs) %P(path)
      const [base, ours, theirs] = args;
      if (!base || !ours || !theirs) throw new Error('merge-driver needs %O %A %B');
      const read = (f: string) => readFile(f, 'utf8').catch(() => null);
      const result = mergeNotes(await read(base), await read(ours), await read(theirs));
      await writeFile(ours, result.clean ? result.text : renderWithMarkers(result));
      process.exitCode = result.clean ? 0 : 1;
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
