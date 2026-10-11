import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { Config } from '../config.js';
import { type Db, nowIso, type Stmt, stmt, toBytes } from '../db/db.js';
import {
  normalizeRecoveryCode,
  randomId,
  randomToken,
  recoveryCode,
  safeEqual,
  sha256,
} from '../util/crypto.js';

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 409 = 400,
  ) {
    super(message);
  }
}

export interface User {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
}

export interface Session {
  userId: string;
  username: string;
  isAdmin: boolean;
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

export interface InviteInfo {
  id: string;
  createdAt: string;
  expiresAt: string | null;
  usedBy: string | null;
  usedAt: string | null;
}

interface CredentialRow {
  id: string;
  user_id: string;
  public_key: unknown;
  counter: number;
  transports: string;
  device_type: string | null;
  backed_up: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

interface UserRow {
  id: string;
  username: string;
  is_admin: number;
  created_at: string;
}

interface RegisterData {
  /** Set when a signed-in user adds another passkey. */
  userId?: string;
  /** New account: the id and name it will get. */
  newUserId?: string;
  username?: string;
  inviteHash?: string;
}

const RECOVERY_CODE_COUNT = 10;
const SETUP_TOKEN_KEY = 'setup_token_hash';
const CHALLENGE_MS = 5 * 60_000;
const USERNAME_RE = /^[\p{L}\p{N}_.-]{2,32}$/u;

export function validUsername(name: string): string {
  const u = name.normalize('NFKC').trim();
  if (!USERNAME_RE.test(u))
    throw new AuthError('ユーザー名は2〜32文字の英数字・かな漢字・_ . - で入力してください');
  return u;
}

function toUser(r: UserRow): User {
  return { id: r.id, username: r.username, isAdmin: !!r.is_admin, createdAt: r.created_at };
}

/**
 * Passkey-only accounts. The server stores public keys and hashes only: no
 * passwords, no email, no IP addresses.
 *
 * - The first account needs the setup token and becomes the admin.
 * - Later accounts follow `cfg.signup`: open, invite-only, or closed.
 */
export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
  ) {}

  // ---- users ---------------------------------------------------------------

