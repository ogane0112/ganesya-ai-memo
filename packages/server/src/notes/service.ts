import { EventEmitter } from 'node:events';
import {
  blameBlocks,
  type BlockAttribution,
  type Choice,
  diffOps,
  type FileVersion,
  inFolders,
  mergeNotes,
  normalizeNotePath,
  normalizePolicy,
  type NoteMergeResult,
  parseNoteLenient,
  renameLinks,
  renderMerge,
  type Resolution,
  serializeNote,
  splitBlocks,
  type WorkspacePolicy,
} from '@gmemo/core';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Agent } from '../auth/agents.js';
import { type DB, nowIso } from '../db/db.js';
import { type CommitInfo, type FileChange, MAIN, type NoteRepo, parseTrailers, TRAILER_AGENT, TRAILER_KIND, TRAILER_PROPOSAL } from '../git/repo.js';
import type { Indexer } from '../search/indexer.js';
import { randomId } from '../util/crypto.js';
import { type Actor, agentIdFromEmail, authorKindFromEmail, gitIdentity, type HumanActor } from './actor.js';

export const POLICY_PATH = '.gmemo/policy.yaml';
export const VIEWS_DIR = '.views';
const PROPOSAL_PREFIX = 'proposals/';

export class NotFoundError extends Error {}
export class ForbiddenError extends Error {}
export class ConflictError extends Error {
  constructor(
    message: string,
    readonly details: unknown,
  ) {
    super(message);
  }
}

export interface NoteDoc {
  path: string;
  content: string;
  /** Git blob id of the content; send it back as `baseSha` when saving. */
  sha: string;
  /** main commit the content was read from. */
  commit: string;
}

export type SaveResult =
  | { status: 'committed'; commit: string; sha: string; merged: boolean }
  | { status: 'unchanged'; commit: string; sha: string }
  | { status: 'proposed'; proposalId: string; reason: string; merged?: boolean; commit?: string };

export interface ProposalRow {
  id: string;
  agent_id: string | null;
  author_name: string;
  author_kind: 'ai' | 'human';
  source: string;
  branch: string;
  base_commit: string;
  title: string;
  description: string;
  status: 'open' | 'merged' | 'rejected';
  created_at: string;
  updated_at: string;
  merged_commit: string | null;
}

export interface ProposalFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  base: string | null;
  proposed: string | null;
  current: string | null;
  /** Main changed this file since the proposal was based. */
  mainChanged: boolean;
  /** Paragraph-level diff from base to proposed. */
  diff: ReturnType<typeof diffOps<string>>;
  merge: NoteMergeResult | null;
  /** Delete/modify clash that needs an explicit keep/delete choice. */
  deleteConflict: boolean;
}

export interface FileResolution extends Resolution {
  /** Skip this file entirely (keep main as is). */
  reject?: boolean;
  /** For delete/modify clashes: keep the file or delete it. */
  file?: 'keep' | 'delete';
}

export interface HistoryEntry {
  sha: string;
  date: string;
  author: string;
  authorKind: 'human' | 'ai' | 'system';
  agentId: string | null;
  subject: string;
  proposalId: string | null;
}

/**
 * All note reads and writes go through here. It decides between direct commits
 * and proposals, runs merges, and keeps the index in sync.
 */
export class NoteService {
  readonly events = new EventEmitter();
  /** path → expiry (ms) while the human has the note open in the editor. */
  private editing = new Map<string, number>();
  private policyCache: { commit: string; policy: WorkspacePolicy } | null = null;

  constructor(
    readonly repo: NoteRepo,
    private readonly db: DB,
    readonly index: Indexer,
    private readonly human: () => HumanActor,
  ) {
    this.events.setMaxListeners(100);
  }

  // ---- policy --------------------------------------------------------------

