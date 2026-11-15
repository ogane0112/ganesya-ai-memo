/**
 * "Sign in with GitHub" for the GitHub storage, through a GitHub App.
 *
 * - The user signs in with the App's OAuth flow once, only to prove which
 *   installations and repositories they can reach (the user token is not kept).
 * - The server then talks to the chosen repository with installation access
 *   tokens: minted on demand from the App's private key, valid for an hour,
 *   limited to that one repository and to Contents. Nothing long-lived is stored
 *   per user except the installation id.
 */
import { StoreError } from './types.js';

export interface GitHubAppConfig {
  /** The App's URL name: https://github.com/apps/<slug>. */
  slug: string;
  clientId: string;
  clientSecret: string;
  /** PEM, PKCS#1 ("BEGIN RSA PRIVATE KEY", as GitHub hands it out) or PKCS#8. */
  privateKey: string;
}

export interface LinkableRepo {
  installationId: number;
  owner: string;
  repo: string;
  private: boolean;
  defaultBranch: string;
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) {
    out.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | out.length, ...out];
}

/** Wrap a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo (WebCrypto only imports PKCS#8). */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = [0x02, 0x01, 0x00];
  // AlgorithmIdentifier { rsaEncryption, NULL }
  const alg = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ];
  const octet = [0x04, ...derLength(pkcs1.length)];
  const bodyLen = version.length + alg.length + octet.length + pkcs1.length;
  const head = [0x30, ...derLength(bodyLen), ...version, ...alg, ...octet];
  const out = new Uint8Array(head.length + pkcs1.length);
  out.set(head);
  out.set(pkcs1, head.length);
  return out;
}

const PEM_RE = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/;

/**
 * The App's private key as it was put in the secret. Accepted forms: the PEM
 * file as is, the PEM with "\n" escaped (one-line env files), or the whole PEM
 * file base64-encoded: plain letters and digits, which survive any shell or
 * command line (multi-line values do not, on Windows in particular).
 */
export function parsePrivateKey(pem: string): { der: Uint8Array; pkcs1: boolean } {
  let text = pem.replace(/\\n/g, '\n').trim();
  if (!text.includes('-----BEGIN') && /^[A-Za-z0-9+/=\s]+$/.test(text)) {
    try {
      text = atob(text.replace(/\s+/g, ''));
    } catch {
      // not base64 either: reported below
    }
  }
  const m = PEM_RE.exec(text);
  if (!m)
    throw new StoreError(
      'GitHub App の秘密鍵(PEM)の形式が正しくありません。.pem ファイルの中身を base64 にしたものを GMEMO_GITHUB_APP_PRIVATE_KEY に設定し直してください',
      500,
    );
  const bin = atob(m[2]!.replace(/\s+/g, ''));
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return { der, pkcs1: !!m[1] };
}

const keys = new Map<string, ReturnType<typeof crypto.subtle.importKey>>();

function signingKey(pem: string): ReturnType<typeof crypto.subtle.importKey> {
  let k = keys.get(pem);
  if (!k) {
    const { der, pkcs1 } = parsePrivateKey(pem);
    k = crypto.subtle.importKey(
      'pkcs8',
      pkcs1 ? pkcs1ToPkcs8(der) : der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    k.catch(() => keys.delete(pem));
    keys.set(pem, k);
  }
  return k;
}

/** Whether the configured private key can be read and used (no network). */
export async function privateKeyProblem(app: GitHubAppConfig): Promise<string | null> {
  try {
    await signingKey(app.privateKey);
    return null;
  } catch (err) {
    return err instanceof StoreError ? err.message : 'GitHub App の秘密鍵を読み込めません';
  }
}

/** A short-lived JWT that authenticates as the App itself. */
export async function appJwt(app: GitHubAppConfig, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000) - 60; // GitHub's clock may run slightly behind
  const head = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify({ iat, exp: iat + 540, iss: app.clientId })));
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    await signingKey(app.privateKey),
    enc.encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const headers = (token: string) => ({
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'x-github-api-version': '2022-11-28',
  'user-agent': 'ganesya-ai-memo',
});

/** Installation tokens per isolate/process: key → token and expiry (ms). */
const tokenCache = new Map<string, { token: string; expires: number }>();
/** Mint a new token when the cached one has less than this left. */
const REFRESH_MS = 5 * 60_000;

