import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git, gitRaw, Mutex } from './git.js';

export interface GitIdentity {
  name: string;
  email: string;
}

export interface FileChange {
  path: string;
  /** New content, or null to delete the file. */
  content: string | Buffer | null;
}

export interface CommitInfo {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  date: string;
  subject: string;
  body: string;
}

export interface ChangedFile {
  status: 'A' | 'M' | 'D';
  path: string;
}

export const MAIN = 'main';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Git trailers used to record authorship details in commit messages. */
export const TRAILER_KIND = 'Gmemo-Author-Kind';
export const TRAILER_AGENT = 'Gmemo-Agent';
export const TRAILER_PROPOSAL = 'Gmemo-Proposal';

export class ConcurrentUpdateError extends Error {}

/**
 * The notes repository. The working tree always mirrors `main` so the folder can
 * be opened directly in Obsidian; other branches are written with plumbing only.
 */
export class NoteRepo {
  readonly lock = new Mutex();
  private indexCounter = 0;

  constructor(readonly dir: string) {}

  private run(args: string[], opts: { input?: string | Buffer; env?: Record<string, string>; okCodes?: number[] } = {}) {
    return git(args, { cwd: this.dir, ...opts });
  }

  async init(mergeDriverCommand?: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const isRepo = await stat(join(this.dir, '.git')).then(
      () => true,
      () => false,
    );
    if (!isRepo) await this.run(['init', '-q', '-b', MAIN]);
    await this.run(['config', 'core.quotepath', 'false']);
    await this.run(['config', 'user.name', 'gmemo']);
    await this.run(['config', 'user.email', 'system@gmemo.local']);
    if (mergeDriverCommand) {
      await this.run(['config', 'merge.gmemo.name', 'gmemo frontmatter-aware note merge']);
      await this.run(['config', 'merge.gmemo.driver', mergeDriverCommand]);
    }
    if (!(await this.head(MAIN))) {
      await this.commit(
        MAIN,
        [
          { path: '.gitattributes', content: '*.md merge=gmemo\n' },
          {
            path: 'Welcome.md',
            content:
              '---\ntitle: Welcome\ncreated_by: human\n---\n# Welcome\n\nこれはあなたのノートです。[[リンク]]でノート同士をつなげられます。\n',
          },
        ],
        { name: 'gmemo', email: 'system@gmemo.local' },
        'Initialize notes repository',
      );
    }
  }

