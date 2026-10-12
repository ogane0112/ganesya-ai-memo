/**
 * Whether a new file or folder fits the existing tree of a repository.
 *
 * Git itself accepts a file and a folder with the same name in different
 * commits, or names that differ only in case, but a clone on Windows or macOS
 * (case-insensitive file systems) then breaks, and the app's folder tree no
 * longer matches the repository. With a GitHub repository the latest commit
 * is the truth, so a name that does not fit it is refused instead of guessed.
 */
export interface Tree {
  /** Exact file paths. */
  files: Set<string>;
  /** Exact folder paths (every parent of every file). */
  folders: Set<string>;
  /** Lower-cased path → the exact file or folder path. */
  byLower: Map<string, string>;
}

export function treeOf(filePaths: Iterable<string>): Tree {
  const files = new Set<string>();
  const folders = new Set<string>();
  const byLower = new Map<string, string>();
  for (const p of filePaths) {
    files.add(p);
    byLower.set(p.toLowerCase(), p);
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (folders.has(d)) continue;
      folders.add(d);
      if (!byLower.has(d.toLowerCase())) byLower.set(d.toLowerCase(), d);
    }
  }
  return { files, folders, byLower };
}

/**
 * Why `path` cannot be added as a `kind` to `tree`, in words for the person
 * (Japanese, like the rest of the interface), or null when it fits. Paths
 * that already exist exactly as that kind fit (saving over a file, reusing a
 * folder).
 */
export function pathClash(tree: Tree, path: string, kind: 'file' | 'folder'): string | null {
  const parts = path.split('/');
  // Every parent must be a folder, spelled the way the repository spells it.
  for (let i = 1; i < parts.length; i++) {
    const d = parts.slice(0, i).join('/');
    if (tree.files.has(d))
      return `「${d}」はファイルとして存在するため、その中には保存できません。`;
    const same = tree.byLower.get(d.toLowerCase());
    if (same && same !== d && tree.folders.has(same))
      return `リポジトリには「${same}」があります。大文字・小文字だけが違う「${d}」は作れません。`;
  }
  if (kind === 'file') {
    if (tree.files.has(path)) return null;
    if (tree.folders.has(path))
      return `「${path}」はフォルダーとして存在するため、同じ名前のファイルは作れません。`;
  } else {
    if (tree.folders.has(path)) return null;
    if (tree.files.has(path))
      return `「${path}」はファイルとして存在するため、同じ名前のフォルダーは作れません。`;
  }
  const same = tree.byLower.get(path.toLowerCase());
  if (same && same !== path)
    return `リポジトリには「${same}」があります。大文字・小文字だけが違う「${path}」は作れません。`;
  return null;
}
