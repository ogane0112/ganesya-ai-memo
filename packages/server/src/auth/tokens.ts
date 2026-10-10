import { type Db, nowIso } from '../db/db.js';
import { randomToken, sha256 } from '../util/crypto.js';
import { type Agent, agentById } from './agents.js';

export const SCOPES = ['notes:read', 'notes:propose', 'notes:write', 'notes:capture'] as const;
export type Scope = (typeof SCOPES)[number];

export interface TokenInfo {
  /** Short public id (prefix of the hash) for listing/revoking. */
  id: string;
  kind: 'access' | 'refresh' | 'pat';
  agentId: string;
  clientId: string | null;
  scope: Scope[];
  label: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface Principal {
  userId: string;
  agent: Agent;
  scope: Set<Scope>;
  tokenId: string;
}

interface TokenRow {
  hash: string;
  kind: 'access' | 'refresh' | 'pat';
  user_id: string;
  agent_id: string;
  client_id: string | null;
  scope: string;
  label: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export function parseScope(scope: string | undefined | null): Scope[] {
  const req = (scope ?? '').split(/\s+/).filter(Boolean);
  const out = SCOPES.filter((s) => req.includes(s));
  return out.length ? out : ['notes:read', 'notes:propose'];
}

const PREFIX = { access: 'gma_', refresh: 'gmr_', pat: 'gmp_' } as const;

/**
 * Bearer tokens for agents. Only SHA-256 hashes are stored; every token is
 * scoped, can expire, and can be revoked individually or per agent.
 */
export class TokenService {
  constructor(
    private readonly db: Db,
    private readonly accessMinutes: number,
  ) {}

  private async insert(
    kind: TokenRow['kind'],
    userId: string,
    agentId: string,
    scope: Scope[],
    opts: { clientId?: string | null; label?: string; expiresAt?: string | null },
  ) {
    const token = PREFIX[kind] + randomToken(32);
    await this.db.run(
      'INSERT INTO tokens(hash, kind, user_id, agent_id, client_id, scope, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      await sha256(token),
      kind,
      userId,
      agentId,
      opts.clientId ?? null,
      scope.join(' '),
      opts.label ?? '',
      nowIso(),
      opts.expiresAt ?? null,
    );
    return token;
  }

  createPat(userId: string, agentId: string, scope: Scope[], label: string, expiresInDays?: number): Promise<string> {
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400_000).toISOString() : null;
    return this.insert('pat', userId, agentId, scope, { label, expiresAt });
  }

  async issueOAuthTokens(userId: string, agentId: string, clientId: string, scope: Scope[]) {
    const access = await this.insert('access', userId, agentId, scope, {
      clientId,
      expiresAt: new Date(Date.now() + this.accessMinutes * 60_000).toISOString(),
    });
    const refresh = await this.insert('refresh', userId, agentId, scope, {
      clientId,
      expiresAt: new Date(Date.now() + 90 * 86400_000).toISOString(),
    });
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: this.accessMinutes * 60, scope: scope.join(' ') };
  }

  /** Exchange a refresh token (rotated: the old one is revoked). */
  async refresh(refreshToken: string, clientId: string) {
    const hash = await sha256(refreshToken);
    const row = await this.db.first<TokenRow>(`SELECT * FROM tokens WHERE hash = ? AND kind = 'refresh'`, hash);
    if (!row || row.revoked_at || row.client_id !== clientId || (row.expires_at && row.expires_at < nowIso())) return null;
    const agent = await agentById(this.db, row.agent_id);
    if (!agent || agent.revokedAt) return null;
    const r = await this.db.run('UPDATE tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL', nowIso(), hash);
    if (r.changes !== 1) return null; // used concurrently
    return this.issueOAuthTokens(row.user_id, row.agent_id, clientId, parseScope(row.scope));
  }

  async verify(bearer: string | undefined): Promise<Principal | null> {
    if (!bearer || !(bearer.startsWith(PREFIX.access) || bearer.startsWith(PREFIX.pat))) return null;
    const hash = await sha256(bearer);
    const row = await this.db.first<TokenRow>('SELECT * FROM tokens WHERE hash = ?', hash);
    if (!row || row.kind === 'refresh' || row.revoked_at) return null;
    if (row.expires_at && row.expires_at < nowIso()) return null;
    const agent = await agentById(this.db, row.agent_id);
    if (!agent || agent.revokedAt || agent.userId !== row.user_id) return null;
    await this.db.run('UPDATE tokens SET last_used_at = ? WHERE hash = ?', nowIso(), hash);
    return { userId: row.user_id, agent, scope: new Set(parseScope(row.scope)), tokenId: hash.slice(0, 12) };
  }

  /** Revoke by raw token (anyone holding it) or by short id (owner only). */
  async revokeToken(rawOrId: string, userId?: string): Promise<void> {
    if (rawOrId.length > 12) await this.db.run('UPDATE tokens SET revoked_at = ? WHERE hash = ?', nowIso(), await sha256(rawOrId));
    else if (userId) await this.db.run(`UPDATE tokens SET revoked_at = ? WHERE substr(hash, 1, 12) = ? AND user_id = ?`, nowIso(), rawOrId, userId);
  }

  async list(userId: string, agentId?: string): Promise<TokenInfo[]> {
    const rows = agentId
      ? await this.db.all<TokenRow>(`SELECT * FROM tokens WHERE user_id = ? AND agent_id = ? AND kind != 'refresh' ORDER BY created_at DESC`, userId, agentId)
      : await this.db.all<TokenRow>(`SELECT * FROM tokens WHERE user_id = ? AND kind != 'refresh' ORDER BY created_at DESC`, userId);
    return rows.map((r) => ({
      id: r.hash.slice(0, 12),
      kind: r.kind,
      agentId: r.agent_id,
      clientId: r.client_id,
      scope: parseScope(r.scope),
      label: r.label,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  /** Remove expired/revoked rows older than 30 days. */
  async prune(): Promise<void> {
    const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
    await this.db.run(
      'DELETE FROM tokens WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR (expires_at IS NOT NULL AND expires_at < ?)',
      cutoff,
      cutoff,
    );
  }
}

/** What a principal may actually do: token scope intersected with agent settings. */
export function capabilities(p: Principal) {
  const canRead = p.agent.canRead && p.scope.has('notes:read');
  const canPropose = p.agent.writeMode !== 'none' && (p.scope.has('notes:propose') || p.scope.has('notes:write'));
  const canWriteDirect = p.agent.writeMode === 'direct' && p.scope.has('notes:write');
  return { canRead, canPropose, canWriteDirect };
}
