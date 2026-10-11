#!/usr/bin/env node
/**
 * Build and deploy to Cloudflare Workers, with the release rules of
 * docs/operations.md checked first.
 *
 *   npm run deploy:stg    # staging (gmemo-stg): any branch
 *   npm run deploy:prod   # production (gmemo): only main, clean, pushed, CI green
 *
 * Add --dry-run to build and check everything without deploying.
 */
import { execFileSync, spawnSync } from 'node:child_process';

const mode = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (mode !== 'staging' && mode !== 'production') {
  console.error('使い方: node scripts/deploy.mjs <staging|production> [--dry-run]');
  process.exit(2);
}
const prod = mode === 'production';
const label = prod ? '本番(gmemo)' : 'ステージング(gmemo-stg)';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const fail = (msg) => {
  console.error(`\n✖ ${msg}\n  デプロイを中止しました(docs/deploy-cloudflare.md)`);
  process.exit(1);
};
const step = (msg) => console.log(`\n▶ ${msg}`);

// ---- 1. Settings for this environment ----------------------------------------------
step(`${label} へのデプロイを確認しています`);
const originVar = prod ? 'GMEMO_ORIGIN' : 'GMEMO_STG_ORIGIN';
const origin = process.env[originVar] ?? '';
if (!origin.startsWith('https://'))
  fail(
    `${originVar} に、この環境の https:// の URL を設定してください(例: export ${originVar}=https://...)`,
  );
if (!prod && !(process.env.GMEMO_ACCESS_TEAM_DOMAIN && process.env.GMEMO_STG_ACCESS_AUD))
  console.log(
    '  注意: GMEMO_ACCESS_TEAM_DOMAIN / GMEMO_STG_ACCESS_AUD が未設定です。' +
      'ステージングは Cloudflare Access を設定するまで全リクエストを拒否します(初回は想定どおり)',
  );
console.log(`  公開URL: ${origin}`);

// ---- 2. Release rules for production -----------------------------------------------
const head = git('rev-parse', 'HEAD');
if (prod) {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') fail(`本番は main からだけデプロイできます(いまは ${branch})`);
  if (git('status', '--porcelain')) fail('コミットしていない変更があります(git status で確認)');
  try {
    git('fetch', '--quiet', 'origin', 'main');
  } catch {
    fail('origin/main を取得できません(ネットワークを確認)');
  }
  if (git('rev-parse', 'origin/main') !== head)
    fail('手元の main が GitHub の main と一致しません(git pull してから)');

  // The commit must have passed CI on GitHub (public API; no token needed).
  const repo = git('remote', 'get-url', 'origin').match(/github\.com[:/](.+?)(\.git)?$/)?.[1];
  if (repo) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/actions/runs?head_sha=${head}&per_page=20`,
        { headers: { accept: 'application/vnd.github+json', 'user-agent': 'gmemo-deploy' } },
      );
      const runs = (await res.json()).workflow_runs ?? [];
      for (const wf of ['CI', 'CodeQL']) {
        const run = runs.find((r) => r.name === wf);
        if (!run) fail(`このコミットで ${wf} がまだ動いていません。GitHub で終わるのを待ってから`);
        if (run.status !== 'completed') fail(`${wf} が実行中です。終わってからもう一度`);
        if (run.conclusion !== 'success') fail(`${wf} が失敗しています: ${run.html_url}`);
      }
      console.log('  GitHub の CI と CodeQL: 成功');
    } catch (e) {
      fail(`GitHub の CI の結果を確認できません(${e.message})`);
    }
  }
  console.log(`  コミット: ${head.slice(0, 7)}(main、GitHub と一致)`);
} else {
  const dirty = git('status', '--porcelain') ? '(コミットしていない変更を含む)' : '';
  console.log(
    `  コミット: ${head.slice(0, 7)} ${git('rev-parse', '--abbrev-ref', 'HEAD')}${dirty}`,
  );
}

// ---- 3. Build ------------------------------------------------------------------------------
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: process.env, ...(cwd ? { cwd } : {}) });
  if (r.status !== 0) fail(`${[cmd, ...args].join(' ')} が失敗しました`);
};
step('ビルドしています(core → web)');
run('npm', ['run', 'build', '-w', '@gmemo/core']);
run('npm', ['run', 'build', '-w', '@gmemo/web']);

// ---- 4. Deploy ------------------------------------------------------------------------------
step(dryRun ? 'デプロイの確認だけを行います(--dry-run)' : `${label} にデプロイしています`);
// cf reads cloudflare.config.ts from the server package.
run('npx', ['cf', 'deploy', '--mode', mode, ...(dryRun ? ['--dry-run'] : [])], 'packages/server');
console.log(
  `\n✔ ${dryRun ? '確認だけ完了(デプロイはしていません)' : `デプロイしました: ${origin}`}`,
);
if (!dryRun)
  console.log(
    prod
      ? '  次: 本番の 設定 → セキュリティログ で、エラーや拒否が増えていないか確認'
      : '  次: ステージングを開いて動作確認(docs/deploy-cloudflare.md のチェックリスト)',
  );