  async head(branch: string): Promise<string | null> {
    const r = await this.run(['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`], { okCodes: [0, 1] });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async resolve(ref: string): Promise<string | null> {
    const r = await this.run(['rev-parse', '--verify', '-q', `${ref}^{commit}`], { okCodes: [0, 1, 128] });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async readFile(ref: string, path: string): Promise<string | null> {
    const r = await this.run(['cat-file', 'blob', `${ref}:${path}`], { okCodes: [0, 128] });
    return r.code === 0 ? r.stdout : null;
  }

  async readRaw(ref: string, path: string): Promise<Buffer | null> {
    const r = await gitRaw(['cat-file', 'blob', `${ref}:${path}`], this.dir);
    return r;
  }

  async readBlob(sha: string): Promise<string | null> {
    if (!/^[0-9a-f]{40}$/.test(sha)) return null;
    const r = await this.run(['cat-file', 'blob', sha], { okCodes: [0, 128] });
    return r.code === 0 ? r.stdout : null;
  }

  async blobId(ref: string, path: string): Promise<string | null> {
    const r = await this.run(['rev-parse', '--verify', '-q', `${ref}:${path}`], { okCodes: [0, 1, 128] });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async hashContent(content: string | Buffer, write = false): Promise<string> {
    const r = await this.run(['hash-object', ...(write ? ['-w'] : []), '--stdin'], { input: content });
    return r.stdout.trim();
  }

  async listFiles(ref: string = MAIN): Promise<{ path: string; sha: string }[]> {
    const r = await this.run(['ls-tree', '-r', '-z', '--full-tree', ref]);
    const out: { path: string; sha: string }[] = [];
    for (const entry of r.stdout.split('\0')) {
      if (!entry) continue;
      const tab = entry.indexOf('\t');
      const meta = entry.slice(0, tab).split(' ');
      if (meta[1] !== 'blob') continue;
      out.push({ path: entry.slice(tab + 1), sha: meta[2] ?? '' });
    }
    return out;
  }

  async changedFiles(from: string | null, to: string): Promise<ChangedFile[]> {
    const r = await this.run(['diff-tree', '-r', '-z', '--no-renames', '--name-status', from ?? EMPTY_TREE, to]);
    const parts = r.stdout.split('\0').filter(Boolean);
    const out: ChangedFile[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const s = parts[i]![0];
      out.push({ status: s === 'A' ? 'A' : s === 'D' ? 'D' : 'M', path: parts[i + 1]! });
    }
    return out;
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const r = await this.run(['merge-base', a, b], { okCodes: [0, 1] });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    const r = await this.run(['merge-base', '--is-ancestor', a, b], { okCodes: [0, 1] });
    return r.code === 0;
  }

  async log(ref: string, opts: { path?: string; limit?: number; firstParent?: boolean; since?: string } = {}): Promise<CommitInfo[]> {
    const args = ['log', '-z', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b'];
    if (opts.firstParent) args.push('--first-parent');
    if (opts.limit) args.push(`-n${opts.limit}`);
    if (opts.since) args.push(`${opts.since}..${ref}`);
    else args.push(ref);
    if (opts.path) args.push('--', opts.path);
    const r = await this.run(args, { okCodes: [0, 128] });
    if (r.code !== 0) return [];
    return r.stdout
      .split('\0')
      .filter((s) => s.trim())
      .map((rec) => {
        const [sha = '', parents = '', authorName = '', authorEmail = '', date = '', subject = '', body = ''] = rec
          .replace(/^\n/, '')
          .split('\x1f');
        return { sha, parents: parents.split(' ').filter(Boolean), authorName, authorEmail, date, subject, body: body.trim() };
      });
  }

  async branches(prefix: string): Promise<{ name: string; sha: string }[]> {
    const r = await this.run(['for-each-ref', '--format=%(refname:strip=2) %(objectname)', `refs/heads/${prefix}`]);
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name = '', sha = ''] = l.split(' ');
        return { name, sha };
      });
  }

  async deleteBranch(branch: string): Promise<void> {
    if (branch === MAIN) throw new Error('refusing to delete main');
    await this.run(['update-ref', '-d', `refs/heads/${branch}`], { okCodes: [0, 1] });
  }

  async createBranch(branch: string, at: string): Promise<void> {
    await this.run(['update-ref', `refs/heads/${branch}`, at, '0'.repeat(40)]);
  }

  /**
   * Create a commit on `branch` containing `changes` on top of `parent`
   * (default: current branch head). Uses a temporary index so the working tree is
   * untouched; when `branch` is main the working tree is synced afterwards.
   * Returns the new commit sha, or the parent sha if nothing changed.
   */
  async commit(
    branch: string,
    changes: FileChange[],
    author: GitIdentity,
    message: string,
    opts: { parent?: string | null; extraParents?: string[]; allowEmpty?: boolean } = {},
  ): Promise<string> {
    const current = await this.head(branch);
    const parent = opts.parent === undefined ? current : opts.parent;
    const indexFile = join(this.dir, '.git', `gmemo-index-${process.pid}-${++this.indexCounter}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      if (parent) await this.run(['read-tree', parent], { env });
      else await this.run(['read-tree', '--empty'], { env });
      for (const ch of changes) {
        if (ch.content === null) {
          await this.run(['update-index', '--force-remove', '--', ch.path], { env });
        } else {
          const sha = await this.hashContent(ch.content, true);
          await this.run(['update-index', '--add', '--cacheinfo', `100644,${sha},${ch.path}`], { env });
        }
      }
      const tree = (await this.run(['write-tree'], { env })).stdout.trim();
      if (parent && !opts.allowEmpty && !opts.extraParents?.length) {
        const parentTree = (await this.run(['rev-parse', `${parent}^{tree}`])).stdout.trim();
        if (parentTree === tree) return parent;
      }
      const parentArgs = [parent, ...(opts.extraParents ?? [])].filter((p): p is string => !!p).flatMap((p) => ['-p', p]);
      const commitEnv = {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: 'gmemo',
        GIT_COMMITTER_EMAIL: 'system@gmemo.local',
      };
      const sha = (await this.run(['commit-tree', tree, ...parentArgs, '-F', '-'], { input: message, env: commitEnv })).stdout.trim();
      const r = await this.run(['update-ref', `refs/heads/${branch}`, sha, current ?? '0'.repeat(40)], { okCodes: [0, 128] });
      if (r.code !== 0) throw new ConcurrentUpdateError(`${branch} moved during commit`);
      if (branch === MAIN) await this.syncWorktree(current, sha);
      return sha;
    } finally {
      await rm(indexFile, { force: true });
    }
  }

  /** Bring the working tree + index from commit `from` to `to` (both on main). */
  private async syncWorktree(from: string | null, to: string): Promise<void> {
    const changed = await this.changedFiles(from, to);
    for (const ch of changed) {
      const abs = join(this.dir, ch.path);
      if (ch.status === 'D') {
        await rm(abs, { force: true });
      } else {
        const content = await this.readRaw(to, ch.path);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content ?? Buffer.alloc(0));
      }
    }
    // Make sure HEAD points at main, then refresh the real index for touched paths.
    await this.run(['symbolic-ref', 'HEAD', `refs/heads/${MAIN}`]);
    if (!from) {
      await this.run(['read-tree', to]);
      return;
    }
    if (changed.length) {
      await this.run(['reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul', to], {
        input: changed.map((c) => c.path).join('\0'),
        env: { GIT_LITERAL_PATHSPECS: '1' },
      });
    }
  }

  /**
   * Commit edits made directly in the working tree (e.g. from Obsidian) as the
   * human user. Returns the new main sha and touched paths, or null if clean.
   */
  async commitExternalChanges(author: GitIdentity): Promise<{ sha: string; paths: string[] } | null> {
    const status = await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (!status.stdout.trim()) return null;
    const before = await this.head(MAIN);
    await this.run(['add', '-A']);
    const tree = (await this.run(['write-tree'])).stdout.trim();
    if (before) {
      const headTree = (await this.run(['rev-parse', `${before}^{tree}`])).stdout.trim();
      if (headTree === tree) return null;
    }
    const sha = (
      await this.run(['commit-tree', tree, ...(before ? ['-p', before] : []), '-F', '-'], {
        input: `Edit outside the app\n\n${TRAILER_KIND}: human\n`,
        env: {
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: 'gmemo',
          GIT_COMMITTER_EMAIL: 'system@gmemo.local',
        },
      })
    ).stdout.trim();
    const r = await this.run(['update-ref', `refs/heads/${MAIN}`, sha, before ?? '0'.repeat(40)], { okCodes: [0, 128] });
    if (r.code !== 0) throw new ConcurrentUpdateError('main moved during external commit');
    const paths = (await this.changedFiles(before, sha)).map((c) => c.path);
    return { sha, paths };
  }

  /** Raw access for backups. */
  async bundle(file: string): Promise<void> {
    await this.run(['bundle', 'create', file, '--all']);
  }
}

/** Parse `Key: value` trailers from a commit body. */
export function parseTrailers(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const m = /^([A-Za-z-]+):\s*(.+)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}
