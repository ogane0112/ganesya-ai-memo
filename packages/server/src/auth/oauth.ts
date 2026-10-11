import type { Config } from '../config.js';
import { type Db, nowIso, stmt } from '../db/db.js';
import { randomId, randomToken, safeEqual, sha256, sha256b64url } from '../util/crypto.js';
import type { AgentInput, AgentStore } from './agents.js';
import { parseScope, type Scope, SCOPES, type TokenService } from './tokens.js';

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
}

/** A client as seen by one user: which of their agents it acts as. */
export interface LinkedClient extends OAuthClient {
  agentId: string;
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scope: Scope[];
  resource?: string;
}

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string;
  created_at: string;
}

function toClient(r: ClientRow): OAuthClient {
  return {
    clientId: r.client_id,
    clientName: r.client_name,
    redirectUris: JSON.parse(r.redirect_uris) as string[],
    createdAt: r.created_at,
  };
}

function isAllowedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    // Native apps may use private-use URI schemes (RFC 8252), e.g. com.example.app:/cb
    return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/i.test(u.protocol);
  } catch {
    return false;
  }
}

/**
 * Minimal OAuth 2.1 authorization server for MCP clients: dynamic client
 * registration, authorization code + PKCE (S256), refresh token rotation.
 * Each authorized client becomes (or is linked to) an agent.
 */
