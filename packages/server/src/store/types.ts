/**
 * Versioned note storage with Git semantics (commits, branches, merge commits).
 * Implementations: the built-in object store in the database (DbGitStore) and a
 * GitHub repository through the GitHub REST API (GitHubStore).
 */
export interface GitIdentity {
  name: string;
  email: string;
}

export interface FileChange {
  path: string;
  /** New content (text or bytes), or null to delete the file. */
  content: string | Uint8Array | null;
}

export interface CommitInfo {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  date: string;
  subject: string;
  body: string;
  /** Paths changed against the first parent, when the store knows them cheaply. */
  paths?: string[];
}

export interface ChangedFile {
  status: 'A' | 'M' | 'D';
  path: string;
}

export interface CommitOptions {
  /** Parent commit; defaults to the branch head (null = root commit). */
  parent?: string | null;
  /** Additional parents (merge commits). */
  extraParents?: string[];
  /** Create a commit even if the tree did not change. */
  allowEmpty?: boolean;
  /**
   * The branch head as the caller last read it. Saves the store a read; the
   * commit is still refused (ConcurrentUpdateError) if the branch moved since.
   */
  current?: string;
}

export interface NoteStore {
  readonly kind: 'builtin' | 'github';
  /** Make sure the default branch exists (creates an initial commit if needed). */
  init(): Promise<void>;
  head(branch: string): Promise<string | null>;
  /** Resolve a branch name or commit sha to a commit sha. */
  resolve(ref: string): Promise<string | null>;
  readFile(commit: string, path: string): Promise<string | null>;
  readRaw(commit: string, path: string): Promise<Uint8Array | null>;
  readBlob(sha: string): Promise<string | null>;
  blobId(commit: string, path: string): Promise<string | null>;
  /** Git blob id of content, without storing it. */
  hashContent(content: string | Uint8Array): Promise<string>;
  listFiles(commit: string): Promise<{ path: string; sha: string }[]>;
  /** Every file of a commit in as few round trips as possible (indexing, export). */
  snapshot(commit: string): Promise<Map<string, Uint8Array>>;
  changedFiles(from: string | null, to: string): Promise<ChangedFile[]>;
  isAncestor(a: string, b: string): Promise<boolean>;
  log(
    ref: string,
    opts?: { path?: string; limit?: number; firstParent?: boolean },
  ): Promise<CommitInfo[]>;
  createBranch(name: string, at: string): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  /**
   * Commit `changes` on top of the parent and move `branch` to it, failing with
   * ConcurrentUpdateError if the branch moved in the meantime. Returns the new
   * commit sha (or the parent if nothing changed and allowEmpty is false).
   */
  commit(
    branch: string,
    changes: FileChange[],
    author: GitIdentity,
    message: string,
    opts?: CommitOptions,
  ): Promise<string>;
}

export const MAIN = 'main';

/** Git trailers used to record authorship details in commit messages. */
export const TRAILER_KIND = 'Gmemo-Author-Kind';
export const TRAILER_AGENT = 'Gmemo-Agent';
export const TRAILER_PROPOSAL = 'Gmemo-Proposal';

export class ConcurrentUpdateError extends Error {}
export class StoreError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

/** A path that does not fit the repository's latest tree (case-only difference, file vs folder). */
export class PathClashError extends StoreError {
  constructor(message: string) {
    super(message, 409);
  }
}

export const WELCOME_NOTE =
  '---\ntitle: Welcome\ncreated_by: human\n---\n# Welcome\n\nこれはあなたのノートです。[[リンク]]でノート同士をつなげられます。\n';

/** Parse `Key: value` trailers from a commit body. */
export function parseTrailers(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const m = /^([A-Za-z-]+):\s*(.+)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

export function splitMessage(message: string): { subject: string; body: string } {
  const i = message.indexOf('\n');
  if (i < 0) return { subject: message.trim(), body: '' };
  return { subject: message.slice(0, i).trim(), body: message.slice(i + 1).trim() };
}

const enc = new TextEncoder();
const dec = new TextDecoder();
export const toUtf8 = (s: string): Uint8Array => enc.encode(s);
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b);
export const asBytes = (c: string | Uint8Array): Uint8Array =>
  typeof c === 'string' ? enc.encode(c) : c;
