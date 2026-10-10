import type {
  Agent,
  AgentPermissions,
  AgentWithAccess,
  AiStatus,
  AskResult,
  AuditEntry,
  AuthState,
  Backlinks,
  BlockAttribution,
  CalendarFeed,
  CalendarSubscription,
  FileResolution,
  GraphData,
  HistoryEntry,
  NoteDoc,
  NoteSummary,
  OAuthRequestInfo,
  PasskeyInfo,
  PluginInfo,
  ProposalDetail,
  ProposalRow,
  ProposalStatus,
  ExternalEvent,
  PublicFinding,
  SaveResult,
  Scope,
  SearchHit,
  ViewEntry,
  ViewRows,
  WorkspacePolicy,
} from './types';
import type { UiPrefs } from '../lib/theme';

/** An HTTP error from the API, carrying the status code and the parsed JSON body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message?: string,
  ) {
    super(message ?? errorMessage(body) ?? `HTTP ${status}`);
    this.name = 'ApiError';
  }

  get code(): string | undefined {
    const b = this.body as { code?: unknown } | null;
    return b && typeof b.code === 'string' ? b.code : undefined;
  }

  get details(): unknown {
    return (this.body as { details?: unknown } | null)?.details;
  }

  get findings(): PublicFinding[] {
    const f = (this.body as { findings?: unknown } | null)?.findings;
    return Array.isArray(f) ? (f as PublicFinding[]) : [];
  }
}

/** The request never reached the server (offline, DNS, connection reset). */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super('サーバーに接続できません');
    this.name = 'NetworkError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

function errorMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const b = body as { error?: unknown; error_description?: unknown };
    if (typeof b.error_description === 'string') return b.error_description;
    if (typeof b.error === 'string') return b.error;
  }
  return undefined;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export function qs(q: Query): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q))
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

let unauthorizedHandler: (() => void) | null = null;
/** Called when any API request answers 401 (session expired). */
export function onUnauthorized(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

export async function request<T>(
  method: string,
  url: string,
  body?: unknown,
  init: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers:
        body !== undefined && !(body instanceof FormData)
          ? { 'content-type': 'application/json' }
          : {},
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      ...init,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new NetworkError(e);
  }
  if (!res.ok) {
    let data: unknown = null;
    const text = await res.text().catch(() => '');
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text };
    }
    if (res.status === 401 && unauthorizedHandler && !url.startsWith('/api/auth/'))
      unauthorizedHandler();
    throw new ApiError(res.status, data);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? await res.json() : await res.text()) as T;
}

const get = <T>(url: string, init?: RequestInit) => request<T>('GET', url, undefined, init);
const post = <T>(url: string, body: unknown = {}) => request<T>('POST', url, body);
const put = <T>(url: string, body: unknown) => request<T>('PUT', url, body);
const patch = <T>(url: string, body: unknown) => request<T>('PATCH', url, body);
const del = <T>(url: string) => request<T>('DELETE', url);

type Ok = { ok: true };