export class OAuthService {
  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly tokens: TokenService,
  ) {}

  metadata() {
    const o = this.cfg.origin;
    return {
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/oauth/token`,
      registration_endpoint: `${o}/oauth/register`,
      revocation_endpoint: `${o}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...SCOPES],
    };
  }

  resourceMetadata() {
    return {
      resource: `${this.cfg.origin}/mcp`,
      authorization_servers: [this.cfg.origin],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: this.cfg.rpName,
    };
  }

  /** Dynamic client registration (RFC 7591). Clients are global; links to agents are per user. */
  async register(body: unknown): Promise<Record<string, unknown>> {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const redirectUris = Array.isArray(b['redirect_uris'])
      ? b['redirect_uris'].filter((u): u is string => typeof u === 'string')
      : [];
    if (
      redirectUris.length === 0 ||
      redirectUris.length > 10 ||
      !redirectUris.every(isAllowedRedirect)
    ) {
      throw new OAuthError(
        'invalid_redirect_uri',
        'redirect_uris must be https, loopback http, or a private-use scheme',
      );
    }
    const authMethod = b['token_endpoint_auth_method'];
    if (authMethod !== undefined && authMethod !== 'none') {
      throw new OAuthError(
        'invalid_client_metadata',
        'only public clients (token_endpoint_auth_method=none) are supported',
      );
    }
    const clientName =
      typeof b['client_name'] === 'string' && b['client_name'].trim()
        ? b['client_name'].trim().slice(0, 80)
        : 'MCP client';
    const clientId = randomId('mcp_');
    await this.db.run(
      'INSERT INTO oauth_clients(client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)',
      clientId,
      clientName,
      JSON.stringify(redirectUris),
      nowIso(),
    );
    return {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
  }

  async client(clientId: string): Promise<OAuthClient | null> {
    const r = await this.db.first<ClientRow>(
      'SELECT * FROM oauth_clients WHERE client_id = ?',
      clientId,
    );
    return r ? toClient(r) : null;
  }

  /** The agent this user linked the client to, if any. */
  async linkedAgent(clientId: string, userId: string): Promise<string | null> {
    const r = await this.db.first<{ agent_id: string }>(
      'SELECT agent_id FROM oauth_client_agents WHERE client_id = ? AND user_id = ?',
      clientId,
      userId,
    );
    return r?.agent_id ?? null;
  }

  /** Clients the user has authorized. */
  async clients(userId: string): Promise<LinkedClient[]> {
    const rows = await this.db.all<ClientRow & { agent_id: string }>(
      `SELECT c.*, l.agent_id FROM oauth_client_agents l JOIN oauth_clients c ON c.client_id = l.client_id
       WHERE l.user_id = ? ORDER BY c.created_at DESC`,
      userId,
    );
    return rows.map((r) => ({ ...toClient(r), agentId: r.agent_id }));
  }

  /** Disconnect a client from this user's notes: unlink it and revoke its tokens. */
  async disconnectClient(userId: string, clientId: string): Promise<void> {
    const now = nowIso();
    await this.db.batch([
      stmt('DELETE FROM oauth_client_agents WHERE client_id = ? AND user_id = ?', clientId, userId),
      stmt(
        'UPDATE tokens SET revoked_at = ? WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL',
        now,
        clientId,
        userId,
      ),
    ]);
  }

  /** Validate an /authorize request before showing the consent screen. */
  async validateAuthorize(q: Record<string, string | undefined>): Promise<AuthorizeRequest> {
    const client = q['client_id'] ? await this.client(q['client_id']) : null;
    if (!client) throw new OAuthError('invalid_client', 'unknown client_id');
    const redirectUri =
      q['redirect_uri'] ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !client.redirectUris.includes(redirectUri))
      throw new OAuthError('invalid_request', 'redirect_uri does not match registration');
    if (q['response_type'] !== 'code')
      throw new OAuthError('unsupported_response_type', 'response_type must be code');
    if (!q['code_challenge'] || (q['code_challenge_method'] ?? 'S256') !== 'S256') {
      throw new OAuthError('invalid_request', 'PKCE with S256 is required');
    }
    return {
      clientId: client.clientId,
      redirectUri,
      codeChallenge: q['code_challenge'],
      // Capture writes as the person, outside the agent's limits: personal tokens only.
      scope: parseScope(q['scope']).filter((s) => s !== 'notes:capture'),
      ...(q['state'] !== undefined ? { state: q['state'] } : {}),
      ...(q['resource'] ? { resource: q['resource'] } : {}),
    };
  }

  /**
   * The signed-in user approved the request. Links the client to one of their
   * agents (or a new one with the chosen permissions), then returns the redirect.
   */
  async approve(
    userId: string,
    agents: AgentStore,
    req: AuthorizeRequest,
    choice: { agentId?: string; newAgent?: AgentInput; scope?: Scope[] },
  ): Promise<string> {
    const client = await this.client(req.clientId);
    if (!client) throw new OAuthError('invalid_client', 'unknown client_id');
    let agentId = choice.agentId ?? (await this.linkedAgent(client.clientId, userId)) ?? undefined;
    const existing = agentId ? await agents.get(agentId) : null;
    if (!existing || existing.revokedAt) {
      agentId = (await agents.create(choice.newAgent ?? { name: client.clientName })).id;
    }
    const code = randomToken(32);
    const scope = choice.scope?.length
      ? choice.scope.filter(
          (s) => (req.scope.includes(s) || s === 'notes:read') && s !== 'notes:capture',
        )
      : req.scope;
    await this.db.batch([
      stmt('DELETE FROM oauth_codes WHERE expires_at < ?', nowIso()),
      stmt(
        `INSERT INTO oauth_client_agents(client_id, user_id, agent_id) VALUES (?, ?, ?)
         ON CONFLICT(client_id, user_id) DO UPDATE SET agent_id = excluded.agent_id`,
        client.clientId,
        userId,
        agentId!,
      ),
      stmt(
        'INSERT INTO oauth_codes(code_hash, client_id, user_id, agent_id, redirect_uri, code_challenge, scope, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        await sha256(code),
        client.clientId,
        userId,
        agentId!,
        req.redirectUri,
        req.codeChallenge,
        scope.join(' '),
        req.resource ?? null,
        new Date(Date.now() + 5 * 60_000).toISOString(),
      ),
    ]);
    const url = new URL(req.redirectUri);
    url.searchParams.set('code', code);
    if (req.state !== undefined) url.searchParams.set('state', req.state);
    url.searchParams.set('iss', this.cfg.origin);
    return url.toString();
  }

  deny(req: AuthorizeRequest): string {
    const url = new URL(req.redirectUri);
    url.searchParams.set('error', 'access_denied');
    if (req.state !== undefined) url.searchParams.set('state', req.state);
    return url.toString();
  }

  async token(form: Record<string, string | undefined>) {
    const grant = form['grant_type'];
    const clientId = form['client_id'];
    if (!clientId || !(await this.client(clientId)))
      throw new OAuthError('invalid_client', 'unknown client_id', 401);
    if (grant === 'authorization_code') {
      const hash = await sha256(form['code'] ?? '');
      const row = await this.db.first<{
        code_hash: string;
        client_id: string;
        user_id: string;
        agent_id: string;
        redirect_uri: string;
        code_challenge: string;
        scope: string;
        expires_at: string;
      }>('SELECT * FROM oauth_codes WHERE code_hash = ?', hash);
      // Codes are single use.
      const claimed = row
        ? (await this.db.run('DELETE FROM oauth_codes WHERE code_hash = ?', hash)).changes
        : 0;
      if (!row || claimed !== 1 || row.expires_at < nowIso() || row.client_id !== clientId)
        throw new OAuthError('invalid_grant', 'invalid or expired code');
      if (form['redirect_uri'] !== undefined && form['redirect_uri'] !== row.redirect_uri)
        throw new OAuthError('invalid_grant', 'redirect_uri mismatch');
      const verifier = form['code_verifier'] ?? '';
      const challenge = await sha256b64url(verifier);
      if (!verifier || !safeEqual(challenge, row.code_challenge))
        throw new OAuthError('invalid_grant', 'PKCE verification failed');
      return this.tokens.issueOAuthTokens(
        row.user_id,
        row.agent_id,
        clientId,
        parseScope(row.scope),
      );
    }
    if (grant === 'refresh_token') {
      const res = await this.tokens.refresh(form['refresh_token'] ?? '', clientId);
      if (!res) throw new OAuthError('invalid_grant', 'invalid refresh token');
      return res;
    }
    throw new OAuthError('unsupported_grant_type', 'unsupported grant_type');
  }
}
