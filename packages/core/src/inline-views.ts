import { parse, stringify } from 'yaml';
import { splitBlocks } from './blocks.js';
import { parseNoteLenient } from './frontmatter.js';
import { ViewError } from './views.js';

/**
 * Inline views: a list of notes (table, kanban, calendar, list) placed inside
 * a note, like an inline database in Notion. In the Markdown they are a fenced
 * block, so other Markdown tools simply show the settings as code:
 *
 *     ```gmemo-view
 *     name: タスク
 *     type: kanban
 *     folder: Projects/プロジェクトA/タスク
 *     ```
 *
 * The settings are the same as a saved view (.views/*.yaml).
 */
export const INLINE_VIEW_LANG = 'gmemo-view';

const OPEN_RE = /^([ \t]*)(`{3,}|~{3,})[ \t]*gmemo-view[ \t]*$/;

export interface InlineViewBlock {
  /** Position among the note's inline views (0-based). */
  index: number;
  /** The YAML between the fences. */
  source: string;
  /** Character range of that YAML in the full note text (frontmatter included). */
  from: number;
  to: number;
}

/** The YAML of a block if the block is an inline view, else null. */
export function inlineViewSource(blockText: string): string | null {
  const lines = blockText.replace(/^\s*\n/, '').split('\n');
  const open = OPEN_RE.exec((lines[0] ?? '').replace(/\r$/, ''));
  if (!open) return null;
  const close = closingLine(lines, open[2]!);
  if (close < 0) return null;
  return lines.slice(1, close).join('\n');
}

/** Index of the line that closes a fence opened with `marker`, or -1. */
function closingLine(lines: string[], marker: string): number {
  for (let i = lines.length - 1; i > 0; i--) {
    const t = lines[i]!.replace(/\r$/, '').trim();
    if (!t) continue;
    return t[0] === marker[0] && t.length >= marker.length && /^[`~]+$/.test(t) ? i : -1;
  }
  return -1;
}

/** Every inline view in a note, in order, with where its YAML sits in the text. */
export function findInlineViews(text: string): InlineViewBlock[] {
  const { body } = parseNoteLenient(text);
  let at = text.length - body.length;
  const out: InlineViewBlock[] = [];
  for (const b of splitBlocks(body)) {
    const raw = b.raw;
    const lines = raw.split('\n');
    // The block may start with blank lines it carries along.
    let first = 0;
    while (first < lines.length && !lines[first]!.trim()) first++;
    const open = OPEN_RE.exec((lines[first] ?? '').replace(/\r$/, ''));
    const close = open ? closingLine(lines.slice(first), open[2]!) : -1;
    if (open && close > 0) {
      const before = lines.slice(0, first + 1).join('\n').length + 1;
      const inner = lines.slice(first + 1, first + close).join('\n');
      out.push({
        index: out.length,
        source: inner,
        from: at + before,
        to: at + before + inner.length,
      });
    }
    at += raw.length;
  }
  return out;
}

/** The note text with inline view `index` given new YAML. Unchanged if there is no such view. */
export function replaceInlineView(text: string, index: number, source: string): string {
  const v = findInlineViews(text)[index];
  if (!v) return text;
  return text.slice(0, v.from) + source.replace(/\n+$/, '') + text.slice(v.to);
}

/**
 * Change some settings of an inline view's YAML, keeping the others (and
 * unknown keys). Throws on YAML that is not a mapping: rewriting it would
 * throw away whatever the person was in the middle of writing.
 */
export function patchInlineViewSource(source: string, patch: Record<string, unknown>): string {
  const raw: unknown = source.trim() ? parse(source) : {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ViewError('一覧の設定は「名前: 値」の形で書いてください');
  const next: Record<string, unknown> = { ...(raw as object) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === '') delete next[k];
    else next[k] = v;
  }
  return stringify(next, { lineWidth: 0 }).trimEnd();
}

/** A new inline view block, ready to insert into a note. */
export function inlineViewBlock(settings: Record<string, unknown>): string {
  return `\`\`\`${INLINE_VIEW_LANG}\n${patchInlineViewSource('', settings)}\n\`\`\`\n`;
}

/**
 * Where an inline view keeps its notes by default: a folder named after the
 * view, inside a folder named after the note ("Projects/A.md" + "タスク" →
 * "Projects/A/タスク"), so each list belongs to its note and lists never mix.
 */
export function inlineViewFolder(notePath: string, name: string): string {
  const base = notePath.replace(/\.md$/i, '');
  const safe = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|#^[\]\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base}/${safe || '一覧'}`;
}
