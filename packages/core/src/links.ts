export interface WikiLink {
  /** Link target as written, without heading/alias (e.g. `Project A` or `folder/Note`). */
  target: string;
  heading?: string;
  alias?: string;
  /** `![[...]]` embeds. */
  embed: boolean;
}

const WIKILINK_RE = /(!?)\[\[([^[\]\n|#]+)(?:#([^[\]\n|]*))?(?:\|([^[\]\n]*))?\]\]/g;
const TAG_RE = /(?:^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

/** Remove fenced code blocks and inline code so links inside code are ignored. */
export function stripCode(body: string): string {
  return body
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
}

export function extractLinks(body: string): WikiLink[] {
  const out: WikiLink[] = [];
  for (const m of stripCode(body).matchAll(WIKILINK_RE)) {
    const target = (m[2] ?? '').trim();
    if (!target) continue;
    const link: WikiLink = { target, embed: m[1] === '!' };
    if (m[3]) link.heading = m[3].trim();
    if (m[4]) link.alias = m[4].trim();
    out.push(link);
  }
  return out;
}

/** Inline `#tags` from the body plus `tags` from frontmatter, lower-cased and de-duplicated. */
export function extractTags(body: string, frontmatterTags?: unknown): string[] {
  const tags = new Set<string>();
  for (const m of stripCode(body).matchAll(TAG_RE)) {
    if (m[1]) tags.add(m[1].toLowerCase());
  }
  const fm = Array.isArray(frontmatterTags)
    ? frontmatterTags
    : typeof frontmatterTags === 'string'
      ? frontmatterTags.split(/[,\s]+/)
      : [];
  for (const t of fm) {
    if (typeof t === 'string' && t.trim()) tags.add(t.trim().replace(/^#/, '').toLowerCase());
  }
  return [...tags];
}

/** Normalize a link target / note path to a comparable key (Obsidian-style, case-insensitive). */
export function linkKey(target: string): string {
  return target
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.md$/i, '')
    .trim()
    .toLowerCase();
}

/**
 * Resolve a wiki link target against the list of note paths.
 * Exact path match wins; otherwise the shortest path whose basename matches.
 */
export function resolveLink(target: string, paths: readonly string[]): string | undefined {
  const key = linkKey(target);
  let best: string | undefined;
  for (const p of paths) {
    const pk = linkKey(p);
    if (pk === key) return p;
    if (pk.endsWith('/' + key) && (best === undefined || p.length < best.length)) best = p;
  }
  return best;
}

/** Rewrite links pointing at `oldTarget` so they point at `newTarget` (used on rename). */
export function renameLinks(body: string, oldPath: string, newPath: string): string {
  const oldKey = linkKey(oldPath);
  const oldBase = oldKey.split('/').pop() ?? oldKey;
  const newName = newPath.replace(/\.md$/i, '');
  const newBase = newName.split('/').pop() ?? newName;
  return body.replace(WIKILINK_RE, (whole, bang: string, target: string, heading?: string, alias?: string) => {
    const k = linkKey(target);
    let replacement: string | undefined;
    if (k === oldKey) replacement = target.includes('/') ? newName : newBase;
    else if (k === oldBase && !target.includes('/')) replacement = newBase;
    if (replacement === undefined) return whole;
    return `${bang}[[${replacement}${heading !== undefined ? '#' + heading : ''}${alias !== undefined ? '|' + alias : ''}]]`;
  });
}
