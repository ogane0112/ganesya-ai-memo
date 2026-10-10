import { splitBlocks } from './blocks.js';
import { diffHunks } from './diff.js';
import { parseNoteLenient } from './frontmatter.js';

export interface Author {
  kind: 'human' | 'ai';
  /** Agent name for AI authors, user name for humans. */
  name: string;
}

export interface FileVersion {
  /** Note text at this version, or null if the file was deleted. */
  text: string | null;
  author: Author;
  commit: string;
  date: string;
}

export interface BlockAttribution {
  /** Index into `splitBlocks(body)` of the latest version. */
  index: number;
  text: string;
  author: Author;
  commit: string;
  date: string;
}

/**
 * Block-level blame: who last changed each paragraph of the latest version.
 * `versions` must be ordered oldest → newest.
 */
export function blameBlocks(versions: readonly FileVersion[]): BlockAttribution[] {
  let prevKeys: string[] = [];
  let attr: Omit<BlockAttribution, 'index' | 'text'>[] = [];
  let lastBlocks: string[] = [];

  for (const v of versions) {
    if (v.text === null) {
      prevKeys = [];
      attr = [];
      lastBlocks = [];
      continue;
    }
    const blocks = splitBlocks(parseNoteLenient(v.text).body).filter((b) => b.key !== '');
    const keys = blocks.map((b) => b.key);
    const next: Omit<BlockAttribution, 'index' | 'text'>[] = [];
    let oi = 0;
    let ni = 0;
    const mine = { author: v.author, commit: v.commit, date: v.date };
    for (const h of diffHunks(prevKeys, keys)) {
      while (ni < h.nStart) {
        next.push(attr[oi]!);
        oi++;
        ni++;
      }
      for (let k = 0; k < h.nLen; k++) next.push(mine);
      oi += h.oLen;
      ni += h.nLen;
    }
    while (ni < keys.length) {
      next.push(attr[oi]!);
      oi++;
      ni++;
    }
    prevKeys = keys;
    attr = next;
    lastBlocks = blocks.map((b) => b.raw);
  }
  return attr.map((a, index) => ({ ...a, index, text: lastBlocks[index] ?? '' }));
}
