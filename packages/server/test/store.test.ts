import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/db.js';
import { SqliteDb } from '../src/db/sqlite.js';
import { DbGitStore } from '../src/store/db-store.js';
import { blobId, decodeTree, encodeTree, objectId } from '../src/store/gitobj.js';
import { GitHubStore } from '../src/store/github-store.js';
import { ConcurrentUpdateError, MAIN, type NoteStore } from '../src/store/types.js';
import { gunzip, gzip, tar, untar } from '../src/util/tar.js';
import { fakeGitHub } from './fake-github.js';

const who = { name: 'me', email: 'human@gmemo.local' };

async function dbStore(): Promise<NoteStore> {
  const db = new SqliteDb(':memory:');
  await migrate(db);
  await db.run(`INSERT INTO users(id, username, created_at) VALUES ('u1', 'me', 'now')`);
  return new DbGitStore(db, 'u1');
}

function githubStore(): NoteStore {
  const gh = fakeGitHub();
  return new GitHubStore({
    owner: gh.owner,
    repo: gh.repo,
    branch: 'main',
    token: gh.token,
    fetch: gh.fetch,
  });
}

describe('git object encoding', () => {
  it('matches git ids', async () => {
    expect(await blobId('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(await blobId('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    expect(await objectId('tree', new Uint8Array(0))).toBe(
      '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    );
    // `git mktree` with one file "a" containing "hello\n"
    const tree = encodeTree([
      { name: 'a', type: 'blob', sha: 'ce013625030ba8dba906f756967f9e9ca394464a' },
    ]);
    expect(await objectId('tree', tree)).toBe('0976950c1fdbcb52435a433913017bf044b3a58f');
    // Directories sort as "name/", so "a.md" comes before the directory "a" (verified with git mktree).
    const mixed = encodeTree([
      { name: 'a', type: 'tree', sha: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' },
      { name: 'a.md', type: 'blob', sha: 'ce013625030ba8dba906f756967f9e9ca394464a' },
    ]);
    expect(await objectId('tree', mixed)).toBe('f918f4bb70e0ccdd42af3fccb2520b1789b0220d');
    expect(decodeTree(tree)).toEqual([
      { name: 'a', type: 'blob', sha: 'ce013625030ba8dba906f756967f9e9ca394464a' },
    ]);
  });
});

describe.each([
  ['builtin (database)', dbStore],
  ['github', async () => githubStore()],
])('NoteStore contract: %s', (_name, make) => {
  it('initializes, commits, reads and diffs', async () => {
    const s = await make();
    await s.init();
    await s.init();
    const h0 = (await s.head(MAIN))!;
    expect(await s.readFile(h0, 'Welcome.md')).toContain('Welcome');

    const h1 = await s.commit(
      MAIN,
      [
        { path: 'a/b/note.md', content: 'hello\n' },
        { path: 'img.bin', content: new Uint8Array([0, 1, 2, 255]) },
      ],
      who,
      'Add',
    );
    expect(await s.head(MAIN)).toBe(h1);
    expect(await s.readFile(h1, 'a/b/note.md')).toBe('hello\n');
    expect([...(await s.readRaw(h1, 'img.bin'))!]).toEqual([0, 1, 2, 255]);
    expect(await s.blobId(h1, 'a/b/note.md')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    expect(await s.hashContent('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    expect((await s.listFiles(h1)).map((f) => f.path).sort()).toEqual([
      'Welcome.md',
      'a/b/note.md',
      'img.bin',
    ]);
    const snap = await s.snapshot(h1);
    expect([...snap.keys()].sort()).toEqual(['Welcome.md', 'a/b/note.md', 'img.bin']);
    expect([...snap.get('img.bin')!]).toEqual([0, 1, 2, 255]);
    expect(await s.changedFiles(h0, h1)).toEqual([
      { status: 'A', path: 'a/b/note.md' },
      { status: 'A', path: 'img.bin' },
    ]);

    // No-op commit returns the parent.
    expect(await s.commit(MAIN, [{ path: 'a/b/note.md', content: 'hello\n' }], who, 'noop')).toBe(
      h1,
    );

    const h2 = await s.commit(
      MAIN,
      [
        { path: 'a/b/note.md', content: null },
        { path: 'Welcome.md', content: 'changed\n' },
      ],
      who,
      'Edit\n\nGmemo-Author-Kind: human',
    );
    expect(await s.readFile(h2, 'a/b/note.md')).toBeNull();
    expect(await s.changedFiles(h1, h2)).toEqual([
      { status: 'M', path: 'Welcome.md' },
      { status: 'D', path: 'a/b/note.md' },
    ]);
    expect(await s.isAncestor(h0, h2)).toBe(true);
    expect(await s.isAncestor(h2, h0)).toBe(false);
    const log = await s.log(MAIN, { firstParent: true });
    expect(log.map((c) => c.subject)).toEqual(['Edit', 'Add', 'Initialize notes']);
    expect(log[0]).toMatchObject({
      authorName: 'me',
      authorEmail: 'human@gmemo.local',
      parents: [h1],
    });
    expect((await s.log(MAIN, { path: 'a/b/note.md' })).map((c) => c.subject)).toEqual([
      'Edit',
      'Add',
    ]);
  });

  it('branches, merge commits and compare-and-swap', async () => {
    const s = await make();
    await s.init();
    const base = (await s.head(MAIN))!;
    await s.createBranch('proposals/p1', base);
    await expect(s.createBranch('proposals/p1', base)).rejects.toBeInstanceOf(
      ConcurrentUpdateError,
    );
    const tip = await s.commit(
      'proposals/p1',
      [{ path: 'ai.md', content: 'from ai\n' }],
      { name: 'Claude', email: 'ag@agents.gmemo.local' },
      'AI\n\nGmemo-Proposal: p1',
      { allowEmpty: true },
    );
    expect(await s.readFile((await s.head(MAIN))!, 'ai.md')).toBeNull();

    const merge = await s.commit(
      MAIN,
      [{ path: 'ai.md', content: 'from ai\n' }],
      who,
      'Merge proposal\n\nGmemo-Proposal: p1',
      { extraParents: [tip] },
    );
    expect((await s.log(MAIN, { limit: 1 }))[0]!.parents).toEqual([base, tip]);
    expect((await s.log(MAIN, { firstParent: true })).map((c) => c.subject)).toEqual([
      'Merge proposal',
      'Initialize notes',
    ]);
    await s.deleteBranch('proposals/p1');
    expect(await s.head('proposals/p1')).toBeNull();

    // A commit computed against a stale parent must not overwrite main.
    await expect(
      s.commit(MAIN, [{ path: 'x.md', content: 'x' }], who, 'stale', { parent: base }),
    ).rejects.toBeInstanceOf(ConcurrentUpdateError);
    expect(await s.head(MAIN)).toBe(merge);
  });
});

describe('tar', () => {
  it('round-trips files including long paths', async () => {
    const long = `${'deep/'.repeat(30)}note.md`;
    const files = [
      { path: 'root/a.md', data: new TextEncoder().encode('hello') },
      { path: `root/${long}`, data: new Uint8Array([1, 2, 3]) },
    ];
    const back = untar(await gunzip(await gzip(tar(files))), 1);
    expect(back.map((f) => f.path)).toEqual(['a.md', long]);
    expect([...back[1]!.data]).toEqual([1, 2, 3]);
  });
});

describe('GitHubStore specifics', () => {
  it('reports bad credentials and keeps proposal branches under gmemo/', async () => {
    const gh = fakeGitHub();
    const bad = new GitHubStore({
      owner: gh.owner,
      repo: gh.repo,
      branch: 'main',
      token: 'nope',
      fetch: gh.fetch,
    });
    await expect(bad.init()).rejects.toThrow(/トークン/);
    const s = new GitHubStore({
      owner: gh.owner,
      repo: gh.repo,
      branch: 'main',
      token: gh.token,
      fetch: gh.fetch,
    });
    await s.init();
    await s.createBranch('proposals/x', (await s.head(MAIN))!);
    expect([...gh.refs.keys()].sort()).toEqual(['gmemo/proposals/x', 'main']);
  });
});
