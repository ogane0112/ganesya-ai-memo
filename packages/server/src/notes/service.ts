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
import { type Db, nowIso } from '../db/db.js';
import {
  type ChangedFile,
  type CommitInfo,
  ConcurrentUpdateError,
  type FileChange,
  MAIN,
  type NoteStore,
  parseTrailers,
  TRAILER_AGENT,
  TRAILER_KIND,
  TRAILER_PROPOSAL,
} from '../store/types.js';
import type { Indexer } from '../search/indexer.js';
import { randomId } from '../util/crypto.js';
import {
  type Actor,
  agentIdFromEmail,
  authorKindFromEmail,
  gitIdentity,
  type HumanActor,
} from './actor.js';

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
  /** For delete/modify clashes: keep the file or delete it. For binary clashes: 'keep' = main, 'theirs' = proposal. */
  file?: 'keep' | 'delete' | 'theirs';
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

/** How many times a write is recomputed when main moved underneath it. */
const MAX_ATTEMPTS = 5;

/**
 * All of one user's note reads and writes go through here. It decides between
 * direct commits and proposals, runs merges, and keeps the index in sync.
 *
 * There is no lock: every commit names the head it was computed against, the
 * store refuses it if main moved (compare-and-swap), and the write is
 * recomputed on top of the new head.
 */
export class NoteService {
  private policyCache: { commit: string; policy: WorkspacePolicy } | null = null;
  /**
   * The head this instance last saw with the index in step. A write that follows
   * a read within the same request starts from it instead of asking again; if
   * main moved in between, the compare-and-swap refuses the commit and the retry
   * reads the real head.
   */
  private seen: { head: string; at: number } | null = null;

  constructor(
    readonly store: NoteStore,
    private readonly db: Db,
    readonly userId: string,
    readonly index: Indexer,
    private readonly humanActor: HumanActor,
    private readonly opts: { checkSeconds: number } = { checkSeconds: 30 },
  ) {}

  human(): HumanActor {
    return this.humanActor;
  }