export const api = {
  // ---- auth ----------------------------------------------------------------
  authState: () => get<AuthState>('/api/auth/state', { cache: 'no-store' }),
  registerOptions: (b: { setupToken?: string; username?: string }) =>
    post<{ challengeId: string; options: unknown }>('/api/auth/register/options', b),
  registerVerify: (b: {
    challengeId: string;
    response: unknown;
    name?: string;
    setupToken?: string;
  }) =>
    post<{ passkey: PasskeyInfo; recoveryCodes: string[] | null }>('/api/auth/register/verify', b),
  loginOptions: () => post<{ challengeId: string; options: unknown }>('/api/auth/login/options'),
  loginVerify: (b: { challengeId: string; response: unknown }) =>
    post<Ok>('/api/auth/login/verify', b),
  recoveryLogin: (code: string) =>
    post<{ ok: true; mustRegisterPasskey: boolean }>('/api/auth/recovery', { code }),
  logout: () => post<Ok>('/api/auth/logout'),
  logoutAll: () => post<Ok>('/api/auth/logout-all'),
  passkeys: () => get<PasskeyInfo[]>('/api/auth/passkeys'),
  renamePasskey: (id: string, name: string) =>
    patch<Ok>(`/api/auth/passkeys/${encodeURIComponent(id)}`, { name }),
  deletePasskey: (id: string) => del<Ok>(`/api/auth/passkeys/${encodeURIComponent(id)}`),
  regenerateRecoveryCodes: () => post<{ codes: string[] }>('/api/auth/recovery-codes'),

  // ---- notes ---------------------------------------------------------------
  notes: (folder?: string) => get<NoteSummary[]>(`/api/notes${qs({ folder })}`),
  note: (path: string, commit?: string) => get<NoteDoc>(`/api/note${qs({ path, commit })}`),
  saveNote: (b: {
    path: string;
    content: string;
    baseSha?: string | null;
    baseCommit?: string;
    device?: string;
    message?: string;
  }) => put<SaveResult>('/api/note', b),
  deleteNote: (path: string) => del<{ commit: string }>(`/api/note${qs({ path })}`),
  renameNote: (from: string, to: string) =>
    post<{ commit: string }>('/api/note/rename', { from, to }),
  editing: (path: string, active: boolean) =>
    request<Ok>('POST', '/api/note/editing', { path, active }, active ? {} : { keepalive: true }),
  backlinks: (path: string) => get<Backlinks>(`/api/note/backlinks${qs({ path })}`),
  noteHistory: (path: string, limit = 50) =>
    get<HistoryEntry[]>(`/api/note/history${qs({ path, limit })}`),
  blame: (path: string) => get<BlockAttribution[]>(`/api/note/blame${qs({ path })}`),
  fileUrl: (path: string) => `/api/file${qs({ path })}`,
  uploadAttachment: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return post<{ path: string; markdown: string }>('/api/attachments', fd);
  },
  capture: (b: { text: string; title?: string; folder?: string; url?: string }) =>
    post<{ path: string; commit: string }>('/api/capture', b),
  search: (q: string, mode: 'hybrid' | 'text' | 'vector' = 'hybrid', signal?: AbortSignal) =>
    get<SearchHit[]>(`/api/search${qs({ q, mode })}`, signal ? { signal } : {}),
  tags: () => get<{ tag: string; count: number }[]>('/api/tags'),
  graph: () => get<GraphData>('/api/graph'),
  history: (opts: { agentId?: string; limit?: number } = {}) =>
    get<HistoryEntry[]>(`/api/history${qs(opts)}`),
  revert: (commit: string) => post<SaveResult>('/api/revert', { commit }),
  revertAgent: (agentId: string) => post<SaveResult[]>('/api/revert-agent', { agentId }),
  sync: () => post<{ committed: string[] }>('/api/sync'),

  // ---- proposals -----------------------------------------------------------
  proposals: (status?: ProposalStatus) => get<ProposalRow[]>(`/api/proposals${qs({ status })}`),
  proposal: (id: string) => get<ProposalDetail>(`/api/proposals/${encodeURIComponent(id)}`),
  mergeProposal: (id: string, resolutions: Record<string, FileResolution> = {}) =>
    post<{ commit: string }>(`/api/proposals/${encodeURIComponent(id)}/merge`, { resolutions }),
  rejectProposal: (id: string) => post<Ok>(`/api/proposals/${encodeURIComponent(id)}/reject`),

  // ---- views ---------------------------------------------------------------
  views: () => get<ViewEntry[]>('/api/views'),
  viewRows: (id: string) => get<ViewRows>(`/api/views/${encodeURIComponent(id)}/rows`),
  saveView: (id: string, source: string) =>
    put<Ok>(`/api/views/${encodeURIComponent(id)}`, { source }),
  deleteView: (id: string) => del<Ok>(`/api/views/${encodeURIComponent(id)}`),

  // ---- AI ------------------------------------------------------------------
  aiStatus: () => get<AiStatus>('/api/ai/status'),
  aiAudit: (limit = 100) => get<AuditEntry[]>(`/api/ai/audit${qs({ limit })}`),
  ask: (b: {
    question: string;
    prefer?: 'auto' | 'local' | 'external';
    confirm?: boolean;
    paths?: string[];
  }) => post<AskResult>('/api/ask', b),
  scanSensitive: (text: string) =>
    post<{ findings: PublicFinding[]; suggestSecret: boolean }>('/api/sensitive/scan', { text }),

  // ---- admin ---------------------------------------------------------------
  agents: () => get<AgentWithAccess[]>('/api/admin/agents'),
  createAgent: (b: Partial<AgentPermissions> & { name: string }) =>
    post<Agent>('/api/admin/agents', b),
  updateAgent: (id: string, b: Partial<AgentPermissions>) =>
    patch<Agent>(`/api/admin/agents/${encodeURIComponent(id)}`, b),
  revokeAgent: (id: string) => del<Ok>(`/api/admin/agents/${encodeURIComponent(id)}`),
  createToken: (agentId: string, b: { scope: Scope[]; label: string; expiresInDays?: number }) =>
    post<{ token: string; scope: Scope[] }>(
      `/api/admin/agents/${encodeURIComponent(agentId)}/tokens`,
      b,
    ),
  revokeToken: (id: string) => del<Ok>(`/api/admin/tokens/${encodeURIComponent(id)}`),
  deleteOAuthClient: (id: string) => del<Ok>(`/api/admin/oauth-clients/${encodeURIComponent(id)}`),
  oauthRequest: (query: string) =>
    get<OAuthRequestInfo>(`/api/admin/oauth/request${query.startsWith('?') ? query : `?${query}`}`),
  oauthConsent: (b: {
    query: Record<string, string>;
    approve: boolean;
    agentId?: string;
    newAgent?: Partial<AgentPermissions>;
    scope?: Scope[];
  }) => post<{ redirect: string }>('/api/admin/oauth/consent', b),
  policy: () => get<WorkspacePolicy>('/api/admin/policy'),
  savePolicy: (p: WorkspacePolicy) => put<WorkspacePolicy>('/api/admin/policy', p),
  allowFinding: (fingerprint: string) => post<Ok>('/api/admin/policy/allow', { fingerprint }),
  reindex: () => post<Ok>('/api/admin/reindex'),
  plugins: () => get<PluginInfo[]>('/api/admin/plugins'),
  preferences: () => get<UiPrefs>('/api/admin/preferences'),
  savePreferences: (p: UiPrefs) => put<UiPrefs>('/api/admin/preferences', p),
  // ---- calendar ------------------------------------------------------------
  calendarEvents: (from: string, to: string) =>
    get<{ timeZone: string; events: ExternalEvent[] }>(`/api/calendar/events${qs({ from, to })}`),
  calendarFeeds: () => get<CalendarFeed[]>('/api/admin/calendar/feeds'),
  createCalendarFeed: (b: { viewId: string; label?: string; includeLinks?: boolean }) =>
    post<{ feed: CalendarFeed; url: string }>('/api/admin/calendar/feeds', b),
  revokeCalendarFeed: (id: string) =>
    del<Ok>(`/api/admin/calendar/feeds/${encodeURIComponent(id)}`),
  calendarSubscriptions: () => get<CalendarSubscription[]>('/api/admin/calendar/subscriptions'),
  addCalendarSubscription: (b: { name?: string; url: string; color?: string }) =>
    post<CalendarSubscription>('/api/admin/calendar/subscriptions', b),
  updateCalendarSubscription: (
    id: string,
    b: Partial<{ name: string; url: string; color: string; enabled: boolean }>,
  ) =>
    patch<CalendarSubscription>(`/api/admin/calendar/subscriptions/${encodeURIComponent(id)}`, b),
  refreshCalendarSubscription: (id: string) =>
    post<CalendarSubscription | null>(
      `/api/admin/calendar/subscriptions/${encodeURIComponent(id)}/refresh`,
    ),
  deleteCalendarSubscription: (id: string) =>
    del<Ok>(`/api/admin/calendar/subscriptions/${encodeURIComponent(id)}`),
  /** Returns the backup file as a Blob plus the server-suggested file name. */
  backup: async (passphrase?: string): Promise<{ blob: Blob; filename: string }> => {
    let res: Response;
    try {
      res = await fetch('/api/admin/backup', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(passphrase ? { passphrase } : {}),
      });
    } catch (e) {
      throw new NetworkError(e);
    }
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      throw new ApiError(res.status, body);
    }
    const cd = res.headers.get('content-disposition') ?? '';
    const m = /filename="([^"]+)"/.exec(cd);
    return { blob: await res.blob(), filename: m?.[1] ?? 'gmemo-backup.gmbk' };
  },
};

/** Human readable Japanese message for any error thrown by the API layer. */
export function describeError(e: unknown): string {
  if (e instanceof NetworkError) return 'サーバーに接続できません。オフラインかもしれません。';
  if (e instanceof ApiError) {
    const msg = e.message;
    switch (e.status) {
      case 401:
        return 'サインインが必要です。';
      case 403:
        return `権限がありません(${msg})`;
      case 404:
        return `見つかりません(${msg})`;
      case 409:
        return `競合があります(${msg})`;
      case 413:
        return 'サイズが大きすぎます。';
      case 503:
        return `AIを利用できません: ${msg}`;
      default:
        return msg;
    }
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
