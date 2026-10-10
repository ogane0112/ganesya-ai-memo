/**
 * Small crypto helpers built on WebCrypto / getRandomValues so they run on Node
 * and on Cloudflare Workers alike.
 */
const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

export function randomId(prefix = ''): string {
  return prefix + b64url(randomBytes(9));
}

/** SHA-256 hex. Tokens are high-entropy random values, so a fast hash is appropriate. */
export async function sha256(value: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(value));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256b64url(value: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value))));
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Human-friendly recovery code: 4 groups of 4 base32 characters. */
export function recoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += alphabet[bytes[i]! % alphabet.length];
  return s.match(/.{4}/g)!.join('-');
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ---- secret encryption (GitHub tokens at rest) --------------------------------

async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`gmemo:${secret}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Encrypt with AES-256-GCM using a server secret. Output: base64url(iv | ciphertext). */
export async function encryptSecret(plain: string, secret: string): Promise<string> {
  if (!secret) throw new Error('GMEMO_SECRET_KEY is not configured');
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64url(out);
}

export async function decryptSecret(blob: string, secret: string): Promise<string> {
  const data = fromB64url(blob);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12) }, await aesKey(secret), data.subarray(12));
  return new TextDecoder().decode(pt);
}
