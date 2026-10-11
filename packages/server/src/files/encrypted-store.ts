import { randomBytes } from '../util/crypto.js';
import type { FileStore, StoredFile } from './file-store.js';

/**
 * Encrypts files before they reach object storage, so the bucket only ever
 * holds ciphertext. The key comes from the server secret (GMEMO_SECRET_KEY) and
 * is different for every user. This protects the bucket's contents from anyone
 * who can read the bucket but not the secret; it is not end-to-end encryption,
 * because the server that holds the secret can decrypt.
 *
 * Format: "GMF1" | 8-byte nonce prefix | chunks. Each chunk is up to 64 KiB of
 * plaintext sealed with AES-256-GCM (16-byte tag). The nonce is the prefix plus
 * the chunk number, and the last chunk is marked in the authenticated data, so
 * chunks cannot be reordered, dropped or cut off without the read failing.
 */
const MAGIC = new Uint8Array([0x47, 0x4d, 0x46, 0x31]); // "GMF1"
const HEADER = MAGIC.length + 8;
const CHUNK = 64 * 1024;
const TAG = 16;

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const chunkCount = (plain: number) => Math.max(1, Math.ceil(plain / CHUNK));

/** Size in storage of a file of `plain` bytes. */
export function sealedSize(plain: number): number {
  return HEADER + plain + TAG * chunkCount(plain);
}

/** Size of the file inside `sealed` bytes of storage, or -1 if that is no valid size. */
export function openedSize(sealed: number): number {
  const body = sealed - HEADER;
  if (body < TAG) return -1;
  const chunks = Math.max(1, Math.ceil(body / (CHUNK + TAG)));
  const plain = body - TAG * chunks;
  return plain >= 0 && sealedSize(plain) === sealed ? plain : -1;
}

async function userKey(secret: string, userId: string): Promise<Key> {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('gmemo-files-v1'),
      info: new TextEncoder().encode(userId),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function nonce(prefix: Uint8Array, index: number): Uint8Array {
  const iv = new Uint8Array(12);
  iv.set(prefix);
  new DataView(iv.buffer).setUint32(8, index);
  return iv;
}

const params = (prefix: Uint8Array, index: number, last: boolean) => ({
  name: 'AES-GCM',
  iv: nonce(prefix, index),
  additionalData: new Uint8Array([last ? 1 : 0]),
});

/** Re-cuts a byte stream into pieces of exactly `size` bytes (the last one may be shorter). */
async function* pieces(
  stream: ReadableStream<Uint8Array>,
  size: number,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let buf = new Uint8Array(size);
  let filled = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let at = 0;
    while (at < value.length) {
      const n = Math.min(size - filled, value.length - at);
      buf.set(value.subarray(at, at + n), filled);
      filled += n;
      at += n;
      if (filled === size) {
        yield buf;
        buf = new Uint8Array(size);
        filled = 0;
      }
    }
  }
  if (filled) yield buf.subarray(0, filled);
}

function streamFrom(gen: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await gen.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
}

async function* seal(
  plain: ReadableStream<Uint8Array>,
  size: number,
  key: Key,
): AsyncGenerator<Uint8Array> {
  const prefix = randomBytes(8);
  const header = new Uint8Array(HEADER);
  header.set(MAGIC);
  header.set(prefix, MAGIC.length);
  yield header;
  const total = chunkCount(size);
  let index = 0;
  let seen = 0;
  const encrypt = async (chunk: Uint8Array) =>
    new Uint8Array(
      await crypto.subtle.encrypt(params(prefix, index, index === total - 1), key, chunk),
    );
  for await (const chunk of pieces(plain, CHUNK)) {
    seen += chunk.length;
    if (index >= total) throw new Error('file is longer than announced');
    yield await encrypt(chunk);
    index++;
  }
  if (seen !== size) throw new Error('file is shorter than announced');
  if (size === 0) yield await encrypt(new Uint8Array(0));
}

async function* open(
  sealed: ReadableStream<Uint8Array>,
  plainSize: number,
  keys: Key[],
): AsyncGenerator<Uint8Array> {
  const total = chunkCount(plainSize);
  const head: { prefix: Uint8Array | null } = { prefix: null };
  let key: Key | null = null;
  let index = 0;
  // The header is shorter than a chunk: read it first, then whole chunks.
  const rest = pieces(
    afterHeader(sealed, (h) => {
      head.prefix = h;
    }),
    CHUNK + TAG,
  );
  for await (const chunk of rest) {
    if (!head.prefix || index >= total) throw new Error('stored file is damaged');
    const p = params(head.prefix, index, index === total - 1);
    let plain: ArrayBuffer | null = null;
    // After a key rotation, older files still open with the previous key.
    const candidates: Key[] = key ? [key] : keys;
    for (const k of candidates) {
      try {
        plain = await crypto.subtle.decrypt(p, k, chunk);
        key = k;
        break;
      } catch {
        /* try the next key */
      }
    }
    if (!plain) throw new Error('stored file cannot be decrypted');
    index++;
    if (plain.byteLength) yield new Uint8Array(plain);
  }
  if (index !== total) throw new Error('stored file is incomplete');
}

/** Passes the stream on without its header, handing the nonce prefix to `onPrefix`. */
function afterHeader(
  stream: ReadableStream<Uint8Array>,
  onPrefix: (prefix: Uint8Array) => void,
): ReadableStream<Uint8Array> {
  const header = new Uint8Array(HEADER);
  let got = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(value, controller) {
        let at = 0;
        if (got < HEADER) {
          at = Math.min(HEADER - got, value.length);
          header.set(value.subarray(0, at), got);
          got += at;
          if (got === HEADER) {
            if (!MAGIC.every((b, i) => header[i] === b)) throw new Error('not an encrypted file');
            onPrefix(header.subarray(MAGIC.length));
          }
        }
        if (at < value.length) controller.enqueue(value.subarray(at));
      },
    }),
  );
}

export class EncryptedFileStore implements FileStore {
  private keys = new Map<string, Promise<Key[]>>();

  constructor(
    private readonly inner: FileStore,
    private readonly secret: string,
    private readonly previousSecret?: string,
  ) {}

  /** Keys of the user a storage key belongs to (`<userId>/…`): current first. */
  private keysFor(storageKey: string): Promise<Key[]> {
    const userId = storageKey.slice(0, storageKey.indexOf('/'));
    if (!userId) throw new Error('file keys start with the user id');
    let hit = this.keys.get(userId);
    if (!hit) {
      hit = Promise.all(
        [this.secret, this.previousSecret]
          .filter((s): s is string => !!s)
          .map((s) => userKey(s, userId)),
      );
      this.keys.set(userId, hit);
      if (this.keys.size > 64) this.keys.delete(this.keys.keys().next().value!);
    }
    return hit;
  }

  async put(key: string, body: ReadableStream<Uint8Array>, size: number): Promise<void> {
    const [current] = await this.keysFor(key);
    await this.inner.put(key, streamFrom(seal(body, size, current!)), sealedSize(size));
  }

  async get(key: string): Promise<StoredFile | null> {
    const stored = await this.inner.get(key);
    if (!stored) return null;
    const size = openedSize(stored.size);
    if (size < 0) throw new Error('stored file is damaged');
    return { body: streamFrom(open(stored.body, size, await this.keysFor(key))), size };
  }

  deletePrefix(prefix: string): Promise<void> {
    return this.inner.deletePrefix(prefix);
  }
}
