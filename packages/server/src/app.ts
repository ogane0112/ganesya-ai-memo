import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Rule } from '@gmemo/core';
import { z } from 'zod';
import { AiGateway } from './ai/gateway.js';
import { createLlmClient } from './ai/llm.js';
import { type Agent, AgentStore } from './auth/agents.js';
import { AuthService } from './auth/auth.js';
import { OAuthService } from './auth/oauth.js';
import { TokenService } from './auth/tokens.js';
import type { Config } from './config.js';
import { APP_MIGRATIONS, type DB, INDEX_MIGRATIONS, openDatabase } from './db/db.js';
import { NoteRepo } from './git/repo.js';
import type { HumanActor } from './notes/actor.js';
import { NoteService } from './notes/service.js';
import {
  type LoadedPlugin,
  loadPlugins,
  type PluginApi,
  type PluginEvent,
} from './plugins/plugins.js';
import { type Embedder, HashingEmbedder, LocalModelEmbedder } from './search/embedder.js';
import { Indexer } from './search/indexer.js';

export interface AppContext {
  cfg: Config;
  appDb: DB;
  indexDb: DB;
  repo: NoteRepo;
  indexer: Indexer;
  notes: NoteService;
  auth: AuthService;
  agents: AgentStore;
  tokens: TokenService;
  oauth: OAuthService;
  ai: AiGateway;
  plugins: LoadedPlugin[];
  extraRules: Rule[];
  human(): HumanActor;
  close(): void;
}

/** Path of the CLI entry, used to register the git merge driver. */
function cliPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, here.endsWith('src') ? 'cli.ts' : 'cli.js');
}

export function mergeDriverCommand(): string {
  const cli = cliPath();
  let runner = JSON.stringify(process.execPath);
  if (cli.endsWith('.ts')) {
    // Running from source (dev/tests): git invokes the driver from the notes dir, so pass tsx by absolute URL.
    const tsxPkg = createRequire(import.meta.url).resolve('tsx/package.json');
    runner += ` --import ${JSON.stringify(pathToFileURL(join(dirname(tsxPkg), 'dist/loader.mjs')).href)}`;
  }
  return `${runner} ${JSON.stringify(cli)} merge-driver %O %A %B %P`;
}

export async function createApp(
  cfg: Config,
  opts: { embedder?: Embedder; loadPlugins?: boolean } = {},
): Promise<AppContext> {
  await mkdir(cfg.dataDir, { recursive: true });
  const appDb = openDatabase(cfg.appDbFile, APP_MIGRATIONS);
  const indexDb = openDatabase(cfg.indexDbFile, INDEX_MIGRATIONS);
  const repo = new NoteRepo(cfg.notesDir);
  await repo.init(mergeDriverCommand());

  const auth = new AuthService(appDb, cfg);
  const human = (): HumanActor => ({ kind: 'human', name: auth.user()?.username ?? 'me' });
  const embedder =
    opts.embedder ??
    (cfg.llm.local && cfg.llm.localEmbedModel
      ? new LocalModelEmbedder(cfg.llm.local, cfg.llm.localEmbedModel)
      : new HashingEmbedder());

  // Assigned right below; the indexer only reads the policy lazily.
  // eslint-disable-next-line prefer-const
  let notes!: NoteService;
  const indexer = new Indexer(indexDb, repo, embedder, () => notes.currentPolicy());
  notes = new NoteService(repo, appDb, indexer, human);
  await notes.init();

  const agents = new AgentStore(appDb);
  const tokens = new TokenService(appDb, agents, cfg.accessTokenMinutes);
  const oauth = new OAuthService(appDb, cfg, agents, tokens);
  const ai = new AiGateway(
    appDb,
    cfg.llm.local ? createLlmClient(cfg.llm.local, 'local') : null,
    cfg.llm.external ? createLlmClient(cfg.llm.external, 'external') : null,
  );

  const ctx: AppContext = {
    cfg,
    appDb,
    indexDb,
    repo,
    indexer,
    notes,
    auth,
    agents,
    tokens,
    oauth,
    ai,
    plugins: [],
    extraRules: [],
    human,
    close() {
      appDb.close();
      indexDb.close();
    },
  };
  ai.setExtraRules(ctx.extraRules);

  if (opts.loadPlugins !== false) {
    ctx.plugins = await loadPlugins(cfg.pluginsDir, {
      makeApi: (name, sink) => pluginApi(ctx, name, sink),
    });
  }
  return ctx;
}

function pluginAgent(ctx: AppContext, name: string): Agent {
  const agentName = `plugin:${name}`;
  return (
    ctx.agents.getByName(agentName) ??
    ctx.agents.create({ name: agentName, description: `Plugin ${name}`, writeMode: 'propose' })
  );
}

function pluginApi(
  ctx: AppContext,
  name: string,
  sink: Pick<LoadedPlugin, 'routes' | 'tools'>,
): PluginApi {
  return {
    name,
    z,
    notes: {
      async read(path) {
        try {
          const d = await ctx.notes.read(path);
          return { path: d.path, content: d.content, sha: d.sha };
        } catch {
          return null;
        }
      },
      list: (folder) =>
        ctx.indexer.listNotes(folder).map((n) => ({ path: n.path, title: n.title, tags: n.tags })),
      search: async (q) =>
        (await ctx.indexer.search(q)).map((h) => ({
          path: h.path,
          title: h.title,
          snippet: h.snippet,
        })),
      propose: (changes, title, description) =>
        ctx.notes.writeAsAgent(pluginAgent(ctx, name), changes, {
          title,
          ...(description ? { description } : {}),
          mode: 'propose',
        }),
    },
    on(event: PluginEvent, handler) {
      ctx.notes.events.on(event, (p: unknown) => {
        try {
          handler(p);
        } catch (e) {
          console.error(`[plugin ${name}]`, e);
        }
      });
    },
    registerRoute: (route) => sink.routes.push(route),
    registerMcpTool: (tool) => sink.tools.push(tool),
    registerSensitiveRule: (rule) => ctx.extraRules.push(rule),
    log: (...args) => console.log(`[plugin ${name}]`, ...args),
  };
}