  /** Workspace policy lives in the repo at .gmemo/policy.yaml (cached per commit). */
  async loadPolicy(): Promise<WorkspacePolicy> {
    const head = (await this.repo.head(MAIN)) ?? '';
    if (this.policyCache?.commit === head) return this.policyCache.policy;
    const text = head ? await this.repo.readFile(head, POLICY_PATH) : null;
    let raw: unknown = {};
    try {
      raw = text ? parseYaml(text) : {};
    } catch {
      raw = {};
    }
    const policy = normalizePolicy(raw);
    this.policyCache = { commit: head, policy };
    return policy;
  }

  /** Synchronous accessor for the last loaded policy (used by the indexer). */
  currentPolicy(): WorkspacePolicy {
    return this.policyCache?.policy ?? normalizePolicy({});
  }

  async savePolicy(policy: WorkspacePolicy): Promise<void> {
    const text = `# Workspace AI policy. Edited from the settings screen.\n${stringifyYaml(policy)}`;
    await this.commitAs(this.human(), [{ path: POLICY_PATH, content: text }], 'Update AI policy');
    await this.loadPolicy();
  }

  // ---- editing presence ----------------------------------------------------

  markEditing(path: string, seconds = 45): void {
    this.editing.set(path, Date.now() + seconds * 1000);
  }

  stopEditing(path: string): void {
    this.editing.delete(path);
  }

  isHumanEditing(path: string): boolean {
    const until = this.editing.get(path);
    if (!until) return false;
    if (until < Date.now()) {
      this.editing.delete(path);
      return false;
    }
    return true;
  }

  // ---- basics --------------------------------------------------------------

  async init(): Promise<void> {
    await this.syncExternal();
    await this.loadPolicy();
    await this.index.sync();
  }

  /** Commit edits made in the working tree by other tools (Obsidian, editors…). */
  async syncExternal(): Promise<string[]> {
    return this.repo.lock.run(() => this.syncExternalLocked());
  }

  private async syncExternalLocked(): Promise<string[]> {
    const res = await this.repo.commitExternalChanges(gitIdentity(this.human()));
    if (!res) return [];
    await this.afterMainCommit(res.sha, res.paths);
    return res.paths;
  }

  private async afterMainCommit(commit: string, paths: string[]) {
    await this.index.updatePaths(paths, commit);
    if (paths.includes(POLICY_PATH)) await this.loadPolicy();
    this.events.emit('change', { commit, paths });
  }

  async head(): Promise<string> {
    const h = await this.repo.head(MAIN);
    if (!h) throw new Error('repository has no main branch');
    return h;
  }

  async read(path: string, ref: string = MAIN): Promise<NoteDoc> {
    const p = normalizeNotePath(path);
    const commit = (await this.repo.resolve(ref)) ?? (await this.head());
    const sha = await this.repo.blobId(commit, p);
    if (!sha) throw new NotFoundError(`note not found: ${p}`);
    const content = (await this.repo.readBlob(sha)) ?? '';
    return { path: p, content, sha, commit };
  }

  async exists(path: string): Promise<boolean> {
    return (await this.repo.blobId(MAIN, path)) !== null;
  }

  /** Low-level commit to main under the lock (external edits are committed first). */
  async commitAs(actor: Actor, changes: FileChange[], subject: string, opts: { extraParents?: string[]; trailers?: Record<string, string> } = {}): Promise<string> {
    return this.repo.lock.run(async () => {
      await this.syncExternalLocked();
      return this.commitLocked(actor, changes, subject, opts);
    });
  }

  private async commitLocked(actor: Actor, changes: FileChange[], subject: string, opts: { extraParents?: string[]; trailers?: Record<string, string> } = {}): Promise<string> {
    const before = await this.repo.head(MAIN);
    const sha = await this.repo.commit(MAIN, changes, gitIdentity(actor), commitMessage(actor, subject, opts.trailers), {
      ...(opts.extraParents ? { extraParents: opts.extraParents } : {}),
    });
    if (sha !== before) await this.afterMainCommit(sha, await this.changedPaths(before, sha));
    return sha;
  }

