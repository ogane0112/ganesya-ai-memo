import { type DB, nowIso } from '../db/db.js';
import { randomId } from '../util/crypto.js';

export type WriteMode = 'none' | 'propose' | 'direct';

export interface Agent {
  id: string;
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
  createdAt: string;
  revokedAt: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  description: string;
  can_read: number;
  write_mode: WriteMode;
  folders: string;
  auto_merge: number;
  auto_merge_folders: string;
  created_at: string;
  revoked_at: string | null;
}

function fromRow(r: AgentRow): Agent {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    canRead: !!r.can_read,
    writeMode: r.write_mode,
    folders: JSON.parse(r.folders) as string[],
    autoMerge: !!r.auto_merge,
    autoMergeFolders: JSON.parse(r.auto_merge_folders) as string[],
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  };
}

export type AgentInput = Partial<Omit<Agent, 'id' | 'createdAt' | 'revokedAt'>> & { name: string };

export class AgentStore {
  constructor(private readonly db: DB) {}

  list(): Agent[] {
    return (this.db.prepare('SELECT * FROM agents ORDER BY created_at').all() as AgentRow[]).map(fromRow);
  }

  get(id: string): Agent | null {
    const r = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
    return r ? fromRow(r) : null;
  }

  getByName(name: string): Agent | null {
    const r = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as AgentRow | undefined;
    return r ? fromRow(r) : null;
  }

  create(input: AgentInput): Agent {
    const name = sanitizeAgentName(input.name);
    let unique = name;
    for (let n = 2; this.getByName(unique); n++) unique = `${name}-${n}`;
    const id = randomId('ag_');
    this.db
      .prepare(
        `INSERT INTO agents(id, name, description, can_read, write_mode, folders, auto_merge, auto_merge_folders, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        unique,
        input.description ?? '',
        input.canRead === false ? 0 : 1,
        input.writeMode ?? 'propose',
        JSON.stringify(input.folders ?? []),
        input.autoMerge ? 1 : 0,
        JSON.stringify(input.autoMergeFolders ?? []),
        nowIso(),
      );
    return this.get(id)!;
  }

  update(id: string, patch: Partial<AgentInput>): Agent | null {
    const cur = this.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE agents SET name = ?, description = ?, can_read = ?, write_mode = ?, folders = ?, auto_merge = ?, auto_merge_folders = ? WHERE id = ?`,
      )
      .run(
        patch.name ? sanitizeAgentName(patch.name) : cur.name,
        next.description,
        next.canRead ? 1 : 0,
        next.writeMode,
        JSON.stringify(next.folders),
        next.autoMerge ? 1 : 0,
        JSON.stringify(next.autoMergeFolders),
        id,
      );
    return this.get(id);
  }

  /** Revoke an agent: all its tokens stop working immediately. */
  revoke(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE agents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), id);
      this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL').run(nowIso(), id);
    })();
  }
}

export function sanitizeAgentName(name: string): string {
  const s = name.replace(/[<>\n\r\t@]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return s || 'agent';
}
