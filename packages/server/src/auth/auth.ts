import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { Config } from '../config.js';
import { type DB, nowIso } from '../db/db.js';
import { normalizeRecoveryCode, randomId, randomToken, recoveryCode, safeEqual, sha256 } from '../util/crypto.js';

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 = 400,
  ) {
    super(message);
  }
}

export interface User {
  id: string;
  username: string;
  createdAt: string;
}

export interface Session {
  userId: string;
  username: string;
  via: 'passkey' | 'recovery';
  expiresAt: string;
}

export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: string | null;
  backedUp: boolean;
}

interface CredentialRow {
  id: string;
  user_id: string;
  public_key: Buffer;
  counter: number;
  transports: string;
  device_type: string | null;
  backed_up: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

interface PendingChallenge {
  challenge: string;
  kind: 'register' | 'login';
  expires: number;
  username?: string;
}

const RECOVERY_CODE_COUNT = 10;
const SETUP_TOKEN_KEY = 'setup_token_hash';

/**
 * Passkey-only authentication for the single human user. The server stores
 * public keys and hashes only: no passwords, no email, no IP addresses.
 */
export class AuthService {
  private challenges = new Map<string, PendingChallenge>();

  constructor(
    private readonly db: DB,
    private readonly cfg: Config,
  ) {}

  user(): User | null {
    const r = this.db.prepare('SELECT id, username, created_at FROM users LIMIT 1').get() as { id: string; username: string; created_at: string } | undefined;
    return r ? { id: r.id, username: r.username, createdAt: r.created_at } : null;
  }

  hasPasskeys(): boolean {
    return !!this.db.prepare('SELECT 1 FROM credentials LIMIT 1').get();
  }

  /** Setup is open when no passkey exists yet; it requires the one-time setup token. */
  needsSetup(): boolean {
    return !this.hasPasskeys();
  }

  /** Create (or replace) the one-time setup token printed to the server console. */
  issueSetupToken(): string {
    const token = randomToken(18);
    this.db
      .prepare(`INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(SETUP_TOKEN_KEY, JSON.stringify({ hash: sha256(token), expires: Date.now() + 24 * 3600 * 1000 }));
    return token;
  }

  private checkSetupToken(token: string | undefined): boolean {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(SETUP_TOKEN_KEY) as { value: string } | undefined;
    if (!row || !token) return false;
    const { hash, expires } = JSON.parse(row.value) as { hash: string; expires: number };
    return expires > Date.now() && safeEqual(hash, sha256(token));
  }

  private gcChallenges() {
    const now = Date.now();
    for (const [k, v] of this.challenges) if (v.expires < now) this.challenges.delete(k);
  }

  // ---- registration --------------------------------------------------------

  /**
   * Options for adding a passkey. Allowed when (a) no passkey exists and the
   * setup token is valid, or (b) the caller has a session.
   */
  async registrationOptions(opts: { session: Session | null; setupToken?: string; username?: string; }) {
    this.gcChallenges();
    let user = this.user();
    if (!opts.session) {
      if (!this.needsSetup()) throw new AuthError('sign in first to add another passkey', 401);
      if (!this.checkSetupToken(opts.setupToken)) throw new AuthError('invalid or expired setup token', 403);
    }
    const username = user?.username ?? (opts.username?.trim() || 'me').slice(0, 40);
    const existing = this.db.prepare('SELECT id, transports FROM credentials').all() as { id: string; transports: string }[];
    const options = await generateRegistrationOptions({
      rpName: this.cfg.rpName,
      rpID: this.cfg.rpId,
      userName: username,
      userDisplayName: username,
      ...(user ? { userID: new TextEncoder().encode(user.id) } : {}),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: JSON.parse(c.transports) as never })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    const challengeId = randomToken(12);
    this.challenges.set(challengeId, { challenge: options.challenge, kind: 'register', expires: Date.now() + 5 * 60_000, username });
    if (!user) user = null;
    return { challengeId, options };
  }

  async verifyRegistration(input: {
    session: Session | null;
    challengeId: string;
    response: RegistrationResponseJSON;
    name?: string;
    setupToken?: string;
  }): Promise<{ passkey: PasskeyInfo; recoveryCodes: string[] | null; sessionToken: string | null }> {
    const pending = this.challenges.get(input.challengeId);
    this.challenges.delete(input.challengeId);
    if (!pending || pending.kind !== 'register' || pending.expires < Date.now()) throw new AuthError('challenge expired');
    if (!input.session && !(this.needsSetup() && this.checkSetupToken(input.setupToken))) throw new AuthError('not allowed', 403);

    const verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: this.cfg.origin,
      expectedRPID: this.cfg.rpId,
      requireUserVerification: false,
    });
    if (!verification.verified) throw new AuthError('passkey verification failed');
    const info = verification.registrationInfo;

    let user = this.user();
    let recoveryCodes: string[] | null = null;
    let sessionToken: string | null = null;
    const now = nowIso();
    this.db.transaction(() => {
      if (!user) {
        user = { id: randomId('u_'), username: pending.username ?? 'me', createdAt: now };
        this.db.prepare('INSERT INTO users(id, username, created_at) VALUES (?, ?, ?)').run(user.id, user.username, now);
      }
      this.db
        .prepare(
          `INSERT INTO credentials(id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          info.credential.id,
          user.id,
          Buffer.from(info.credential.publicKey),
          info.credential.counter,
          JSON.stringify(info.credential.transports ?? []),
          info.credentialDeviceType,
          info.credentialBackedUp ? 1 : 0,
          (input.name ?? '').trim().slice(0, 60) || defaultPasskeyName(info.credentialDeviceType),
          now,
        );
      if (!input.session) {
        // First passkey (or re-setup after an admin reset): issue recovery codes and sign in.
        recoveryCodes = this.replaceRecoveryCodes();
        this.db.prepare('DELETE FROM settings WHERE key = ?').run(SETUP_TOKEN_KEY);
        sessionToken = this.createSession(user.id, 'passkey');
      }
    })();
    return { passkey: this.passkey(info.credential.id)!, recoveryCodes, sessionToken };
  }

