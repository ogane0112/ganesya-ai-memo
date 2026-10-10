import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { mergeDriverCommand } from '../src/app.js';
import { git } from '../src/git/git.js';
import { MAIN, NoteRepo } from '../src/git/repo.js';

it('registers a git merge driver that merges frontmatter by key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gmemo-driver-'));
  try {
    const repo = new NoteRepo(dir);
    await repo.init(mergeDriverCommand());
    const who = { name: 't', email: 't@example.com' };
    const base = await repo.commit(MAIN, [{ path: 'n.md', content: '---\ntitle: T\nstatus: todo\n---\np1\n\np2\n' }], who, 'base');
    await repo.createBranch('other', base);
    await repo.commit('other', [{ path: 'n.md', content: '---\ntitle: T\nstatus: done\n---\np1\n\np2 other\n' }], who, 'other');
    await repo.commit(MAIN, [{ path: 'n.md', content: '---\ntitle: T2\nstatus: todo\n---\np1 main\n\np2\n' }], who, 'main');
    await git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'merge', '-q', '--no-edit', 'other'], { cwd: dir });
    expect(await readFile(join(dir, 'n.md'), 'utf8')).toBe('---\ntitle: T2\nstatus: done\n---\np1 main\n\np2 other\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
