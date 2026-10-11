import { type Db, stmt, type Stmt, toBytes } from '../db/db.js';
import {
  blobId,
  type CommitData,
  decodeTree,
  encodeCommit,
  encodeTree,
  objectId,
  type TreeEntry,
} from './gitobj.js';
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
  splitMessage,
  WELCOME_NOTE,
} from './types.js';

interface CommitRow {
  sha: string;
  tree: string;
  parents: string;
  author_name: string;
  author_email: string;
  date: string;
  message: string;
  changed: string;
}

const HEX40 = /^[0-9a-f]{40}$/;

/**
 * Built-in note store: real git objects (same ids as git would compute) kept in
 * the database, one namespace per user. Commits are stored as rows with the
 * list of paths changed against the first parent, so path history is cheap.
 */
export class DbGitStore implements NoteStore {
  readonly kind = 'builtin' as const;
  private objects = new Map<string, { type: string; data: Uint8Array }>();
  private commits = new Map<string, CommitRow>();

  constructor(
    private readonly db: Db,
    private readonly userId: string,
  ) {}

  // ---- object access --------------------------------------------------------

  private async object(sha: string): Promise<{ type: string; data: Uint8Array } | null> {
    const hit = this.objects.get(sha);
    if (hit) return hit;
    const r = await this.db.first<{ type: string; data: unknown }>(
      'SELECT type, data FROM git_objects WHERE user_id = ? AND sha = ?',
      this.userId,
      sha,
    );
    if (!r) return null;
    const obj = { type: r.type, data: toBytes(r.data) };
    this.objects.set(sha, obj);
    return obj;
  }

  /**
   * Commit metadata. With `prefetch`, a miss also loads the next older commits
   * in one query, so history walks need a handful of queries instead of one per commit.
   */
  private async commitRow(sha: string, prefetch = false): Promise<CommitRow | null> {
    const hit = this.commits.get(sha);
    if (hit) return hit;
    const colsSql = 'sha, tree, parents, author_name, author_email, date, message, changed';
    const r = await this.db.first<CommitRow>(
      `SELECT ${colsSql} FROM git_commits WHERE user_id = ? AND sha = ?`,
      this.userId,
      sha,
    );
    if (!r) return null;
    this.commits.set(sha, r);
    if (prefetch) {
      const older = await this.db.all<CommitRow>(
        `SELECT ${colsSql} FROM git_commits WHERE user_id = ? AND date <= ? ORDER BY date DESC LIMIT 300`,
        this.userId,
        r.date,
      );
      for (const o of older) if (!this.commits.has(o.sha)) this.commits.set(o.sha, o);
    }
    return r;
  }

  private async treeEntries(sha: string): Promise<TreeEntry[]> {
    const o = await this.object(sha);
    return o && o.type === 'tree' ? decodeTree(o.data) : [];
  }

