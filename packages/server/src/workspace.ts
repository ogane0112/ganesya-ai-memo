import { AgentLens } from './ai/agent-lens.js';
import { AiGateway } from './ai/gateway.js';
import type { LlmClient } from './ai/llm.js';
import { AgentStore } from './auth/agents.js';
import { CalendarService } from './calendar/calendar.js';
import type { Config } from './config.js';
import { type Db, nowIso } from './db/db.js';
import type { HumanActor } from './notes/actor.js';
import { NoteService } from './notes/service.js';
import type { Embedder } from './search/embedder.js';
import { Indexer } from './search/indexer.js';
import { DbGitStore } from './store/db-store.js';
import { GitHubStore } from './store/github-store.js';
import { MAIN, type NoteStore, StoreError } from './store/types.js';
import { decryptSecret, encryptSecret } from './util/crypto.js';

export type StorageKind = 'builtin' | 'github';

export interface StorageSettings {
  storage: StorageKind;
  github: { owner: string; repo: string; branch: string; hasToken: boolean } | null;
  updatedAt: string;
}

interface WorkspaceRow {
  user_id: string;
  storage: StorageKind;
  github_owner: string | null;
  github_repo: string | null;
  github_branch: string | null;
  github_token_enc: string | null;
  updated_at: string;
}

