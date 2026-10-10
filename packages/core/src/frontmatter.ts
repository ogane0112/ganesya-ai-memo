import { parseDocument, stringify } from 'yaml';

export type Frontmatter = Record<string, unknown>;

export interface ParsedNote {
  /** Parsed YAML frontmatter. Empty object when the note has none. */
  frontmatter: Frontmatter;
  /** Whether the source text contained a frontmatter block at all. */
  hasFrontmatter: boolean;
  /** Markdown body after the frontmatter block. */
  body: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;

export class FrontmatterError extends Error {}

/** Split a Markdown note into YAML frontmatter and body. */
export function parseNote(text: string): ParsedNote {
  const m = FM_RE.exec(text);
  if (!m) return { frontmatter: {}, hasFrontmatter: false, body: text };
  const raw = m[1] ?? '';
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new FrontmatterError(doc.errors[0]?.message ?? 'invalid frontmatter');
  }
  const value: unknown = doc.toJS();
  const frontmatter =
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Frontmatter) : {};
  return { frontmatter, hasFrontmatter: true, body: text.slice(m[0].length) };
}

/** Lenient variant: broken YAML is treated as "no frontmatter" instead of throwing. */
export function parseNoteLenient(text: string): ParsedNote {
  try {
    return parseNote(text);
  } catch {
    return { frontmatter: {}, hasFrontmatter: false, body: text };
  }
}

/** Serialize frontmatter + body back into note text. Key order is preserved. */
export function serializeNote(frontmatter: Frontmatter, body: string): string {
  const keys = Object.keys(frontmatter).filter((k) => frontmatter[k] !== undefined);
  if (keys.length === 0) return body;
  const clean: Frontmatter = {};
  for (const k of keys) clean[k] = frontmatter[k];
  const yaml = stringify(clean, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}

/** Return a copy of the note with some frontmatter keys replaced. `undefined` deletes a key. */
export function updateFrontmatter(text: string, patch: Frontmatter): string {
  const { frontmatter, body } = parseNoteLenient(text);
  const next: Frontmatter = { ...frontmatter };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return serializeNote(next, body);
}

/** Note title: frontmatter `title`, else first H1, else file name. */
export function noteTitle(path: string, parsed: ParsedNote): string {
  const t = parsed.frontmatter['title'];
  if (typeof t === 'string' && t.trim()) return t.trim();
  const h1 = /^#\s+(.+)$/m.exec(parsed.body);
  if (h1?.[1]) return h1[1].trim();
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}
