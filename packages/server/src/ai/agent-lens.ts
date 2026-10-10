import {
  effectiveAccess,
  type Finding,
  inFolders,
  maskText,
  scanText,
  type WorkspacePolicy,
} from '@gmemo/core';
import type { Rule } from '@gmemo/core';
import type { Agent } from '../auth/agents.js';
import { type DB, nowIso } from '../db/db.js';

/**
 * How notes look to an agent. Agents whose model runs outside this machine are
 * "external AI": they only see notes whose policy allows external AI, and in
 * mask/warn mode detected secrets are replaced with stable placeholders like
 * `[SECRET_3fa9c2d1]`. When the agent writes text containing a placeholder, the
 * original value is restored locally, so secrets round-trip without leaving.
 */
export class AgentLens {
  constructor(
    private readonly db: DB,
    private readonly extraRules: () => Rule[],
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
      extraRules: this.extraRules(),
    });
  }

  /** Text as handed to the agent. Throws in block mode when something is detected. */
  outgoing(
    agent: Agent,
    text: string,
    policy: WorkspacePolicy,
  ): { text: string; findings: Finding[]; blocked: boolean } {
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
    const ins = this.db.prepare(
      'INSERT INTO secret_placeholders(placeholder, value, created_at) VALUES (?, ?, ?) ON CONFLICT(placeholder) DO NOTHING',
    );
    for (const [ph, value] of Object.entries(mapping)) ins.run(ph, value, nowIso());
    return { text: masked.text, findings, blocked: false };
  }

  /** Restore placeholders in text written by an agent. */
  incoming(text: string): string {
    if (!text.includes('[SECRET_')) return text;
    const get = this.db.prepare('SELECT value FROM secret_placeholders WHERE placeholder = ?');
    return text.replace(
      /\[SECRET_[0-9a-f]{8}\]/g,
      (ph) => (get.get(ph) as { value: string } | undefined)?.value ?? ph,
    );
  }
}