export interface GitHubInput {
  owner: string;
  repo: string;
  branch?: string;
  /** Omitted to keep the stored token (changing only the branch, say). */
  token?: string;
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_RE = /^(?!\/|.*\/\/|.*\.\.|.*\.lock$)[A-Za-z0-9._/-]{1,100}$/;

/** Everything a workspace needs that is shared across users. */
export interface WorkspaceDeps {
  db: Db;
  cfg: Config;
  fts: boolean;
  embedder: Embedder;
  llm: { local: LlmClient | null; external: LlmClient | null };
  fetch?: typeof fetch;
}

export async function loadWorkspaceRow(db: Db, userId: string): Promise<WorkspaceRow> {
  const row = await db.first<WorkspaceRow>('SELECT * FROM workspaces WHERE user_id = ?', userId);
  if (row) return row;
  const now = nowIso();
  await db.run(
    `INSERT INTO workspaces(user_id, storage, updated_at) VALUES (?, 'builtin', ?) ON CONFLICT(user_id) DO NOTHING`,
    userId,
    now,
  );
  return {
    user_id: userId,
    storage: 'builtin',
    github_owner: null,
    github_repo: null,
    github_branch: null,
    github_token_enc: null,
    updated_at: now,
  };
}

export function storageSettings(row: WorkspaceRow): StorageSettings {
  return {
    storage: row.storage,
    github:
      row.github_owner && row.github_repo
        ? {
            owner: row.github_owner,
            repo: row.github_repo,
            branch: row.github_branch ?? 'main',
            hasToken: !!row.github_token_enc,
          }
        : null,
    updatedAt: row.updated_at,
  };
}

async function githubStore(
  deps: WorkspaceDeps,
  g: { owner: string; repo: string; branch: string; token: string },
): Promise<GitHubStore> {
  return new GitHubStore({
    ...g,
    apiBase: deps.cfg.githubApiBase,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}

async function storeFor(deps: WorkspaceDeps, row: WorkspaceRow): Promise<NoteStore> {
  if (row.storage === 'github') {
    if (!row.github_owner || !row.github_repo || !row.github_token_enc)
      throw new StoreError('GitHubの接続設定が不完全です。設定画面で接続し直してください', 409);
    if (!deps.cfg.secretKey)
      throw new StoreError('サーバーに GMEMO_SECRET_KEY が設定されていません', 500);
    const enc = row.github_token_enc;
    let token = await decryptSecret(enc, deps.cfg.secretKey).catch(() => null);
    if (token === null && deps.cfg.previousSecretKey) {
      // Encrypted before the last key rotation: decrypt with the old key, re-encrypt with the new one.
      token = await decryptSecret(enc, deps.cfg.previousSecretKey).catch(() => null);
      if (token !== null)
        await deps.db.run(
          'UPDATE workspaces SET github_token_enc = ? WHERE user_id = ? AND github_token_enc = ?',
          await encryptSecret(token, deps.cfg.secretKey),
          row.user_id,
          enc,
        );
    }
    if (token === null)
      throw new StoreError('保存されたGitHubトークンを復号できません。接続し直してください', 409);
    return githubStore(deps, {
      owner: row.github_owner,
      repo: row.github_repo,
      branch: row.github_branch ?? 'main',
      token,
    });
  }
  return new DbGitStore(deps.db, row.user_id);
}

/** One user's notes, index, agents and AI access. */
export class Workspace {
  private constructor(
    readonly userId: string,
    readonly username: string,
    readonly settings: StorageSettings,
    readonly store: NoteStore,
    readonly notes: NoteService,
    readonly indexer: Indexer,
    readonly agents: AgentStore,
    readonly ai: AiGateway,
    readonly lens: AgentLens,
    readonly calendar: CalendarService,
  ) {}

  static async open(
    deps: WorkspaceDeps,
    user: { id: string; username: string },
    row?: WorkspaceRow,
  ): Promise<Workspace> {
    const r = row ?? (await loadWorkspaceRow(deps.db, user.id));
    const store = await storeFor(deps, r);
    const human: HumanActor = { kind: 'human', name: user.username };
    // The indexer reads the policy lazily, after the service exists.
    // eslint-disable-next-line prefer-const
    let notes!: NoteService;
    const indexer = new Indexer(
      deps.db,
      user.id,
      store,
      deps.embedder,
      () => notes.currentPolicy(),
      { fts: deps.fts },
    );
    notes = new NoteService(store, deps.db, user.id, indexer, human, {
      checkSeconds: deps.cfg.githubCheckSeconds,
    });
    return new Workspace(
      user.id,
      user.username,
      storageSettings(r),
      store,
      notes,
      indexer,
      new AgentStore(deps.db, user.id),
      new AiGateway(deps.db, user.id, deps.llm.local, deps.llm.external),
      new AgentLens(deps.db, user.id),
      new CalendarService(deps.db, user.id, deps.cfg, notes, indexer),
    );
  }

  human(): HumanActor {
    return this.notes.human();
  }
}

/**
 * Switch a user's storage. The current notes (latest version, not history) are
 * copied into the new place when `copy` is set; history stays where it was.
 * Open proposals cannot move between stores and are closed.
 */
export async function switchStorage(
  deps: WorkspaceDeps,
  current: Workspace,
  target: { storage: 'builtin' } | { storage: 'github'; github: GitHubInput; copy: boolean },
): Promise<{ copied: number; closedProposals: number }> {
  const db = deps.db;
  const row = await loadWorkspaceRow(db, current.userId);
  let next: WorkspaceRow;
  if (target.storage === 'github') {
    const g = target.github;
    const owner = g.owner.trim();
    const repo = g.repo.trim().replace(/\.git$/, '');
    const branch = (g.branch ?? '').trim() || 'main';
    if (!NAME_RE.test(owner) || !NAME_RE.test(repo))
      throw new StoreError('リポジトリ名の形式が正しくありません', 400);
    if (!BRANCH_RE.test(branch)) throw new StoreError('ブランチ名の形式が正しくありません', 400);
    if (!deps.cfg.secretKey)
      throw new StoreError(
        'サーバーに GMEMO_SECRET_KEY が設定されていないため、GitHubは使えません',
        400,
      );
    let tokenEnc = row.github_token_enc;
    if (g.token?.trim()) tokenEnc = await encryptSecret(g.token.trim(), deps.cfg.secretKey);
    else if (row.github_owner !== owner || row.github_repo !== repo) tokenEnc = null;
    if (!tokenEnc) throw new StoreError('GitHubのトークンを入力してください', 400);
    next = {
      ...row,
      storage: 'github',
      github_owner: owner,
      github_repo: repo,
      github_branch: branch,
      github_token_enc: tokenEnc,
      updated_at: nowIso(),
    };
  } else {
    next = { ...row, storage: 'builtin', updated_at: nowIso() };
  }

  const target_ = await storeFor(deps, next);
  // Validates the token and repository (creates the first commit in an empty repo).
  await target_.init();

  let copied = 0;
  const sameStore =
    row.storage === next.storage &&
    (next.storage === 'builtin' ||
      (row.github_owner === next.github_owner &&
        row.github_repo === next.github_repo &&
        row.github_branch === next.github_branch));
  const copy = target.storage === 'github' ? target.copy : true;
  if (!sameStore && copy) {
    const srcHead = await current.store.head(MAIN);
    if (srcHead) {
      const files = await current.store.snapshot(srcHead);
      const dstHead = (await target_.head(MAIN))!;
      const changes = [...files].map(([path, content]) => ({ path, content }));
      if (changes.length) {
        await target_.commit(
          MAIN,
          changes,
          { name: current.username, email: 'human@gmemo.local' },
          `Import notes from ${row.storage === 'github' ? 'GitHub' : 'the built-in store'}\n\nGmemo-Author-Kind: human\n`,
          { parent: dstHead },
        );
        copied = changes.length;
      }
    }
  }

  const closedProposals = sameStore ? 0 : await current.notes.abandonOpenProposals();
  await db.run(
    `UPDATE workspaces SET storage = ?, github_owner = ?, github_repo = ?, github_branch = ?, github_token_enc = ?, updated_at = ? WHERE user_id = ?`,
    next.storage,
    next.github_owner,
    next.github_repo,
    next.github_branch,
    next.github_token_enc,
    next.updated_at,
    current.userId,
  );
  // The index describes the old store; rebuild it from the new one.
  await db.batch(current.indexer.clearStmts());
  return { copied, closedProposals };
}

/** Forget the GitHub connection (switches back to the built-in store first if needed). */
export async function disconnectGitHub(db: Db, userId: string): Promise<void> {
  await db.run(
    `UPDATE workspaces SET github_owner = NULL, github_repo = NULL, github_branch = NULL, github_token_enc = NULL, updated_at = ? WHERE user_id = ? AND storage = 'builtin'`,
    nowIso(),
    userId,
  );
}
