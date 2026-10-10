import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Rule } from '@gmemo/core';
import { z } from 'zod';
import type { Agent } from '../auth/agents.js';

export type PluginEvent = 'change' | 'proposal';

export interface PluginRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path below /api/plugins/<plugin>/ */
  path: string;
  handler: (req: Request) => Response | Promise<Response>;
}

export interface PluginMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  handler: (args: Record<string, unknown>, ctx: { agent: Agent }) => Promise<string> | string;
}

/** What a plugin can do. Plugins run in-process with full trust: install only code you trust. */
export interface PluginApi {
  readonly name: string;
  /** The server's zod, for MCP tool input schemas. */
  readonly z: typeof z;
  notes: {
    read(path: string): Promise<{ path: string; content: string; sha: string } | null>;
    list(folder?: string): { path: string; title: string; tags: string[] }[];
    search(query: string): Promise<{ path: string; title: string; snippet: string }[]>;
    /** Suggest changes. Recorded with the plugin as the AI author, subject to the plugin agent's settings. */
    propose(
      changes: { path: string; content: string | null }[],
      title: string,
      description?: string,
    ): Promise<unknown>;
  };
  on(event: PluginEvent, handler: (payload: unknown) => void): void;
  registerRoute(route: PluginRoute): void;
  registerMcpTool(tool: PluginMcpTool): void;
  registerSensitiveRule(rule: Rule): void;
  log(...args: unknown[]): void;
}

export interface GmemoPlugin {
  name?: string;
  setup(api: PluginApi): void | Promise<void>;
}

export interface LoadedPlugin {
  name: string;
  dir: string;
  routes: PluginRoute[];
  tools: PluginMcpTool[];
  error?: string;
}

export interface PluginHost {
  makeApi(name: string, sink: { routes: PluginRoute[]; tools: PluginMcpTool[] }): PluginApi;
}

/** Load every plugin folder in `dir`. Each must export a `GmemoPlugin` as default. */
export async function loadPlugins(dir: string, host: PluginHost): Promise<LoadedPlugin[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const out: LoadedPlugin[] = [];
  for (const entry of entries.sort()) {
    const pdir = join(dir, entry);
    if (!(await stat(pdir).catch(() => null))?.isDirectory()) continue;
    const loaded: LoadedPlugin = { name: entry, dir: pdir, routes: [], tools: [] };
    try {
      let main = 'index.js';
      const pkg = await readFile(join(pdir, 'package.json'), 'utf8').catch(() => null);
      if (pkg) main = (JSON.parse(pkg) as { main?: string }).main ?? main;
      const mod = (await import(pathToFileURL(join(pdir, main)).href)) as {
        default?: GmemoPlugin | (() => GmemoPlugin);
      };
      const plugin = typeof mod.default === 'function' ? mod.default() : mod.default;
      if (!plugin || typeof plugin.setup !== 'function')
        throw new Error('default export must be a plugin with setup()');
      loaded.name = (plugin.name ?? entry).replace(/[^\w-]/g, '-');
      await plugin.setup(host.makeApi(loaded.name, loaded));
      console.log(`[plugins] loaded ${loaded.name}`);
    } catch (e) {
      loaded.error = (e as Error).message;
      console.error(`[plugins] failed to load ${entry}: ${loaded.error}`);
    }
    out.push(loaded);
  }
  return out;
}