  /** Cheap stores are deep-walked; GitHub costs one request per step. */
  private get cheap(): boolean {
    return this.store.kind === 'builtin';
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof ConcurrentUpdateError) || attempt >= MAX_ATTEMPTS) throw e;
        await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 30));
      }
    }
  }

  // ---- policy --------------------------------------------------------------

  /** Workspace policy lives in the notes at .gmemo/policy.yaml (cached per commit). */
  async loadPolicy(head?: string): Promise<WorkspacePolicy> {
    const h = head ?? (await this.currentHead());
    if (this.policyCache?.commit === h) return this.policyCache.policy;
    const text = h ? await this.store.readFile(h, POLICY_PATH) : null;
    let raw: unknown = {};
    try {
      raw = text ? parseYaml(text) : {};
    } catch {
      raw = {};
    }
    const policy = normalizePolicy(raw);
    this.policyCache = { commit: h, policy };
    return policy;
  }

  /** Synchronous accessor for the last loaded policy (used by the indexer). */
  currentPolicy(): WorkspacePolicy {
    return this.policyCache?.policy ?? normalizePolicy({});
  }

  async savePolicy(policy: WorkspacePolicy): Promise<void> {
    const text = `# Workspace AI policy. Edited from the settings screen.\n${stringifyYaml(policy)}`;
    await this.commitAs(this.human(), [{ path: POLICY_PATH, content: text }], 'Update AI policy');
  }

  // ---- editing presence ----------------------------------------------------

  async markEditing(path: string, seconds = 45): Promise<void> {
    await this.db.run(
      `INSERT INTO editing(user_id, path, until) VALUES (?, ?, ?)
       ON CONFLICT(user_id, path) DO UPDATE SET until = excluded.until`,
      this.userId,
      path,
      new Date(Date.now() + seconds * 1000).toISOString(),
    );
  }

  async stopEditing(path: string): Promise<void> {
    await this.db.run('DELETE FROM editing WHERE user_id = ? AND path = ?', this.userId, path);
  }

  async isHumanEditing(path: string): Promise<boolean> {
    const r = await this.db.first<{ until: string }>(
      'SELECT until FROM editing WHERE user_id = ? AND path = ?',
      this.userId,
      path,
    );
    return !!r && r.until > nowIso();
  }

  // ---- basics --------------------------------------------------------------

  async init(): Promise<void> {
    await this.store.init();
    const head = await this.head();
    await this.index.sync(head);
    await this.loadPolicy(head);
  }

  /** Authoritative head of main (always asks the store). */
  async head(): Promise<string> {
    const h = await this.store.head(MAIN);
    if (h) return h;
    // A new account (or an emptied repository): create the first commit. Parallel
    // first requests race here; the loser simply reads the winner's commit.
    await this.store.init().catch((e: unknown) => {
      if (!(e instanceof ConcurrentUpdateError)) throw e;
    });
    const created = await this.store.head(MAIN);
    if (!created) throw new NotFoundError('ノートを初期化できませんでした');
    return created;
  }

  /**
   * Head for reads, with the index brought up to date. GitHub repositories can
   * change outside the app, so they are re-checked every `checkSeconds`.
   */
  async currentHead(): Promise<string> {
    // The built-in store always needs both answers: ask for them together.
    const [state, stored] = await Promise.all([
      this.index.state(),
      this.cheap ? this.store.head(MAIN) : null,
    ]);
    if (
      !this.cheap &&
      state.commit &&
      state.checkedAt &&
      Date.now() - Date.parse(state.checkedAt) < this.opts.checkSeconds * 1000
    )
      return state.commit;
    const head = stored ?? (await this.head());
    if (head !== state.commit) await this.index.sync(head);
    else if (!this.cheap) await this.index.touch();
    if (this.cheap) this.seen = { head, at: Date.now() };
    return head;
  }

  /** The head from a read moments ago (see `seen`), or null to ask the store. */
  private recentHead(): string | null {
    return this.seen && Date.now() - this.seen.at < 2000 ? this.seen.head : null;
  }

  /** Index and policy follow-up after this service moved main from `parent` to `commit`. */
  private async afterMainCommit(parent: string | null, commit: string, changed: ChangedFile[]) {
    const paths = changed.map((c) => c.path);
    const inStep = parent !== null && this.recentHead() === parent;
    this.seen = null;
    if (inStep || (await this.index.state()).commit === parent) {
      // Only edits to existing notes: no link can start or stop resolving.
      const samePaths = changed.every(
        (c) => c.status === 'M' || !c.path.toLowerCase().endsWith('.md'),
      );
      await this.index.updatePaths(paths, commit, nowIso(), { samePaths });
    } else await this.index.sync(commit);
    if (this.cheap) this.seen = { head: commit, at: Date.now() };
    if (paths.includes(POLICY_PATH)) await this.loadPolicy(commit);
  }

  async read(path: string, ref?: string): Promise<NoteDoc> {
    const p = normalizeNotePath(path);
    const commit =
      ref && ref !== MAIN
        ? ((await this.store.resolve(ref)) ?? (await this.currentHead()))
        : await this.currentHead();
    const sha = await this.store.blobId(commit, p);
    if (!sha) throw new NotFoundError(`note not found: ${p}`);
    const content = (await this.store.readBlob(sha)) ?? '';
    return { path: p, content, sha, commit };
  }

  async readRaw(path: string): Promise<Uint8Array | null> {
    return this.store.readRaw(await this.currentHead(), path);
  }

  async exists(path: string, head?: string): Promise<boolean> {
    return (await this.store.blobId(head ?? (await this.currentHead()), path)) !== null;
  }

  /** Commit to main as `actor`, recomputed if main moves concurrently. */
  async commitAs(
    actor: Actor,
    changes: FileChange[] | ((head: string) => Promise<FileChange[]>),
    subject: string,
    opts: { extraParents?: string[]; trailers?: Record<string, string> } = {},
  ): Promise<string> {
    return this.retry(async () => {
      const head = await this.head();
      const list = typeof changes === 'function' ? await changes(head) : changes;
      return this.commitOn(head, actor, list, subject, opts);
    });
  }

  /** One compare-and-swap commit on top of `head`. Throws ConcurrentUpdateError if main moved. */
  private async commitOn(
    head: string,
    actor: Actor,
    changes: FileChange[],
    subject: string,
    opts: { extraParents?: string[]; trailers?: Record<string, string> } = {},
  ): Promise<string> {
    const sha = await this.store.commit(
      MAIN,
      changes,
      gitIdentity(actor),
      commitMessage(actor, subject, opts.trailers),
      {
        parent: head,
        current: head,
        ...(opts.extraParents ? { extraParents: opts.extraParents } : {}),
      },
    );
    if (sha !== head)
      await this.afterMainCommit(head, sha, await this.store.changedFiles(head, sha));
    return sha;
  }

  // ---- human writes --------------------------------------------------------

  /**
   * Save a note as the human. `baseSha` is the blob the editor started from; if
   * main moved since (another device, an agent), the edit is merged
   * paragraph-by-paragraph. Unresolvable clashes become a proposal to review.
   */
  async saveAsHuman(
    path: string,
    content: string,
    opts: { baseSha?: string | null; baseCommit?: string; message?: string; device?: string } = {},
  ): Promise<SaveResult> {
    const p = normalizeNotePath(path);
    const human = this.human();
    let first = true;
    return this.retry(async () => {
      const head = (first ? this.recentHead() : null) ?? (await this.head());
      first = false;
      const currentSha = await this.store.blobId(head, p);
      let text = content;
      if (!currentSha && !opts.baseSha) text = withCreator(text, human);

      const diverged = opts.baseSha !== undefined && (opts.baseSha ?? null) !== currentSha;
      if (diverged) {
        const base = opts.baseSha ? await this.store.readBlob(opts.baseSha) : null;
        const current = currentSha ? await this.store.readBlob(currentSha) : null;
        const merge = mergeNotes(base, current, text);
        if (!merge.clean || current === null) {
          const baseCommit =
            opts.baseCommit && (await this.store.resolve(opts.baseCommit))
              ? opts.baseCommit
              : await this.findCommitWithBlob(p, opts.baseSha ?? null, head);
          const id = await this.createProposal(human, [{ path: p, content: text }], {
            baseCommit,
            title: `${opts.device ?? '別の端末'}での編集: ${p}`,
            description:
              '同じノートが他で更新されていたため、自動で統合できなかった部分の確認が必要です。',
            source: 'device',
          });
          return {
            status: 'proposed',
            proposalId: id,
            reason: current === null ? 'deleted-on-main' : 'conflict',
          };
        }
        text = merge.text;
      }
      if (currentSha && (await this.store.hashContent(text)) === currentSha)
        return { status: 'unchanged', commit: head, sha: currentSha };
      const commit = await this.commitOn(
        head,
        human,
        [{ path: p, content: text }],
        opts.message ?? `Update ${p}`,
      );
      return {
        status: 'committed',
        commit,
        sha: await this.store.hashContent(text),
        merged: diverged,
      };
    });
  }

  /** Best effort: find the newest main commit where `path` had blob `sha`. */
  private async findCommitWithBlob(
    path: string,
    sha: string | null,
    head: string,
  ): Promise<string> {
    if (!sha) return head;
    for (const c of await this.store.log(head, { path, limit: this.cheap ? 200 : 15 })) {
      if ((await this.store.blobId(c.sha, path)) === sha) return c.sha;
    }
    return head;
  }

  async deleteAsHuman(path: string): Promise<string> {
    const p = normalizeNotePath(path, { requireMarkdown: false });
    return this.commitAs(
      this.human(),
      async (head) => {
        if (!(await this.exists(p, head))) throw new NotFoundError(`note not found: ${p}`);
        return [{ path: p, content: null }];
      },
      `Delete ${p}`,
    );
  }

  /** Rename a note and rewrite [[links]] that point at it, in one commit. */
  async rename(actor: Actor, from: string, to: string): Promise<string> {
    const src = normalizeNotePath(from);
    const dst = normalizeNotePath(to);
    return this.commitAs(
      actor,
      async (head) => {
        const content = await this.store.readFile(head, src);
        if (content === null) throw new NotFoundError(`note not found: ${src}`);
        if (await this.store.blobId(head, dst))
          throw new ConflictError(`${dst} already exists`, null);
        const changes: FileChange[] = [
          { path: src, content: null },
          { path: dst, content },
        ];
        for (const b of await this.index.backlinks(src)) {
          const text = await this.store.readFile(head, b.path);
          if (text === null || b.path === src) continue;
          const { frontmatter, body, hasFrontmatter } = parseNoteLenient(text);
          const nb = renameLinks(body, src, dst);
          if (nb !== body)
            changes.push({
              path: b.path,
              content: hasFrontmatter ? serializeNote(frontmatter, nb) : nb,
            });
        }
        return changes;
      },
      `Rename ${src} → ${dst}`,
    );
  }

  /** Quick capture from phone / share sheet: append to today's inbox or create a note. */
  async capture(
    text: string,
    opts: { title?: string; folder?: string; actor?: Actor; timeZone?: string } = {},
  ): Promise<{ path: string; commit: string }> {
    const actor = opts.actor ?? this.human();
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: opts.timeZone ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const part = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
    const date = `${part('year')}-${part('month')}-${part('day')}`;
    const time = `${part('hour')}:${part('minute')}`;
    const folder = (opts.folder ?? 'Inbox').replace(/^\/+|\/+$/g, '');
    // Same rules as note paths (no "..", no .git, no control characters).
    normalizeNotePath(`${folder}/x.md`);
    let path = '';
    if (opts.title) {
      const base = `${folder}/${opts.title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim() || date}`;
      const content = withCreator(`# ${opts.title}\n\n${text.trim()}\n`, actor);
      const commit = await this.commitAs(
        actor,
        async (head) => {
          path = `${base}.md`;
          for (let n = 2; await this.exists(path, head); n++) path = `${base} ${n}.md`;
          return [{ path, content }];
        },
        `Capture ${base}`,
      );
      return { path, commit };
    }
    path = `${folder}/${date}.md`;
    const entry = `- ${time} ${text.trim().replace(/\n/g, '\n  ')}\n`;
    const commit = await this.commitAs(
      actor,
      async (head) => {
        const existing = await this.store.readFile(head, path);
        const content =
          existing === null
            ? withCreator(`# ${date}\n\n${entry}`, actor)
            : existing.replace(/\n*$/, '\n') + entry;
        return [{ path, content }];
      },
      `Capture to ${path}`,
    );
    return { path, commit };
  }

  // ---- agent writes --------------------------------------------------------

  assertAgentCan(agent: Agent, action: 'read' | 'write', paths: string[]): void {
    if (agent.revokedAt) throw new ForbiddenError('agent revoked');
    if (action === 'read' && !agent.canRead) throw new ForbiddenError('agent cannot read');
    if (action === 'write' && agent.writeMode === 'none')
      throw new ForbiddenError('agent is read-only');
    for (const p of paths) {
      if (!inFolders(p, agent.folders)) throw new ForbiddenError(`agent has no access to ${p}`);
      if (p.startsWith('.gmemo/') && action === 'write')
        throw new ForbiddenError('agents cannot change workspace settings');
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
    opts: {
      title: string;
      description?: string;
      baseShas?: Record<string, string | null>;
      baseCommit?: string;
      mode?: 'direct' | 'propose';
    },
  ): Promise<SaveResult> {
    const normalized = changes.map((c) => ({
      ...c,
      path: normalizeNotePath(c.path, { requireMarkdown: false }),
    }));
    this.assertAgentCan(
      agent,
      'write',
      normalized.map((c) => c.path),
    );
    const actor: Actor = { kind: 'ai', agentId: agent.id, name: agent.name };
    const wantsDirect =
      (opts.mode ?? (agent.writeMode === 'direct' ? 'direct' : 'propose')) === 'direct' &&
      agent.writeMode === 'direct';

    const prepare = async (head: string) => {
      const prepared: FileChange[] = [];
      for (const c of normalized) {
        const exists = (await this.store.blobId(head, c.path)) !== null;
        prepared.push({
          path: c.path,
          content:
            typeof c.content === 'string' && !exists && c.path.endsWith('.md')
              ? withCreator(c.content, actor)
              : c.content,
        });
      }
      return prepared;
    };
    const propose = async (head: string, prepared: FileChange[]) => {
      const baseCommit =
        opts.baseCommit && (await this.store.resolve(opts.baseCommit))
          ? opts.baseCommit
          : await this.baseForShas(prepared, opts.baseShas, head);
      return this.createProposal(actor, prepared, {
        baseCommit,
        title: opts.title,
        description: opts.description ?? '',
        source: 'agent',
        agentId: agent.id,
      });
    };

    if (wantsDirect) {
      const res = await this.retry(
        async (): Promise<
          SaveResult | { reason: string; head: string; prepared: FileChange[] }
        > => {
          const head = await this.head();
          const prepared = await prepare(head);
          let reason: string | null = null;
          for (const c of prepared) {
            if (await this.isHumanEditing(c.path)) reason = `human is editing ${c.path}`;
            const expected = opts.baseShas?.[c.path];
            if (expected !== undefined && expected !== (await this.store.blobId(head, c.path)))
              reason = `${c.path} changed since it was read`;
          }
          if (reason) return { reason, head, prepared };
          const commit = await this.commitOn(head, actor, prepared, opts.title);
          return { status: 'committed', commit, sha: '', merged: false };
        },
      );
      if ('status' in res) return res;
      const id = await propose(res.head, res.prepared);
      return { status: 'proposed', proposalId: id, reason: res.reason };
    }

    const head = await this.head();
    const prepared = await prepare(head);
    const id = await propose(head, prepared);
    if (agent.autoMerge && prepared.every((c) => inFolders(c.path, agent.autoMergeFolders))) {
      const detail = await this.proposalFiles(id);
      let editing = false;
      for (const c of prepared) if (await this.isHumanEditing(c.path)) editing = true;
      if (detail.every((f) => !f.deleteConflict && (f.merge?.clean ?? true)) && !editing) {
        try {
          const commit = await this.mergeProposal(id, {});
          return {
            status: 'proposed',
            proposalId: id,
            reason: 'auto-merged',
            merged: true,
            commit,
          };
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e;
        }
      }
    }
    return { status: 'proposed', proposalId: id, reason: 'proposal' };
  }

  private async baseForShas(
    changes: FileChange[],
    baseShas: Record<string, string | null> | undefined,
    head: string,
  ): Promise<string> {
    if (!baseShas) return head;
    for (const c of changes) {
      const sha = baseShas[c.path];
      if (sha !== undefined && sha !== (await this.store.blobId(head, c.path)))
        return this.findCommitWithBlob(c.path, sha, head);
    }
    return head;
  }

  // ---- proposals -----------------------------------------------------------

  private async createProposal(
    author: Actor,
    changes: FileChange[],
    opts: {
      baseCommit: string;
      title: string;
      description: string;
      source: string;
      agentId?: string;
    },
  ): Promise<string> {
    const id = randomId('pr_');
    const branch = PROPOSAL_PREFIX + id;
    await this.store.createBranch(branch, opts.baseCommit);
    const msg = commitMessage(author, opts.title, { [TRAILER_PROPOSAL]: id }, opts.description);
    await this.store.commit(branch, changes, gitIdentity(author), msg, { allowEmpty: true });
    const now = nowIso();
    await this.db.run(
      `INSERT INTO proposals(id, user_id, agent_id, author_name, author_kind, source, branch, base_commit, title, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      id,
      this.userId,
      opts.agentId ?? null,
      author.name,
      author.kind,
      opts.source,
      branch,
      opts.baseCommit,
      opts.title.slice(0, 200),
      opts.description,
      now,
      now,
    );
    return id;
  }

  /** Add more changes to an open proposal (an agent iterating on its suggestion). */
  async amendProposal(
    agent: Agent,
    id: string,
    changes: FileChange[],
    message: string,
  ): Promise<void> {
    const p = await this.getProposal(id);
    if (p.status !== 'open') throw new ConflictError('proposal is not open', null);
    if (p.agent_id !== agent.id) throw new ForbiddenError('not your proposal');
    const normalized = changes.map((c) => ({
      ...c,
      path: normalizeNotePath(c.path, { requireMarkdown: false }),
    }));
    this.assertAgentCan(
      agent,
      'write',
      normalized.map((c) => c.path),
    );
    const actor: Actor = { kind: 'ai', agentId: agent.id, name: agent.name };
    await this.retry(() =>
      this.store.commit(
        p.branch,
        normalized,
        gitIdentity(actor),
        commitMessage(actor, message, { [TRAILER_PROPOSAL]: id }),
      ),
    );
    await this.db.run(
      'UPDATE proposals SET updated_at = ? WHERE id = ? AND user_id = ?',
      nowIso(),
      id,
      this.userId,
    );
  }

  async listProposals(status?: ProposalRow['status']): Promise<ProposalRow[]> {
    return status
      ? this.db.all<ProposalRow>(
          'SELECT * FROM proposals WHERE user_id = ? AND status = ? ORDER BY created_at DESC',
          this.userId,
          status,
        )
      : this.db.all<ProposalRow>(
          'SELECT * FROM proposals WHERE user_id = ? ORDER BY created_at DESC LIMIT 200',
          this.userId,
        );
  }

  async openProposalCount(): Promise<number> {
    return (
      (
        await this.db.first<{ n: number }>(
          `SELECT COUNT(*) AS n FROM proposals WHERE user_id = ? AND status = 'open'`,
          this.userId,
        )
      )?.n ?? 0
    );
  }

  async getProposal(id: string): Promise<ProposalRow> {
    const row = await this.db.first<ProposalRow>(
      'SELECT * FROM proposals WHERE id = ? AND user_id = ?',
      id,
      this.userId,
    );
    if (!row) throw new NotFoundError('proposal not found');
    return row;
  }

  async proposalFiles(id: string, mainHead?: string): Promise<ProposalFile[]> {
    const p = await this.getProposal(id);
    const tip = p.status === 'open' ? await this.store.head(p.branch) : null;
    const proposalHead =
      tip ??
      (p.merged_commit
        ? ((await this.store.log(p.merged_commit, { limit: 1 }))[0]?.parents[1] ?? null)
        : null);
    if (!proposalHead) return [];
    const main = mainHead ?? (await this.head());
    const files: ProposalFile[] = [];
    for (const ch of await this.store.changedFiles(p.base_commit, proposalHead)) {
      const base = await this.store.readFile(p.base_commit, ch.path);
      const proposed = await this.store.readFile(proposalHead, ch.path);
      const current = p.status === 'open' ? await this.store.readFile(main, ch.path) : base;
      const mainChanged = current !== base;
      const isText =
        ch.path.toLowerCase().endsWith('.md') ||
        ch.path.endsWith('.yaml') ||
        ch.path.endsWith('.txt');
      const deleteConflict =
        mainChanged && (proposed === null || current === null) && proposed !== current;
      const merge =
        isText && !deleteConflict && proposed !== null ? mergeNotes(base, current, proposed) : null;
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
  async mergeProposal(
    id: string,
    resolutions: Record<string, FileResolution> = {},
  ): Promise<string> {
    const commit = await this.retry(async () => {
      const p = await this.getProposal(id);
      if (p.status !== 'open') throw new ConflictError('proposal is not open', null);
      const tip = await this.store.head(p.branch);
      if (!tip) throw new NotFoundError('proposal branch missing');
      const head = await this.head();
      const files = await this.proposalFiles(id, head);
      const changes: FileChange[] = [];
      const unresolved: { path: string; blocks: number[]; keys: string[]; file?: boolean }[] = [];

      for (const f of files) {
        const r = resolutions[f.path] ?? {};
        if (r.reject) continue;
        if (f.deleteConflict) {
          if (!r.file) unresolved.push({ path: f.path, blocks: [], keys: [], file: true });
          else
            changes.push({
              path: f.path,
              content:
                r.file === 'delete'
                  ? null
                  : r.file === 'theirs'
                    ? f.proposed
                    : (f.proposed ?? f.current),
            });
          continue;
        }
        if (f.proposed === null) {
          changes.push({ path: f.path, content: null });
          continue;
        }
        if (!f.mainChanged) {
          changes.push({ path: f.path, content: (await this.store.readRaw(tip, f.path)) ?? null });
          continue;
        }
        if (!f.merge) {
          // Binary or non-note file: proposal wins unless main also changed it.
          if (f.mainChanged && !r.file)
            unresolved.push({ path: f.path, blocks: [], keys: [], file: true });
          else if (r.file !== 'keep' || !f.mainChanged) {
            changes.push({
              path: f.path,
              content: (await this.store.readRaw(tip, f.path)) ?? null,
            });
          }
          continue;
        }
        if (!f.merge.clean) {
          const missingBlocks = f.merge.segments
            .filter((s) => s.type === 'conflict' && r.blocks?.[s.index] === undefined)
            .map((s) => (s.type === 'conflict' ? s.index : -1));
          const missingKeys = f.merge.frontmatterConflicts
            .filter((c) => r.frontmatter?.[c.key] === undefined)
            .map((c) => c.key);
          if (missingBlocks.length || missingKeys.length) {
            unresolved.push({ path: f.path, blocks: missingBlocks, keys: missingKeys });
            continue;
          }
        }
        changes.push({ path: f.path, content: renderMerge(f.merge, r) });
      }
      if (unresolved.length)
        throw new ConflictError('proposal has unresolved conflicts', unresolved);

      const author: Actor =
        p.author_kind === 'ai' && p.agent_id
          ? { kind: 'ai', agentId: p.agent_id, name: p.author_name }
          : { kind: 'human', name: p.author_name };
      return this.commitOn(head, author, changes, `Merge proposal: ${p.title}`, {
        extraParents: [tip],
        trailers: { [TRAILER_PROPOSAL]: p.id },
      });
    });
    const p = await this.getProposal(id);
    await this.db.run(
      `UPDATE proposals SET status = 'merged', merged_commit = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      commit,
      nowIso(),
      id,
      this.userId,
    );
    await this.store.deleteBranch(p.branch);
    return commit;
  }

  async rejectProposal(id: string): Promise<void> {
    const p = await this.getProposal(id);
    if (p.status !== 'open') throw new ConflictError('proposal is not open', null);
    await this.db.run(
      `UPDATE proposals SET status = 'rejected', updated_at = ? WHERE id = ? AND user_id = ?`,
      nowIso(),
      id,
      this.userId,
    );
    // Keep the commit reachable for reference.
    const tip = await this.store.head(p.branch);
    if (tip) await this.store.createBranch(`rejected/${id}`, tip).catch(() => undefined);
    await this.store.deleteBranch(p.branch);
  }

  /** Mark open proposals rejected without touching the store (used when storage changes). */
  async abandonOpenProposals(): Promise<number> {
    const r = await this.db.run(
      `UPDATE proposals SET status = 'rejected', updated_at = ? WHERE user_id = ? AND status = 'open'`,
      nowIso(),
      this.userId,
    );
    return r.changes;
  }

  // ---- history, blame, revert ---------------------------------------------

  async history(
    opts: { path?: string; limit?: number; agentId?: string } = {},
  ): Promise<HistoryEntry[]> {
    const commits = await this.store.log(MAIN, {
      ...(opts.path ? { path: normalizeNotePath(opts.path, { requireMarkdown: false }) } : {}),
      limit: Math.min(opts.limit ?? 100, 500),
      firstParent: true,
    });
    return commits.map(toHistory).filter((h) => !opts.agentId || h.agentId === opts.agentId);
  }

  /** Paragraph-level attribution for coloring AI-written blocks. */
  async blame(path: string): Promise<BlockAttribution[]> {
    const p = normalizeNotePath(path);
    const commits = (
      await this.store.log(MAIN, { path: p, limit: this.cheap ? 300 : 25, firstParent: true })
    ).reverse();
    const versions: FileVersion[] = [];
    for (const c of commits) {
      const kind = authorKindFromEmail(c.authorEmail);
      versions.push({
        text: await this.store.readFile(c.sha, p),
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
    const [c] = await this.store.log(sha, { limit: 1 });
    if (!c) throw new NotFoundError('commit not found');
    const parent = c.parents[0] ?? null;
    const changes: FileChange[] = [];
    for (const f of await this.store.changedFiles(parent, c.sha)) {
      changes.push({
        path: f.path,
        content: parent ? await this.store.readRaw(parent, f.path) : null,
      });
    }
    const id = await this.createProposal(human, changes, {
      baseCommit: c.sha,
      title: `Revert: ${c.subject}`,
      description: `${c.sha.slice(0, 8)} を取り消します`,
      source: 'revert',
    });
    const files = await this.proposalFiles(id);
    if (files.every((f) => !f.deleteConflict && (f.merge?.clean ?? !f.mainChanged))) {
      try {
        const commit = await this.mergeProposal(id, {});
        return { status: 'proposed', proposalId: id, reason: 'reverted', merged: true, commit };
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
      }
    }
    return { status: 'proposed', proposalId: id, reason: 'revert needs review' };
  }

  /** Revert every change an agent made on main (optionally since a date), newest first. */
  async revertAgent(agentId: string, since?: string): Promise<SaveResult[]> {
    const commits = (
      await this.store.log(MAIN, { firstParent: true, limit: this.cheap ? 1000 : 200 })
    ).filter((c) => agentIdFromEmail(c.authorEmail) === agentId && (!since || c.date >= since));
    const results: SaveResult[] = [];
    for (const c of commits) results.push(await this.revertCommit(c.sha));
    return results;
  }

  // ---- views ---------------------------------------------------------------

  async listViewFiles(): Promise<{ id: string; text: string }[]> {
    const head = await this.currentHead();
    const out: { id: string; text: string }[] = [];
    for (const f of await this.store.listFiles(head)) {
      const m = new RegExp(`^${VIEWS_DIR}/([^/]+)\\.ya?ml$`).exec(f.path);
      if (m) out.push({ id: m[1]!, text: (await this.store.readBlob(f.sha)) ?? '' });
    }
    return out;
  }

  async saveViewFile(id: string, text: string): Promise<void> {
    if (!/^[\w\-\u3000-\u9fff]+$/.test(id)) throw new ForbiddenError('invalid view id');
    await this.commitAs(
      this.human(),
      [{ path: `${VIEWS_DIR}/${id}.yaml`, content: text }],
      `Save view ${id}`,
    );
  }

  async deleteViewFile(id: string): Promise<void> {
    if (!/^[\w\-\u3000-\u9fff]+$/.test(id)) throw new ForbiddenError('invalid view id');
    await this.commitAs(
      this.human(),
      [{ path: `${VIEWS_DIR}/${id}.yaml`, content: null }],
      `Delete view ${id}`,
    );
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

function commitMessage(
  actor: Actor,
  subject: string,
  trailers: Record<string, string> = {},
  description = '',
): string {
  const t: Record<string, string> = { [TRAILER_KIND]: actor.kind, ...trailers };
  if (actor.kind === 'ai') t[TRAILER_AGENT] = actor.name;
  const lines = Object.entries(t).map(([k, v]) => `${k}: ${v}`);
  return `${subject.replace(/\n/g, ' ').slice(0, 200)}\n\n${description ? description.trim() + '\n\n' : ''}${lines.join('\n')}\n`;
}

/** Record who created a note in its frontmatter (only when not already set). */
export function withCreator(text: string, actor: Actor): string {
  const parsed = parseNoteLenient(text);
  if (parsed.frontmatter['created_by'] !== undefined) return text;
  const fm: Record<string, unknown> = {
    ...parsed.frontmatter,
    created_by: actor.kind === 'ai' ? 'ai' : 'human',
  };
  if (actor.kind === 'ai') fm['ai_agent'] = actor.name;
  return serializeNote(fm, parsed.body);
}

export type { Choice };