  private async changedPaths(from: string | null, to: string): Promise<string[]> {
    return (await this.repo.changedFiles(from, to)).map((c) => c.path);
  }

  // ---- human writes --------------------------------------------------------

  /**
   * Save a note as the human. `baseSha` is the blob the editor started from; if
   * main moved since (another device, an agent), the edit is merged
   * paragraph-by-paragraph. Unresolvable clashes become a proposal to review.
   */
  async saveAsHuman(path: string, content: string, opts: { baseSha?: string | null; baseCommit?: string; message?: string; device?: string } = {}): Promise<SaveResult> {
    const p = normalizeNotePath(path);
    const human = this.human();
    return this.repo.lock.run(async () => {
      await this.syncExternalLocked();
      const head = await this.head();
      const currentSha = await this.repo.blobId(head, p);
      let text = content;
      if (!currentSha && !opts.baseSha) text = withCreator(text, human);

      if (opts.baseSha !== undefined && (opts.baseSha ?? null) !== currentSha) {
        const base = opts.baseSha ? await this.repo.readBlob(opts.baseSha) : null;
        const current = currentSha ? await this.repo.readBlob(currentSha) : null;
        const merge = mergeNotes(base, current, text);
        if (!merge.clean || current === null) {
          const baseCommit = opts.baseCommit && (await this.repo.resolve(opts.baseCommit)) ? opts.baseCommit : await this.findCommitWithBlob(p, opts.baseSha ?? null, head);
          const id = await this.createProposalLocked(human, [{ path: p, content: text }], {
            baseCommit,
            title: `${opts.device ?? '別の端末'}での編集: ${p}`,
            description: '同じノートが他で更新されていたため、自動で統合できなかった部分の確認が必要です。',
            source: 'device',
          });
          return { status: 'proposed', proposalId: id, reason: current === null ? 'deleted-on-main' : 'conflict' };
        }
        text = merge.text;
      }
      if (currentSha && (await this.repo.hashContent(text)) === currentSha) return { status: 'unchanged', commit: head, sha: currentSha };
      const commit = await this.commitLocked(human, [{ path: p, content: text }], opts.message ?? `Update ${p}`);
      return { status: 'committed', commit, sha: (await this.repo.blobId(commit, p)) ?? '', merged: opts.baseSha !== undefined && (opts.baseSha ?? null) !== currentSha };
    });
  }

  /** Best effort: find the newest main commit where `path` had blob `sha`. */
  private async findCommitWithBlob(path: string, sha: string | null, head: string): Promise<string> {
    if (!sha) return head;
    for (const c of await this.repo.log(head, { path, limit: 200 })) {
      if ((await this.repo.blobId(c.sha, path)) === sha) return c.sha;
    }
    return head;
  }

  async deleteAsHuman(path: string): Promise<string> {
    const p = normalizeNotePath(path, { requireMarkdown: false });
    if (!(await this.exists(p))) throw new NotFoundError(`note not found: ${p}`);
    return this.commitAs(this.human(), [{ path: p, content: null }], `Delete ${p}`);
  }

  /** Rename a note and rewrite [[links]] that point at it, in one commit. */
  async rename(actor: Actor, from: string, to: string): Promise<string> {
    const src = normalizeNotePath(from);
    const dst = normalizeNotePath(to);
    return this.repo.lock.run(async () => {
      await this.syncExternalLocked();
      const head = await this.head();
      const content = await this.repo.readFile(head, src);
      if (content === null) throw new NotFoundError(`note not found: ${src}`);
      if (await this.repo.blobId(head, dst)) throw new ConflictError(`${dst} already exists`, null);
      const changes: FileChange[] = [
        { path: src, content: null },
        { path: dst, content },
      ];
      for (const b of this.index.backlinks(src)) {
        const text = await this.repo.readFile(head, b.path);
        if (text === null || b.path === src) continue;
        const { frontmatter, body, hasFrontmatter } = parseNoteLenient(text);
        const nb = renameLinks(body, src, dst);
        if (nb !== body) changes.push({ path: b.path, content: hasFrontmatter ? serializeNote(frontmatter, nb) : nb });
      }
      return this.commitLocked(actor, changes, `Rename ${src} → ${dst}`);
    });
  }