  private async lookup(commit: string, path: string): Promise<TreeEntry | null> {
    const c = await this.commitRow(commit);
    if (!c) return null;
    let tree = c.tree;
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const e = (await this.treeEntries(tree)).find((x) => x.name === parts[i]);
      if (!e) return null;
      if (i === parts.length - 1) return e;
      if (e.type !== 'tree') return null;
      tree = e.sha;
    }
    return null;
  }

  // ---- NoteStore --------------------------------------------------------------

  async init(): Promise<void> {
    if (await this.head(MAIN)) return;
    await this.commit(
      MAIN,
      [{ path: 'Welcome.md', content: WELCOME_NOTE }],
      { name: 'gmemo', email: 'system@gmemo.local' },
      'Initialize notes',
      {
        parent: null,
      },
    );
  }

  async head(branch: string): Promise<string | null> {
    const r = await this.db.first<{ sha: string }>(
      'SELECT sha FROM git_refs WHERE user_id = ? AND name = ?',
      this.userId,
      branch,
    );
    return r?.sha ?? null;
  }

  async resolve(ref: string): Promise<string | null> {
    if (HEX40.test(ref) && (await this.commitRow(ref))) return ref;
    return this.head(ref);
  }

  async readRaw(commit: string, path: string): Promise<Uint8Array | null> {
    const e = await this.lookup(commit, path);
    if (!e || e.type !== 'blob') return null;
    return (await this.object(e.sha))?.data ?? null;
  }

  async readFile(commit: string, path: string): Promise<string | null> {
    const raw = await this.readRaw(commit, path);
    return raw ? fromUtf8(raw) : null;
  }

  async readBlob(sha: string): Promise<string | null> {
    if (!HEX40.test(sha)) return null;
    const o = await this.object(sha);
    return o && o.type === 'blob' ? fromUtf8(o.data) : null;
  }

  async blobId(commit: string, path: string): Promise<string | null> {
    const e = await this.lookup(commit, path);
    return e && e.type === 'blob' ? e.sha : null;
  }

  hashContent(content: string | Uint8Array): Promise<string> {
    return blobId(content);
  }

  async listFiles(commit: string): Promise<{ path: string; sha: string }[]> {
    const c = await this.commitRow(commit);
    if (!c) return [];
    const out: { path: string; sha: string }[] = [];
    const walk = async (tree: string, prefix: string) => {
      for (const e of await this.treeEntries(tree)) {
        if (e.type === 'tree') await walk(e.sha, `${prefix}${e.name}/`);
        else out.push({ path: prefix + e.name, sha: e.sha });
      }
    };
    await walk(c.tree, '');
    return out;
  }

  async snapshot(commit: string): Promise<Map<string, Uint8Array>> {
    const files = await this.listFiles(commit);
    const bySha = new Map<string, Uint8Array>();
    const missing = [...new Set(files.map((f) => f.sha))].filter((sha) => {
      const hit = this.objects.get(sha);
      if (hit) bySha.set(sha, hit.data);
      return !hit;
    });
    for (let i = 0; i < missing.length; i += 90) {
      const chunk = missing.slice(i, i + 90);
      const rows = await this.db.all<{ sha: string; data: unknown }>(
        `SELECT sha, data FROM git_objects WHERE user_id = ? AND sha IN (${chunk.map(() => '?').join(',')})`,
        this.userId,
        ...chunk,
      );
      for (const r of rows) bySha.set(r.sha, toBytes(r.data));
    }
    const out = new Map<string, Uint8Array>();
    for (const f of files) {
      const data = bySha.get(f.sha);
      if (data) out.set(f.path, data);
    }
    return out;
  }

  private async diffTrees(
    a: string | null,
    b: string | null,
    prefix: string,
    out: ChangedFile[],
  ): Promise<void> {
    if (a === b) return;
    const ea = new Map((a ? await this.treeEntries(a) : []).map((e) => [e.name, e]));
    const eb = new Map((b ? await this.treeEntries(b) : []).map((e) => [e.name, e]));
    for (const name of new Set([...ea.keys(), ...eb.keys()])) {
      const x = ea.get(name);
      const y = eb.get(name);
      if (x && y && x.sha === y.sha && x.type === y.type) continue;
      const path = prefix + name;
      if (x?.type === 'tree' || y?.type === 'tree') {
        await this.diffTrees(
          x?.type === 'tree' ? x.sha : null,
          y?.type === 'tree' ? y.sha : null,
          `${path}/`,
          out,
        );
        if (x?.type === 'blob') out.push({ status: 'D', path });
        if (y?.type === 'blob') out.push({ status: 'A', path });
        continue;
      }
      out.push({ status: !x ? 'A' : !y ? 'D' : 'M', path });
    }
  }

  async changedFiles(from: string | null, to: string): Promise<ChangedFile[]> {
    const ta = from ? ((await this.commitRow(from))?.tree ?? null) : null;
    const tb = (await this.commitRow(to))?.tree ?? null;
    const out: ChangedFile[] = [];
    await this.diffTrees(ta, tb, '', out);
    return out.sort((x, y) => (x.path < y.path ? -1 : 1));
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length && seen.size < 20000) {
      const sha = queue.shift()!;
      if (sha === a) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const c = await this.commitRow(sha, true);
      if (c) queue.push(...(JSON.parse(c.parents) as string[]));
    }
    return false;
  }

  /** History along the first-parent chain (merges show up as one commit). */
  async log(
    ref: string,
    opts: { path?: string; limit?: number; firstParent?: boolean } = {},
  ): Promise<CommitInfo[]> {
    let sha = await this.resolve(ref);
    const limit = opts.limit ?? 100;
    const out: CommitInfo[] = [];
    let steps = 0;
    while (sha && out.length < limit && steps++ < 50000) {
      const c = await this.commitRow(sha, true);
      if (!c) break;
      const parents = JSON.parse(c.parents) as string[];
      const changed = JSON.parse(c.changed) as string[];
      if (!opts.path || changed.includes(opts.path)) {
        const { subject, body } = splitMessage(c.message);
        out.push({
          sha: c.sha,
          parents,
          authorName: c.author_name,
          authorEmail: c.author_email,
          date: c.date,
          subject,
          body,
          paths: changed,
        });
      }
      sha = parents[0] ?? null;
    }
    return out;
  }

  async createBranch(name: string, at: string): Promise<void> {
    try {
      await this.db.run(
        'INSERT INTO git_refs(user_id, name, sha) VALUES (?, ?, ?)',
        this.userId,
        name,
        at,
      );
    } catch {
      throw new ConcurrentUpdateError(`branch ${name} already exists`);
    }
  }

  async deleteBranch(name: string): Promise<void> {
    if (name === MAIN) throw new Error('refusing to delete main');
    await this.db.run('DELETE FROM git_refs WHERE user_id = ? AND name = ?', this.userId, name);
  }

  /** Apply changes to a tree, writing new tree objects. Returns the new tree sha. */
  private async applyToTree(
    treeSha: string | null,
    changes: { parts: string[]; content: Uint8Array | null }[],
    writes: Map<string, { type: string; data: Uint8Array }>,
  ): Promise<string | null> {
    const entries = new Map(
      (treeSha ? await this.treeEntries(treeSha) : []).map((e) => [e.name, e]),
    );
    const byChild = new Map<string, { parts: string[]; content: Uint8Array | null }[]>();
    for (const ch of changes) {
      const [head, ...rest] = ch.parts;
      if (rest.length === 0) {
        if (ch.content === null) entries.delete(head!);
        else {
          const sha = await objectId('blob', ch.content);
          writes.set(sha, { type: 'blob', data: ch.content });
          this.objects.set(sha, { type: 'blob', data: ch.content });
          entries.set(head!, { name: head!, type: 'blob', sha });
        }
      } else {
        const list = byChild.get(head!) ?? [];
        list.push({ parts: rest, content: ch.content });
        byChild.set(head!, list);
      }
    }
    for (const [name, sub] of byChild) {
      const cur = entries.get(name);
      const sha = await this.applyToTree(cur?.type === 'tree' ? cur.sha : null, sub, writes);
      if (sha) entries.set(name, { name, type: 'tree', sha });
      else entries.delete(name);
    }
    if (entries.size === 0) return null;
    const data = encodeTree([...entries.values()]);
    const sha = await objectId('tree', data);
    writes.set(sha, { type: 'tree', data });
    this.objects.set(sha, { type: 'tree', data });
    return sha;
  }

  async commit(
    branch: string,
    changes: FileChange[],
    author: GitIdentity,
    message: string,
    opts: CommitOptions = {},
  ): Promise<string> {
    const current = opts.current ?? (await this.head(branch));
    const parent = opts.parent === undefined ? current : opts.parent;
    const parentTree = parent ? ((await this.commitRow(parent))?.tree ?? null) : null;
    const writes = new Map<string, { type: string; data: Uint8Array }>();
    const tree =
      (await this.applyToTree(
        parentTree,
        changes.map((c) => ({
          parts: c.path.split('/'),
          content: c.content === null ? null : asBytes(c.content),
        })),
        writes,
      )) ?? (await this.emptyTree(writes));
    if (parent && tree === parentTree && !opts.allowEmpty && !opts.extraParents?.length)
      return parent;

    const date = new Date().toISOString();
    const parents = [parent, ...(opts.extraParents ?? [])].filter((p): p is string => !!p);
    const data: CommitData = {
      tree,
      parents,
      authorName: author.name,
      authorEmail: author.email,
      date,
      committerName: 'gmemo',
      committerEmail: 'system@gmemo.local',
      message,
    };
    const sha = await objectId('commit', encodeCommit(data));
    const changed: string[] = [];
    if (parentTree !== tree) {
      const out: ChangedFile[] = [];
      await this.diffTrees(parentTree, tree, '', out);
      changed.push(...out.map((c) => c.path));
    }
    const stmts: Stmt[] = [...writes].map(([s, o]) =>
      stmt(
        'INSERT OR IGNORE INTO git_objects(user_id, sha, type, data) VALUES (?, ?, ?, ?)',
        this.userId,
        s,
        o.type,
        o.data,
      ),
    );
    stmts.push(
      stmt(
        'INSERT OR IGNORE INTO git_commits(user_id, sha, tree, parents, author_name, author_email, date, message, changed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        this.userId,
        sha,
        tree,
        JSON.stringify(parents),
        author.name,
        author.email,
        date,
        message,
        JSON.stringify(changed),
      ),
    );
    const row: CommitRow = {
      sha,
      tree,
      parents: JSON.stringify(parents),
      author_name: author.name,
      author_email: author.email,
      date,
      message,
      changed: JSON.stringify(changed),
    };

    // Compare-and-swap the branch ref. Like a non-forced git push, the new
    // commit must descend from the branch's current head.
    if (
      current !== null &&
      parent !== current &&
      !(parent && (await this.isAncestor(current, parent)))
    ) {
      throw new ConcurrentUpdateError(`${branch} is not an ancestor of the new commit`);
    }
    if (current === null) {
      await this.db.batch(stmts);
      await this.createBranch(branch, sha);
    } else {
      // Objects and the ref move in one round trip. If the branch moved, the
      // objects stay behind unreferenced, exactly as after a refused push.
      stmts.push(
        stmt(
          'UPDATE git_refs SET sha = ? WHERE user_id = ? AND name = ? AND sha = ?',
          sha,
          this.userId,
          branch,
          current,
        ),
      );
      const res = await this.db.batch(stmts);
      if (res[res.length - 1]?.changes !== 1)
        throw new ConcurrentUpdateError(`${branch} moved during commit`);
    }
    this.commits.set(sha, row);
    return sha;
  }

  private async emptyTree(
    writes: Map<string, { type: string; data: Uint8Array }>,
  ): Promise<string> {
    const data = new Uint8Array(0);
    const sha = await objectId('tree', data);
    writes.set(sha, { type: 'tree', data });
    return sha;
  }
}
