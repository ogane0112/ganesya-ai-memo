import type { UiPrefs } from '../lib/theme';

/**
 * Types mirrored from the server's JSON responses (packages/server). Shared
 * shapes that live in @gmemo/core are imported from there.
 */
import type {
  AiAccess,
  BlockAttribution,
  DiffOp,
  NoteMergeResult,
  Choice,
  ViewDefinition,
  ViewNote,
  WorkspacePolicy,
} from '@gmemo/core';

export type {
  AiAccess,
  BlockAttribution,
  Choice,
  NoteMergeResult,
  ViewDefinition,
  ViewNote,
  WorkspacePolicy,
};

export type AppEnv = 'production' | 'staging' | 'development';

export interface AuthState {
  needsSetup: boolean;
  /** Which deployment this is (staging shows a banner). */
  env?: AppEnv;
  /** Who may create an account (after the first, admin, account). */
  signup: SignupMode;
  user: { username: string; isAdmin: boolean } | null;
  session: { via: 'passkey' | 'recovery'; expiresAt: string } | null;
  rpId: string;
  origin: string;
  recoveryCodesRemaining: number | null;
  passkeyCount: number | null;
  /** Display preferences (null when signed out). */
  prefs?: UiPrefs | null;
}

export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: string | null;
  backedUp: boolean;
}

export interface NoteSummary {
  path: string;
  title: string;
  createdBy: string | null;
  aiAgent: string | null;
  updatedAt: string | null;
  tags: string[];
}

export interface NoteDoc {
  path: string;
  content: string;
  sha: string;
  commit: string;
  frontmatter: Record<string, unknown>;
  access?: AiAccess;
}

export type SaveResult =
  | { status: 'committed'; commit: string; sha: string; merged: boolean }
  | { status: 'unchanged'; commit: string; sha: string }
  | { status: 'proposed'; proposalId: string; reason: string; merged?: boolean; commit?: string };

export interface Backlinks {
  backlinks: { path: string; title: string; context: string }[];
  outgoing: { target: string; path: string | null }[];
}

export interface HistoryEntry {
  sha: string;
  date: string;
  author: string;
  authorKind: 'human' | 'ai' | 'system';
  agentId: string | null;
  subject: string;
  proposalId: string | null;
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  score: number;
  matchedBy: ('text' | 'vector')[];
}

export interface GraphData {
  nodes: { id: string; title: string; createdBy: string | null; tags: string[] }[];
  edges: { source: string; target: string }[];
}

export type ProposalStatus = 'open' | 'merged' | 'rejected';

export interface ProposalRow {
  id: string;
  agent_id: string | null;
  author_name: string;
  author_kind: 'ai' | 'human';
  source: string;
  branch: string;
  base_commit: string;
  title: string;
  description: string;
  status: ProposalStatus;
  created_at: string;
  updated_at: string;
  merged_commit: string | null;
}

export interface ProposalFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  base: string | null;
  proposed: string | null;
  current: string | null;
  mainChanged: boolean;
  diff: DiffOp<string>[];
  merge: NoteMergeResult | null;
  deleteConflict: boolean;
}

export interface ProposalDetail {
  proposal: ProposalRow;
  files: ProposalFile[];
}

export interface FileResolution {
  blocks?: Record<number, Choice>;
  frontmatter?: Record<string, 'ours' | 'theirs'>;
  reject?: boolean;
  file?: 'keep' | 'delete' | 'theirs';
}

export interface UnresolvedConflict {
  path: string;
  blocks: number[];
  keys: string[];
  file?: boolean;
}

export interface ViewEntry {
  id: string;
  view?: ViewDefinition;
  error?: string;
  source: string;
}

export interface ViewRows {
  view: ViewDefinition;
  rows: ViewNote[];
  groups?: { key: string; rows: ViewNote[] }[];
}

export interface AiStatus {
  local: string | null;
  external: string | null;
  externalAcknowledged: boolean;
}

export interface AuditEntry {
  at: string;
  kind: string;
  actor: string;
  detail: Record<string, unknown>;
}

export interface PublicFinding {
  rule: string;
  category: string;
  label: string;
  start: number;
  end: number;
  fingerprint: string;
  preview: string;
}

export interface AskResult {
  answer: string;
  target: 'local' | 'external';
  model: string;
  used: string[];
  excluded: string[];
  sources: { n: number; path: string; title: string }[];
  findings: PublicFinding[];
  masked: boolean;
}

export type Scope = 'notes:read' | 'notes:propose' | 'notes:write' | 'notes:capture';
export const SCOPES: Scope[] = ['notes:read', 'notes:propose', 'notes:write', 'notes:capture'];

export type WriteMode = 'none' | 'propose' | 'direct';

export interface AgentPermissions {
  name: string;
  description: string;
  canRead: boolean;
  writeMode: WriteMode;
  folders: string[];
  autoMerge: boolean;
  autoMergeFolders: string[];
  location: 'external' | 'local';
}

export interface Agent extends AgentPermissions {
  id: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface TokenInfo {
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

export interface AgentWithAccess extends Agent {
  clients: { clientId: string; clientName: string; createdAt: string }[];
  tokens: TokenInfo[];
}

export interface OAuthRequestInfo {
  request: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state?: string;
    scope: Scope[];
    resource?: string;
  };
  client: { name: string; redirectUri: string; linkedAgentId: string | null };
  agents: Agent[];
}

export type SignupMode = 'open' | 'invite' | 'closed';

export interface StorageSettings {
  storage: 'builtin' | 'github';
  github: { owner: string; repo: string; branch: string; hasToken: boolean } | null;
  updatedAt: string;
  /** The server has a secret key, so GitHub tokens can be stored. */
  githubAvailable: boolean;
}

export interface UserInfo {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
}

export interface InviteInfo {
  id: string;
  createdAt: string;
  expiresAt: string | null;
  usedBy: string | null;
  usedAt: string | null;
}

// ---- calendar ---------------------------------------------------------------

export interface CalendarFeed {
  id: string;
  viewId: string;
  label: string;
  includeLinks: boolean;
  createdAt: string;
  lastFetchedAt: string | null;
}

export interface CalendarSubscription {
  id: string;
  name: string;
  urlPreview: string;
  color: string;
  enabled: boolean;
  createdAt: string;
  fetchedAt: string | null;
  lastError: string | null;
  eventCount: number | null;
}

export interface ExternalEvent {
  uid: string;
  title: string;
  location?: string;
  allDay: boolean;
  /** All-day: 'YYYY-MM-DD'; timed: ISO 8601 UTC. */
  start: string;
  /** Exclusive end. */
  end: string;
  subscriptionId: string;
  calendar: string;
  color: string;
}

export type SecurityOutcome = 'success' | 'failure' | 'denied';

/** One entry of the security audit log. */
export interface SecurityEvent {
  id: number;
  at: string;
  userId: string | null;
  actor: string;
  action: string;
  outcome: SecurityOutcome;
  target: string | null;
  /** Keyed hash of the client address (h:…), the address, or null. */
  ip: string | null;
  /** Coarse "browser / OS". */
  ua: string | null;
  detail: Record<string, unknown>;
}

export interface SecurityLogCheck {
  checked: number;
  firstId: number | null;
  lastId: number | null;
  tampered: number[];
  missing: { from: number; to: number }[];
  unsigned: number;
}
