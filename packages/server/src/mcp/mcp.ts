import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { applyView, parseView } from '@gmemo/core';
import { z } from 'zod';
import type { AgentOps } from '../api/agent-ops.js';
import type { AppContext } from '../app.js';
import { capabilities, type Principal } from '../auth/tokens.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function fail(e: unknown): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
}

const INSTRUCTIONS = `This server holds the user's personal Markdown notes (Obsidian-compatible: YAML frontmatter, [[wiki links]]).
- You are a co-editor. Your writes are usually PROPOSALS the user reviews, like pull requests; they are attributed to you.
- Read a note before changing it and pass its sha as base_sha so concurrent edits merge safely.
- Write whole-file Markdown. Keep existing frontmatter keys; edit paragraph by paragraph so merges stay clean.
- Text like [SECRET_1a2b3c4d] is a masked secret. Keep placeholders unchanged; the server restores them.
- Some notes are hidden from you by the user's AI policy. Do not ask for them.`;

/** Build an MCP server bound to one authenticated agent. */
export function buildMcpServer(ctx: AppContext, ops: AgentOps, principal: Principal): McpServer {
  const server = new McpServer({ name: 'ganesya-ai-memo', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const agent = principal.agent;
  const caps = capabilities(principal);

  const wrap =
    <A>(fn: (args: A) => Promise<unknown>) =>
    async (args: A): Promise<ToolResult> => {
      try {
        return ok(await fn(args));
      } catch (e) {
        return fail(e);
      }
    };

  if (caps.canRead) {
    server.registerTool(
      'search_notes',
      {
        title: 'Search notes',
        description: 'Hybrid full-text + semantic search over the notes you may access. Returns paths, titles and snippets.',
        inputSchema: { query: z.string().describe('Search words or a question'), limit: z.number().int().min(1).max(50).optional() },
        annotations: { readOnlyHint: true },
      },
      wrap(async ({ query, limit }: { query: string; limit?: number }) => ops.search(agent, query, limit ?? 10)),
    );

    server.registerTool(
      'list_notes',
      {
        title: 'List notes',
        description: 'List notes (path, title, tags, last update), optionally inside a folder.',
        inputSchema: { folder: z.string().optional() },
        annotations: { readOnlyHint: true },
      },
      wrap(async ({ folder }: { folder?: string }) => (await ops.list(agent, folder)).slice(0, 500)),
    );

    server.registerTool(
      'read_note',
      {
        title: 'Read a note',
        description: 'Read the full Markdown of a note. Returns content plus sha/commit to pass back when writing.',
        inputSchema: { path: z.string().describe('e.g. "Projects/Plan.md"') },
        annotations: { readOnlyHint: true },
      },
      wrap(async ({ path }: { path: string }) => ops.read(agent, path)),
    );

    server.registerTool(
      'get_backlinks',
      {
        title: 'Backlinks',
        description: 'Notes that link to the given note with [[...]].',
        inputSchema: { path: z.string() },
        annotations: { readOnlyHint: true },
      },
      wrap(async ({ path }: { path: string }) => ops.backlinks(agent, path)),
    );

    server.registerTool(
      'query_view',
      {
        title: 'Query a database view',
        description: 'Run a saved view (table/kanban/calendar defined in .views/*.yaml) and return matching notes with their properties. Call without id to list views.',
        inputSchema: { id: z.string().optional() },
        annotations: { readOnlyHint: true },
      },
      wrap(async ({ id }: { id?: string }) => {
        const files = await ctx.notes.listViewFiles();
        if (!id) return files.map((f) => f.id);
        const f = files.find((v) => v.id === id);
        if (!f) throw new Error('view not found');
        const view = parseView(f.id, f.text);
        return ops.filter(agent, applyView(view, ctx.indexer.viewNotes()), (r) => r.path);
      }),
    );
  }

  if (caps.canPropose) {
    const changeSchema = z.object({
      path: z.string().describe('Note path ending in .md'),
      content: z.string().nullable().describe('Full new Markdown, or null to delete'),
    });
    server.registerTool(
      'propose_changes',
      {
        title: 'Propose changes',
        description:
          'Suggest edits to one or more notes as a single proposal for the user to review (like a pull request). Small tidy-ups may be auto-merged if the user allowed it.',
        inputSchema: {
          title: z.string().describe('Short summary of the change'),
          description: z.string().optional().describe('Why / what changed'),
          changes: z.array(changeSchema).min(1),
          base_shas: z.record(z.string(), z.string().nullable()).optional().describe('path → sha from read_note (null for new files)'),
        },
      },
      wrap(async (a: { title: string; description?: string; changes: { path: string; content: string | null }[]; base_shas?: Record<string, string | null> }) =>
        ops.write(principal, a.changes, {
          title: a.title,
          ...(a.description ? { description: a.description } : {}),
          ...(a.base_shas ? { baseShas: a.base_shas } : {}),
          mode: 'propose',
        }),
      ),
    );

    server.registerTool(
      'write_note',
      {
        title: 'Write a note',
        description: caps.canWriteDirect
          ? 'Create or replace a note. Commits directly when safe; becomes a proposal if the user is editing it or it changed since you read it.'
          : 'Create or replace a note. You do not have direct write access, so this becomes a proposal for review.',
        inputSchema: {
          path: z.string(),
          content: z.string(),
          base_sha: z.string().nullable().optional().describe('sha from read_note; null when creating a new note'),
          summary: z.string().optional(),
        },
      },
      wrap(async (a: { path: string; content: string; base_sha?: string | null; summary?: string }) =>
        ops.write(principal, [{ path: a.path, content: a.content }], {
          title: a.summary ?? `Update ${a.path}`,
          ...(a.base_sha !== undefined ? { baseShas: { [a.path]: a.base_sha } } : {}),
          mode: 'direct',
        }),
      ),
    );

    server.registerTool(
      'list_my_proposals',
      {
        title: 'My proposals',
        description: 'Your proposals and whether the user merged or rejected them.',
        inputSchema: { status: z.enum(['open', 'merged', 'rejected']).optional() },
        annotations: { readOnlyHint: true },
      },
      wrap(async ({ status }: { status?: 'open' | 'merged' | 'rejected' }) =>
        ops.proposals(agent, status).map((p) => ({ id: p.id, title: p.title, status: p.status, created_at: p.created_at })),
      ),
    );

    server.registerTool(
      'get_proposal',
      {
        title: 'Proposal status',
        description: 'Details of one of your proposals, including whether each file still merges cleanly.',
        inputSchema: { id: z.string() },
        annotations: { readOnlyHint: true },
      },
      wrap(async ({ id }: { id: string }) => ops.proposal(agent, id)),
    );
  }

  for (const plugin of ctx.plugins) {
    for (const tool of plugin.tools) {
      server.registerTool(
        `${plugin.name}_${tool.name}`.replace(/[^\w-]/g, '_').slice(0, 64),
        { description: tool.description, inputSchema: tool.inputSchema },
        wrap(async (args: Record<string, unknown>) => tool.handler(args, { agent })),
      );
    }
  }
  return server;
}

/** Handle one MCP HTTP request (stateless Streamable HTTP). */
export async function handleMcp(ctx: AppContext, ops: AgentOps, principal: Principal, req: Request): Promise<Response> {
  const server = buildMcpServer(ctx, ops, principal);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close();
  }
}
