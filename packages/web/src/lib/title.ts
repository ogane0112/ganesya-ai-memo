import { parseNoteLenient, updateFrontmatter } from '@gmemo/core';
import { titleFromPath, toNotePath } from './paths';

/**
 * A note's name, as the app shows it: frontmatter `title`, else its first
 * `# heading`, else the file name. Editing the name changes the same place.
 */
export function titleOf(content: string, path: string | null): string {
  const { frontmatter, body } = parseNoteLenient(content);
  if (typeof frontmatter['title'] === 'string' && frontmatter['title'].trim())
    return frontmatter['title'].trim();
  const h = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  return h ?? (path ? titleFromPath(path) : '');
}

/**
 * The body without its leading `# heading` when that heading is the name (the
 * editor shows the name in its own field). `heading` and `gap` put it back.
 */
export function splitTitle(
  body: string,
  title: string,
): { heading: string | null; gap: string; rest: string } {
  const m = /^(\s*)#[ \t]+(.+?)[ \t]*(\r?\n[ \t]*\r?\n?|$)/.exec(body);
  if (!m || m[2] !== title) return { heading: null, gap: '', rest: body };
  return { heading: m[1] + '# ' + m[2], gap: m[3]!, rest: body.slice(m[0].length) };
}

/**
 * Rename inside the text: the frontmatter `title` if there is one, and the
 * first `# heading` when it carried the old name (or there is no `title`).
 * A note named only by its file name is left as it is.
 */
export function retitle(content: string, oldTitle: string, newTitle: string): string {
  const { frontmatter } = parseNoteLenient(content);
  let out = content;
  const fmTitle = typeof frontmatter['title'] === 'string';
  if (fmTitle) out = updateFrontmatter(out, { title: newTitle });
  const head = out.length - parseNoteLenient(out).body.length;
  const body = out.slice(head);
  const m = /^#[ \t]+(.+?)[ \t]*$/m.exec(body);
  if (m && (!fmTitle || m[1] === oldTitle)) {
    const at = head + m.index;
    out = `${out.slice(0, at)}# ${newTitle}${out.slice(at + m[0].length)}`;
  }
  return out;
}

/** A name as a file name: a slash is part of the name, not a folder. */
export function cleanTitle(title: string): string {
  return title.trim().replace(/[\\/]+/g, '-');
}

/** Where a note named `title` lives in `folder`. */
export function pathForTitle(title: string, folder: string): string {
  return toNotePath(cleanTitle(title), folder);
}