  async userCount(): Promise<number> {
    return (await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM users'))?.n ?? 0;
  }

  async user(id: string): Promise<User | null> {
    const r = await this.db.first<UserRow>('SELECT * FROM users WHERE id = ?', id);
    return r ? toUser(r) : null;
  }

  async userByName(username: string): Promise<User | null> {
    const r = await this.db.first<UserRow>('SELECT * FROM users WHERE username = ?', username);
    return r ? toUser(r) : null;
  }

  async users(): Promise<User[]> {
    return (await this.db.all<UserRow>('SELECT * FROM users ORDER BY created_at')).map(toUser);
  }

  /** No account exists yet: the next registration needs the setup token. */
  async needsSetup(): Promise<boolean> {
    return (await this.userCount()) === 0;
  }

  /** What the sign-up screen should ask for. */
  async signupState(): Promise<{ needsSetup: boolean; signup: Config['signup'] }> {
    return { needsSetup: await this.needsSetup(), signup: this.cfg.signup };
  }

  /** Node only: create the one-time setup token printed to the console (24 h). */
  async issueSetupToken(): Promise<string> {
    const token = randomToken(18);
    await this.db.run(
      `INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      SETUP_TOKEN_KEY,
      JSON.stringify({ hash: await sha256(token), expires: Date.now() + 24 * 3600 * 1000 }),
    );
    return token;
  }

  private async checkSetupToken(token: string | undefined): Promise<boolean> {
    if (!token) return false;
    if (this.cfg.setupToken) return safeEqual(token, this.cfg.setupToken);
    const row = await this.db.first<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      SETUP_TOKEN_KEY,
    );
    if (!row) return false;
    const { hash, expires } = JSON.parse(row.value) as { hash: string; expires: number };
    return expires > Date.now() && safeEqual(hash, await sha256(token));
  }

  /** Delete an account and all of its data. `extra` adds statements for optional tables. */
  async deleteUser(id: string, extra: Stmt[] = []): Promise<void> {
    // Everything else references users(id) with ON DELETE CASCADE or is keyed by user_id.
    const tables = [
      'git_objects',
      'git_commits',
      'git_refs',
      'editing',
      'audit',
      'secret_placeholders',
      'notes',
      'links',
      'tags',
      'chunks',
      'index_state',
    ];
    await this.db.batch([
      ...extra,
      ...tables.map((t) => stmt(`DELETE FROM ${t} WHERE user_id = ?`, id)),
      stmt('DELETE FROM users WHERE id = ?', id),
    ]);
  }

  // ---- invites ---------------------------------------------------------------

  async createInvite(createdBy: string, days = 7): Promise<{ code: string; invite: InviteInfo }> {
    const code = randomToken(12);
    const hash = await sha256(code);
    const expires = new Date(Date.now() + days * 86400_000).toISOString();
    await this.db.run(
      'INSERT INTO invites(code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)',
      hash,
      createdBy,
      nowIso(),
      expires,
    );
    return { code, invite: (await this.invites()).find((i) => i.id === hash.slice(0, 12))! };
  }

  async invites(): Promise<InviteInfo[]> {
    const rows = await this.db.all<{
      code_hash: string;
      created_at: string;
      expires_at: string | null;
      used_by: string | null;
      used_at: string | null;
    }>('SELECT * FROM invites ORDER BY created_at DESC LIMIT 100');
    return rows.map((r) => ({
      id: r.code_hash.slice(0, 12),
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      usedBy: r.used_by,
      usedAt: r.used_at,
    }));
  }

  async deleteInvite(id: string): Promise<void> {
    await this.db.run(
      'DELETE FROM invites WHERE substr(code_hash, 1, 12) = ? AND used_at IS NULL',
      id,
    );
  }

  private async inviteValid(hash: string): Promise<boolean> {
    const r = await this.db.first<{ expires_at: string | null }>(
      'SELECT expires_at FROM invites WHERE code_hash = ? AND used_at IS NULL',
      hash,
    );
    return !!r && (!r.expires_at || r.expires_at > nowIso());
  }

  // ---- challenges ----------------------------------------------------------

  private async saveChallenge(challenge: string, kind: string, data: object): Promise<string> {
    const id = randomToken(12);
    await this.db.batch([
      stmt('DELETE FROM challenges WHERE expires_at < ?', nowIso()),
      stmt(
        'INSERT INTO challenges(id, challenge, kind, data, expires_at) VALUES (?, ?, ?, ?, ?)',
        id,
        challenge,
        kind,
        JSON.stringify(data),
        new Date(Date.now() + CHALLENGE_MS).toISOString(),
      ),
    ]);
    return id;
  }

  /** Single use: the row is deleted before it is returned. */
  private async takeChallenge<T>(
    id: string,
    kind: string,
  ): Promise<{ challenge: string; data: T }> {
    const row = await this.db.first<{
      challenge: string;
      kind: string;
      data: string;
      expires_at: string;
    }>('SELECT * FROM challenges WHERE id = ?', id);
    const claimed = row
      ? (await this.db.run('DELETE FROM challenges WHERE id = ?', id)).changes
      : 0;
    if (!row || claimed !== 1 || row.kind !== kind || row.expires_at < nowIso())
      throw new AuthError('もう一度やり直してください(確認の有効期限が切れました)');
    return { challenge: row.challenge, data: JSON.parse(row.data) as T };
  }

  // ---- registration --------------------------------------------------------

  /**
   * Options for creating a passkey: either a new account (username plus setup
   * token or invite, depending on the sign-up mode) or another passkey for the
   * signed-in user.
   */
  async registrationOptions(opts: {
    session: Session | null;
    username?: string;
    setupToken?: string;
    inviteCode?: string;
  }) {
    let data: RegisterData;
    let userId: string;
    let username: string;
    if (opts.session) {
      userId = opts.session.userId;
      username = opts.session.username;
      data = { userId };
    } else {
      username = validUsername(opts.username ?? '');
      const inviteHash = await this.assertMaySignUp(opts);
      if (await this.userByName(username))
        throw new AuthError('このユーザー名はすでに使われています', 409);
      userId = randomId('u_');
      data = { newUserId: userId, username, ...(inviteHash ? { inviteHash } : {}) };
    }
    const existing = opts.session
      ? await this.db.all<{ id: string; transports: string }>(
          'SELECT id, transports FROM credentials WHERE user_id = ?',
          userId,
        )
      : [];
    const options = await generateRegistrationOptions({
      rpName: this.cfg.rpName,
      rpID: this.cfg.rpId,
      userName: username,
      userDisplayName: username,
      userID: new TextEncoder().encode(userId),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.id,
        transports: JSON.parse(c.transports) as never,
      })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    const challengeId = await this.saveChallenge(options.challenge, 'register', data);
    return { challengeId, options };
  }

  /** Returns the invite hash to consume, if the mode needs one. */
  private async assertMaySignUp(opts: {
    setupToken?: string;
    inviteCode?: string;
  }): Promise<string | undefined> {
    if (await this.needsSetup()) {
      if (!(await this.checkSetupToken(opts.setupToken)))
        throw new AuthError('セットアップトークンが正しくないか、期限切れです', 403);
      return undefined;
    }
    if (this.cfg.signup === 'closed')
      throw new AuthError('このサーバーは新規登録を受け付けていません', 403);
    if (this.cfg.signup === 'invite') {
      const hash = opts.inviteCode ? await sha256(opts.inviteCode.trim()) : '';
      if (!hash || !(await this.inviteValid(hash)))
        throw new AuthError('招待コードが正しくないか、使用済みです', 403);
      return hash;
    }
    return undefined;
  }

  async verifyRegistration(input: {
    session: Session | null;
    challengeId: string;
    response: RegistrationResponseJSON;
    name?: string;
    setupToken?: string;
  }): Promise<{
    userId: string;
    passkey: PasskeyInfo;
    recoveryCodes: string[] | null;
    sessionToken: string | null;
  }> {
    const { challenge, data } = await this.takeChallenge<RegisterData>(
      input.challengeId,
      'register',
    );
    if (data.userId && data.userId !== input.session?.userId)
      throw new AuthError('サインインし直してください', 403);

    const verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: challenge,
      expectedOrigin: this.cfg.origin,
      expectedRPID: this.cfg.rpId,
      requireUserVerification: false,
    });
    if (!verification.verified) throw new AuthError('パスキーを確認できませんでした');
    const info = verification.registrationInfo;
    const now = nowIso();
    const credential = stmt(
      `INSERT INTO credentials(id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      info.credential.id,
      data.userId ?? data.newUserId!,
      info.credential.publicKey,
      info.credential.counter,
      JSON.stringify(info.credential.transports ?? []),
      info.credentialDeviceType,
      info.credentialBackedUp ? 1 : 0,
      (input.name ?? '').trim().slice(0, 60) || defaultPasskeyName(info.credentialDeviceType),
      now,
    );

    if (data.userId) {
      await this.db.batch([credential]);
      return {
        userId: data.userId,
        passkey: (await this.passkey(data.userId, info.credential.id))!,
        recoveryCodes: null,
        sessionToken: null,
      };
    }

    // New account.
    const userId = data.newUserId!;
    const first = await this.needsSetup();
    if (data.inviteHash) {
      const r = await this.db.run(
        'UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ? AND used_at IS NULL',
        userId,
        now,
        data.inviteHash,
      );
      if (r.changes !== 1) throw new AuthError('招待コードはすでに使われています', 403);
    }
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
    const sessionToken = randomToken(32);
    const stmts: Stmt[] = [
      stmt(
        'INSERT INTO users(id, username, is_admin, created_at) VALUES (?, ?, ?, ?)',
        userId,
        data.username!,
        first ? 1 : 0,
        now,
      ),
      credential,
      stmt(
        `INSERT INTO workspaces(user_id, storage, updated_at) VALUES (?, 'builtin', ?)`,
        userId,
        now,
      ),
      ...(await this.recoveryCodeStmts(userId, codes)),
      await this.sessionStmt(sessionToken, userId, 'passkey', this.cfg.sessionDays),
    ];
    if (first) stmts.push(stmt('DELETE FROM settings WHERE key = ?', SETUP_TOKEN_KEY));
    try {
      await this.db.batch(stmts);
    } catch (e) {
      if (/UNIQUE/i.test((e as Error).message))
        throw new AuthError('このユーザー名はすでに使われています', 409);
      throw e;
    }
    return {
      userId,
      passkey: (await this.passkey(userId, info.credential.id))!,
      recoveryCodes: codes,
      sessionToken,
    };
  }

  // ---- authentication ------------------------------------------------------

  async authenticationOptions() {
    const options = await generateAuthenticationOptions({
      rpID: this.cfg.rpId,
      userVerification: 'preferred',
    });
    const challengeId = await this.saveChallenge(options.challenge, 'login', {});
    return { challengeId, options };
  }

  async verifyAuthentication(
    challengeId: string,
    response: AuthenticationResponseJSON,
  ): Promise<{ token: string; userId: string; credentialId: string }> {
    const { challenge } = await this.takeChallenge(challengeId, 'login');
    const cred = await this.db.first<CredentialRow>(
      'SELECT * FROM credentials WHERE id = ?',
      response.id,
    );
    if (!cred) throw new AuthError('このパスキーは登録されていません', 401);
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.cfg.origin,
      expectedRPID: this.cfg.rpId,
      credential: {
        id: cred.id,
        publicKey: toBytes(cred.public_key) as Uint8Array<ArrayBuffer>,
        counter: cred.counter,
        transports: JSON.parse(cred.transports) as never,
      },
      requireUserVerification: false,
    });
    if (!verification.verified) throw new AuthError('パスキーを確認できませんでした', 401);
    await this.db.run(
      'UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?',
      verification.authenticationInfo.newCounter,
      nowIso(),
      cred.id,
    );
    return {
      token: await this.createSession(cred.user_id, 'passkey'),
      userId: cred.user_id,
      credentialId: cred.id,
    };
  }

