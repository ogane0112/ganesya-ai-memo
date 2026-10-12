import { type Frontmatter, parseNote } from '@gmemo/core';

/**
 * Note properties (frontmatter) as the properties panel edits them. The panel
 * and the Markdown source are two views of the same text: the panel only ever
 * rewrites the frontmatter block, so the body, the cursor and undo history in
 * the editor are left alone.
 */

/** Properties with their own control in the panel. */
export const KNOWN_PROPS = ['date', 'end', 'tags', 'status', 'ai', 'sensitivity'] as const;
/** Kept as they are and not shown: written by the app itself or edited elsewhere. */
export const SYSTEM_PROPS = new Set(['title', 'created_by', 'ai_agent']);

export const STATUS_SUGGESTIONS = ['未着手', '進行中', '保留', '完了'];

export const AI_OPTIONS = [
  { value: '', label: 'フォルダの設定に従う' },
  { value: 'external', label: '外部AIにも送ってよい' },
  { value: 'local', label: 'ローカルAIのみ' },
  { value: 'none', label: 'AIに送らない' },
] as const;

export type PropsRead =
  { ok: true; frontmatter: Frontmatter; head: string } | { ok: false; error: string };

/**
 * The note's frontmatter, plus the exact text of the frontmatter block
 * (`head`, empty when there is none). Broken YAML is reported, not guessed at:
 * editing over it would throw away whatever the person was in the middle of.
 */
export function readProps(text: string): PropsRead {
  try {
    const parsed = parseNote(text);
    return {
      ok: true,
      frontmatter: parsed.frontmatter,
      head: text.slice(0, text.length - parsed.body.length),
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** A date property as the panel shows it: whether it has a time, and the input value. */
export interface DateField {
  allDay: boolean;
  /** `YYYY-MM-DD` (all day) or `YYYY-MM-DDTHH:mm` (for <input type="datetime-local">). */
  input: string;
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2}))?/;

/** Read a stored date (`2026-10-12`, `2026-10-12 10:00`, `2026-10-12T10:00:00+09:00`…). */
export function toDateField(v: unknown): DateField | null {
  if (typeof v !== 'string') return null;
  const m = DATE_RE.exec(v.trim());
  if (!m) return null;
  if (!m[2]) return { allDay: true, input: m[1]! };
  return { allDay: false, input: `${m[1]}T${m[2].padStart(2, '0')}:${m[3]}` };
}

/** The value to store: `2026-10-12` or `2026-10-12 10:00` (read in the app's time zone). */
export function fromDateField(f: DateField): string | undefined {
  if (!f.input) return undefined;
  const m = DATE_RE.exec(f.input);
  if (!m) return undefined;
  if (f.allDay || !m[2]) return m[1];
  return `${m[1]} ${m[2].padStart(2, '0')}:${m[3]}`;
}

/** Switch between all-day and timed, keeping the day (a new time starts at 09:00). */
export function toggleAllDay(f: DateField, allDay: boolean): DateField {
  const day = f.input.slice(0, 10);
  if (!day) return { allDay, input: '' };
  return allDay ? { allDay, input: day } : { allDay, input: `${day}T09:00` };
}

/** Tags as a list, whatever shape they were written in (list, or "a, b"). */
export function readTags(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return [...new Set(list.map((t) => String(t).trim().replace(/^#/, '')).filter(Boolean))];
}

/** Properties without a control of their own, shown as editable text when they are text. */
export function otherProps(fm: Frontmatter): { key: string; value: unknown; editable: boolean }[] {
  return Object.entries(fm)
    .filter(([k]) => !SYSTEM_PROPS.has(k) && !(KNOWN_PROPS as readonly string[]).includes(k))
    .map(([key, value]) => ({
      key,
      value,
      editable: typeof value === 'string' || typeof value === 'number' || value === null,
    }));
}

/** Property names people can type: letters, digits, `_` and `-`, not starting with a digit. */
export function validPropName(name: string): boolean {
  return /^[A-Za-z_぀-ヿ㐀-鿿][\w\-぀-ヿ㐀-鿿]*$/.test(name);
}

/** Text typed for an "other" property: kept as a number if the old value was one and it still is. */
export function typedValue(old: unknown, text: string): unknown {
  if (typeof old === 'number' && text.trim() !== '' && Number.isFinite(Number(text)))
    return Number(text);
  return text;
}
