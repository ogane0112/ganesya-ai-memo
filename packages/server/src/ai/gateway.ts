import {
  type AiAccess,
  type Finding,
  fingerprint,
  maskText,
  scanText,
  unmaskText,
  type WorkspacePolicy,
} from '@gmemo/core';
import { type Db, nowIso } from '../db/db.js';
import { type ChatMessage, type LlmClient, parseJsonLoose } from './llm.js';

export class AiUnavailableError extends Error {}

/** The request contains sensitive data and the policy blocks it. */
export class SensitiveBlockedError extends Error {
  constructor(readonly findings: Finding[]) {
    super('sensitive information detected; sending to external AI is blocked');
  }
}

/** Warn mode: the caller must confirm before data leaves the machine. */
export class SensitiveWarningError extends Error {
  constructor(readonly findings: Finding[]) {
    super('sensitive information detected; confirm to send to external AI');
  }
}

export interface ContextDoc {
  path: string;
  title: string;
  text: string;
  access: AiAccess;
}

export interface GatewayResult {
  answer: string;
  target: 'local' | 'external';
  model: string;
  used: string[];
  /** Notes left out because their policy does not allow this target. */
  excluded: string[];
  findings: Finding[];
  masked: boolean;
}

/** Detection result with labels for the UI (values are never logged). */
export type PublicFinding = Omit<Finding, 'value'> & { preview: string };

export function publicFinding(f: Finding): PublicFinding {
  const { value, ...rest } = f;
  const preview =
    value.length <= 4
      ? '•'.repeat(value.length)
      : `${value.slice(0, 2)}${'•'.repeat(Math.min(8, value.length - 4))}${value.slice(-2)}`;
  return { ...rest, preview };
}

/**
 * The single exit point for note content going to an LLM. Enforces per-folder
 * AI access, runs local sensitive-data detection before any external call,
 * masks/unmasks placeholders, and keeps a local audit trail.
 */
export class AiGateway {
  constructor(
    private readonly db: Db,
    private readonly userId: string,
    private readonly local: LlmClient | null,
    private readonly external: LlmClient | null,
  ) {}

  status() {
    return { local: this.local?.label ?? null, external: this.external?.label ?? null };
  }

  pickTarget(prefer: 'local' | 'external' | 'auto', policy: WorkspacePolicy): LlmClient {
    const externalOk = !!this.external && policy.externalAcknowledged;
    if (prefer === 'external') {
      if (!this.external) throw new AiUnavailableError('外部AIが設定されていません');
      if (!policy.externalAcknowledged)
        throw new AiUnavailableError(
          '外部AIはまだ有効化されていません(設定画面で確認してください)',
        );
      return this.external;
    }
    if (prefer === 'local' || !externalOk) {
      if (!this.local) throw new AiUnavailableError('ローカルLLMが設定されていません');
      return this.local;
    }
    return this.local ?? this.external!;
  }

  /** Rule-based + dictionary scan, plus the local model as an entity detector when enabled. */
  async scan(text: string, policy: WorkspacePolicy): Promise<Finding[]> {
    const opts = {
      dictionary: policy.sensitive.dictionary,
      allow: policy.sensitive.allow,
      disabledRules: policy.sensitive.disabledRules,
    };
    const findings = scanText(text, opts);
    if (policy.sensitive.useLocalModel && this.local) {
      const allow = new Set(policy.sensitive.allow);
      for (const f of await this.detectEntities(text).catch(() => [])) {
        if (!allow.has(f.fingerprint) && !findings.some((x) => f.start < x.end && x.start < f.end))
          findings.push(f);
      }
      findings.sort((a, b) => a.start - b.start);
    }
    return findings;
  }

  /** Ask the local model for names, addresses, companies and internal project names. */
  async detectEntities(text: string): Promise<Finding[]> {
    if (!this.local) return [];
    const reply = await this.local.chat({
      system:
        'You find personal or confidential entities in text. Reply with JSON only: {"entities":[{"text":"exact substring","type":"person|address|organization|project"}]}. Include only entities that literally appear in the text. Return {"entities":[]} if none.',
      messages: [{ role: 'user', content: text.slice(0, 8000) }],
      json: true,
      maxTokens: 800,
    });
    const parsed = parseJsonLoose(reply) as {
      entities?: { text?: unknown; type?: unknown }[];
    } | null;
    const labels: Record<string, string> = {
      person: '人名',
      address: '住所',
      organization: '社名・団体名',
      project: 'プロジェクト名',
    };
    const out: Finding[] = [];
    for (const e of parsed?.entities ?? []) {
      if (typeof e.text !== 'string' || e.text.length < 2) continue;
      const type = typeof e.type === 'string' ? e.type : 'entity';
      let idx = text.indexOf(e.text);
      while (idx >= 0) {
        out.push({
          rule: `local-model:${type}`,
          category: 'entity',
          label: labels[type] ?? '固有名詞',
          start: idx,
          end: idx + e.text.length,
          value: e.text,
          fingerprint: fingerprint(e.text),
        });
        idx = text.indexOf(e.text, idx + e.text.length);
      }
    }
    return out;
  }