/**
 * A token for one repository of an installation, with Contents read/write only.
 * Cached until shortly before it expires.
 */
export async function installationToken(
  app: GitHubAppConfig,
  apiBase: string,
  installationId: number,
  repo: string,
  f: typeof fetch,
): Promise<string> {
  const key = `${apiBase}|${app.clientId}|${installationId}|${repo}`;
  const hit = tokenCache.get(key);
  if (hit && hit.expires - Date.now() > REFRESH_MS) return hit.token;
  const res = await f(`${apiBase}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: { ...headers(await appJwt(app)), 'content-type': 'application/json' },
    body: JSON.stringify({ repositories: [repo], permissions: { contents: 'write' } }),
  });
  if (!res.ok) {
    tokenCache.delete(key);
    const msg = (await res.text().catch(() => '')).slice(0, 200);
    if (res.status === 404)
      throw new StoreError(
        'GitHub App がこのリポジトリにインストールされていません。設定の「保存先」から GitHub に接続し直してください',
        409,
      );
    if (res.status === 401)
      throw new StoreError(
        `GitHub App として認証できません(サーバーの秘密鍵か Client ID を確認してください): ${msg}`,
        500,
      );
    if (res.status === 422 || res.status === 403)
      throw new StoreError(
        `GitHub App にこのリポジトリへの書き込みが許可されていません(App の権限 Contents: Read and write と、インストール先のリポジトリを確認してください): ${msg}`,
        409,
      );
    throw new StoreError(`GitHub App のトークンを取得できません (${res.status}): ${msg}`);
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(key, { token: data.token, expires: Date.parse(data.expires_at) });
  return data.token;
}

/** Drop cached installation tokens (tests; after GitHub rejects one). */
export function forgetInstallationTokens(): void {
  tokenCache.clear();
}

/** Where to send the user to sign in (GitHub's OAuth authorize page). */
export function authorizeUrl(
  app: GitHubAppConfig,
  webBase: string,
  redirectUri: string,
  state: string,
): string {
  const q = new URLSearchParams({ client_id: app.clientId, redirect_uri: redirectUri, state });
  return `${webBase}/login/oauth/authorize?${q}`;
}

/** Where to install the App on (more) repositories. */
export function installUrl(app: GitHubAppConfig, webBase: string): string {
  return `${webBase}/apps/${encodeURIComponent(app.slug)}/installations/new`;
}

/** Exchange the OAuth code for a user token (used once, then dropped). */
export async function exchangeCode(
  app: GitHubAppConfig,
  webBase: string,
  code: string,
  redirectUri: string,
  f: typeof fetch,
): Promise<string> {
  const res = await f(`${webBase}/login/oauth/access_token`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'ganesya-ai-memo',
    },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token)
    throw new StoreError(
      `GitHub でのログインを完了できませんでした: ${data.error_description ?? data.error ?? res.status}`,
      400,
    );
  return data.access_token;
}

/** Every repository the signed-in user can reach through an installation of this App. */
export async function linkableRepos(
  apiBase: string,
  userToken: string,
  f: typeof fetch,
): Promise<LinkableRepo[]> {
  const get = async <T>(path: string): Promise<T> => {
    const res = await f(`${apiBase}${path}`, { headers: headers(userToken) });
    if (!res.ok)
      throw new StoreError(
        `GitHub からリポジトリの一覧を取得できません (${res.status})`,
        res.status === 401 ? 401 : 502,
      );
    return (await res.json()) as T;
  };
  const out: LinkableRepo[] = [];
  const { installations } = await get<{ installations: { id: number }[] }>(
    '/user/installations?per_page=100',
  );
  for (const inst of installations) {
    for (let page = 1; page <= 10; page++) {
      const r = await get<{
        total_count: number;
        repositories: {
          name: string;
          owner: { login: string };
          private: boolean;
          default_branch: string;
        }[];
      }>(`/user/installations/${inst.id}/repositories?per_page=100&page=${page}`);
      for (const repo of r.repositories)
        out.push({
          installationId: inst.id,
          owner: repo.owner.login,
          repo: repo.name,
          private: repo.private,
          defaultBranch: repo.default_branch || 'main',
        });
      if (r.repositories.length < 100) break;
    }
  }
  return out.sort((a, b) =>
    `${a.owner}/${a.repo}`.toLowerCase() < `${b.owner}/${b.repo}`.toLowerCase() ? -1 : 1,
  );
}
