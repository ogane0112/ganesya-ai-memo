/**
 * Git object encoding with WebCrypto SHA-1, so ids are identical to what real
 * git (and GitHub) would compute for the same content.
 */
import { asBytes, toUtf8 } from './types.js';

export async function sha1Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-1', data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Hash an object exactly like `git hash-object -t <type>`. */
export async function objectId(type: 'blob' | 'tree' | 'commit', body: Uint8Array): Promise<string> {
  return sha1Hex(concat([toUtf8(`${type} ${body.length}\0`), body]));
}

export function blobId(content: string | Uint8Array): Promise<string> {
  return objectId('blob', asBytes(content));
}

export interface TreeEntry {
  name: string;
  type: 'blob' | 'tree';
  sha: string;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Git sorts tree entries by name, treating directory names as if they ended in '/'. */
function sortKey(e: TreeEntry): string {
  return e.type === 'tree' ? `${e.name}/` : e.name;
}

export function encodeTree(entries: TreeEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => {
    const x = toUtf8(sortKey(a));
    const y = toUtf8(sortKey(b));
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
    return x.length - y.length;
  });
  return concat(
    sorted.flatMap((e) => [toUtf8(`${e.type === 'tree' ? '40000' : '100644'} ${e.name}\0`), hexToBytes(e.sha)]),
  );
}

export function decodeTree(data: Uint8Array): TreeEntry[] {
  const out: TreeEntry[] = [];
  const dec = new TextDecoder();
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0, sp);
    const mode = dec.decode(data.subarray(i, sp));
    const name = dec.decode(data.subarray(sp + 1, nul));
    const sha = bytesToHex(data.subarray(nul + 1, nul + 21));
    out.push({ name, type: mode === '40000' ? 'tree' : 'blob', sha });
    i = nul + 21;
  }
  return out;
}

export interface CommitData {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** ISO date */
  date: string;
  committerName: string;
  committerEmail: string;
  message: string;
}

function gitDate(iso: string): string {
  return `${Math.floor(Date.parse(iso) / 1000)} +0000`;
}

export function encodeCommit(c: CommitData): Uint8Array {
  const lines = [`tree ${c.tree}`, ...c.parents.map((p) => `parent ${p}`)];
  lines.push(`author ${c.authorName} <${c.authorEmail}> ${gitDate(c.date)}`);
  lines.push(`committer ${c.committerName} <${c.committerEmail}> ${gitDate(c.date)}`);
  return toUtf8(`${lines.join('\n')}\n\n${c.message}`);
}

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
