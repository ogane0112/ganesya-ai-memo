import { type Db, nowIso, stmt } from '../db/db.js';
import { randomId } from '../util/crypto.js';

export type WriteMode = 'none' | 'propose' | 'direct';

export interface Agent {
  id: string;
  userId: string;
  name: string;
  description: string;
  canRead: boolean;
  writeMode: WriteMode;
  /** Folders the agent may access. Empty = all. */
  folders: string[];
  /** Merge clean proposals automatically. */
  autoMerge: boolean;
  /** Restrict auto-merge to these folders. Empty = everywhere the agent can write. */
  autoMergeFolders: string[];
  /** Where the agent's model runs. External agents only see notes allowed for external AI. */
  location: 'external' | 'local';
  createdAt: string;
  revokedAt: string | null;
}

interface AgentRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  can_read: number;
  write_mode: WriteMode;
  folders: string;
  auto_merge: number;
  auto_merge_folders: string;
  location: 'external' | 'local';
  created_at: string;
  revoked_at: string | null;
}

function fromRow(r: AgentRow): Agent {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    description: r.description,
    canRead: !!r.can_read,
    writeMode: r.write_mode,
    folders: JSON.parse(r.folders) as string[],
    autoMerge: !!r.auto_merge,
    autoMergeFolders: JSON.parse(r.auto_merge_folders) as string[],
    location: r.location,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  };
}

export type AgentInput = Partial<Omit<Agent, 'id' | 'userId' | 'createdAt' | 'revokedAt'>> & {
  name: string;
};

/** Load any agent by id (token verification), regardless of the owner. */
export async function agentById(db: Db, id: string): Promise<Agent | null> {
  const r = await db.first<AgentRow>('SELECT * FROM agents WHERE id = ?', id);
  return r ? fromRow(r) : null;
}

/** A user's AI agents. */
export class AgentStore {
  constructor(
    private readonly db: Db,
    readonly userId: string,
  ) {}

  async list(): Promise<Agent[]> {
    return (
      await this.db.all<AgentRow>(
        'SELECT * FROM agents WHERE user_id = ? ORDER BY created_at',
        this.userId,
      )
    ).map(fromRow);
  }

  async get(id: string): Promise<Agent | null> {
    const r = await this.db.first<AgentRow>(
      'SELECT * FROM agents WHERE id = ? AND user_id = ?',
      id,
      this.userId,
    );
    return r ? fromRow(r) : null;
  }

  async getByName(name: string): Promise<Agent | null> {
    const r = await this.db.first<AgentRow>(
      'SELECT * FROM agents WHERE name = ? AND user_id = ?',
      name,
      this.userId,
    );
    return r ? fromRow(r) : null;
  }

  async create(input: AgentInput): Promise<Agent> {
    const name = sanitizeAgentName(input.name);
    let unique = name;
    for (let n = 2; await this.getByName(unique); n++) unique = `${name}-${n}`;
    const id = randomId('ag_');
    await this.db.run(
      `INSERT INTO agents(id, user_id, name, description, can_read, write_mode, folders, auto_merge, auto_merge_folders, location, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      this.userId,
      unique,
      input.description ?? '',
      input.canRead === false ? 0 : 1,
      input.writeMode ?? 'propose',
      JSON.stringify(input.folders ?? []),
      input.autoMerge ? 1 : 0,
      JSON.stringify(input.autoMergeFolders ?? []),
      input.location === 'local' ? 'local' : 'external',
      nowIso(),
    );
    return (await this.get(id))!;
  }

  async update(id: string, patch: Partial<AgentInput>): Promise<Agent | null> {
    const cur = await this.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    await this.db.run(
      `UPDATE agents SET name = ?, description = ?, can_read = ?, write_mode = ?, folders = ?, auto_merge = ?, auto_merge_folders = ?, location = ? WHERE id = ? AND user_id = ?`,
      patch.name ? sanitizeAgentName(patch.name) : cur.name,
      next.description,
      next.canRead ? 1 : 0,
      next.writeMode,
      JSON.stringify(next.folders),
      next.autoMerge ? 1 : 0,
      JSON.stringify(next.autoMergeFolders),
      next.location,
      id,
      this.userId,
    );
    return this.get(id);
  }

  /** Revoke an agent: all its tokens stop working immediately. */
  async revoke(id: string): Promise<void> {
    const now = nowIso();
    await this.db.batch([
      stmt(
        'UPDATE agents SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
        now,
        id,
        this.userId,
      ),
      stmt(
        'UPDATE tokens SET revoked_at = ? WHERE agent_id = ? AND user_id = ? AND revoked_at IS NULL',
        now,
        id,
        this.userId,
      ),
    ]);
  }
}

export function sanitizeAgentName(name: string): string {
  const s = name
    .replace(/[<>\n\r\t@]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return s || 'agent';
}
