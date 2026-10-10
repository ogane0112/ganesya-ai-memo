/**
 * Local, rule-based detection of secrets and personal information.
 * Nothing here talks to the network. Detection is an aid, not a guarantee.
 */

export type FindingCategory = 'secret' | 'credential' | 'pii' | 'financial' | 'dictionary' | 'entity';

export interface Finding {
  rule: string;
  category: FindingCategory;
  /** Human readable label (Japanese), for the UI. */
  label: string;
  start: number;
  end: number;
  value: string;
  /** Stable fingerprint of the value, used for "this is fine" allow-listing. */
  fingerprint: string;
}

export interface Rule {
  id: string;
  category: FindingCategory;
  label: string;
  pattern: RegExp;
  /** Capture group holding the sensitive value (default: whole match). */
  group?: number;
  validate?: (value: string) => boolean;
}

function luhn(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** Japanese "My Number" (個人番号) check digit. */
export function isMyNumber(value: string): boolean {
  const d = value.replace(/\D/g, '');
  if (d.length !== 12) return false;
  let sum = 0;
  for (let n = 1; n <= 11; n++) {
    const p = Number(d[11 - n]);
    const q = n <= 6 ? n + 1 : n - 5;
    sum += p * q;
  }
  const r = sum % 11;
  const check = r <= 1 ? 0 : 11 - r;
  return check === Number(d[11]);
}

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of freq.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Built-in rules. Patterns follow common secret-scanner (gitleaks-style) conventions. */
export const BUILTIN_RULES: readonly Rule[] = [
  { id: 'private-key', category: 'secret', label: '秘密鍵', pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'aws-access-key', category: 'secret', label: 'AWSアクセスキー', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { id: 'github-token', category: 'secret', label: 'GitHubトークン', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { id: 'gitlab-token', category: 'secret', label: 'GitLabトークン', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'anthropic-key', category: 'secret', label: 'Anthropic APIキー', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'openai-key', category: 'secret', label: 'OpenAI APIキー', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g, validate: (v) => !v.startsWith('sk-ant-') },
  { id: 'slack-token', category: 'secret', label: 'Slackトークン', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'slack-webhook', category: 'secret', label: 'Slack Webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g },
  { id: 'google-api-key', category: 'secret', label: 'Google APIキー', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'stripe-key', category: 'secret', label: 'Stripeキー', pattern: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { id: 'jwt', category: 'credential', label: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { id: 'url-credentials', category: 'credential', label: 'URL内の認証情報', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s:/@]+)@/gi, group: 1 },
  {
    id: 'password-assignment',
    category: 'credential',
    label: 'パスワードらしき文字列',
    pattern: /(?:password|passwd|pwd|passphrase|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|パスワード|暗証番号)\s*[:=：]\s*["']?([^\s"'`]{6,})/gi,
    group: 1,
    validate: (v) => entropy(v) >= 2.5 && !/^\[SECRET_[0-9a-z]+\]$/.test(v),
  },
  { id: 'credit-card', category: 'financial', label: 'クレジットカード番号', pattern: /\b(?:\d[ -]?){12,18}\d\b/g, validate: luhn },
  { id: 'my-number', category: 'pii', label: 'マイナンバー', pattern: /(?<!\d)\d{4}[ -]?\d{4}[ -]?\d{4}(?!\d)/g, validate: isMyNumber },
  { id: 'phone-jp', category: 'pii', label: '電話番号', pattern: /(?<![\d-])(?:\+81[ -]?|0)(?:\d{1,4}[ -]\d{1,4}[ -]\d{3,4}|[789]0\d{8}|\d{9})(?![\d-])/g },
  { id: 'email', category: 'pii', label: 'メールアドレス', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

/** FNV-1a based fingerprint. Not a security hash — only used to remember allow-listed values. */
export function fingerprint(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export interface ScanOptions {
  /** Extra words the user marked as confidential (company names, customers…). */
  dictionary?: readonly string[];
  /** Fingerprints the user marked as "not a problem". */
  allow?: ReadonlySet<string> | readonly string[];
  /** Rule ids to skip. */
  disabledRules?: readonly string[];
  extraRules?: readonly Rule[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scanText(text: string, opts: ScanOptions = {}): Finding[] {
  const allow = opts.allow instanceof Set ? opts.allow : new Set(opts.allow ?? []);
  const disabled = new Set(opts.disabledRules ?? []);
  const rules: Rule[] = [...BUILTIN_RULES, ...(opts.extraRules ?? [])].filter((r) => !disabled.has(r.id));
  for (const word of opts.dictionary ?? []) {
    const w = word.trim();
    if (!w) continue;
    rules.push({ id: 'dictionary', category: 'dictionary', label: `辞書: ${w}`, pattern: new RegExp(escapeRe(w), 'giu') });
  }

  const found: Finding[] = [];
  for (const rule of rules) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
    for (const m of text.matchAll(re)) {
      const g = rule.group ?? 0;
      const value = m[g];
      if (!value) continue;
      if (rule.validate && !rule.validate(value)) continue;
      const offset = g === 0 ? 0 : m[0].indexOf(value);
      const start = (m.index ?? 0) + offset;
      const fp = fingerprint(value);
      if (allow.has(fp)) continue;
      found.push({ rule: rule.id, category: rule.category, label: rule.label, start, end: start + value.length, value, fingerprint: fp });
    }
  }
  return dedupe(found);
}

/** Drop findings fully contained in an earlier/larger finding. */
function dedupe(findings: Finding[]): Finding[] {
  findings.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Finding[] = [];
  for (const f of findings) {
    const last = out[out.length - 1];
    if (last && f.start < last.end) continue;
    out.push(f);
  }
  return out;
}

export interface MaskResult {
  text: string;
  /** Placeholder → original value. Keep this locally; never send it. */
  mapping: Record<string, string>;
}

/**
 * Replace findings with `[SECRET_n]` placeholders. The same value always gets the
 * same placeholder, and an existing mapping can be extended across several texts.
 */
export function maskText(
  text: string,
  findings: readonly Finding[],
  mapping: Record<string, string> = {},
  placeholder: (f: Finding, n: number) => string = (_f, n) => `[SECRET_${n}]`,
): MaskResult {
  const reverse = new Map(Object.entries(mapping).map(([k, v]) => [v, k]));
  let n = Object.keys(mapping).length;
  let out = '';
  let pos = 0;
  for (const f of [...findings].sort((a, b) => a.start - b.start)) {
    if (f.start < pos) continue;
    let ph = reverse.get(f.value);
    if (!ph) {
      ph = placeholder(f, ++n);
      reverse.set(f.value, ph);
      mapping[ph] = f.value;
    }
    out += text.slice(pos, f.start) + ph;
    pos = f.end;
  }
  out += text.slice(pos);
  return { text: out, mapping };
}

/** Restore placeholders in a model response using the local mapping. */
export function unmaskText(text: string, mapping: Readonly<Record<string, string>>): string {
  return text.replace(/\[SECRET_[0-9a-z]+\]/g, (ph) => mapping[ph] ?? ph);
}
