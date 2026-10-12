import {
  effectiveAccess,
  type Finding,
  fingerprint,
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
 * mask/warn mode detected secrets are replaced with stable random placeholders like
 * `[SECRET_3fa9c2d1e07b4a55]`. When the agent writes text containing a placeholder, the
 * original value is restored locally, so secrets round-trip without leaving.
 */
export type HiddenReason = 'folder' | 'ai-none' | 'local-only';

/** What to tell an agent (and the owner, through the agent) about a hidden note. */
export function hiddenMessage(path: string, reason: HiddenReason, agent: Agent): string {
  switch (reason) {
    case 'folder':
      return `${path} is outside the folders this agent may read (${agent.folders.join(', ')}). The owner can change the agent's folders in Settings → Agents.`;
    case 'ai-none':
      return `${path} is not shared with any AI: AI sharing is off for this note or its folder. The owner can change it in Settings → AI policy, or in the note's properties.`;
    case 'local-only':
      return `${path} is shared with local AI only, and this agent is an external AI. The owner can allow external AI for its folder in Settings → AI policy ("外部AI可"), or for this note in its properties ("外部AIにも送ってよい").`;
  }
}

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
    return this.whyHidden(agent, path, frontmatter, policy) === null;
  }

  /**
   * Why `agent` may not see `path`, or null when it may:
   * - 'folder': outside the folders this agent was limited to
   * - 'ai-none': AI sharing is off for the note or its folder
   * - 'local-only': only local AI may see it, and this agent is an external AI
   */
  whyHidden(
    agent: Agent,
    path: string,
    frontmatter: Record<string, unknown> | null,
    policy: WorkspacePolicy,
  ): HiddenReason | null {
    if (!inFolders(path, agent.folders)) return 'folder';
    const access = effectiveAccess(policy, path, frontmatter ?? {});
    if (access === 'none') return 'ai-none';
    if (agent.location === 'external' && access !== 'external') return 'local-only';
    return null;
  }

  private scan(text: string, policy: WorkspacePolicy): Finding[] {
    return scanText(text, {
      dictionary: policy.sensitive.dictionary,
      allow: policy.sensitive.allow,
      disabledRules: policy.sensitive.disabledRules,
    });
  }

  /** Every value masked for this user so far (placeholder → value), newest first. */
  private async known(memo: LensMemo): Promise<Map<string, string>> {
    memo.known ??= this.db
      .all<{ placeholder: string; value: string }>(
        'SELECT placeholder, value FROM secret_placeholders WHERE user_id = ? ORDER BY created_at DESC LIMIT 5000',
        this.userId,
      )
      .then((rows) => {
        // value → placeholder to reuse. Old hash-based placeholders reveal a hash of the
        // value, so they are never handed out again ('' = known value, new placeholder needed).
        const byValue = new Map<string, string>();
        for (const r of rows)
          if (r.placeholder.length === LONG) byValue.set(r.value, r.placeholder);
          else if (!byValue.has(r.value)) byValue.set(r.value, '');
        return byValue;
      });
    return memo.known;
  }

  /**
   * Text as handed to the agent. Throws in block mode when something is detected.
   *
   * Besides what the rules detect, every value ever masked for this user is masked
   * wherever it appears: an agent cannot reveal a secret by writing its placeholder
   * into a context the rules no longer match (`x[SECRET_…]x`) and reading it back.
   * Placeholders are random, so they say nothing about the value.
   */
  async outgoing(
    agent: Agent,
    text: string,
    policy: WorkspacePolicy,
    memo: LensMemo = {},
  ): Promise<{ text: string; findings: Finding[]; blocked: boolean }> {
    if (agent.location === 'local') return { text, findings: [], blocked: false };
    const byValue = await this.known(memo);
    const allowed = new Set(policy.sensitive.allow);
    const findings = [
      ...this.scan(text, policy),
      ...knownFindings(text, byValue).filter((f) => !allowed.has(fingerprint(f.value))),
    ];
    if (findings.length === 0) return { text, findings, blocked: false };
    if (policy.sensitive.mode === 'block') return { text: '', findings, blocked: true };
    const mapping: Record<string, string> = {};
    const created: [string, string][] = [];
    const masked = maskText(text, findings, mapping, (f) => {
      let ph = byValue.get(f.value);
      if (!ph) {
        ph = randomPlaceholder();
        byValue.set(f.value, ph);
        created.push([ph, f.value]);
      }
      return ph;
    });
    if (created.length) {
      const now = nowIso();
      await this.db.batch(
        created.map(([ph, value]) =>
          stmt(
            'INSERT INTO secret_placeholders(user_id, placeholder, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, placeholder) DO NOTHING',
            this.userId,
            ph,
            value,
            now,
          ),
        ),
      );
    }
    return { text: masked.text, findings, blocked: false };
  }

  /** Restore placeholders in text written by an agent. */
  async incoming(text: string): Promise<string> {
    const found = [...new Set(text.match(PLACEHOLDER) ?? [])].slice(0, 90);
    if (found.length === 0) return text;
    const rows = await this.db.all<{ placeholder: string; value: string }>(
      `SELECT placeholder, value FROM secret_placeholders WHERE user_id = ? AND placeholder IN (${found.map(() => '?').join(',')})`,
      this.userId,
      ...found,
    );
    const map = new Map(rows.map((r) => [r.placeholder, r.value]));
    return text.replace(PLACEHOLDER, (ph) => map.get(ph) ?? ph);
  }
}

/** Per-request cache for AgentLens (one database read for all texts of a request). */
export interface LensMemo {
  known?: Promise<Map<string, string>>;
}

/** `[SECRET_` + 8 hex (older, hash-based) or 16 hex (random) + `]`. */
const PLACEHOLDER = /\[SECRET_[0-9a-f]{8}(?:[0-9a-f]{8})?\]/g;
const LONG = '[SECRET_]'.length + 16;
/** Shorter known values are not masked by value alone (they would match by chance). */
const MIN_KNOWN_LENGTH = 6;

function randomPlaceholder(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `[SECRET_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}]`;
}

/** Occurrences of previously masked values, as findings. */
function knownFindings(text: string, byValue: Map<string, string>): Finding[] {
  const out: Finding[] = [];
  for (const value of byValue.keys()) {
    if (value.length < MIN_KNOWN_LENGTH) continue;
    for (let i = text.indexOf(value); i !== -1; i = text.indexOf(value, i + value.length))
      out.push({
        rule: 'known-secret',
        category: 'secret',
        label: '以前に伏せた値',
        start: i,
        end: i + value.length,
        value,
        fingerprint: '',
      });
  }
  return out;
}
