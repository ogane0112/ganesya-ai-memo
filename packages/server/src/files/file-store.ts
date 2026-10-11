/**
 * Where uploaded files (attachments) are kept when they do not go into the note
 * store: object storage, one prefix per user. Notes never live here.
 */
export interface StoredFile {
  body: ReadableStream<Uint8Array> | Uint8Array;
  size: number;
  contentType: string | null;
}

export interface FileStore {
  put(key: string, data: Uint8Array, opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  /** Remove every object whose key starts with `prefix` (account deletion). */
  deletePrefix(prefix: string): Promise<void>;
}

/** The key of a user's file. `path` is the path notes link to (`files/…`). */
export function fileKey(userId: string, path: string): string {
  return `${userId}/${path}`;
}

/** Minimal structural types for an R2 bucket binding (avoids a hard dependency on workers-types). */
export interface R2ObjectBodyLike {
  body: ReadableStream<Uint8Array>;
  size: number;
  httpMetadata?: { contentType?: string };
}
export interface R2BucketLike {
  put(
    key: string,
    value: Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  list(options: {
    prefix: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  delete(keys: string | string[]): Promise<void>;
}

/** Workers adapter: a Cloudflare R2 bucket. */
export class R2FileStore implements FileStore {
  constructor(private readonly bucket: R2BucketLike) {}

  async put(key: string, data: Uint8Array, opts: { contentType?: string } = {}): Promise<void> {
    await this.bucket.put(
      key,
      data,
      opts.contentType ? { httpMetadata: { contentType: opts.contentType } } : undefined,
    );
  }

  async get(key: string): Promise<StoredFile | null> {
    const o = await this.bucket.get(key);
    return o
      ? { body: o.body, size: o.size, contentType: o.httpMetadata?.contentType ?? null }
      : null;
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
  readonly objects = new Map<string, { data: Uint8Array; contentType: string | null }>();

  async put(key: string, data: Uint8Array, opts: { contentType?: string } = {}): Promise<void> {
    this.objects.set(key, { data, contentType: opts.contentType ?? null });
  }

  async get(key: string): Promise<StoredFile | null> {
    const o = this.objects.get(key);
    return o ? { body: o.data, size: o.data.length, contentType: o.contentType } : null;
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.objects.keys()])
      if (key.startsWith(prefix)) this.objects.delete(key);
  }
}
