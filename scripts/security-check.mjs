#!/usr/bin/env node
/**
 * Checks the security ledgers (security/*.yaml) against the repository:
 *
 *   - every advisory reported by `npm audit` is registered in vulnerabilities.yaml
 *   - no registered advisory is marked fixed / not-affected while npm still reports it
 *   - no open entry is past its due date; no accepted risk is past its review date
 *   - every direct dependency is registered in dependencies.yaml (and nothing extra)
 *   - every test named in threats.yaml exists
 *
 * Usage: node scripts/security-check.mjs [--offline]   (--offline skips npm audit)
 * Exit code 1 when anything needs attention. See docs/secure-development.md.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const offline = process.argv.includes('--offline');
const today = new Date().toISOString().slice(0, 10);

const errors = [];
const warnings = [];
const read = (p) => parse(readFileSync(join(root, p), 'utf8'));

// ---- vulnerabilities.yaml ---------------------------------------------------------
const SEVERITIES = ['critical', 'high', 'moderate', 'low'];
const SCOPES = ['production', 'build', 'dev'];
const STATUSES = ['open', 'fixed', 'not-affected', 'accepted'];
const date = /^\d{4}-\d{2}-\d{2}$/;

const vulns = read('security/vulnerabilities.yaml').entries ?? [];
const byId = new Map();
for (const v of vulns) {
  const where = `vulnerabilities.yaml ${v.id ?? '(id なし)'}`;
  if (!v.id) errors.push(`${where}: id がありません`);
  else if (byId.has(v.id)) errors.push(`${where}: id が重複しています`);
  byId.set(v.id, v);
  if (!SEVERITIES.includes(v.severity)) errors.push(`${where}: severity が不正です`);
  if (!SCOPES.includes(v.scope)) errors.push(`${where}: scope が不正です`);
  if (!STATUSES.includes(v.status)) errors.push(`${where}: status が不正です`);
  for (const k of ['found', 'due'])
    if (!date.test(String(v[k] ?? '')))
      errors.push(`${where}: ${k} は YYYY-MM-DD で書いてください`);
  if (v.status !== 'open' && !date.test(String(v.closed ?? '')))
    errors.push(`${where}: 閉じた項目には closed(日付)が必要です`);
  if (v.status === 'open' && v.due < today)
    errors.push(`${where}: 対応期限(${v.due})を過ぎています`);
  if (v.status === 'accepted') {
    if (!v.reason) errors.push(`${where}: accepted には reason(受け入れる理由)が必要です`);
    if (!date.test(String(v.review_by ?? '')))
      errors.push(`${where}: accepted には review_by(見直し期限)が必要です`);
    else if (v.review_by < today)
      errors.push(`${where}: リスク受容の見直し期限(${v.review_by})を過ぎています`);
  }
  if (v.status === 'not-affected' && !v.reason)
    errors.push(`${where}: not-affected には reason(影響しない理由)が必要です`);
}

// ---- npm audit ----------------------------------------------------------------------
function audit(args) {
  try {
    return JSON.parse(
      execFileSync('npm', ['audit', '--json', ...args], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  } catch (e) {
    // npm audit exits 1 when it finds something; the report is still on stdout.
    if (e.stdout) return JSON.parse(e.stdout);
    throw e;
  }
}

function advisories(report) {
  const out = new Map();
  for (const v of Object.values(report.vulnerabilities ?? {}))
    for (const via of v.via)
      if (typeof via === 'object' && via.url) {
        const id = via.url.split('/').pop();
        out.set(id, { id, package: via.name, severity: via.severity, title: via.title });
      }
  return out;
}

if (offline) {
  warnings.push('--offline: npm audit を省略しました');
} else {
  const all = advisories(audit([]));
  const production = advisories(audit(['--omit=dev']));
  for (const a of all.values()) {
    const scope = production.has(a.id) ? 'production' : 'build/dev';
    const entry = byId.get(a.id);
    if (!entry) {
      errors.push(
        `未登録の脆弱性: ${a.id} ${a.package} (${a.severity}, ${scope}) ${a.title}\n` +
          `    → security/vulnerabilities.yaml に追加し、方針の期限内に対応してください`,
      );
    } else if (entry.status === 'fixed') {
      errors.push(`${a.id}: 台帳では fixed ですが、npm audit がまだ報告しています`);
    } else if (scope === 'production' && entry.scope !== 'production') {
      errors.push(`${a.id}: 本番の依存に含まれています。台帳の scope を production にしてください`);
    }
  }
  for (const v of vulns)
    if (v.source === 'advisory' && v.status === 'open' && !all.has(v.id))
      warnings.push(`${v.id}: npm audit が報告しなくなりました。直っていれば fixed にしてください`);
}

// ---- dependencies.yaml ----------------------------------------------------------------
const workspaces = {
  root: '.',
  core: 'packages/core',
  server: 'packages/server',
  web: 'packages/web',
};
const declared = new Set();
for (const [ws, dir] of Object.entries(workspaces)) {
  const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }))
    declared.add(`${ws}:${name}`);
}
const registered = new Set();
for (const d of read('security/dependencies.yaml').dependencies ?? []) {
  const key = `${d.workspace}:${d.name}`;
  if (registered.has(key)) errors.push(`dependencies.yaml: ${key} が重複しています`);
  registered.add(key);
  if (!d.purpose) errors.push(`dependencies.yaml: ${key} に purpose がありません`);
  if (!['high', 'medium', 'low'].includes(d.risk))
    errors.push(`dependencies.yaml: ${key} の risk が不正です`);
  if (!SCOPES.includes(d.scope)) errors.push(`dependencies.yaml: ${key} の scope が不正です`);
}
for (const key of declared)
  if (!registered.has(key))
    errors.push(
      `未登録の依存ライブラリ: ${key}\n    → security/dependencies.yaml に用途とリスクを書いてください`,
    );
for (const key of registered)
  if (!declared.has(key)) errors.push(`dependencies.yaml: ${key} は package.json にありません`);

// ---- threats.yaml ---------------------------------------------------------------------
for (const t of read('security/threats.yaml').threats ?? []) {
  const tests = t.tests ?? [];
  if (tests.length === 0 && !t.gap)
    errors.push(`threats.yaml ${t.id}: テストがない場合は gap に理由を書いてください`);
  for (const { file, name } of tests) {
    const path = join(root, file);
    if (!existsSync(path)) errors.push(`threats.yaml ${t.id}: ${file} がありません`);
    else if (!readFileSync(path, 'utf8').includes(name))
      errors.push(`threats.yaml ${t.id}: ${file} にテスト「${name}」が見つかりません`);
  }
}

// ---- report -------------------------------------------------------------------------------
for (const w of warnings) console.log(`注意: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`NG: ${e}`);
  console.error(`\n${errors.length} 件の問題があります(docs/secure-development.md)`);
  process.exit(1);
}
const open = vulns.filter((v) => v.status === 'open').length;
console.log(
  `OK: 脆弱性台帳 ${vulns.length} 件(対応中 ${open} 件)、依存 ${registered.size} 件、脅威 ${
    (read('security/threats.yaml').threats ?? []).length
  } 件`,
);
