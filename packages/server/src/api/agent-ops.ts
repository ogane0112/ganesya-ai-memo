import { normalizeNotePath, publicFindingLabel } from './agent-ops-util.js';
import type { WorkspacePolicy } from '@gmemo/core';
import type { AgentLens } from '../ai/agent-lens.js';
import type { AppContext } from '../app.js';
import type { Agent } from '../auth/agents.js';
import { capabilities, type Principal } from '../auth/tokens.js';
import { ForbiddenError, NotFoundError, type SaveResult } from '../notes/service.js';

/**
 * Operations as seen by an agent (shared by the REST API and the MCP server).
 * Applies folder limits, the per-folder AI policy and secret masking.
 */
export class AgentOps {
  constructor(
    private readonly ctx: AppContext,
    readonly lens: AgentLens,
  ) {}

  private policy(): Promise<WorkspacePolicy> {
    return this.ctx.notes.loadPolicy();
  }

  canSeeSync(agent: Agent, path: string, policy: WorkspacePolicy): boolean {
    return this.lens.canSee(agent, path, this.ctx.indexer.getMeta(path)?.frontmatter ?? null, policy);
  }

  async filter<T>(agent: Agent, items: T[], pathOf: (t: T) => string): Promise<T[]> {
    const policy = await this.policy();
    return items.filter((i) => this.canSeeSync(agent, pathOf(i), policy));
  }

  async list(agent: Agent, folder?: string) {
    return this.filter(agent, this.ctx.indexer.listNotes(folder), (n) => n.path);
  }

  async read(agent: Agent, rawPath: string) {
    if (!agent.canRead) throw new ForbiddenError('agent cannot read');
    const path = normalizeNotePath(rawPath);
    const policy = await this.policy();
    const doc = await this.ctx.notes.read(path);
    const meta = this.ctx.indexer.getMeta(path);
    if (!this.lens.canSee(agent, path, meta?.frontmatter ?? null, policy)) {
      throw new ForbiddenError(`${path} is not available to this agent (folder or AI policy)`);
    }
    const out = this.lens.outgoing(agent, doc.content, policy);
    if (out.blocked) {
      throw new ForbiddenError(`${path} contains sensitive information (${publicFindingLabel(out.findings)}); blocked by policy`);
    }
    return { path, content: out.text, sha: doc.sha, commit: doc.commit, maskedFindings: out.findings.length };
  }

  async search(agent: Agent, query: string, limit = 20) {
    const policy = await this.policy();
    const hits = (await this.ctx.indexer.search(query, limit * 2)).filter((h) => this.canSeeSync(agent, h.path, policy)).slice(0, limit);
    return hits.map((h) => ({ ...h, snippet: this.lens.outgoing(agent, h.snippet, policy).text }));
  }

  async backlinks(agent: Agent, path: string) {
    const policy = await this.policy();
    return this.ctx.indexer
      .backlinks(normalizeNotePath(path))
      .filter((b) => this.canSeeSync(agent, b.path, policy))
      .map((b) => ({ ...b, context: this.lens.outgoing(agent, b.context, policy).text }));
  }

  async write(
    principal: Principal,
    changes: { path: string; content: string | null }[],
    opts: { title: string; description?: string; baseShas?: Record<string, string | null>; baseCommit?: string; mode?: 'direct' | 'propose' },
  ): Promise<SaveResult> {
    const caps = capabilities(principal);
    if (!caps.canPropose) throw new ForbiddenError('this token cannot write');
    const policy = await this.policy();
    for (const c of changes) {
      const path = normalizeNotePath(c.path, { requireMarkdown: false });
      const exists = this.ctx.indexer.getMeta(path) !== null;
      if (exists && !this.canSeeSync(principal.agent, path, policy)) throw new ForbiddenError(`${path} is not available to this agent`);
    }
    const restored = changes.map((c) => ({ path: c.path, content: c.content === null ? null : this.lens.incoming(c.content) }));
    return this.ctx.notes.writeAsAgent(principal.agent, restored, {
      ...opts,
      mode: caps.canWriteDirect && opts.mode !== 'propose' ? 'direct' : 'propose',
    });
  }

  proposals(agent: Agent, status?: 'open' | 'merged' | 'rejected') {
    return this.ctx.notes.listProposals(status).filter((p) => p.agent_id === agent.id);
  }

  async proposal(agent: Agent, id: string) {
    const p = this.ctx.notes.getProposal(id);
    if (p.agent_id !== agent.id) throw new NotFoundError('proposal not found');
    const files = await this.ctx.notes.proposalFiles(id);
    return {
      proposal: p,
      files: files.map((f) => ({ path: f.path, status: f.status, mainChanged: f.mainChanged, clean: f.merge?.clean ?? !f.deleteConflict })),
    };
  }
}
