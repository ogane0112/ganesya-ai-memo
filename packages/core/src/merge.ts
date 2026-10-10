import { type Block, joinBlocks, splitBlocks } from './blocks.js';
import { diff3 } from './diff.js';
import { deepEqual, type Frontmatter, parseNoteLenient, serializeNote } from './frontmatter.js';

export interface FrontmatterConflict {
  key: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
}

export interface BlockConflict {
  base: string;
  ours: string;
  theirs: string;
}

export type MergeSegment =
  { type: 'stable'; text: string } | { type: 'conflict'; index: number; conflict: BlockConflict };

export interface NoteMergeResult {
  clean: boolean;
  frontmatter: Frontmatter;
  frontmatterConflicts: FrontmatterConflict[];
  segments: MergeSegment[];
  /** Merged text. Where conflicts exist, "ours" is used provisionally. */
  text: string;
}

export type Choice = 'ours' | 'theirs' | 'both' | { custom: string };

const MISSING = Symbol('missing');

function isScalarArray(v: unknown): v is (string | number | boolean)[] {
  return Array.isArray(v) && v.every((x) => ['string', 'number', 'boolean'].includes(typeof x));
}

/** Set-style merge of scalar arrays (e.g. tags): keep additions from both sides, apply removals from both. */
function mergeScalarArrays(base: unknown[], ours: unknown[], theirs: unknown[]): unknown[] {
  const removed = new Set(base.filter((x) => !ours.includes(x) || !theirs.includes(x)));
  const out: unknown[] = [];
  for (const x of [...ours, ...theirs]) {
    if (!out.includes(x) && !removed.has(x)) out.push(x);
  }
  return out;
}

/**
 * Key-level three-way merge of YAML frontmatter. Keys changed on only one side
 * merge cleanly; scalar arrays are merged as sets; anything else that both sides
 * changed differently is a conflict.
 */
export function mergeFrontmatter(
  base: Frontmatter,
  ours: Frontmatter,
  theirs: Frontmatter,
): { merged: Frontmatter; conflicts: FrontmatterConflict[] } {
  const keys: string[] = [];
  for (const k of [...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base)]) {
    if (!keys.includes(k)) keys.push(k);
  }
  const merged: Frontmatter = {};
  const conflicts: FrontmatterConflict[] = [];
  const get = (o: Frontmatter, k: string) => (Object.hasOwn(o, k) ? o[k] : MISSING);

  for (const k of keys) {
    const b = get(base, k);
    const o = get(ours, k);
    const t = get(theirs, k);
    let value: unknown;
    if (deepEqual(o, t)) value = o;
    else if (deepEqual(o, b)) value = t;
    else if (deepEqual(t, b)) value = o;
    else if (isScalarArray(o) && isScalarArray(t) && (b === MISSING || isScalarArray(b))) {
      value = mergeScalarArrays(b === MISSING ? [] : (b as unknown[]), o, t);
    } else {
      conflicts.push({
        key: k,
        base: b === MISSING ? undefined : b,
        ours: o === MISSING ? undefined : o,
        theirs: t === MISSING ? undefined : t,
      });
      value = o;
    }
    if (value !== MISSING) merged[k] = value;
  }
  return { merged, conflicts };
}

function blocksText(blocks: Block[]): string {
  return joinBlocks(blocks);
}

/**
 * Three-way merge of whole notes: frontmatter by key, body by paragraph block.
 * `null` stands for "file does not exist" on that side.
 */
export function mergeNotes(
  base: string | null,
  ours: string | null,
  theirs: string | null,
): NoteMergeResult {
  const b = parseNoteLenient(base ?? '');
  const o = parseNoteLenient(ours ?? '');
  const t = parseNoteLenient(theirs ?? '');

  const fm = mergeFrontmatter(b.frontmatter, o.frontmatter, t.frontmatter);
  const regions = diff3(
    splitBlocks(b.body),
    splitBlocks(o.body),
    splitBlocks(t.body),
    (x, y) => x.key === y.key,
  );

  const segments: MergeSegment[] = [];
  let conflictIndex = 0;
  const pending: Block[] = [];
  const flushStable = () => {
    if (pending.length) segments.push({ type: 'stable', text: blocksText(pending.splice(0)) });
  };
  for (const r of regions) {
    if (r.type === 'stable') pending.push(...r.items);
    else {
      flushStable();
      segments.push({
        type: 'conflict',
        index: conflictIndex++,
        conflict: {
          base: blocksText(r.base),
          ours: blocksText(r.ours),
          theirs: blocksText(r.theirs),
        },
      });
    }
  }
  flushStable();

  const clean = fm.conflicts.length === 0 && conflictIndex === 0;
  const result: NoteMergeResult = {
    clean,
    frontmatter: fm.merged,
    frontmatterConflicts: fm.conflicts,
    segments,
    text: '',
  };
  result.text = renderMerge(result, {});
  return result;
}

export interface Resolution {
  /** Per block conflict index. Defaults to 'ours'. */
  blocks?: Record<number, Choice>;
  /** Per frontmatter key. Defaults to 'ours'. */
  frontmatter?: Record<string, 'ours' | 'theirs'>;
}

function pick(c: BlockConflict, choice: Choice): string {
  if (choice === 'ours') return c.ours;
  if (choice === 'theirs') return c.theirs;
  if (choice === 'both') {
    return (
      [c.ours, c.theirs]
        .map((s) => s.trimEnd())
        .filter(Boolean)
        .join('\n\n') + '\n'
    );
  }
  return choice.custom;
}

/** Produce the final note text for a merge result and a set of conflict choices. */
export function renderMerge(result: NoteMergeResult, resolution: Resolution): string {
  const fm: Frontmatter = { ...result.frontmatter };
  for (const c of result.frontmatterConflicts) {
    const choice = resolution.frontmatter?.[c.key] ?? 'ours';
    const v = choice === 'ours' ? c.ours : c.theirs;
    if (v === undefined) delete fm[c.key];
    else fm[c.key] = v;
  }
  const parts: Block[] = [];
  for (const s of result.segments) {
    const text =
      s.type === 'stable' ? s.text : pick(s.conflict, resolution.blocks?.[s.index] ?? 'ours');
    if (text.trim() === '') continue;
    parts.push(...splitBlocks(text));
  }
  return serializeNote(fm, joinBlocks(parts));
}

/** Render with git-style conflict markers (used by the git merge driver). */
export function renderWithMarkers(
  result: NoteMergeResult,
  oursLabel = 'ours',
  theirsLabel = 'theirs',
): string {
  const fm: Frontmatter = { ...result.frontmatter };
  let body = '';
  for (const s of result.segments) {
    if (s.type === 'stable') body += ensureBreak(s.text);
    else {
      body += `<<<<<<< ${oursLabel}\n${ensureNl(s.conflict.ours)}=======\n${ensureNl(s.conflict.theirs)}>>>>>>> ${theirsLabel}\n\n`;
    }
  }
  let text = serializeNote(fm, body.replace(/\n+$/, '\n'));
  if (result.frontmatterConflicts.length) {
    const lines = result.frontmatterConflicts.map(
      (c) => `#   ${c.key}: ours=${JSON.stringify(c.ours)} theirs=${JSON.stringify(c.theirs)}`,
    );
    text = `<<<<<<< frontmatter conflicts (kept ours)\n${lines.join('\n')}\n>>>>>>>\n` + text;
  }
  return text;
}

function ensureNl(s: string): string {
  return s.endsWith('\n') ? s : s + '\n';
}
function ensureBreak(s: string): string {
  return /\n\s*\n$/.test(s) ? s : ensureNl(s) + '\n';
}
