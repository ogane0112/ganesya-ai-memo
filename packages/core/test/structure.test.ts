import { describe, expect, it } from 'vitest';
import { pathClash, treeOf } from '../src/index.js';

const tree = treeOf(['Projects/Plan.md', 'Projects/notes', 'Inbox/2026.md', 'README.md']);

describe('fitting new paths into a repository tree', () => {
  it('accepts new names, and existing ones of the same kind', () => {
    expect(pathClash(tree, 'Projects/New.md', 'file')).toBeNull();
    expect(pathClash(tree, 'Projects/Plan.md', 'file')).toBeNull();
    expect(pathClash(tree, 'Ideas/x.md', 'file')).toBeNull();
    expect(pathClash(tree, 'Projects', 'folder')).toBeNull();
    expect(pathClash(tree, 'Projects/2026', 'folder')).toBeNull();
  });

  it('refuses names that differ only in case from what the repository has', () => {
    expect(pathClash(tree, 'projects/New.md', 'file')).toContain('「Projects」');
    expect(pathClash(tree, 'projects', 'folder')).toContain('「Projects」');
    expect(pathClash(tree, 'Projects/plan.md', 'file')).toContain('「Projects/Plan.md」');
    expect(pathClash(tree, 'readme.md', 'file')).toContain('「README.md」');
  });

  it('refuses a file where a folder is, and a folder where a file is', () => {
    expect(pathClash(tree, 'Projects/notes/a.md', 'file')).toContain('ファイルとして存在');
    expect(pathClash(tree, 'Projects/notes', 'folder')).toContain('ファイルとして存在');
    expect(pathClash(tree, 'Inbox', 'file')).toContain('フォルダーとして存在');
  });
});
