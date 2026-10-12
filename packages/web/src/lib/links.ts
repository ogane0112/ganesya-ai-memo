import { resolveLink } from '@gmemo/core';

const baseName = (p: string) =>
  p
    .slice(p.lastIndexOf('/') + 1)
    .replace(/\.md$/i, '')
    .toLowerCase();

/**
 * What to write inside [[ ]] to point at `path`: the note's name alone when no
 * other note has that name, otherwise the folder too. A bare name shared by two
 * notes would resolve by path length, and quietly move to another note later.
 */
export function linkTarget(path: string, paths: readonly string[]): string {
  const full = path.replace(/\.md$/i, '');
  const name = full.slice(full.lastIndexOf('/') + 1);
  const unique = paths.filter((p) => baseName(p) === name.toLowerCase()).length <= 1;
  return unique && resolveLink(name, paths) === path ? name : full;
}

/** The whole link, with the selected text kept as what the link shows. */
export function wikiLink(target: string, label = ''): string {
  // "|" and "]" would end the link early; line breaks are not allowed in one.
  const shown = label.replace(/[|\]\r\n]+/g, ' ').trim();
  return shown && shown !== target ? `[[${target}|${shown}]]` : `[[${target}]]`;
}

/** Notes matching what was typed (title or folder), best matches first. */
export function searchNotes<T extends { path: string; title: string }>(
  notes: readonly T[],
  query: string,
  limit = 30,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return notes.slice(0, limit);
  const score = (n: T) => {
    const t = n.title.toLowerCase();
    if (t === q) return 0;
    if (t.startsWith(q)) return 1;
    if (t.includes(q)) return 2;
    if (n.path.toLowerCase().includes(q)) return 3;
    return -1;
  };
  return notes
    .map((n) => ({ n, s: score(n) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.n.title.localeCompare(b.n.title, 'ja'))
    .slice(0, limit)
    .map((x) => x.n);
}
