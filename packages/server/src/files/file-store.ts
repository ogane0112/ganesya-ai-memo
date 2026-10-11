/**
 * Where uploaded files (attachments) are kept when they do not go into the note
 * store: object storage, one prefix per user. Notes never live here.
 *
 * Files travel as streams with a known size, so a large upload is never held
 * in memory more than once.
 */
export interface StoredFile {
  body: ReadableStream<Uint8Array>;
  size: number;
}

export interface FileStore {
  put(key: string, body: ReadableStream<Uint8Array>, size: number): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  /** Remove every object whose key starts with `prefix` (account deletion). */
  deletePrefix(prefix: string): Promise<void>;
}

/** The key of a user's file. `path` is the path notes link to (`files/…`). */
export function fileKey(userId: string, path: string): string {
  return `${userId}/${path}`;
}

export function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.length) controller.enqueue(bytes);
      controller.close();
    },
  });
}

export async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Minimal structural types for an R2 bucket binding (avoids a hard dependency on workers-types). */
export interface R2BucketLike {
  put(key: string, value: ReadableStream<Uint8Array>): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
  list(options: {
    prefix: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  delete(keys: string | string[]): Promise<void>;
}

/** Workers runtime: a stream that tells its consumer how long it is (R2 needs to know). */
declare const FixedLengthStream: {
  new (length: number): TransformStream<Uint8Array, Uint8Array>;
};

/** Workers adapter: a Cloudflare R2 bucket. */
export class R2FileStore implements FileStore {
  constructor(private readonly bucket: R2BucketLike) {}

  async put(key: string, body: ReadableStream<Uint8Array>, size: number): Promise<void> {
    await this.bucket.put(key, body.pipeThrough(new FixedLengthStream(size)));
  }

  async get(key: string): Promise<StoredFile | null> {
    const o = await this.bucket.get(key);
    return o ? { body: o.body, size: o.size } : null;
  }

  async deletePrefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      if (page.objects.length) await this.bucket.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
}

/** In-memory store for tests. */
export class MemoryFileStore implements FileStore {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, body: ReadableStream<Uint8Array>, size: number): Promise<void> {
    const data = await bytesOf(body);
    if (data.length !== size) throw new Error(`expected ${size} bytes, got ${data.length}`);
    this.objects.set(key, data);
  }

  async get(key: string): Promise<StoredFile | null> {
    const data = this.objects.get(key);
    return data ? { body: streamOf(data), size: data.length } : null;
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.objects.keys()])
      if (key.startsWith(prefix)) this.objects.delete(key);
  }
}
