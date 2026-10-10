import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { type DB, nowIso } from '../db/db.js';
import { randomId, randomToken, safeEqual, sha256 } from '../util/crypto.js';
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
  agentId: string | null;
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scope: Scope[];
  resource?: string;
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
    private readonly db: DB,
    private readonly cfg: Config,
    private readonly agents: AgentStore,
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

  register(body: unknown): Record<string, unknown> {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const redirectUris = Array.isArray(b['redirect_uris'])
      ? b['redirect_uris'].filter((u): u is string => typeof u === 'string')
      : [];
    if (redirectUris.length === 0 || !redirectUris.every(isAllowedRedirect)) {
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
    this.db
      .prepare(
        'INSERT INTO oauth_clients(client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(clientId, clientName, JSON.stringify(redirectUris), nowIso());
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

  client(clientId: string): OAuthClient | null {
    const r = this.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as
      | {
          client_id: string;
          client_name: string;
          redirect_uris: string;
          created_at: string;
          agent_id: string | null;
        }
      | undefined;
    return r
      ? {
          clientId: r.client_id,
          clientName: r.client_name,
          redirectUris: JSON.parse(r.redirect_uris) as string[],
          createdAt: r.created_at,
          agentId: r.agent_id,
        }
      : null;
  }

  clients(): OAuthClient[] {
    return (
      this.db.prepare('SELECT client_id FROM oauth_clients ORDER BY created_at DESC').all() as {
        client_id: string;
      }[]
    ).map((r) => this.client(r.client_id)!);
  }

  deleteClient(clientId: string): void {
    this.db.prepare('DELETE FROM oauth_clients WHERE client_id = ?').run(clientId);
  }

  /** Validate an /authorize request before showing the consent screen. */
  validateAuthorize(q: Record<string, string | undefined>): AuthorizeRequest {
    const client = q['client_id'] ? this.client(q['client_id']) : null;
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
      scope: parseScope(q['scope']),
      ...(q['state'] !== undefined ? { state: q['state'] } : {}),
      ...(q['resource'] ? { resource: q['resource'] } : {}),
    };
  }

  /**
   * The signed-in human approved the request. Links the client to an existing
   * agent or creates one with the chosen permissions, then returns the redirect.
   */
  approve(
    req: AuthorizeRequest,
    choice: { agentId?: string; newAgent?: AgentInput; scope?: Scope[] },
  ): string {
    const client = this.client(req.clientId);
    if (!client) throw new OAuthError('invalid_client', 'unknown client_id');
    let agentId = choice.agentId ?? client.agentId ?? undefined;
    if (!agentId || !this.agents.get(agentId)) {
      agentId = this.agents.create(choice.newAgent ?? { name: client.clientName }).id;
    }
    this.db
      .prepare('UPDATE oauth_clients SET agent_id = ? WHERE client_id = ?')
      .run(agentId, client.clientId);
    const code = randomToken(32);
    const scope = choice.scope?.length
      ? choice.scope.filter((s) => req.scope.includes(s) || s === 'notes:read')
      : req.scope;
    this.db
      .prepare(
        'INSERT INTO oauth_codes(code_hash, client_id, agent_id, redirect_uri, code_challenge, scope, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        sha256(code),
        client.clientId,
        agentId,
        req.redirectUri,
        req.codeChallenge,
        scope.join(' '),
        req.resource ?? null,
        new Date(Date.now() + 5 * 60_000).toISOString(),
      );
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

  token(form: Record<string, string | undefined>) {
    const grant = form['grant_type'];
    const clientId = form['client_id'];
    if (!clientId || !this.client(clientId))
      throw new OAuthError('invalid_client', 'unknown client_id', 401);
    if (grant === 'authorization_code') {
      const code = form['code'] ?? '';
      const row = this.db
        .prepare('SELECT * FROM oauth_codes WHERE code_hash = ?')
        .get(sha256(code)) as
        | {
            code_hash: string;
            client_id: string;
            agent_id: string;
            redirect_uri: string;
            code_challenge: string;
            scope: string;
            expires_at: string;
          }
        | undefined;
      // Codes are single use.
      if (row) this.db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(row.code_hash);
      if (!row || row.expires_at < nowIso() || row.client_id !== clientId)
        throw new OAuthError('invalid_grant', 'invalid or expired code');
      if (form['redirect_uri'] !== undefined && form['redirect_uri'] !== row.redirect_uri)
        throw new OAuthError('invalid_grant', 'redirect_uri mismatch');
      const verifier = form['code_verifier'] ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (!verifier || !safeEqual(challenge, row.code_challenge))
        throw new OAuthError('invalid_grant', 'PKCE verification failed');
      return this.tokens.issueOAuthTokens(row.agent_id, clientId, parseScope(row.scope));
    }
    if (grant === 'refresh_token') {
      const res = this.tokens.refresh(form['refresh_token'] ?? '', clientId);
      if (!res) throw new OAuthError('invalid_grant', 'invalid refresh token');
      return res;
    }
    throw new OAuthError('unsupported_grant_type', 'unsupported grant_type');
  }
}