  /** Quick capture from phone / share sheet: append to today's inbox or create a note. */
  async capture(text: string, opts: { title?: string; folder?: string; actor?: Actor } = {}): Promise<{ path: string; commit: string }> {
    const actor = opts.actor ?? this.human();
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const folder = (opts.folder ?? 'Inbox').replace(/^\/+|\/+$/g, '');
    if (opts.title) {
      const base = `${folder}/${opts.title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim() || date}`;
      let path = `${base}.md`;
      for (let n = 2; await this.exists(path); n++) path = `${base} ${n}.md`;
      const content = withCreator(`# ${opts.title}\n\n${text.trim()}\n`, actor);
      const commit = await this.commitAs(actor, [{ path, content }], `Capture ${path}`);
      return { path, commit };
    }
    const path = `${folder}/${date}.md`;
    return this.repo.lock.run(async () => {
      await this.syncExternalLocked();
      const head = await this.head();
      const existing = await this.repo.readFile(head, path);
      const time = now.toTimeString().slice(0, 5);
      const entry = `- ${time} ${text.trim().replace(/\n/g, '\n  ')}\n`;
      const content = existing === null ? withCreator(`# ${date}\n\n${entry}`, actor) : existing.replace(/\n*$/, '\n') + entry;
      const commit = await this.commitLocked(actor, [{ path, content }], `Capture to ${path}`);
      return { path, commit };
    });
  }

  // ---- agent writes --------------------------------------------------------

  assertAgentCan(agent: Agent, action: 'read' | 'write', paths: string[]): void {
    if (agent.revokedAt) throw new ForbiddenError('agent revoked');
    if (action === 'read' && !agent.canRead) throw new ForbiddenError('agent cannot read');
    if (action === 'write' && agent.writeMode === 'none') throw new ForbiddenError('agent is read-only');
    for (const p of paths) {
      if (!inFolders(p, agent.folders)) throw new ForbiddenError(`agent has no access to ${p}`);
      if (p.startsWith('.gmemo/') && action === 'write') throw new ForbiddenError('agents cannot change workspace settings');
    }
  }

  /**
   * Write changes as an AI agent. With `direct` permission and no clash the
   * change goes straight to main; otherwise it becomes a proposal. A direct
   * write is downgraded to a proposal when the file changed since the agent
   * read it (`baseShas`) or the human currently has it open.
   */
  async writeAsAgent(
    agent: Agent,
    changes: FileChange[],
    opts: { title: string; description?: string; baseShas?: Record<string, string | null>; baseCommit?: string; mode?: 'direct' | 'propose' },
  ): Promise<SaveResult> {
    const normalized = changes.map((c) => ({ ...c, path: normalizeNotePath(c.path, { requireMarkdown: false }) }));
    this.assertAgentCan(agent, 'write', normalized.map((c) => c.path));
    const actor: Actor = { kind: 'ai', agentId: agent.id, name: agent.name };

    return this.repo.lock.run(async () => {
      await this.syncExternalLocked();
      const head = await this.head();
      const prepared: FileChange[] = [];
      for (const c of normalized) {
        const exists = (await this.repo.blobId(head, c.path)) !== null;
        prepared.push({ path: c.path, content: typeof c.content === 'string' && !exists && c.path.endsWith('.md') ? withCreator(c.content, actor) : c.content });
      }

      const wantsDirect = (opts.mode ?? (agent.writeMode === 'direct' ? 'direct' : 'propose')) === 'direct' && agent.writeMode === 'direct';
      if (wantsDirect) {
        let reason: string | null = null;
        for (const c of prepared) {
          if (this.isHumanEditing(c.path)) reason = `human is editing ${c.path}`;
          const expected = opts.baseShas?.[c.path];
          if (expected !== undefined && expected !== (await this.repo.blobId(head, c.path))) reason = `${c.path} changed since it was read`;
        }
        if (!reason) {
          const commit = await this.commitLocked(actor, prepared, opts.title);
          return { status: 'committed', commit, sha: '', merged: false };
        }
        const baseCommit = opts.baseCommit && (await this.repo.resolve(opts.baseCommit)) ? opts.baseCommit : await this.baseForShas(prepared, opts.baseShas, head);
        const id = await this.createProposalLocked(actor, prepared, { baseCommit, title: opts.title, description: opts.description ?? '', source: 'agent', agentId: agent.id });
        return { status: 'proposed', proposalId: id, reason };
      }

      const baseCommit = opts.baseCommit && (await this.repo.resolve(opts.baseCommit)) ? opts.baseCommit : await this.baseForShas(prepared, opts.baseShas, head);
      const id = await this.createProposalLocked(actor, prepared, { baseCommit, title: opts.title, description: opts.description ?? '', source: 'agent', agentId: agent.id });
      if (agent.autoMerge && prepared.every((c) => inFolders(c.path, agent.autoMergeFolders))) {
        const detail = await this.proposalFilesLocked(id);
        if (detail.every((f) => !f.deleteConflict && (f.merge?.clean ?? true)) && !prepared.some((c) => this.isHumanEditing(c.path))) {
          const commit = await this.mergeProposalLocked(id, {}, this.human());
          return { status: 'proposed', proposalId: id, reason: 'auto-merged', merged: true, commit };
        }
      }
      return { status: 'proposed', proposalId: id, reason: 'proposal' };
    });
  }

