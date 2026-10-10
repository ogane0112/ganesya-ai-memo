import type { WorkspacePolicy } from '@gmemo/core';
import type { Agent } from '../auth/agents.js';
import { capabilities, type Principal } from '../auth/tokens.js';
import { ForbiddenError, NotFoundError, type SaveResult } from '../notes/service.js';
import type { Workspace } from '../workspace.js';
import { normalizeNotePath, publicFindingLabel } from './agent-ops-util.js';

/**
 * Operations as seen by an agent (shared by the REST API and the MCP server).
 * Applies folder limits, the per-folder AI policy and secret masking.
 */
export class AgentOps {
  constructor(private readonly ws: Workspace) {}

  private policy(): Promise<WorkspacePolicy> {
    return this.ws.notes.loadPolicy();
  }

  /** Visibility checker over the current index (one query for all paths). */
  async visibility(agent: Agent): Promise<(path: string) => boolean> {
    const policy = await this.policy();
    const meta = await this.ws.indexer.allMeta();
    return (path) => this.ws.lens.canSee(agent, path, meta.get(path) ?? null, policy);
  }

  async filter<T>(agent: Agent, items: T[], pathOf: (t: T) => string): Promise<T[]> {
    const canSee = await this.visibility(agent);
    return items.filter((i) => canSee(pathOf(i)));
  }

  async list(agent: Agent, folder?: string) {
    return this.filter(agent, await this.ws.indexer.listNotes(folder), (n) => n.path);
  }

  async read(agent: Agent, rawPath: string) {
    if (!agent.canRead) throw new ForbiddenError('agent cannot read');
    const path = normalizeNotePath(rawPath);
    const policy = await this.policy();
    const doc = await this.ws.notes.read(path);
    const meta = await this.ws.indexer.getMeta(path);
    if (!this.ws.lens.canSee(agent, path, meta?.frontmatter ?? null, policy)) {
      throw new ForbiddenError(`${path} is not available to this agent (folder or AI policy)`);
    }
    const out = await this.ws.lens.outgoing(agent, doc.content, policy);
    if (out.blocked) {
      throw new ForbiddenError(
        `${path} contains sensitive information (${publicFindingLabel(out.findings)}); blocked by policy`,
      );
    }
    return {
      path,
      content: out.text,
      sha: doc.sha,
      commit: doc.commit,
      maskedFindings: out.findings.length,
    };
  }

  async search(agent: Agent, query: string, limit = 20) {
    const policy = await this.policy();
    const canSee = await this.visibility(agent);
    const hits = (await this.ws.indexer.search(query, limit * 2))
      .filter((h) => canSee(h.path))
      .slice(0, limit);
    return Promise.all(
      hits.map(async (h) => ({
        ...h,
        snippet: (await this.ws.lens.outgoing(agent, h.snippet, policy)).text,
      })),
    );
  }

  async backlinks(agent: Agent, path: string) {
    const policy = await this.policy();
    const canSee = await this.visibility(agent);
    return Promise.all(
      (await this.ws.indexer.backlinks(normalizeNotePath(path)))
        .filter((b) => canSee(b.path))
        .map(async (b) => ({
          ...b,
          context: (await this.ws.lens.outgoing(agent, b.context, policy)).text,
        })),
    );
  }

  async write(
    principal: Principal,
    changes: { path: string; content: string | null }[],
    opts: {
      title: string;
      description?: string;
      baseShas?: Record<string, string | null>;
      baseCommit?: string;
      mode?: 'direct' | 'propose';
    },
  ): Promise<SaveResult> {
    const caps = capabilities(principal);
    if (!caps.canPropose) throw new ForbiddenError('this token cannot write');
    const canSee = await this.visibility(principal.agent);
    const meta = await this.ws.indexer.allMeta();
    for (const c of changes) {
      const path = normalizeNotePath(c.path, { requireMarkdown: false });
      if (meta.has(path) && !canSee(path))
        throw new ForbiddenError(`${path} is not available to this agent`);
    }
    const restored = await Promise.all(
      changes.map(async (c) => ({
        path: c.path,
        content: c.content === null ? null : await this.ws.lens.incoming(c.content),
      })),
    );
    return this.ws.notes.writeAsAgent(principal.agent, restored, {
      ...opts,
      mode: caps.canWriteDirect && opts.mode !== 'propose' ? 'direct' : 'propose',
    });
  }

  async proposals(agent: Agent, status?: 'open' | 'merged' | 'rejected') {
    return (await this.ws.notes.listProposals(status)).filter((p) => p.agent_id === agent.id);
  }

  async proposal(agent: Agent, id: string) {
    const p = await this.ws.notes.getProposal(id);
    if (p.agent_id !== agent.id) throw new NotFoundError('proposal not found');
    const files = await this.ws.notes.proposalFiles(id);
    return {
      proposal: p,
      files: files.map((f) => ({
        path: f.path,
        status: f.status,
        mainChanged: f.mainChanged,
        clean: f.merge?.clean ?? !f.deleteConflict,
      })),
    };
  }
}
