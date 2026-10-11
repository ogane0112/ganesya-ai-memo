#!/usr/bin/env node
/**
 * Checks the GitHub repository settings described in docs/github-setup.md through
 * the GitHub API.
 *
 * Without a token it reads what the public API shows (rulesets, default branch,
 * CI results). Some settings (merge options, private vulnerability reporting) are
 * only visible to the repository's admins: pass a token to check those too, e.g.
 *   GITHUB_TOKEN=$(gh auth token) npm run github:check
 * The token is only sent to api.github.com and is never printed.
 *
 * Usage: npm run github:check [-- owner/repo]
 */
const repo = process.argv[2] ?? 'ogane0112/ganesya-ai-memo';
const api = `https://api.github.com/repos/${repo}`;
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

async function get(path) {
  const res = await fetch(`${api}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'gmemo-settings-check',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) return { error: `${res.status} ${res.statusText}` };
  return res.json();
}

/** ok: true = done, false = not done, null = cannot tell from here. */
const results = [];
const check = (step, name, ok, hint) => results.push({ step, name, ok, hint });

const info = await get('');
if (info.error) {
  console.error(`リポジトリを読めません(${repo}): ${info.error}`);
  process.exit(1);
}
const isAdmin = info.permissions?.admin === true;
const NEEDS_TOKEN =
  '管理者だけが見られる設定です。GITHUB_TOKEN を付けて実行するか、画面で確認してください';

// ---- 2. Default branch and merge options ------------------------------------------
check(
  '2',
  'デフォルトブランチが main',
  info.default_branch === 'main',
  `いまは ${info.default_branch}。Settings → General → Default branch`,
);

// ---- 5. Ruleset protecting the default branch -----------------------------------
const list = await get('/rulesets?includes_parents=true');
const rulesets = Array.isArray(list)
  ? (
      await Promise.all(
        list.filter((r) => r.target === 'branch').map((r) => get(`/rulesets/${r.id}`)),
      )
    ).filter((r) => !r.error)
  : [];
const coversMain = (r) => {
  const inc = r.conditions?.ref_name?.include ?? [];
  return (
    inc.includes('~DEFAULT_BRANCH') ||
    inc.includes('~ALL') ||
    inc.includes(`refs/heads/${info.default_branch}`)
  );
};
const forMain = rulesets.filter(coversMain);
const active = forMain.filter((r) => r.enforcement === 'active');
const inactive = forMain.filter((r) => r.enforcement !== 'active');

if (forMain.length === 0) {
  check(
    '5',
    'main を守るルールセットがある',
    false,
    'Settings → Rules → Rulesets → New branch ruleset(Target は Include default branch)',
  );
} else {
  check(
    '5',
    'ルールセットが有効(Enforcement status: Active)',
    active.length > 0,
    inactive
      .map(
        (r) =>
          `「${r.name}」が ${r.enforcement === 'evaluate' ? 'Evaluate(記録だけで止めない)' : 'Disabled(無効)'} のままです。` +
          `ルールセットを開き、Enforcement status を Active にして Save changes`,
      )
      .join(' / '),
  );
}

// Judge the rules on the active rulesets; if none is active, on the configured ones,
// so the report also says whether the rules themselves are right.
const judged = active.length ? active : forMain;
const rules = judged.flatMap((r) => r.rules ?? []);
const has = (t) => rules.some((r) => r.type === t);
const param = (t) => rules.find((r) => r.type === t)?.parameters ?? {};
const suffix = active.length ? '' : '(ルールセットが有効になれば効きます)';
if (forMain.length) {
  check('5', `Restrict deletions${suffix}`, has('deletion'), 'Restrict deletions にチェック');
  check(
    '5',
    `Block force pushes${suffix}`,
    has('non_fast_forward'),
    'Block force pushes にチェック',
  );
  check(
    '5',
    `Require linear history${suffix}`,
    has('required_linear_history'),
    'Require linear history にチェック',
  );
  check(
    '5',
    `Require a pull request before merging${suffix}`,
    has('pull_request'),
    'Require a pull request before merging にチェック',
  );
  check(
    '5',
    'Restrict updates がオフ(オンだと誰もマージできない)',
    !has('update'),
    'Restrict updates のチェックを外す',
  );
  const pr = param('pull_request');
  if (has('pull_request')) {
    check(
      '5',
      '承認数が 0(1人開発の間)',
      (pr.required_approving_review_count ?? 0) === 0,
      '1以上だと自分のPRをマージできない。Required approvals を 0 に',
    );
    check(
      '5',
      '未解決のコメントがあるとマージできない',
      pr.required_review_thread_resolution === true,
      'Require conversation resolution before merging にチェック',
    );
  }
  const contexts = new Set(
    (param('required_status_checks').required_status_checks ?? []).map((c) => c.context),
  );
  for (const name of ['check', 'security', 'docker', 'analyze'])
    check(
      '5',
      `必須チェックに ${name}${suffix}`,
      contexts.has(name),
      'Require status checks to pass → Add checks で追加',
    );
  check(
    '5⑥',
    `CodeQL の結果が必須${suffix}`,
    has('code_scanning'),
    'Require code scanning results → CodeQL、Security alerts: High or higher',
  );
}

// Squash only: either the repository allows nothing else, or the active ruleset does.
const rulesetSquashOnly = (() => {
  const m = active.flatMap((r) => r.rules ?? []).find((r) => r.type === 'pull_request')
    ?.parameters?.allowed_merge_methods;
  return Array.isArray(m) && m.length === 1 && m[0] === 'squash';
})();
if (info.allow_merge_commit === undefined && !rulesetSquashOnly) {
  check('2', 'マージ方法が Squash のみ', null, NEEDS_TOKEN);
} else {
  check(
    '2',
    'マージ方法が Squash のみ',
    rulesetSquashOnly ||
      (info.allow_squash_merge && !info.allow_merge_commit && !info.allow_rebase_merge),
    'Settings → General → Pull Requests で Allow merge commits / Allow rebase merging のチェックを外す' +
      '(またはルールセットの Allowed merge methods を Squash だけに)',
  );
}
check(
  '2',
  'マージ後に作業ブランチを自動削除',
  info.delete_branch_on_merge === undefined ? null : info.delete_branch_on_merge === true,
  info.delete_branch_on_merge === undefined
    ? NEEDS_TOKEN
    : 'Settings → General → Pull Requests → Automatically delete head branches',
);

// ---- 4. Private vulnerability reporting ------------------------------------------------
const pvr = isAdmin ? await get('/private-vulnerability-reporting') : null;
check(
  '4①',
  'Private vulnerability reporting が有効',
  pvr && !pvr.error ? pvr.enabled === true : null,
  pvr && !pvr.error
    ? 'Settings → Advanced Security → Private vulnerability reporting の右の Enable を押す'
    : NEEDS_TOKEN,
);

// ---- CI on main ---------------------------------------------------------------------------
const runs = await get(`/actions/runs?branch=${info.default_branch}&event=push&per_page=20`);
for (const wf of ['CI', 'CodeQL']) {
  const last = (runs.workflow_runs ?? []).find((r) => r.name === wf && r.status === 'completed');
  check(
    'CI',
    `main の最新の ${wf} が成功`,
    last ? last.conclusion === 'success' : null,
    last ? `${last.conclusion}: ${last.html_url}` : 'main でまだ動いていない',
  );
}

// ---- report ---------------------------------------------------------------------------------
const mark = (ok) => (ok === true ? '✅' : ok === false ? '❌' : '⚠️ ');
let ng = 0;
let unknown = 0;
for (const r of results) {
  if (r.ok === false) ng++;
  if (r.ok === null) unknown++;
  console.log(
    `${mark(r.ok)} [手順${r.step}] ${r.name}${r.ok === true ? '' : `\n      → ${r.hint}`}`,
  );
}
console.log(`
画面で確認する項目(API では確認できません):
  [手順1] 2段階認証:右上のアイコン → Settings → Password and authentication
  [手順3] Actions の権限:Settings → Actions → General
  [手順4] Dependabot、Push protection:Settings → Advanced Security
  詳しくは docs/github-setup.md の「設定できたかの確認」`);
console.log(
  ng
    ? `\n❌ ${ng} 件の設定が未完了です${unknown ? `(⚠️ ${unknown} 件は確認できませんでした)` : ''}`
    : unknown
      ? `\n✅ 確認できた設定はすべて完了しています(⚠️ ${unknown} 件は確認できませんでした)`
      : '\n✅ API で確認できる設定はすべて完了しています',
);
process.exit(ng ? 1 : 0);