  /** Sign in with a one-time recovery code (to register a new passkey). */
  async loginWithRecoveryCode(
    username: string,
    code: string,
  ): Promise<{ token: string; userId: string }> {
    const user = await this.userByName(username.normalize('NFKC').trim());
    const hash = await sha256(normalizeRecoveryCode(code));
    const r = user
      ? await this.db.run(
          'UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND hash = ? AND used_at IS NULL',
          nowIso(),
          user.id,
          hash,
        )
      : { changes: 0 };
    if (!user || r.changes !== 1)
      throw new AuthError('ユーザー名か復旧コードが正しくありません', 401);
    return { token: await this.createSession(user.id, 'recovery', 1), userId: user.id };
  }

  // ---- sessions ------------------------------------------------------------

  private async sessionStmt(
    token: string,
    userId: string,
    via: 'passkey' | 'recovery',
    days: number,
  ): Promise<Stmt> {
    return stmt(
      'INSERT INTO sessions(token_hash, user_id, created_at, expires_at, via) VALUES (?, ?, ?, ?, ?)',
      await sha256(token),
      userId,
      nowIso(),
      new Date(Date.now() + days * 86400_000).toISOString(),
      via,
    );
  }

  async createSession(
    userId: string,
    via: 'passkey' | 'recovery',
    days = this.cfg.sessionDays,
  ): Promise<string> {
    const token = randomToken(32);
    await this.db.batch([
      stmt('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?', userId, nowIso()),
      await this.sessionStmt(token, userId, via, days),
    ]);
    return token;
  }