  // ---- authentication ------------------------------------------------------

  async authenticationOptions() {
    this.gcChallenges();
    const options = await generateAuthenticationOptions({ rpID: this.cfg.rpId, userVerification: 'preferred' });
    const challengeId = randomToken(12);
    this.challenges.set(challengeId, { challenge: options.challenge, kind: 'login', expires: Date.now() + 5 * 60_000 });
    return { challengeId, options };
  }

  async verifyAuthentication(challengeId: string, response: AuthenticationResponseJSON): Promise<string> {
    const pending = this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    if (!pending || pending.kind !== 'login' || pending.expires < Date.now()) throw new AuthError('challenge expired');
    const cred = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(response.id) as CredentialRow | undefined;
    if (!cred) throw new AuthError('unknown passkey', 401);
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: this.cfg.origin,
      expectedRPID: this.cfg.rpId,
      credential: {
        id: cred.id,
        publicKey: new Uint8Array(cred.public_key),
        counter: cred.counter,
        transports: JSON.parse(cred.transports) as string[],
      },
      requireUserVerification: false,
    });
    if (!verification.verified) throw new AuthError('passkey verification failed', 401);
    this.db.prepare('UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?').run(verification.authenticationInfo.newCounter, nowIso(), cred.id);
    return this.createSession(cred.user_id, 'passkey');
  }

  /** Sign in with a one-time recovery code (to register a new passkey). */
  loginWithRecoveryCode(code: string): string {
    const user = this.user();
    if (!user) throw new AuthError('no account yet', 400);
    const hash = sha256(normalizeRecoveryCode(code));
    const row = this.db.prepare('SELECT hash FROM recovery_codes WHERE hash = ? AND used_at IS NULL').get(hash);
    if (!row) throw new AuthError('invalid recovery code', 401);
    this.db.prepare('UPDATE recovery_codes SET used_at = ? WHERE hash = ?').run(nowIso(), hash);
    return this.createSession(user.id, 'recovery', 1);
  }

  // ---- sessions ------------------------------------------------------------

  createSession(userId: string, via: 'passkey' | 'recovery', days = this.cfg.sessionDays): string {
    const token = randomToken(32);
    const expires = new Date(Date.now() + days * 86400_000).toISOString();
    this.db.prepare('INSERT INTO sessions(token_hash, user_id, created_at, expires_at, via) VALUES (?, ?, ?, ?, ?)').run(sha256(token), userId, nowIso(), expires, via);
    return token;
  }

  session(token: string | undefined): Session | null {
    if (!token) return null;
    const r = this.db
      .prepare('SELECT s.user_id, s.expires_at, s.via, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
      .get(sha256(token)) as { user_id: string; expires_at: string; via: 'passkey' | 'recovery'; username: string } | undefined;
    if (!r) return null;
    if (r.expires_at < nowIso()) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
      return null;
    }
    return { userId: r.user_id, username: r.username, via: r.via, expiresAt: r.expires_at };
  }

  logout(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  logoutEverywhere(): void {
    this.db.prepare('DELETE FROM sessions').run();
  }

  // ---- passkey management --------------------------------------------------

  passkeys(): PasskeyInfo[] {
    return (this.db.prepare('SELECT * FROM credentials ORDER BY created_at').all() as CredentialRow[]).map(toInfo);
  }

  passkey(id: string): PasskeyInfo | null {
    const r = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as CredentialRow | undefined;
    return r ? toInfo(r) : null;
  }

  renamePasskey(id: string, name: string): void {
    this.db.prepare('UPDATE credentials SET name = ? WHERE id = ?').run(name.trim().slice(0, 60) || 'Passkey', id);
  }

  deletePasskey(id: string): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM credentials').get() as { n: number }).n;
    if (count <= 1) throw new AuthError('cannot delete the last passkey');
    this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
  }

  /** Generate a fresh set of recovery codes (old ones stop working). Returned once. */
  replaceRecoveryCodes(): string[] {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM recovery_codes').run();
      const ins = this.db.prepare('INSERT INTO recovery_codes(hash, created_at) VALUES (?, ?)');
      for (const c of codes) ins.run(sha256(normalizeRecoveryCode(c)), nowIso());
    })();
    return codes;
  }

  remainingRecoveryCodes(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NULL').get() as { n: number }).n;
  }

  /** Admin CLI: remove all passkeys and sessions so the owner can register again. */
  adminReset(): string {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM credentials').run();
      this.db.prepare('DELETE FROM sessions').run();
    })();
    return this.issueSetupToken();
  }
}

function toInfo(r: CredentialRow): PasskeyInfo {
  return { id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at, deviceType: r.device_type, backedUp: !!r.backed_up };
}

function defaultPasskeyName(deviceType: string): string {
  return deviceType === 'multiDevice' ? '同期パスキー' : 'このデバイスのパスキー';
}
