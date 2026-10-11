#!/usr/bin/env node
/**
 * Checks the GitHub repository settings described in docs/github-setup.md, as far
 * as the public GitHub API shows them (no token needed for a public repository).
 * Settings only visible to admins (Dependabot alerts, secret scanning, Actions
 * permissions) are listed at the end for checking on the settings pages.
 *
 * Usage: npm run github:check [-- owner/repo]
 */
const repo = process.argv[2] ?? 'ogane0112/ganesya-ai-memo';
const api = `https://api.github.com/repos/${repo}`;

async function get(path) {
  const res = await fetch(`${api}${path}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'gmemo-settings-check' },
  });
  if (!res.ok) return { error: `${res.status} ${res.statusText}` };
  return res.json();
}

const results = [];
const check = (step, name, ok, hint) => results.push({ step, name, ok, hint });

const info = await get('');
if (info.error) {
  console.error(`リポジトリを読めません(${repo}): ${info.error}`);
  process.exit(1);
}

// ---- 2. Default branch and merge options ------------------------------------------
check(
  '2',
  'デフォルトブランチが main',
  info.default_branch === 'main',
  `いまは ${info.default_branch}。Settings → General → Default branch`,
);
check(
  '2',
  'マージ方法が Squash のみ',
  info.allow_squash_merge && !info.allow_merge_commit && !info.allow_rebase_merge,
  'Settings → General → Pull Requests で Allow merge commits / Allow rebase merging のチェックを外す',
);
check(
  '2',
  'マージ後に作業ブランチを自動削除',
  info.delete_branch_on_merge === true,
  'Settings → General → Automatically delete head branches',
);

// ---- 4. Private vulnerability reporting ------------------------------------------------
const pvr = await get('/private-vulnerability-reporting');
check(
  '4①',
  'Private vulnerability reporting が有効',
  pvr.enabled === true,
  'Settings → Advanced Security → Private vulnerability reporting → Enable',
);

// ---- 5. Ruleset on main ------------------------------------------------------------------
const rules = await get(`/rules/branches/${encodeURIComponent(info.default_branch)}`);
const ruleTypes = new Set(Array.isArray(rules) ? rules.map((r) => r.type) : []);
const has = (t) => ruleTypes.has(t);
check(
  '5',
  'ルールセットが main に効いている(Active)',
  ruleTypes.size > 0,
  'Settings → Rules → Rulesets。Enforcement status が Active か、Target が default branch か',
);
check('5', 'Restrict deletions', has('deletion'), 'ルールセットで Restrict deletions にチェック');
check(
  '5',
  'Block force pushes',
  has('non_fast_forward'),
  'ルールセットで Block force pushes にチェック',
);
check(
  '5',
  'Require linear history',
  has('required_linear_history'),
  'ルールセットで Require linear history にチェック',
);
check(
  '5',
  'Require a pull request before merging',
  has('pull_request'),
  'ルールセットで Require a pull request before merging にチェック',
);
check(
  '5',
  'Restrict updates がオフ(オンだと誰もマージできない)',
  !has('update'),
  'ルールセットで Restrict updates のチェックを外す',
);

const statusRule = Array.isArray(rules)
  ? rules.find((r) => r.type === 'required_status_checks')
  : null;
const contexts = new Set(
  (statusRule?.parameters?.required_status_checks ?? []).map((c) => c.context),
);
for (const name of ['check', 'security', 'docker', 'analyze'])
  check(
    '5',
    `必須チェックに ${name}`,
    contexts.has(name),
    'ルールセットの Require status checks to pass → Add checks で追加',
  );

const prRule = Array.isArray(rules) ? rules.find((r) => r.type === 'pull_request') : null;
if (prRule) {
  const p = prRule.parameters ?? {};
  check(
    '5',
    '承認数が 0(1人開発の間)',
    (p.required_approving_review_count ?? 0) === 0,
    '1以上だと自分のPRをマージできない。Required approvals を 0 に',
  );
  check(
    '5',
    '未解決のコメントがあるとマージできない',
    p.required_review_thread_resolution === true,
    'Require conversation resolution before merging にチェック',
  );
}
check(
  '5⑥',
  'CodeQL の結果が必須(PR #1 のマージ後に追加)',
  has('code_scanning'),
  'ルールセットで Require code scanning results → CodeQL、High or higher',
);

// ---- CI on main ---------------------------------------------------------------------------
const runs = await get(`/actions/runs?branch=${info.default_branch}&event=push&per_page=20`);
for (const wf of ['CI', 'CodeQL']) {
  const last = (runs.workflow_runs ?? []).find((r) => r.name === wf && r.status === 'completed');
  check(
    'CI',
    `main の最新の ${wf} が成功`,
    last?.conclusion === 'success',
    last ? `${last.conclusion}: ${last.html_url}` : 'main でまだ動いていない',
  );
}

// ---- report ---------------------------------------------------------------------------------
let ng = 0;
for (const r of results) {
  if (!r.ok) ng++;
  console.log(
    `${r.ok ? '✅' : '❌'} [手順${r.step}] ${r.name}${r.ok ? '' : `\n      → ${r.hint}`}`,
  );
}
console.log(`
画面で確認する項目(管理者にしか見えないため、このスクリプトでは確認できません):
  [手順1] 2段階認証:右上のアイコン → Settings → Password and authentication
  [手順3] Actions の権限:Settings → Actions → General
  [手順4] Dependabot alerts / security updates、Push protection:Settings → Advanced Security
  詳しくは docs/github-setup.md の「設定できたかの確認」`);
console.log(ng ? `\n${ng} 件の設定が未完了です` : '\nAPI で確認できる設定はすべて完了しています');
process.exit(ng ? 1 : 0);