  async session(token: string | undefined): Promise<Session | null> {
    if (!token) return null;
    const hash = await sha256(token);
    const r = await this.db.first<{
      user_id: string;
      expires_at: string;
      via: 'passkey' | 'recovery';
      username: string;
      is_admin: number;
    }>(
      'SELECT s.user_id, s.expires_at, s.via, u.username, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
      hash,
    );
    if (!r) return null;
    if (r.expires_at < nowIso()) {
      await this.db.run('DELETE FROM sessions WHERE token_hash = ?', hash);
      return null;
    }
    return {
      userId: r.user_id,
      username: r.username,
      isAdmin: !!r.is_admin,
      via: r.via,
      expiresAt: r.expires_at,
    };
  }

  async logout(token: string): Promise<void> {
    await this.db.run('DELETE FROM sessions WHERE token_hash = ?', await sha256(token));
  }

  async logoutEverywhere(userId: string): Promise<void> {
    await this.db.run('DELETE FROM sessions WHERE user_id = ?', userId);
  }

  // ---- passkey management --------------------------------------------------

  async passkeys(userId: string): Promise<PasskeyInfo[]> {
    return (
      await this.db.all<CredentialRow>(
        'SELECT * FROM credentials WHERE user_id = ? ORDER BY created_at',
        userId,
      )
    ).map(toInfo);
  }