  /**
   * Run a chat with note context. Contexts that the policy does not allow for
   * the chosen target are dropped (and reported), never sent.
   */
  async chat(input: {
    policy: WorkspacePolicy;
    prefer: 'local' | 'external' | 'auto';
    system: string;
    messages: ChatMessage[];
    contexts: ContextDoc[];
    confirmSensitive?: boolean;
    actor: string;
    purpose: string;
  }): Promise<GatewayResult> {
    const client = this.pickTarget(input.prefer, input.policy);
    const allowed = (a: AiAccess) =>
      client.location === 'external' ? a === 'external' : a !== 'none';
    const used = input.contexts.filter((c) => allowed(c.access));
    const excluded = input.contexts.filter((c) => !allowed(c.access)).map((c) => c.path);

    const contextBlock = used
      .map((c, i) => `[${i + 1}] ${c.title} (${c.path})\n${c.text}`)
      .join('\n\n---\n\n');
    let system = input.system + (contextBlock ? `\n\n# Notes\n\n${contextBlock}` : '');
    let messages = input.messages;
    const findings: Finding[] = [];
    let mapping: Record<string, string> = {};
    let masked = false;

    if (client.location === 'external') {
      const all = [system, ...messages.map((m) => m.content)];
      for (const t of all) findings.push(...(await this.scan(t, input.policy)));
      if (findings.length) {
        const mode = input.policy.sensitive.mode;
        if (mode === 'block') {
          await this.audit('egress-blocked', input.actor, {
            purpose: input.purpose,
            target: client.label,
            paths: used.map((u) => u.path),
            findings: findings.length,
          });
          throw new SensitiveBlockedError(findings);
        }
        if (mode === 'warn' && !input.confirmSensitive) throw new SensitiveWarningError(findings);
        if (mode === 'mask') {
          mapping = {};
          const maskOne = async (t: string) =>
            maskText(t, await this.scan(t, input.policy), mapping).text;
          system = await maskOne(system);
          messages = await Promise.all(
            messages.map(async (m) => ({ ...m, content: await maskOne(m.content) })),
          );
          masked = true;
        }
      }
    }

    const answer = await client.chat({ system, messages, maxTokens: 1500 });
    if (client.location === 'external') {
      await this.audit('egress', input.actor, {
        purpose: input.purpose,
        target: client.label,
        paths: used.map((u) => u.path),
        findings: findings.length,
        masked,
      });
    }
    return {
      answer: masked ? unmaskText(answer, mapping) : answer,
      target: client.location,
      model: client.label,
      used: used.map((u) => u.path),
      excluded,
      findings,
      masked,
    };
  }

  async audit(kind: string, actor: string, detail: Record<string, unknown>): Promise<void> {
    await this.db.run(
      'INSERT INTO audit(user_id, at, kind, actor, detail) VALUES (?, ?, ?, ?, ?)',
      this.userId,
      nowIso(),
      kind,
      actor,
      JSON.stringify(detail),
    );
  }

  async auditLog(
    limit = 100,
  ): Promise<{ at: string; kind: string; actor: string; detail: Record<string, unknown> }[]> {
    return (
      await this.db.all<{ at: string; kind: string; actor: string; detail: string }>(
        'SELECT at, kind, actor, detail FROM audit WHERE user_id = ? ORDER BY id DESC LIMIT ?',
        this.userId,
        Math.min(limit, 500),
      )
    ).map((r) => ({
      ...r,
      detail: JSON.parse(r.detail) as Record<string, unknown>,
    }));
  }
}

export const ASK_SYSTEM_PROMPT = `あなたはユーザー自身のノートに基づいて質問に答えるアシスタントです。
- 下の「Notes」にある内容だけを根拠に、日本語で簡潔に答えてください。
- 根拠にしたノートは [1] のような番号で示してください。
- ノートに答えがない場合は、そう伝えてください。推測で補わないでください。
- [SECRET_n] のような置換文字列はそのまま使ってください。`;
