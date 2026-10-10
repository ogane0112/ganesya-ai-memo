export class PathError extends Error {}

/**
 * Validate and normalize a note path relative to the notes root.
 * Rejects absolute paths, `..`, the `.git` directory and control characters.
 */
export function normalizeNotePath(input: string, { requireMarkdown = true } = {}): string {
  const p = input
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/')
    .trim();
  if (!p) throw new PathError('empty path');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(p)) throw new PathError('control characters in path');
  const parts = p.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..')
      throw new PathError(`invalid path segment in ${input}`);
    if (part.toLowerCase() === '.git') throw new PathError('access to .git is not allowed');
  }
  if (requireMarkdown && !/\.md$/i.test(p)) throw new PathError('notes must be .md files');
  return p;
}

/** Is `path` inside one of `folders`? An empty folder list means "everywhere". */
export function inFolders(path: string, folders: readonly string[] | undefined): boolean {
  if (!folders || folders.length === 0) return true;
  return folders.some((f) => {
    const norm = f.replace(/^\/+|\/+$/g, '');
    return norm === '' || path === norm || path.startsWith(norm + '/');
  });
}

/** Turn a title into a safe file name. */
export function slugifyTitle(title: string): string {
  const s = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|#^[\]\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return s || 'Untitled';
}
