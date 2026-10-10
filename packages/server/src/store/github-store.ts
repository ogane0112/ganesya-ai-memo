import { gunzip, untar } from '../util/tar.js';
import { blobId } from './gitobj.js';
import {
  asBytes,
  type ChangedFile,
  type CommitInfo,
  type CommitOptions,
  ConcurrentUpdateError,
  type FileChange,
  fromUtf8,
  type GitIdentity,
  MAIN,
  type NoteStore,
  parseTrailers,
  splitMessage,
  StoreError,
  TRAILER_PROPOSAL,
  WELCOME_NOTE,
} from './types.js';

export interface GitHubConfig {
  owner: string;
  repo: string;
  /** Branch that plays the role of `main`. */
  branch: string;
  token: string;
  apiBase?: string;
  fetch?: typeof fetch;
}

const HEX40 = /^[0-9a-f]{40}$/;

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64decode(b64: string): Uint8Array {
  const s = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const isText = (c: string | Uint8Array): c is string => typeof c === 'string';

/**
 * Notes stored in a GitHub repository, written with the Git Data API so every
 * change is a real commit (authors, merge commits, branches). Proposal branches
 * live under `gmemo/` so they do not clutter the repository's own branches.
 */
export class GitHubStore implements NoteStore {
  readonly kind = 'github' as const;
  private readonly api: string;
  private readonly f: typeof fetch;
  private trees = new Map<string, Map<string, string>>();
  private blobs = new Map<string, Uint8Array>();
  private commitTrees = new Map<string, string>();

  constructor(private readonly cfg: GitHubConfig) {
    this.api = `${(cfg.apiBase ?? 'https://api.github.com').replace(/\/+$/, '')}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
    this.f = cfg.fetch ?? fetch.bind(globalThis);
  }

  private ghBranch(name: string): string {
    return name === MAIN ? this.cfg.branch : `gmemo/${name}`;
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    okStatuses: number[] = [],
  ): Promise<{ status: number; data: T | null }> {
    const res = await this.f(`${this.api}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.cfg.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'ganesya-ai-memo',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.ok) {
      const text = await res.text();
      return { status: res.status, data: text ? (JSON.parse(text) as T) : null };
    }
    if (okStatuses.includes(res.status)) return { status: res.status, data: null };
    const msg = await res.text().catch(() => '');
    if (res.status === 401)
      throw new StoreError('GitHubのトークンが無効です。設定で接続し直してください', 401);
    if (res.status === 403)
      throw new StoreError(
        `GitHubへのアクセスが拒否されました(権限不足か回数制限): ${msg.slice(0, 200)}`,
        403,
      );
    if (res.status === 404)
      throw new StoreError(
        'GitHubのリポジトリが見つかりません(名前かトークンの権限を確認してください)',
        404,
      );
    throw new StoreError(`GitHub API ${method} ${path} → ${res.status}: ${msg.slice(0, 200)}`);
  }

  // ---- reads ------------------------------------------------------------------

  async init(): Promise<void> {
    if (await this.head(MAIN)) return;
    // The Git Data API cannot write to an empty repository; the contents API can.
    await this.req('PUT', `/contents/Welcome.md`, {
      message: 'Initialize notes',
      content: b64encode(asBytes(WELCOME_NOTE)),
      branch: this.cfg.branch,
    });
  }

  async head(branch: string): Promise<string | null> {
    const r = await this.req<{ object: { sha: string } }>(
      'GET',
      `/git/ref/heads/${this.ghBranch(branch)}`,
      undefined,
      [404, 409],
    );
    return r.data?.object.sha ?? null;
  }

  async resolve(ref: string): Promise<string | null> {
    if (HEX40.test(ref)) return ref;
    return this.head(ref);
  }

  private async commitTree(commit: string): Promise<string> {
    const hit = this.commitTrees.get(commit);
    if (hit) return hit;
    const r = await this.req<{ tree: { sha: string } }>('GET', `/git/commits/${commit}`);
    const tree = r.data!.tree.sha;
    this.commitTrees.set(commit, tree);
    return tree;
  }

  /** path → blob sha for a commit (cached; commits are immutable). */
  private async fileMap(commit: string): Promise<Map<string, string>> {
    const tree = await this.commitTree(commit);
    const hit = this.trees.get(tree);
    if (hit) return hit;
    const r = await this.req<{
      tree: { path: string; type: string; sha: string }[];
      truncated: boolean;
    }>('GET', `/git/trees/${tree}?recursive=1`);
    const map = new Map<string, string>();
    for (const e of r.data!.tree) if (e.type === 'blob') map.set(e.path, e.sha);
    this.trees.set(tree, map);
    return map;
  }

  private async blob(sha: string): Promise<Uint8Array | null> {
    const hit = this.blobs.get(sha);
    if (hit) return hit;
    const r = await this.req<{ content: string; encoding: string }>(
      'GET',
      `/git/blobs/${sha}`,
      undefined,
      [404, 422],
    );
    if (!r.data) return null;
    const bytes =
      r.data.encoding === 'base64' ? b64decode(r.data.content) : asBytes(r.data.content);
    this.blobs.set(sha, bytes);
    return bytes;
  }

  async blobId(commit: string, path: string): Promise<string | null> {
    return (await this.fileMap(commit)).get(path) ?? null;
  }

  async readRaw(commit: string, path: string): Promise<Uint8Array | null> {
    const sha = await this.blobId(commit, path);
    return sha ? this.blob(sha) : null;
  }

  async readFile(commit: string, path: string): Promise<string | null> {
    const raw = await this.readRaw(commit, path);
    return raw ? fromUtf8(raw) : null;
  }

  async readBlob(sha: string): Promise<string | null> {
    if (!HEX40.test(sha)) return null;
    const raw = await this.blob(sha);
    return raw ? fromUtf8(raw) : null;
  }

  hashContent(content: string | Uint8Array): Promise<string> {
    return blobId(content);
  }

  async listFiles(commit: string): Promise<{ path: string; sha: string }[]> {
    return [...(await this.fileMap(commit))].map(([path, sha]) => ({ path, sha }));
  }

  /** One tarball download instead of a request per file. */
  async snapshot(commit: string): Promise<Map<string, Uint8Array>> {
    const res = await this.f(`${this.api}/tarball/${commit}`, {
      headers: {
        authorization: `Bearer ${this.cfg.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'ganesya-ai-memo',
      },
      redirect: 'follow',
    });
    if (!res.ok) throw new StoreError(`GitHubからノートを取得できませんでした (${res.status})`);
    const files = untar(await gunzip(new Uint8Array(await res.arrayBuffer())), 1);
    const known = await this.fileMap(commit);
    const out = new Map<string, Uint8Array>();
    for (const f of files) if (known.has(f.path)) out.set(f.path, f.data);
    return out;
  }

  async changedFiles(from: string | null, to: string): Promise<ChangedFile[]> {
    const a = from ? await this.fileMap(from) : new Map<string, string>();
    const b = await this.fileMap(to);
    const out: ChangedFile[] = [];
    for (const [p, sha] of b) {
      const old = a.get(p);
      if (old === undefined) out.push({ status: 'A', path: p });
      else if (old !== sha) out.push({ status: 'M', path: p });
    }
    for (const p of a.keys()) if (!b.has(p)) out.push({ status: 'D', path: p });
    return out.sort((x, y) => (x.path < y.path ? -1 : 1));
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    const r = await this.req<{ status: string }>('GET', `/compare/${a}...${b}`, undefined, [404]);
    return r.data?.status === 'ahead' || r.data?.status === 'identical';
  }

  /**
   * History. GitHub lists every reachable commit; with `firstParent` the
   * commits that only exist on proposal branches are dropped (they carry a
   * proposal trailer and are not merges), which matches main's first-parent view.
   */
  async log(
    ref: string,
    opts: { path?: string; limit?: number; firstParent?: boolean } = {},
  ): Promise<CommitInfo[]> {
    const sha = HEX40.test(ref) ? ref : this.ghBranch(ref);
    const limit = opts.limit ?? 100;
    const out: CommitInfo[] = [];
    for (let page = 1; out.length < limit && page <= 20; page++) {
      const q = new URLSearchParams({ sha, per_page: '100', page: String(page) });
      if (opts.path) q.set('path', opts.path);
      const r = await this.req<
        {
          sha: string;
          parents: { sha: string }[];
          commit: { message: string; author: { name: string; email: string; date: string } };
        }[]
      >('GET', `/commits?${q.toString()}`, undefined, [404, 409]);
      const list = r.data ?? [];
      for (const c of list) {
        const { subject, body } = splitMessage(c.commit.message);
        const parents = c.parents.map((p) => p.sha);
        if (opts.firstParent && parents.length === 1 && parseTrailers(body)[TRAILER_PROPOSAL])
          continue;
        out.push({
          sha: c.sha,
          parents,
          authorName: c.commit.author.name,
          authorEmail: c.commit.author.email,
          date: c.commit.author.date,
          subject,
          body,
        });
        if (out.length >= limit) break;
      }
      if (list.length < 100) break;
    }
    return out;
  }

  // ---- writes -----------------------------------------------------------------

  async createBranch(name: string, at: string): Promise<void> {
    const r = await this.req(
      'POST',
      '/git/refs',
      { ref: `refs/heads/${this.ghBranch(name)}`, sha: at },
      [422],
    );
    if (r.status === 422) throw new ConcurrentUpdateError(`branch ${name} already exists`);
  }

  async deleteBranch(name: string): Promise<void> {
    if (name === MAIN) throw new Error('refusing to delete main');
    await this.req('DELETE', `/git/refs/heads/${this.ghBranch(name)}`, undefined, [404, 422]);
  }

  async commit(
    branch: string,
    changes: FileChange[],
    author: GitIdentity,
    message: string,
    opts: CommitOptions = {},
  ): Promise<string> {
    const current = await this.head(branch);
    const parent = opts.parent === undefined ? current : opts.parent;
    const existing = parent ? await this.fileMap(parent) : new Map<string, string>();
    const parentTree = parent ? await this.commitTree(parent) : null;

    const entries: Record<string, unknown>[] = [];
    for (const c of changes) {
      if (c.content === null) {
        if (existing.has(c.path))
          entries.push({ path: c.path, mode: '100644', type: 'blob', sha: null });
      } else if (isText(c.content)) {
        entries.push({ path: c.path, mode: '100644', type: 'blob', content: c.content });
      } else {
        const b = await this.req<{ sha: string }>('POST', '/git/blobs', {
          content: b64encode(c.content),
          encoding: 'base64',
        });
        entries.push({ path: c.path, mode: '100644', type: 'blob', sha: b.data!.sha });
      }
    }
    let tree = parentTree;
    if (entries.length) {
      const t = await this.req<{ sha: string }>('POST', '/git/trees', {
        ...(parentTree ? { base_tree: parentTree } : {}),
        tree: entries,
      });
      tree = t.data!.sha;
    }
    if (parent && tree === parentTree && !opts.allowEmpty && !opts.extraParents?.length)
      return parent;
    if (!tree) {
      const t = await this.req<{ sha: string }>('POST', '/git/trees', { tree: [] });
      tree = t.data!.sha;
    }

    const date = new Date().toISOString();
    const parents = [parent, ...(opts.extraParents ?? [])].filter((p): p is string => !!p);
    const c = await this.req<{ sha: string }>('POST', '/git/commits', {
      message,
      tree,
      parents,
      author: { name: author.name, email: author.email, date },
      committer: { name: 'gmemo', email: 'system@gmemo.local', date },
    });
    const sha = c.data!.sha;
    this.commitTrees.set(sha, tree);

    if (current === null) {
      await this.createBranch(branch, sha);
    } else {
      // Not forced: GitHub rejects the update unless it fast-forwards from the
      // current head, which is our compare-and-swap.
      const r = await this.req(
        'PATCH',
        `/git/refs/heads/${this.ghBranch(branch)}`,
        { sha, force: false },
        [422],
      );
      if (r.status === 422) throw new ConcurrentUpdateError(`${branch} moved during commit`);
    }
    return sha;
  }
}
