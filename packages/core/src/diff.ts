/** A changed region: `o[oStart, oStart+oLen)` was replaced by `n[nStart, nStart+nLen)`. */
export interface Hunk {
  oStart: number;
  oLen: number;
  nStart: number;
  nLen: number;
}

/**
 * Longest-common-subsequence diff over arbitrary keys. Returns the changed hunks.
 * Common prefix/suffix are trimmed first so typical edits stay cheap.
 */
export function diffHunks<T>(
  o: readonly T[],
  n: readonly T[],
  eq: (a: T, b: T) => boolean = Object.is,
): Hunk[] {
  let pre = 0;
  while (pre < o.length && pre < n.length && eq(o[pre]!, n[pre]!)) pre++;
  let suf = 0;
  while (
    suf < o.length - pre &&
    suf < n.length - pre &&
    eq(o[o.length - 1 - suf]!, n[n.length - 1 - suf]!)
  )
    suf++;

  const a = o.slice(pre, o.length - suf);
  const b = n.slice(pre, n.length - suf);
  const rows = a.length;
  const cols = b.length;
  if (rows === 0 && cols === 0) return [];
  if (rows === 0 || cols === 0) return [{ oStart: pre, oLen: rows, nStart: pre, nLen: cols }];

  // dp[i][j] = LCS length of a[i:], b[j:]
  const width = cols + 1;
  const dp = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      dp[i * width + j] = eq(a[i]!, b[j]!)
        ? dp[(i + 1) * width + j + 1]! + 1
        : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
    }
  }

  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let cur: Hunk | undefined;
  const flush = () => {
    if (cur && (cur.oLen > 0 || cur.nLen > 0)) hunks.push(cur);
    cur = undefined;
  };
  while (i < rows || j < cols) {
    if (i < rows && j < cols && eq(a[i]!, b[j]!)) {
      flush();
      i++;
      j++;
    } else {
      cur ??= { oStart: pre + i, oLen: 0, nStart: pre + j, nLen: 0 };
      if (j < cols && (i >= rows || dp[i * width + j + 1]! >= dp[(i + 1) * width + j]!)) {
        cur.nLen++;
        j++;
      } else {
        cur.oLen++;
        i++;
      }
    }
  }
  flush();
  return hunks;
}

export type Diff3Region<T> =
  { type: 'stable'; items: T[] } | { type: 'conflict'; base: T[]; ours: T[]; theirs: T[] };

interface SidedHunk extends Hunk {
  side: 'ours' | 'theirs';
}

function overlaps(h: Hunk, start: number, end: number): boolean {
  const hEnd = h.oStart + h.oLen;
  if (h.oLen === 0 && start === end) return h.oStart === start;
  if (h.oLen === 0) return h.oStart > start && h.oStart < end;
  if (start === end) return start > h.oStart && start < hEnd;
  return h.oStart < end && start < hEnd;
}

/**
 * Three-way merge of sequences. Non-overlapping changes from both sides are
 * combined; overlapping changes that differ become conflict regions.
 * Edits to *adjacent* items (e.g. neighbouring paragraphs) do not conflict.
 */
export function diff3<T>(
  base: readonly T[],
  ours: readonly T[],
  theirs: readonly T[],
  eq: (a: T, b: T) => boolean = Object.is,
): Diff3Region<T>[] {
  const hunks: SidedHunk[] = [
    ...diffHunks(base, ours, eq).map((h) => ({ ...h, side: 'ours' as const })),
    ...diffHunks(base, theirs, eq).map((h) => ({ ...h, side: 'theirs' as const })),
  ].sort((x, y) => x.oStart - y.oStart || x.oLen - y.oLen || (x.side === 'ours' ? -1 : 1));

  const out: Diff3Region<T>[] = [];
  const pushStable = (items: T[]) => {
    if (items.length === 0) return;
    const last = out[out.length - 1];
    if (last?.type === 'stable') last.items.push(...items);
    else out.push({ type: 'stable', items });
  };

  let offset = 0;
  let idx = 0;
  while (idx < hunks.length) {
    const first = hunks[idx]!;
    let start = first.oStart;
    let end = first.oStart + first.oLen;
    const group: SidedHunk[] = [first];
    idx++;
    let grew = true;
    while (grew && idx < hunks.length) {
      grew = false;
      const h = hunks[idx]!;
      if (overlaps(h, start, end) || group.some((g) => overlaps(h, g.oStart, g.oStart + g.oLen))) {
        group.push(h);
        start = Math.min(start, h.oStart);
        end = Math.max(end, h.oStart + h.oLen);
        idx++;
        grew = true;
      }
    }

    pushStable(base.slice(offset, start) as T[]);

    const sideContent = (side: 'ours' | 'theirs', seq: readonly T[]): T[] | undefined => {
      const hs = group.filter((g) => g.side === side);
      if (hs.length === 0) return undefined;
      const h0 = hs[0]!;
      const hN = hs[hs.length - 1]!;
      const from = h0.nStart - (h0.oStart - start);
      const to = hN.nStart + hN.nLen + (end - (hN.oStart + hN.oLen));
      return seq.slice(from, to) as T[];
    };
    const o = sideContent('ours', ours);
    const t = sideContent('theirs', theirs);
    if (o === undefined) pushStable(t ?? []);
    else if (t === undefined) pushStable(o);
    else if (o.length === t.length && o.every((v, k) => eq(v, t[k]!))) pushStable(o);
    else out.push({ type: 'conflict', base: base.slice(start, end) as T[], ours: o, theirs: t });

    offset = end;
  }
  pushStable(base.slice(offset) as T[]);
  return out;
}

export type DiffOp<T> =
  | { op: 'equal'; items: T[] }
  | { op: 'delete'; items: T[] }
  | { op: 'insert'; items: T[] }
  | { op: 'replace'; from: T[]; to: T[] };

/** Two-way diff as a list of operations, for display. */
export function diffOps<T>(
  o: readonly T[],
  n: readonly T[],
  eq: (a: T, b: T) => boolean = Object.is,
): DiffOp<T>[] {
  const ops: DiffOp<T>[] = [];
  let oi = 0;
  for (const h of diffHunks(o, n, eq)) {
    if (h.oStart > oi) ops.push({ op: 'equal', items: o.slice(oi, h.oStart) as T[] });
    const from = o.slice(h.oStart, h.oStart + h.oLen) as T[];
    const to = n.slice(h.nStart, h.nStart + h.nLen) as T[];
    if (from.length && to.length) ops.push({ op: 'replace', from, to });
    else if (from.length) ops.push({ op: 'delete', items: from });
    else ops.push({ op: 'insert', items: to });
    oi = h.oStart + h.oLen;
  }
  if (oi < o.length) ops.push({ op: 'equal', items: o.slice(oi) as T[] });
  return ops;
}
