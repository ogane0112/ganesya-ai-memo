/**
 * Block (paragraph) level segmentation of a Markdown body.
 *
 * A block is a paragraph, a heading, a single top-level list item, a fenced code
 * block, a block quote, or a table. Each block keeps its raw text including the
 * trailing newline(s), so `blocks.map(b => b.raw).join('')` reproduces the body
 * exactly. Comparisons use `key` (whitespace-trimmed text).
 */
export interface Block {
  raw: string;
  key: string;
  kind: BlockKind;
}

export type BlockKind = 'paragraph' | 'heading' | 'list' | 'code' | 'quote' | 'table' | 'blank';

const HEADING_RE = /^ {0,3}#{1,6}(\s|$)/;
const LIST_RE = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const QUOTE_RE = /^ {0,3}>/;
const TABLE_RE = /^ {0,3}\|/;
const HR_RE = /^ {0,3}([-*_])( *\1){2,} *$/;

function isBlank(line: string): boolean {
  return line.trim() === '';
}

export function splitBlocks(body: string): Block[] {
  if (body === '') return [];
  // Keep line terminators attached so raw text round-trips.
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const blocks: Block[] = [];
  let leading = '';
  let i = 0;

  const push = (raw: string, kind: BlockKind) => {
    blocks.push({ raw: leading + raw, key: raw.trim(), kind });
    leading = '';
  };

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const text = line.replace(/\r?\n$/, '');

    if (isBlank(text)) {
      // Blank lines belong to the preceding block (or lead the first one).
      const last = blocks[blocks.length - 1];
      if (last) last.raw += line;
      else leading += line;
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(text);
    if (fence) {
      const marker = fence[1] ?? '```';
      let raw = line;
      i++;
      while (i < lines.length) {
        const l = lines[i] ?? '';
        raw += l;
        i++;
        if (
          l.trimStart().startsWith(marker[0]!.repeat(marker.length)) &&
          l.trim().replace(/[`~]/g, '') === ''
        )
          break;
      }
      push(raw, 'code');
      continue;
    }

    if (HEADING_RE.test(text) || HR_RE.test(text)) {
      push(line, 'heading');
      i++;
      continue;
    }

    if (LIST_RE.test(text)) {
      // One block per top-level list item, including its indented continuation.
      let raw = line;
      i++;
      while (i < lines.length) {
        const l = (lines[i] ?? '').replace(/\r?\n$/, '');
        if (isBlank(l)) break;
        if (LIST_RE.test(l) || HEADING_RE.test(l) || FENCE_RE.test(l)) break;
        raw += lines[i];
        i++;
      }
      push(raw, 'list');
      continue;
    }

    const kind: BlockKind = QUOTE_RE.test(text)
      ? 'quote'
      : TABLE_RE.test(text)
        ? 'table'
        : 'paragraph';
    let raw = line;
    i++;
    while (i < lines.length) {
      const l = (lines[i] ?? '').replace(/\r?\n$/, '');
      if (isBlank(l) || HEADING_RE.test(l) || FENCE_RE.test(l)) break;
      if (kind === 'paragraph' && LIST_RE.test(l)) break;
      raw += lines[i];
      i++;
    }
    push(raw, kind);
  }

  if (leading) blocks.push({ raw: leading, key: '', kind: 'blank' });
  return blocks;
}

/**
 * Join blocks produced from different versions. Ensures blocks are separated
 * correctly even when a block that used to be last is now followed by another.
 */
export function joinBlocks(blocks: readonly Block[]): string {
  let out = '';
  blocks.forEach((b, idx) => {
    let raw = b.raw;
    const next = blocks[idx + 1];
    if (next) {
      if (!raw.endsWith('\n')) raw += '\n';
      const tightList = b.kind === 'list' && next.kind === 'list';
      if (!tightList && !/\n[ \t]*\n$/.test(raw)) raw += '\n';
    }
    out += raw;
  });
  return out;
}
