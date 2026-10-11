/**
 * Minimal tar reader/writer (ustar + pax path records) and gzip helpers built
 * on Compression Streams, available on Node and Cloudflare Workers. Used for
 * GitHub tarball snapshots and for exporting notes.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface TarFile {
  path: string;
  data: Uint8Array;
}

async function pipe(
  data: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const out = new Response(
    new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream),
  );
  return new Uint8Array(await out.arrayBuffer());
}

export const gzip = (data: Uint8Array) => pipe(data, new CompressionStream('gzip'));
export const gunzip = (data: Uint8Array) => pipe(data, new DecompressionStream('gzip'));

function field(block: Uint8Array, start: number, len: number): string {
  const raw = block.subarray(start, start + len);
  const end = raw.indexOf(0);
  return dec.decode(end < 0 ? raw : raw.subarray(0, end));
}

function octal(block: Uint8Array, start: number, len: number): number {
  return parseInt(field(block, start, len).trim() || '0', 8);
}

function paxRecords(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = dec.decode(data);
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(' ', i);
    if (sp < 0) break;
    const len = Number(text.slice(i, sp));
    if (!len) break;
    const rec = text.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Regular files in a tar archive. `stripComponents` drops leading path parts
 * (GitHub tarballs wrap everything in `owner-repo-sha/`).
 */
export function untar(tar: Uint8Array, stripComponents = 0): TarFile[] {
  const files: TarFile[] = [];
  let off = 0;
  let paxPath: string | null = null;
  let longName: string | null = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156]!);
    const dataStart = off + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      paxPath = paxRecords(data)['path'] ?? null;
      continue;
    }
    if (type === 'L') {
      longName = field(data, 0, data.length);
      continue;
    }
    if (type === 'g') continue;
    const prefix = field(h, 345, 155);
    const name = field(h, 0, 100);
    const full = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = null;
    longName = null;
    if (type !== '0' && type !== '\0') continue;
    const parts = full.split('/').slice(stripComponents);
    if (parts.length === 0 || parts.some((p) => p === '..' || p === '')) continue;
    files.push({ path: parts.join('/'), data: new Uint8Array(data) });
  }
  return files;
}

function header(name: string, size: number, type: string): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, start: number, len: number) =>
    h.set(enc.encode(s).subarray(0, len), start);
  put(name, 0, 100);
  put('0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  put(
    Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, '0') + '\0',
    136,
    12,
  );
  put('        ', 148, 8);
  put(type, 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

/** Build a tar archive. Long paths use pax records. */
export function tar(files: TarFile[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const pad = (n: number) => new Uint8Array((512 - (n % 512)) % 512);
  for (const f of files) {
    if (enc.encode(f.path).length > 99) {
      const body = (len: number) => `${len} path=${f.path}\n`;
      let len = enc.encode(body(0)).length;
      while (enc.encode(body(len)).length !== len) len = enc.encode(body(len)).length;
      const rec = enc.encode(body(len));
      chunks.push(header('PaxHeader', rec.length, 'x'), rec, pad(rec.length));
    }
    chunks.push(header(f.path, f.data.length, '0'), f.data, pad(f.data.length));
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
