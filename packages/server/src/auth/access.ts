/**
 * Cloudflare Access: verifies the signed token Access adds to every request it
 * lets through (header `Cf-Access-Jwt-Assertion`, or the CF_Authorization
 * cookie). Checking it in the Worker as well means the app stays closed even
 * if a request reaches it without passing Access (another route, a
 * misconfigured policy).
 */
interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

export interface AccessIdentity {
  email: string | null;
  /** Service tokens have no email; their common name / client id is used. */
  subject: string;
}

const enc = new TextEncoder();
const CERT_TTL_MS = 60 * 60_000;
const certCache = new Map<string, { at: number; keys: Jwk[] }>();

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s))) as Record<string, unknown>;
}

async function certs(teamDomain: string, fetchImpl: typeof fetch, force = false): Promise<Jwk[]> {
  const hit = certCache.get(teamDomain);
  if (hit && !force && Date.now() - hit.at < CERT_TTL_MS) return hit.keys;
  const res = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const keys = ((await res.json()) as { keys: Jwk[] }).keys;
  certCache.set(teamDomain, { at: Date.now(), keys });
  return keys;
}

export function accessToken(req: Request): string | null {
  const header = req.headers.get('cf-access-jwt-assertion');
  if (header) return header;
  const cookie = req.headers.get('cookie') ?? '';
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return m ? decodeURIComponent(m[1]!) : null;
}

/** Returns the identity, or null when the token is missing, expired or not for this app. */
export async function verifyAccessToken(
  token: string | null,
  cfg: { teamDomain: string; aud: string },
  fetchImpl: typeof fetch = fetch,
): Promise<AccessIdentity | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = b64urlJson(parts[0]!);
    payload = b64urlJson(parts[1]!);
  } catch {
    return null;
  }
  if (header['alg'] !== 'RS256' || typeof header['kid'] !== 'string') return null;
  const now = Math.floor(Date.now() / 1000);
  const aud = payload['aud'];
  const auds = Array.isArray(aud) ? aud : [aud];
  if (!auds.includes(cfg.aud)) return null;
  if (typeof payload['exp'] !== 'number' || payload['exp'] < now) return null;
  if (typeof payload['nbf'] === 'number' && payload['nbf'] > now + 60) return null;
  if (payload['iss'] !== `https://${cfg.teamDomain}`) return null;

  let keys = await certs(cfg.teamDomain, fetchImpl);
  let jwk = keys.find((k) => k.kid === header['kid']);
  if (!jwk) {
    // Keys rotate: refetch once before giving up.
    keys = await certs(cfg.teamDomain, fetchImpl, true);
    jwk = keys.find((k) => k.kid === header['kid']);
  }
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlBytes(parts[2]!),
    enc.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;
  const email = typeof payload['email'] === 'string' ? payload['email'] : null;
  const subject =
    email ??
    (typeof payload['common_name'] === 'string' ? payload['common_name'] : null) ??
    String(payload['sub'] ?? 'unknown');
  return { email, subject };
}

/** Test helper. */
export function clearAccessCertCache(): void {
  certCache.clear();
}
