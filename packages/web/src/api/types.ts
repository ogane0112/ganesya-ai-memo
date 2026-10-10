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

export interface AuthState {
  needsSetup: boolean;
  user: { username: string } | null;
  session: { via: 'passkey' | 'recovery'; expiresAt: string } | null;
  rpId: string;
  origin: string;
  recoveryCodesRemaining: number | null;
  passkeyCount: number | null;
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

export interface PluginInfo {
  name: string;
  error: string | null;
  routes: string[];
  tools: string[];
}