  private async baseForShas(changes: FileChange[], baseShas: Record<string, string | null> | undefined, head: string): Promise<string> {
    if (!baseShas) return head;
    for (const c of changes) {
      const sha = baseShas[c.path];
      if (sha !== undefined && sha !== (await this.repo.blobId(head, c.path))) return this.findCommitWithBlob(c.path, sha, head);
    }
    return head;
  }

  // ---- proposals -----------------------------------------------------------

  private async createProposalLocked(
    author: Actor,
    changes: FileChange[],
    opts: { baseCommit: string; title: string; description: string; source: string; agentId?: string },
  ): Promise<string> {
    const id = randomId('pr_');
    const branch = PROPOSAL_PREFIX + id;
    await this.repo.createBranch(branch, opts.baseCommit);
    const msg = commitMessage(author, opts.title, { [TRAILER_PROPOSAL]: id }, opts.description);
    await this.repo.commit(branch, changes, gitIdentity(author), msg, { allowEmpty: true });
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO proposals(id, agent_id, author_name, author_kind, source, branch, base_commit, title, description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(id, opts.agentId ?? null, author.name, author.kind, opts.source, branch, opts.baseCommit, opts.title.slice(0, 200), opts.description, now, now);
    this.events.emit('proposal', { id, status: 'open' });
    return id;
  }

  /** Add more changes to an open proposal (an agent iterating on its suggestion). */
  async amendProposal(agent: Agent, id: string, changes: FileChange[], message: string): Promise<void> {
    const p = this.getProposal(id);
    if (p.status !== 'open') throw new ConflictError('proposal is not open', null);
    if (p.agent_id !== agent.id) throw new ForbiddenError('not your proposal');
    const normalized = changes.map((c) => ({ ...c, path: normalizeNotePath(c.path, { requireMarkdown: false }) }));
    this.assertAgentCan(agent, 'write', normalized.map((c) => c.path));
    await this.repo.lock.run(async () => {
      await this.repo.commit(p.branch, normalized, gitIdentity({ kind: 'ai', agentId: agent.id, name: agent.name }), commitMessage({ kind: 'ai', agentId: agent.id, name: agent.name }, message, { [TRAILER_PROPOSAL]: id }));
      this.db.prepare('UPDATE proposals SET updated_at = ? WHERE id = ?').run(nowIso(), id);
    });
    this.events.emit('proposal', { id, status: 'open' });
  }

  listProposals(status?: ProposalRow['status']): ProposalRow[] {
    return (
      status
        ? this.db.prepare('SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC').all(status)
        : this.db.prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT 200').all()
    ) as ProposalRow[];
  }

  getProposal(id: string): ProposalRow {
    const row = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as ProposalRow | undefined;
    if (!row) throw new NotFoundError('proposal not found');
    return row;
  }

  async proposalFiles(id: string): Promise<ProposalFile[]> {
    return this.proposalFilesLocked(id);
  }

  private async proposalFilesLocked(id: string): Promise<ProposalFile[]> {
    const p = this.getProposal(id);
    const tip = p.status === 'open' ? await this.repo.head(p.branch) : null;
    const proposalHead = tip ?? (p.merged_commit ? (await this.repo.log(p.merged_commit, { limit: 1 }))[0]?.parents[1] ?? null : null);
    if (!proposalHead) return [];
    const main = await this.head();
    const files: ProposalFile[] = [];
    for (const ch of await this.repo.changedFiles(p.base_commit, proposalHead)) {
      const base = await this.repo.readFile(p.base_commit, ch.path);
      const proposed = await this.repo.readFile(proposalHead, ch.path);
      const current = p.status === 'open' ? await this.repo.readFile(main, ch.path) : base;
      const mainChanged = current !== base;
      const isText = ch.path.toLowerCase().endsWith('.md') || ch.path.endsWith('.yaml') || ch.path.endsWith('.txt');
      const deleteConflict = mainChanged && (proposed === null || current === null) && proposed !== current;
      const merge = isText && !deleteConflict && proposed !== null ? mergeNotes(base, current, proposed) : null;
      files.push({
        path: ch.path,
        status: base === null ? 'added' : proposed === null ? 'deleted' : 'modified',
        base,
        proposed,
        current,
        mainChanged,
        diff: diffOps(
          splitBlocks(base ?? '').map((b) => b.key),
          splitBlocks(proposed ?? '').map((b) => b.key),
        ),
        merge,
        deleteConflict,
      });
    }
    return files;
  }

  /**
   * Merge a proposal into main. Clean files merge automatically; conflicting
   * blocks/keys use `resolutions` (ours = main, theirs = proposal).
   */
  async mergeProposal(id: string, resolutions: Record<string, FileResolution> = {}): Promise<string> {
    return this.repo.lock.run(async () => {
      await this.syncExternalLocked();
      return this.mergeProposalLocked(id, resolutions, this.human());
    });
  }

  private async mergeProposalLocked(id: string, resolutions: Record<string, FileResolution>, _approver: HumanActor): Promise<string> {
    const p = this.getProposal(id);
    if (p.status !== 'open') throw new ConflictError('proposal is not open', null);
    const tip = await this.repo.head(p.branch);
    if (!tip) throw new NotFoundError('proposal branch missing');
    const files = await this.proposalFilesLocked(id);
    const changes: FileChange[] = [];
    const unresolved: { path: string; blocks: number[]; keys: string[]; file?: boolean }[] = [];

    for (const f of files) {
      const r = resolutions[f.path] ?? {};
      if (r.reject) continue;
      if (f.deleteConflict) {
        if (!r.file) unresolved.push({ path: f.path, blocks: [], keys: [], file: true });
        else changes.push({ path: f.path, content: r.file === 'delete' ? null : (f.proposed ?? f.current) });
        continue;
      }
      if (f.proposed === null) {
        changes.push({ path: f.path, content: null });
        continue;
      }
      if (!f.mainChanged) {
        changes.push({ path: f.path, content: (await this.repo.readRaw(tip, f.path)) ?? null });
        continue;
      }
      if (!f.merge) {
        // Binary or non-note file: proposal wins unless main also changed it.
        if (f.mainChanged && !r.file) unresolved.push({ path: f.path, blocks: [], keys: [], file: true });
        else if (r.file !== 'keep' || !f.mainChanged) {
          changes.push({ path: f.path, content: (await this.repo.readRaw(tip, f.path)) ?? null });
        }
        continue;
      }
      if (!f.merge.clean) {
        const missingBlocks = f.merge.segments.filter((s) => s.type === 'conflict' && r.blocks?.[s.index] === undefined).map((s) => (s.type === 'conflict' ? s.index : -1));
        const missingKeys = f.merge.frontmatterConflicts.filter((c) => r.frontmatter?.[c.key] === undefined).map((c) => c.key);
        if (missingBlocks.length || missingKeys.length) {
          unresolved.push({ path: f.path, blocks: missingBlocks, keys: missingKeys });
          continue;
        }
      }
      changes.push({ path: f.path, content: renderMerge(f.merge, r) });
    }
    if (unresolved.length) throw new ConflictError('proposal has unresolved conflicts', unresolved);

    const author: Actor = p.author_kind === 'ai' && p.agent_id ? { kind: 'ai', agentId: p.agent_id, name: p.author_name } : { kind: 'human', name: p.author_name };
    const commit = await this.commitLocked(author, changes, `Merge proposal: ${p.title}`, {
      extraParents: [tip],
      trailers: { [TRAILER_PROPOSAL]: p.id },
    });
    this.db.prepare(`UPDATE proposals SET status = 'merged', merged_commit = ?, updated_at = ? WHERE id = ?`).run(commit, nowIso(), id);
    await this.repo.deleteBranch(p.branch);
    this.events.emit('proposal', { id, status: 'merged' });
    return commit;
  }

  async rejectProposal(id: string): Promise<void> {
    const p = this.getProposal(id);
    if (p.status !== 'open') throw new ConflictError('proposal is not open', null);
    await this.repo.lock.run(async () => {
      this.db.prepare(`UPDATE proposals SET status = 'rejected', updated_at = ? WHERE id = ?`).run(nowIso(), id);
      // Keep the commit reachable for reference via a tag-like ref.
      const tip = await this.repo.head(p.branch);
      if (tip) await this.repo.createBranch(`rejected/${id}`, tip).catch(() => undefined);
      await this.repo.deleteBranch(p.branch);
    });
    this.events.emit('proposal', { id, status: 'rejected' });
  }

  // ---- history, blame, revert ---------------------------------------------

  async history(opts: { path?: string; limit?: number; agentId?: string } = {}): Promise<HistoryEntry[]> {
    const commits = await this.repo.log(MAIN, { ...(opts.path ? { path: normalizeNotePath(opts.path, { requireMarkdown: false }) } : {}), limit: opts.limit ?? 100, firstParent: true });
    return commits.map(toHistory).filter((h) => !opts.agentId || h.agentId === opts.agentId);
  }

  /** Paragraph-level attribution for coloring AI-written blocks. */
  async blame(path: string): Promise<BlockAttribution[]> {
    const p = normalizeNotePath(path);
    const commits = (await this.repo.log(MAIN, { path: p, limit: 300, firstParent: true })).reverse();
    const versions: FileVersion[] = [];
    for (const c of commits) {
      const kind = authorKindFromEmail(c.authorEmail);
      versions.push({
        text: await this.repo.readFile(c.sha, p),
        author: { kind: kind === 'ai' ? 'ai' : 'human', name: c.authorName },
        commit: c.sha,
        date: c.date,
      });
    }
    return blameBlocks(versions);
  }

  /**
   * Undo a main commit. Implemented as a proposal whose base is that commit and
   * whose content is the parent state, so later edits are preserved by the
   * normal three-way merge. Merged right away when clean.
   */
  async revertCommit(sha: string): Promise<SaveResult> {
    const human = this.human();
    return this.repo.lock.run(async () => {
      await this.syncExternalLocked();
      const [c] = await this.repo.log(sha, { limit: 1 });
      if (!c) throw new NotFoundError('commit not found');
      const parent = c.parents[0] ?? null;
      const changes: FileChange[] = [];
      for (const f of await this.repo.changedFiles(parent, c.sha)) {
        changes.push({ path: f.path, content: parent ? await this.repo.readRaw(parent, f.path) : null });
      }
      const id = await this.createProposalLocked(human, changes, { baseCommit: c.sha, title: `Revert: ${c.subject}`, description: `${c.sha.slice(0, 8)} を取り消します`, source: 'revert' });
      const files = await this.proposalFilesLocked(id);
      if (files.every((f) => !f.deleteConflict && (f.merge?.clean ?? !f.mainChanged))) {
        const commit = await this.mergeProposalLocked(id, {}, human);
        return { status: 'proposed', proposalId: id, reason: 'reverted', merged: true, commit };
      }
      return { status: 'proposed', proposalId: id, reason: 'revert needs review' };
    });
  }

  /** Revert every change an agent made on main (optionally since a date), newest first. */
  async revertAgent(agentId: string, since?: string): Promise<SaveResult[]> {
    const commits = (await this.repo.log(MAIN, { firstParent: true, limit: 1000 })).filter(
      (c) => agentIdFromEmail(c.authorEmail) === agentId && (!since || c.date >= since),
    );
    const results: SaveResult[] = [];
    for (const c of commits) results.push(await this.revertCommit(c.sha));
    return results;
  }

  // ---- views ---------------------------------------------------------------

  async listViewFiles(): Promise<{ id: string; text: string }[]> {
    const head = await this.head();
    const out: { id: string; text: string }[] = [];
    for (const f of await this.repo.listFiles(head)) {
      const m = new RegExp(`^${VIEWS_DIR}/([^/]+)\\.ya?ml$`).exec(f.path);
      if (m) out.push({ id: m[1]!, text: (await this.repo.readBlob(f.sha)) ?? '' });
    }
    return out;
  }

  async saveViewFile(id: string, text: string): Promise<void> {
    if (!/^[\w\-\u3000-\u9fff]+$/.test(id)) throw new ForbiddenError('invalid view id');
    await this.commitAs(this.human(), [{ path: `${VIEWS_DIR}/${id}.yaml`, content: text }], `Save view ${id}`);
  }

  async deleteViewFile(id: string): Promise<void> {
    if (!/^[\w\-\u3000-\u9fff]+$/.test(id)) throw new ForbiddenError('invalid view id');
    await this.commitAs(this.human(), [{ path: `${VIEWS_DIR}/${id}.yaml`, content: null }], `Delete view ${id}`);
  }
}

function toHistory(c: CommitInfo): HistoryEntry {
  const trailers = parseTrailers(c.body);
  return {
    sha: c.sha,
    date: c.date,
    author: c.authorName,
    authorKind: authorKindFromEmail(c.authorEmail),
    agentId: agentIdFromEmail(c.authorEmail),
    subject: c.subject,
    proposalId: trailers[TRAILER_PROPOSAL] ?? null,
  };
}

function commitMessage(actor: Actor, subject: string, trailers: Record<string, string> = {}, description = ''): string {
  const t: Record<string, string> = { [TRAILER_KIND]: actor.kind, ...trailers };
  if (actor.kind === 'ai') t[TRAILER_AGENT] = actor.name;
  const lines = Object.entries(t).map(([k, v]) => `${k}: ${v}`);
  return `${subject.replace(/\n/g, ' ').slice(0, 200)}\n\n${description ? description.trim() + '\n\n' : ''}${lines.join('\n')}\n`;
}

/** Record who created a note in its frontmatter (only when not already set). */
export function withCreator(text: string, actor: Actor): string {
  const parsed = parseNoteLenient(text);
  if (parsed.frontmatter['created_by'] !== undefined) return text;
  const fm: Record<string, unknown> = { ...parsed.frontmatter, created_by: actor.kind === 'ai' ? 'ai' : 'human' };
  if (actor.kind === 'ai') fm['ai_agent'] = actor.name;
  return serializeNote(fm, parsed.body);
}

export type { Choice };
