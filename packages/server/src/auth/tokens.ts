import { type DB, nowIso } from '../db/db.js';
import { randomToken, sha256 } from '../util/crypto.js';
import type { Agent, AgentStore } from './agents.js';

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
  agent: Agent;
  scope: Set<Scope>;
  tokenId: string;
}

interface TokenRow {
  hash: string;
  kind: 'access' | 'refresh' | 'pat';
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
    private readonly db: DB,
    private readonly agents: AgentStore,
    private readonly accessMinutes: number,
  ) {}

  private insert(
    kind: TokenRow['kind'],
    agentId: string,
    scope: Scope[],
    opts: { clientId?: string | null; label?: string; expiresAt?: string | null },
  ) {
    const token = PREFIX[kind] + randomToken(32);
    this.db
      .prepare(
        'INSERT INTO tokens(hash, kind, agent_id, client_id, scope, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        sha256(token),
        kind,
        agentId,
        opts.clientId ?? null,
        scope.join(' '),
        opts.label ?? '',
        nowIso(),
        opts.expiresAt ?? null,
      );
    return token;
  }

  createPat(agentId: string, scope: Scope[], label: string, expiresInDays?: number): string {
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 86400_000).toISOString()
      : null;
    return this.insert('pat', agentId, scope, { label, expiresAt });
  }

  issueOAuthTokens(agentId: string, clientId: string, scope: Scope[]) {
    const access = this.insert('access', agentId, scope, {
      clientId,
      expiresAt: new Date(Date.now() + this.accessMinutes * 60_000).toISOString(),
    });
    const refresh = this.insert('refresh', agentId, scope, {
      clientId,
      expiresAt: new Date(Date.now() + 90 * 86400_000).toISOString(),
    });
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: this.accessMinutes * 60,
      scope: scope.join(' '),
    };
  }

  /** Exchange a refresh token (rotated: the old one is revoked). */
  refresh(refreshToken: string, clientId: string) {
    const row = this.db
      .prepare(`SELECT * FROM tokens WHERE hash = ? AND kind = 'refresh'`)
      .get(sha256(refreshToken)) as TokenRow | undefined;
    if (
      !row ||
      row.revoked_at ||
      row.client_id !== clientId ||
      (row.expires_at && row.expires_at < nowIso())
    )
      return null;
    const agent = this.agents.get(row.agent_id);
    if (!agent || agent.revokedAt) return null;
    this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE hash = ?').run(nowIso(), row.hash);
    return this.issueOAuthTokens(row.agent_id, clientId, parseScope(row.scope));
  }

  verify(bearer: string | undefined): Principal | null {
    if (!bearer || !(bearer.startsWith(PREFIX.access) || bearer.startsWith(PREFIX.pat)))
      return null;
    const hash = sha256(bearer);
    const row = this.db.prepare('SELECT * FROM tokens WHERE hash = ?').get(hash) as
      TokenRow | undefined;
    if (!row || row.kind === 'refresh' || row.revoked_at) return null;
    if (row.expires_at && row.expires_at < nowIso()) return null;
    const agent = this.agents.get(row.agent_id);
    if (!agent || agent.revokedAt) return null;
    this.db.prepare('UPDATE tokens SET last_used_at = ? WHERE hash = ?').run(nowIso(), hash);
    return { agent, scope: new Set(parseScope(row.scope)), tokenId: hash.slice(0, 12) };
  }

  revokeToken(rawOrId: string): void {
    if (rawOrId.length > 12)
      this.db
        .prepare('UPDATE tokens SET revoked_at = ? WHERE hash = ?')
        .run(nowIso(), sha256(rawOrId));
    else
      this.db
        .prepare(`UPDATE tokens SET revoked_at = ? WHERE substr(hash, 1, 12) = ?`)
        .run(nowIso(), rawOrId);
  }

  list(agentId?: string): TokenInfo[] {
    const rows = (
      agentId
        ? this.db
            .prepare(
              `SELECT * FROM tokens WHERE agent_id = ? AND kind != 'refresh' ORDER BY created_at DESC`,
            )
            .all(agentId)
        : this.db
            .prepare(`SELECT * FROM tokens WHERE kind != 'refresh' ORDER BY created_at DESC`)
            .all()
    ) as TokenRow[];
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
  prune(): void {
    const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
    this.db
      .prepare(
        'DELETE FROM tokens WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR (expires_at IS NOT NULL AND expires_at < ?)',
      )
      .run(cutoff, cutoff);
  }
}

/** What a principal may actually do: token scope intersected with agent settings. */
export function capabilities(p: Principal) {
  const canRead = p.agent.canRead && p.scope.has('notes:read');
  const canPropose =
    p.agent.writeMode !== 'none' && (p.scope.has('notes:propose') || p.scope.has('notes:write'));
  const canWriteDirect = p.agent.writeMode === 'direct' && p.scope.has('notes:write');
  return { canRead, canPropose, canWriteDirect };
}
