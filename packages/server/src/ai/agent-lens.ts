import {
  effectiveAccess,
  type Finding,
  inFolders,
  maskText,
  scanText,
  type WorkspacePolicy,
} from '@gmemo/core';
import type { Agent } from '../auth/agents.js';
import { type Db, nowIso, stmt } from '../db/db.js';

/**
 * How notes look to an agent. Agents whose model runs outside this machine are
 * "external AI": they only see notes whose policy allows external AI, and in
 * mask/warn mode detected secrets are replaced with stable placeholders like
 * `[SECRET_3fa9c2d1]`. When the agent writes text containing a placeholder, the
 * original value is restored locally, so secrets round-trip without leaving.
 */
export class AgentLens {
  constructor(
    private readonly db: Db,
    private readonly userId: string,
  ) {}

  canSee(
    agent: Agent,
    path: string,
    frontmatter: Record<string, unknown> | null,
    policy: WorkspacePolicy,
  ): boolean {
    if (!inFolders(path, agent.folders)) return false;
    const access = effectiveAccess(policy, path, frontmatter ?? {});
    if (access === 'none') return false;
    return agent.location === 'local' || access === 'external';
  }

  private scan(text: string, policy: WorkspacePolicy): Finding[] {
    return scanText(text, {
      dictionary: policy.sensitive.dictionary,
      allow: policy.sensitive.allow,
      disabledRules: policy.sensitive.disabledRules,
    });
  }

  /** Text as handed to the agent. Throws in block mode when something is detected. */
  async outgoing(
    agent: Agent,
    text: string,
    policy: WorkspacePolicy,
  ): Promise<{ text: string; findings: Finding[]; blocked: boolean }> {
    if (agent.location === 'local') return { text, findings: [], blocked: false };
    const findings = this.scan(text, policy);
    if (findings.length === 0) return { text, findings, blocked: false };
    if (policy.sensitive.mode === 'block') return { text: '', findings, blocked: true };
    const mapping: Record<string, string> = {};
    const masked = maskText(
      text,
      findings,
      mapping,
      (f) => `[SECRET_${f.fingerprint.slice(0, 8)}]`,
    );
    const now = nowIso();
    await this.db.batch(
      Object.entries(mapping).map(([ph, value]) =>
        stmt(
          'INSERT INTO secret_placeholders(user_id, placeholder, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, placeholder) DO NOTHING',
          this.userId,
          ph,
          value,
          now,
        ),
      ),
    );
    return { text: masked.text, findings, blocked: false };
  }

  /** Restore placeholders in text written by an agent. */
  async incoming(text: string): Promise<string> {
    const found = [...new Set(text.match(/\[SECRET_[0-9a-f]{8}\]/g) ?? [])].slice(0, 90);
    if (found.length === 0) return text;
    const rows = await this.db.all<{ placeholder: string; value: string }>(
      `SELECT placeholder, value FROM secret_placeholders WHERE user_id = ? AND placeholder IN (${found.map(() => '?').join(',')})`,
      this.userId,
      ...found,
    );
    const map = new Map(rows.map((r) => [r.placeholder, r.value]));
    return text.replace(/\[SECRET_[0-9a-f]{8}\]/g, (ph) => map.get(ph) ?? ph);
  }
}
