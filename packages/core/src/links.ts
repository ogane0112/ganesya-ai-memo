/** How a link was written: `[[...]]`, a Markdown link, or frontmatter `related`. */
export type LinkKind = 'wikilink' | 'markdown' | 'related';

export interface NoteLink {
  /**
   * For `wikilink`, the target as written (resolved Obsidian-style later). For
   * `markdown` and `related`, the note path from the repository root.
   */
  target: string;
  kind: LinkKind;
  embed?: boolean;
}

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
  return body.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '').replace(/`[^`\n]*`/g, '');
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

// Markdown links. The link text may hold one level of brackets (`[![img](a.png)](b.md)`);
// a destination with spaces has to be wrapped in <> and may be followed by a title.
const MD_TEXT = String.raw`(?:[^[\]\\\n]|\\.|\[(?:[^[\]\\\n]|\\.)*\])*`;
const MD_INLINE_RE = new RegExp(
  String.raw`(!?)\[${MD_TEXT}\]\(\s*(<[^<>\n]*>|[^\s()]*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)`,
  'g',
);
const MD_REF_USE_RE = new RegExp(String.raw`(!?)\[(${MD_TEXT})\]\[(${MD_TEXT})\]`, 'g');
const MD_REF_DEF_RE = /^[ \t]{0,3}\[([^[\]\n]+)\]:[ \t]*(<[^<>\n]*>|\S+)/gm;

/** Resolve `.` and `..`, drop empty segments. Undefined when it climbs past the root. */
function normalizePosixPath(path: string): string | undefined {
  const out: string[] = [];
  for (const seg of path.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length ? out.join('/') : undefined;
}

/**
 * The note a Markdown link or `related` entry points at, as a path from the
 * repository root. `dir` is the folder of the linking note (`''` at the top).
 * External URLs, anchors, folders and files other than `.md` give undefined.
 */
function linkedNotePath(dest: string, dir: string, { fromRoot = false } = {}): string | undefined {
  let d = dest.trim();
  if (d.startsWith('<') && d.endsWith('>')) d = d.slice(1, -1).trim();
  d = d.replace(/\\(.)/g, '$1');
  if (!d || d.startsWith('#')) return undefined;
  // Scheme-ful URLs (http:, mailto:, …) and protocol-relative ones are not notes.
  if (/^[a-z][a-z0-9+.-]*:/i.test(d) || d.startsWith('//')) return undefined;
  d = d.split('#')[0]!.split('?')[0]!;
  if (!d) return undefined;
  try {
    d = decodeURIComponent(d);
  } catch {
    // Keep a half-encoded path as written rather than dropping the link.
  }
  if (d.endsWith('/')) return undefined; // a folder, not a note
  const path = normalizePosixPath(fromRoot || d.startsWith('/') ? d : dir + d);
  if (!path) return undefined;
  if (/\.md$/i.test(path)) return path;
  // `related` is a list of notes, so a missing extension is just shorthand.
  return fromRoot && !/\.[a-z0-9]{1,8}$/i.test(path) ? `${path}.md` : undefined;
}

/** Reference labels are matched case-insensitively, with runs of space collapsed. */
function refLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

function relatedValues(frontmatter: Record<string, unknown> | undefined): string[] {
  const v = frontmatter?.['related'];
  const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return list.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
}

/**
 * Every link out of one note: `[[wiki links]]`, Markdown links to `.md` files
 * (relative to the note's folder) and the `related` list in its frontmatter
 * (relative to the repository root). De-duplicated per kind and target.
 */
export function extractNoteLinks(
  src: string,
  body: string,
  frontmatter?: Record<string, unknown>,
): NoteLink[] {
  const out: NoteLink[] = [];
  const seen = new Set<string>();
  const add = (kind: LinkKind, target: string | undefined, embed = false) => {
    if (!target) return;
    const key = `${kind} ${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(embed ? { target, kind, embed } : { target, kind });
  };

  for (const l of extractLinks(body)) add('wikilink', l.target, l.embed);

  const dir = src.replace(/\\/g, '/').replace(/[^/]*$/, '');
  // Wiki links are already in; blanking them keeps `[[a]](b)` from reading as a Markdown link.
  const text = stripCode(body).replace(WIKILINK_RE, ' ');
  for (const m of text.matchAll(MD_INLINE_RE))
    if (m[1] !== '!') add('markdown', linkedNotePath(m[2] ?? '', dir));
  const defs = new Map<string, string>();
  for (const m of text.matchAll(MD_REF_DEF_RE)) defs.set(refLabel(m[1]!), m[2]!);
  for (const m of text.matchAll(MD_REF_USE_RE)) {
    if (m[1] === '!') continue;
    // `[text][]` (collapsed) uses the text as its label.
    const dest = defs.get(refLabel(m[3] || m[2] || ''));
    if (dest) add('markdown', linkedNotePath(dest, dir));
  }

  for (const r of relatedValues(frontmatter))
    add('related', linkedNotePath(r, '', { fromRoot: true }));
  return out;
}

/**
 * The note a link points at, or undefined when nothing matches. Wiki links
 * resolve Obsidian-style; paths from Markdown links and `related` are already
 * absolute and have to match a note exactly (case included).
 */
export function resolveNoteLink(link: NoteLink, paths: ReadonlySet<string>): string | undefined {
  return link.kind === 'wikilink'
    ? resolveLink(link.target, paths)
    : paths.has(link.target)
      ? link.target
      : undefined;
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
  return target.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.md$/i, '').trim().toLowerCase();
}

/**
 * Resolve a wiki link target against the list of note paths.
 * Exact path match wins; otherwise the shortest path whose basename matches.
 */
export function resolveLink(target: string, paths: Iterable<string>): string | undefined {
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
  return body.replace(
    WIKILINK_RE,
    (whole, bang: string, target: string, heading?: string, alias?: string) => {
      const k = linkKey(target);
      let replacement: string | undefined;
      if (k === oldKey) replacement = target.includes('/') ? newName : newBase;
      else if (k === oldBase && !target.includes('/')) replacement = newBase;
      if (replacement === undefined) return whole;
      return `${bang}[[${replacement}${heading !== undefined ? '#' + heading : ''}${alias !== undefined ? '|' + alias : ''}]]`;
    },
  );
}
