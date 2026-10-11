import type { WorkspacePolicy } from '@gmemo/core';
import type { LensMemo } from '../ai/agent-lens.js';
import type { AuditEvent } from '../audit/audit.js';
import type { Agent } from '../auth/agents.js';
import { capabilities, type Principal } from '../auth/tokens.js';
import { ForbiddenError, NotFoundError, type SaveResult } from '../notes/service.js';
import type { Workspace } from '../workspace.js';
import { normalizeNotePath, publicFindingLabel } from './agent-ops-util.js';

/**
 * Operations as seen by an agent (shared by the REST API and the MCP server).
 * Applies folder limits, the per-folder AI policy and secret masking.
 */
export type AuditSink = (ev: Omit<AuditEvent, 'actor'> & { actor?: string }) => Promise<void>;

export class AgentOps {
  /** One lookup of the user's masked values per request. */
  private readonly memo: LensMemo = {};

  constructor(
    private readonly ws: Workspace,
    /** Records what agents read and write (paths and counts only, never content). */
    private readonly audit: AuditSink = async () => undefined,
  ) {}

  private record(agent: Agent, ev: Omit<AuditEvent, 'actor' | 'userId'>) {
    return this.audit({ ...ev, actor: `agent:${agent.id}`, userId: this.ws.userId });
  }

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
      await this.record(agent, {
        action: 'agent.read',
        outcome: 'denied',
        target: path,
        detail: { reason: 'folder-or-policy' },
      });
      throw new ForbiddenError(`${path} is not available to this agent (folder or AI policy)`);
    }
    const out = await this.ws.lens.outgoing(agent, doc.content, policy, this.memo);
    if (out.blocked) {
      await this.record(agent, {
        action: 'agent.read',
        outcome: 'denied',
        target: path,
        detail: { reason: 'sensitive', findings: publicFindingLabel(out.findings) },
      });
      throw new ForbiddenError(
        `${path} contains sensitive information (${publicFindingLabel(out.findings)}); blocked by policy`,
      );
    }
    await this.record(agent, {
      action: 'agent.read',
      target: path,
      detail: { agent: agent.name, location: agent.location, masked: out.findings.length },
    });
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
    // The query itself may contain private words: only the result paths are kept.
    await this.record(agent, {
      action: 'agent.search',
      detail: { agent: agent.name, results: hits.map((h) => h.path).slice(0, 30) },
    });
    return Promise.all(
      hits.map(async (h) => ({
        ...h,
        snippet: (await this.ws.lens.outgoing(agent, h.snippet, policy, this.memo)).text,
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
          context: (await this.ws.lens.outgoing(agent, b.context, policy, this.memo)).text,
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
    if (!caps.canPropose) {
      await this.record(principal.agent, {
        action: 'agent.write',
        outcome: 'denied',
        detail: { reason: 'read-only token', paths: changes.map((c) => c.path).slice(0, 30) },
      });
      throw new ForbiddenError('this token cannot write');
    }
    // Agents write only where they can read: existing notes by their frontmatter, new
    // notes and other files by folder limits and the folder's AI policy.
    const canSee = await this.visibility(principal.agent);
    for (const c of changes) {
      const path = normalizeNotePath(c.path, { requireMarkdown: false });
      if (!canSee(path)) throw new ForbiddenError(`${path} is not available to this agent`);
    }
    const restored = await Promise.all(
      changes.map(async (c) => ({
        path: c.path,
        content: c.content === null ? null : await this.ws.lens.incoming(c.content),
      })),
    );
    const result = await this.ws.notes.writeAsAgent(principal.agent, restored, {
      ...opts,
      mode: caps.canWriteDirect && opts.mode !== 'propose' ? 'direct' : 'propose',
    });
    await this.record(principal.agent, {
      action: 'agent.write',
      target: result.status === 'proposed' ? result.proposalId : null,
      detail: {
        agent: principal.agent.name,
        status: result.status,
        paths: changes.map((c) => c.path).slice(0, 30),
      },
    });
    return result;
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