  async passkey(userId: string, id: string): Promise<PasskeyInfo | null> {
    const r = await this.db.first<CredentialRow>(
      'SELECT * FROM credentials WHERE id = ? AND user_id = ?',
      id,
      userId,
    );
    return r ? toInfo(r) : null;
  }

  async renamePasskey(userId: string, id: string, name: string): Promise<void> {
    await this.db.run(
      'UPDATE credentials SET name = ? WHERE id = ? AND user_id = ?',
      name.trim().slice(0, 60) || 'Passkey',
      id,
      userId,
    );
  }

  async deletePasskey(userId: string, id: string): Promise<void> {
    if ((await this.passkeys(userId)).length <= 1)
      throw new AuthError('最後のパスキーは削除できません');
    await this.db.run('DELETE FROM credentials WHERE id = ? AND user_id = ?', id, userId);
  }

  private async recoveryCodeStmts(userId: string, codes: string[]): Promise<Stmt[]> {
    const now = nowIso();
    return [
      stmt('DELETE FROM recovery_codes WHERE user_id = ?', userId),
      ...(await Promise.all(
        codes.map(async (c) =>
          stmt(
            'INSERT INTO recovery_codes(user_id, hash, created_at) VALUES (?, ?, ?)',
            userId,
            await sha256(normalizeRecoveryCode(c)),
            now,
          ),
        ),
      )),
    ];
  }

  /** Generate a fresh set of recovery codes (old ones stop working). Returned once. */
  async replaceRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
    await this.db.batch(await this.recoveryCodeStmts(userId, codes));
    return codes;
  }

  async remainingRecoveryCodes(userId: string): Promise<number> {
    return (
      (
        await this.db.first<{ n: number }>(
          'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL',
          userId,
        )
      )?.n ?? 0
    );
  }

  /**
   * Admin: a user lost every passkey and recovery code. Signs them out and
   * returns fresh recovery codes to hand over out of band.
   */
  async adminResetUser(userId: string): Promise<string[]> {
    await this.logoutEverywhere(userId);
    return this.replaceRecoveryCodes(userId);
  }
}

function toInfo(r: CredentialRow): PasskeyInfo {
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    deviceType: r.device_type,
    backedUp: !!r.backed_up,
  };
}

function defaultPasskeyName(deviceType: string): string {
  return deviceType === 'multiDevice' ? '同期パスキー' : 'このデバイスのパスキー';
}
