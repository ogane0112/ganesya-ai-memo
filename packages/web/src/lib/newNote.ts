import { toNotePath } from './paths';

/** First non-empty line of a memo, without Markdown heading/list markers. */
export function firstLineTitle(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
    .trim()
    .slice(0, 60);
}

export function timestampTitle(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Pick a path that does not collide with existing (or queued) notes: "Title.md", "Title 2.md", … */
export function uniquePath(title: string, folder: string, taken: ReadonlySet<string>): string {
  const base = toNotePath(title, folder).replace(/\.md$/, '');
  let p = `${base}.md`;
  for (let n = 2; taken.has(p.toLowerCase()); n++) p = `${base} ${n}.md`;
  return p;
}

/** Content for a quick-written note: adds a "# Title" heading unless the body already starts with one. */
export function quickNoteContent(title: string, body: string): string {
  const b = body.replace(/\s+$/, '');
  if (!title.trim()) return `${b}\n`;
  if (/^\s*#\s/.test(b)) return `${b}\n`;
  return `# ${title.trim()}\n\n${b}${b ? '\n' : ''}`;
}

/**
 * Where a memo started with "new note" gets saved, decided from what was
 * written (like iOS Notes: the first line is the title). null while there is
 * no first line yet, so leaving an empty memo creates nothing.
 *
 * `heading` is where to insert "# " so the first line reads as the title, or
 * null when it already is a heading or is a list item (left as written).
 */
export function newNotePlan(
  text: string,
  folder: string,
  taken: ReadonlySet<string>,
): { path: string; heading: number | null } | null {
  const title = firstLineTitle(text);
  if (!title) return null;
  const start = text.search(/\S/);
  const line = text.slice(start).split('\n')[0]!;
  const plain = !/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```)/.test(line);
  const lineStart = text.lastIndexOf('\n', start) + 1;
  // A slash in a title is part of the name, not a folder.
  const name = title.replace(/[\\/]+/g, '-');
  return { path: uniquePath(name, folder, taken), heading: plain ? lineStart : null };
}
