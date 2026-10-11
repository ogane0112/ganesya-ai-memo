# Cloudflare にデプロイする

このアプリを Cloudflare Workers(サーバー)と D1(データベース)に載せる手順です。初めてでも上から順に進めれば、**ステージング(自分だけが使う確認用)→ 本番**の2つの環境ができあがります。所要時間は初回で1時間ほどです。

```
ブラウザ / AIエージェント ──▶ Cloudflare Workers(このアプリ)──▶ D1(アカウント・ノート・履歴・検索インデックス)
                                                             └─▶ GitHub API(GitHub保存を選んだユーザーのみ)
```

- Webアプリ(PWA)も同じ Worker から配信されます(別のサーバーは不要)。
- 環境ごとに **Worker・データベース・シークレットを完全に分けます**([運用方針](operations.md))。

| 環境         | Worker / D1 | 公開URLの例                                    | 使う人                      | デプロイ              |
| ------------ | ----------- | ---------------------------------------------- | --------------------------- | --------------------- |
| ステージング | `gmemo-stg` | `https://gmemo-stg.<サブドメイン>.workers.dev` | 自分だけ(Cloudflare Access) | `npm run deploy:stg`  |
| 本番         | `gmemo`     | `https://gmemo.<サブドメイン>.workers.dev`     | 利用者(招待制)              | `npm run deploy:prod` |

## 全体の流れ

| #   | やること                                       | 初回だけ | 毎回 |
| --- | ---------------------------------------------- | :------: | :--: |
| 1   | 準備(アカウント、Node.js、リポジトリ)          |    ✓     |      |
| 2   | Cloudflare にログイン、サブドメインを確認      |    ✓     |      |
| 3   | 公開URLなどを設定ファイルに書く                |    ✓     |      |
| 4   | ステージングにデプロイ                         |    ✓     |  ✓   |
| 5   | ステージングのシークレットを設定               |    ✓     |      |
| 6   | ステージングを自分だけに制限(Access)           |    ✓     |      |
| 7   | ステージングで最初のアカウントを作り、動作確認 |    ✓     |  ✓   |
| 8   | 本番にデプロイ、シークレット、最初のアカウント |    ✓     |  ✓   |

2回目以降は「[更新をデプロイする](#更新をデプロイする2回目以降)」だけです。

---

## 1. 準備

必要なもの:

- **Cloudflare アカウント**(無料で可)。作ったら、右上のアイコン → **Profile** → **Authentication** で **2段階認証を必ず有効に**してください。このアカウントを乗っ取られると、全ユーザーのデータに届きます
- **Node.js 22 以上**(`node -v` で確認)
- **git**

リポジトリを取得して、依存関係を入れます。

```sh
git clone https://github.com/ogane0112/ganesya-ai-memo
cd ganesya-ai-memo
npm ci
```

デプロイには Cloudflare の CLI **`cf`** を使います。依存関係に入っているので、別途インストールは不要です(`npx cf …` で動きます)。

> `cf` は 2026年9月に公開されたオープンベータです。うまく動かない場合は末尾の「[Wrangler を使う場合](#wrangler-を使う場合)」でもデプロイできます。

## 2. Cloudflare にログインする

```sh
cd packages/server
npx cf auth login     # ブラウザが開くので、Cloudflare にログインして許可する
npx cf auth whoami    # ログインできたか確認(アカウント名が表示されればOK)
cd ../..
```

次に、**workers.dev のサブドメイン**を確認します。Cloudflare のダッシュボード → **Workers & Pages** を開くと、右側に `<サブドメイン>.workers.dev` と表示されています。初めての場合は、ここでサブドメイン名を決めて登録します(例:`taro` → `gmemo.taro.workers.dev`)。

> **公開URLはあとから変えないでください。** パスキーはドメインに紐づくので、URL を変えると全員のパスキーが使えなくなります。独自ドメインを使う予定なら、最初から独自ドメインで始めてください(「[独自ドメインを使う](#独自ドメインを使う)」)。

## 3. 公開URLなどを設定ファイルに書く

毎回のデプロイで同じ値を使うので、リポジトリの一番上に `deploy.env` というファイルを作ります(`.gitignore` 済みなので GitHub には上がりません。**秘密の値はここに書きません**)。

```sh
cat > deploy.env <<'ENV'
# ステージングと本番の公開URL(<サブドメイン> を手順2の名前に置き換える)
export GMEMO_STG_ORIGIN=https://gmemo-stg.<サブドメイン>.workers.dev
export GMEMO_ORIGIN=https://gmemo.<サブドメイン>.workers.dev
# Cloudflare Access(手順6で埋める)
export GMEMO_ACCESS_TEAM_DOMAIN=
export GMEMO_STG_ACCESS_AUD=
ENV
```

デプロイの前に毎回、この値を読み込みます。

```sh
source deploy.env
```

ほかに変えられる値(通常はそのままで構いません):

| 環境変数         | 既定値       | 説明                                                                     |
| ---------------- | ------------ | ------------------------------------------------------------------------ |
| `GMEMO_SIGNUP`   | `invite`     | 本番の登録方法。`open`(誰でも)/ `invite`(招待制)/ `closed`(新規登録停止) |
| `GMEMO_TIMEZONE` | `Asia/Tokyo` | タイムゾーン                                                             |

## 4. ステージングにデプロイする

```sh
source deploy.env
npm run deploy:stg
```

このコマンドは、次を順に行います。

1. 公開URLが設定されているか確認する
2. Webアプリとサーバーをビルドする
3. Cloudflare Workers に `gmemo-stg` としてアップロードする(初回は D1 データベース `gmemo-stg` も自動で作られます)

最後に `✔ デプロイしました: https://gmemo-stg.…` と出れば成功です。

**この時点でステージングの URL を開くと「This environment is not configured for access.」と表示されます。** 手順6で Cloudflare Access を設定するまで、全員を拒否する作りになっているためで、想定どおりです。

> 本当にアップロードせずに確認だけしたいときは `npm run deploy:stg -- --dry-run` です。

## 5. ステージングのシークレットを設定する

シークレット(秘密の値)は、ファイルやコマンドの履歴に残らないよう、その場で生成して Cloudflare に直接送ります。

```sh
cd packages/server

# 最初の(管理者)アカウントを作るためのトークン。手順7で使うので、表示された値を控える
STG_SETUP_TOKEN=$(openssl rand -base64 24)
echo "ステージングのセットアップトークン: $STG_SETUP_TOKEN"
npx cf workers secrets update GMEMO_SETUP_TOKEN --worker gmemo-stg --text "$STG_SETUP_TOKEN"

# GitHub トークンの暗号化とセキュリティログの署名に使うキー(画面には出さない)
npx cf workers secrets update GMEMO_SECRET_KEY --worker gmemo-stg --text "$(openssl rand -base64 32)"

unset STG_SETUP_TOKEN
cd ../..
```

- `GMEMO_SECRET_KEY` は、あとで鍵を入れ替えるときのために、パスワード管理ツールにも控えておくと安心です(画面に出したくない場合は、生成した値を一度変数に入れて、パスワード管理ツールに貼ってから送ります)。入れ替えの手順は [運用方針](operations.md#gmemo_secret_key-の入れ替え年1回または漏洩の疑いがあるとき) にあります。
- シークレットは設定した時点で反映されます(再デプロイは不要)。

## 6. ステージングを自分だけに制限する(Cloudflare Access)

ステージングに入れるのを、**自分のメールアドレスでログインした人だけ**にします。

1. Cloudflare のダッシュボード → **Zero Trust** を開く。初めての場合はチーム名を決める(無料プランで可)。チームドメインは `<チーム名>.cloudflareaccess.com` です
2. ダッシュボード → **Workers & Pages** → **gmemo-stg** → **Settings** → **Domains & Routes** で、`workers.dev` の行の **Cloudflare Access** を有効にする
3. 作られた Access アプリケーション(Zero Trust → **Access** → **Applications**)を開き、ポリシーを **Action: Allow**、**Include: Emails = 自分のメールアドレス** だけにする(ほかのルールは消す)
4. アプリケーションの概要にある **Application Audience (AUD) Tag** をコピーする
5. `deploy.env` の2行を埋める

   ```sh
   export GMEMO_ACCESS_TEAM_DOMAIN=<チーム名>.cloudflareaccess.com
   export GMEMO_STG_ACCESS_AUD=<コピーしたAUDタグ>
   ```

6. もう一度デプロイする

   ```sh
   source deploy.env
   npm run deploy:stg
   ```

**確認**:ステージングの URL を開くと、Cloudflare Access のログイン画面(メールに届くコードを入力)が出て、その後アプリが表示されれば成功です。画面上部に「STG」の帯が出ます。シークレットウィンドウで別のメールアドレスを入れると、入れないことも確かめておきます。

> アプリ自身も Access の署名付きトークンを検証しています。Access を誤って外しても、トークンがなければ 403 で拒否されます。
> ステージングは Access の内側にあるので、Claude などの MCP クライアントからは接続できません。MCP の確認はローカル(「[ローカルで試す](#ローカルで試す)」)で行います。

## 7. ステージングで最初のアカウントを作り、動作確認する

1. ステージングの URL を開くと「セットアップが必要です」と出る
2. **アカウントを作成する** → ユーザー名と、手順5で控えたセットアップトークンを入力 → パスキーを登録
3. 表示される**リカバリーコードを保存する**(パスキーをなくしたときに必要)

このアカウントが管理者になります。ステージングは新規登録が停止されているので、ほかの人は登録できません。

**動作確認のチェックリスト**(毎回のデプロイ後にも行います):

- [ ] サインイン・サインアウトができる
- [ ] ノートを作成・編集・検索できる、履歴が見られる
- [ ] 設定 → セキュリティログ に今の操作が記録され、管理者の「改ざんチェック」が問題なしになる
- [ ] (データベースの変更を含むとき)最初のアクセスでエラーが出ない(マイグレーションは自動)

## 8. 本番にデプロイする

本番へのデプロイは、**`main` ブランチの、GitHub の CI が通ったコミットからだけ**できるようにしてあります(作業中のコードを本番に出す事故を防ぐため)。

```sh
git checkout main
git pull
source deploy.env
npm run deploy:prod
```

コマンドは、デプロイの前に次を確認し、満たさないと中止します。

| 確認                                    | 中止されたときの対処                  |
| --------------------------------------- | ------------------------------------- |
| `GMEMO_ORIGIN` が `https://` で設定済み | `deploy.env` を確認して `source` する |
| いま `main` ブランチにいる              | `git checkout main`                   |
| コミットしていない変更がない            | `git status` で確認                   |
| 手元の `main` が GitHub と一致          | `git pull`                            |
| そのコミットで CI と CodeQL が成功      | GitHub の Actions で結果を待つ / 直す |

**初回だけ**、デプロイ後に本番のシークレットを設定し、最初のアカウントを作ります(手順5・7と同じで、Worker 名が `gmemo` になります。値はステージングと**別のもの**にします)。

```sh
cd packages/server
PROD_SETUP_TOKEN=$(openssl rand -base64 24)
echo "本番のセットアップトークン: $PROD_SETUP_TOKEN"
npx cf workers secrets update GMEMO_SETUP_TOKEN --worker gmemo --text "$PROD_SETUP_TOKEN"
npx cf workers secrets update GMEMO_SECRET_KEY --worker gmemo --text "$(openssl rand -base64 32)"
unset PROD_SETUP_TOKEN
cd ../..
```

本番の URL を開き、セットアップトークンで管理者アカウントを作ります。ほかの人は **設定 → サーバー管理 → 招待リンクを作成** で招待します(リンクは1回だけ・7日間有効)。

---

## 更新をデプロイする(2回目以降)

[運用方針](operations.md#2-リリースの流れ) の流れです。

```sh
# 1. 変更を PR にし、CI が通ったら main にマージする(GitHub 上で)

# 2. ステージングで確認
git checkout main && git pull
source deploy.env
npm run deploy:stg
#    → 手順7のチェックリストで確認

# 3. 本番へ
npm run deploy:prod
#    → 本番の 設定 → セキュリティログ で、エラーや拒否が増えていないか確認
```

データベースのマイグレーションは、新しいバージョンへの最初のリクエストで自動的に実行されます。

## 問題が起きたら(元に戻す)

**アプリを前のバージョンに戻す**:ダッシュボード → **Workers & Pages** → 対象の Worker(`gmemo` など)→ **Deployments** で、1つ前のバージョンの「…」→ **Rollback**。数秒で切り替わります。

**データベースを過去の時点に戻す**:D1 は過去30日の任意の時点に戻せます(Time Travel)。戻した時点より後の変更はすべて消えるので、最後の手段です。

1. ダッシュボード → **Storage & Databases** → **D1** → `gmemo` を開き、**Database ID** をコピー
2. 戻したい日時を決めて実行(UTC で指定)

   ```sh
   cd packages/server
   npx cf d1 time-travel restore <Database ID> --timestamp 2026-10-11T03:00:00Z
   ```

**ログを見る**:ダッシュボード → **Workers & Pages** → 対象の Worker → **Logs**。セキュリティログの内容もここに JSON で出ています。

## よくあるつまずき

| 症状                                                             | 原因と対処                                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GMEMO_STG_ORIGIN に、この環境の https:// の URL を…` で止まる   | `source deploy.env` を忘れている、または `deploy.env` の URL が未記入                                                      |
| ステージングが「This environment is not configured for access.」 | 手順6の Access の値がデプロイに入っていない。`deploy.env` を埋めて `source` し、`npm run deploy:stg`                       |
| ステージングが「Forbidden」                                      | Access のログインを通っていない、または AUD タグが違う。Zero Trust のアプリの AUD タグと `GMEMO_STG_ACCESS_AUD` を見比べる |
| パスキーの登録・ログインでエラー                                 | 開いている URL と `GMEMO_ORIGIN`(`GMEMO_STG_ORIGIN`)が一字一句同じか。末尾の `/` や `http`/`https` の違いも不可            |
| 「セットアップトークンが正しくない」                             | シークレットを設定した Worker 名が違う(`gmemo-stg` と `gmemo`)。設定し直してから再度入力                                   |
| 本番デプロイが「main と一致しません」「CI が実行中」で止まる     | 安全確認による中止。`git pull` する、または GitHub の Actions で CI が終わるのを待つ                                       |
| 操作によって `Exceeded CPU time` のエラー                        | 無料プランのCPU時間(10ms)を超えている。ノートが多い場合は Workers Paid を検討(下の「料金と制限の目安」)                    |

## 独自ドメインを使う

独自ドメイン(例:`memo.example.com`)を Cloudflare で管理している場合:

1. ダッシュボード → **Workers & Pages** → `gmemo` → **Settings** → **Domains & Routes** → **Add** → **Custom domain** でドメインを追加
2. `deploy.env` の `GMEMO_ORIGIN` を `https://memo.example.com` にして `npm run deploy:prod`
3. 同じ画面で `workers.dev` の公開を無効にする(入口を1つにする)

> パスキーはドメインに紐づくので、**最初のアカウントを作る前に**決めてください。あとから変えると、全員がリカバリーコードで入り直してパスキーを登録し直すことになります。

## ローカルで試す

```sh
cd packages/server
printf 'GMEMO_SETUP_TOKEN=local-setup\nGMEMO_SECRET_KEY=local-secret\n' > .dev.vars
npx cf dev --port 8787     # http://localhost:8787 (D1 はローカルのSQLiteで動く)
```

`http://localhost:8787/setup?token=local-setup` を開いてアカウントを作成します。`localhost` ではHTTPSなしでもパスキーが使えます。

## 料金と制限の目安

| 項目                          | 無料プラン              | 有料プラン(Workers Paid, 月 $5〜) |
| ----------------------------- | ----------------------- | --------------------------------- |
| リクエスト                    | 10万/日                 | 1000万/月 込み                    |
| 1リクエストのCPU時間          | 10ms                    | 30秒(既定)                        |
| D1 ストレージ                 | 5GB                     | 5GB 込み + 従量                   |
| 1リクエストあたりのD1クエリ   | 50                      | 1000                              |
| 1つの値(ノート・添付)の大きさ | 2MB(D1保存の場合の上限) | 同左                              |

普段のメモ・検索・AIからの提案は無料プランでも動く想定ですが、**数百ノートを一度に処理する操作(保存先の切り替え、インデックスの再構築、大量のノートを含む検索)はCPU時間を多く使う**ため、無料プランの10msを超えてエラーになることがあります。複数人で使う場合や、ノートが多い場合は Workers Paid を推奨します。

- D1 に保存する場合、1つのファイルは約1.9MBまでです。大きな添付ファイルを扱うなら GitHub 保存にしてください(20MBまで)。
- ノート数が数千を超えると、ベクトル検索(全チャンクとの比較)が重くなります。

## 動作確認済みの範囲

- `cf dev` / `wrangler dev`(ローカルの workerd + D1)で、アカウント作成(パスキー)、招待、リカバリー、ノートの保存・検索(日本語の全文検索を含む)、MCP、提案と承認、エクスポートまで確認しています。
- `cf deploy --dry-run --mode staging` / `--mode production` でビルドとバインディング(D1、静的アセット、環境変数、レート制限)の確認までしています。
- `npm run deploy:stg -- --dry-run` の一連の流れ(確認 → ビルド → `cf deploy --dry-run`)と、本番の安全確認(`main`、GitHub との一致、CI の結果)は実際に動かして確認しています。ダッシュボードの画面名(Domains & Routes、Deployments など)は執筆時点のもので、変わることがあります。
- Cloudflare Access のトークン検証は、同じ形式の署名付きトークンを使ったテストで確認しています。実際の Access との組み合わせは未確認です。
- 本番の Cloudflare 環境への実際のデプロイと、本物の GitHub API での動作は、開発時点では未確認です(GitHub API はテスト用の模擬サーバーで確認)。問題があれば Issue で教えてください。
- D1 の全文検索(FTS5 trigram)が使えない環境では、自動的に LIKE 検索に切り替わります。

## Wrangler を使う場合

`cf` がベータで不安な場合や、CI(GitHub Actions の wrangler-action など)で使う場合は、Wrangler でもデプロイできます。`cloudflare.config.ts` の代わりに `packages/server/wrangler.toml` を作ります。

```toml
name = "gmemo"
main = "src/worker.ts"
compatibility_date = "2026-09-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "../web/dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*", "/mcp", "/oauth/*", "/.well-known/*", "/cal/*"]

[[ratelimits]]
name = "AUTH_LIMITER"
namespace_id = "7001"
simple = { limit = 30, period = 60 }

[[d1_databases]]
binding = "DB"
database_name = "gmemo"
database_id = "<npx wrangler d1 create gmemo で表示されたID>"

[triggers]
crons = ["17 3 * * *"]

[vars]
GMEMO_ORIGIN = "https://gmemo.<サブドメイン>.workers.dev"
GMEMO_ENV = "production"
GMEMO_SIGNUP = "invite"
GMEMO_TIMEZONE = "Asia/Tokyo"
```

```sh
npx wrangler d1 create gmemo
npx wrangler secret put GMEMO_SETUP_TOKEN
npx wrangler secret put GMEMO_SECRET_KEY
npx wrangler deploy
```

ステージングは `name = "gmemo-stg"`、D1 も `gmemo-stg` にした別の設定ファイル(`wrangler.stg.toml` など、`GMEMO_ENV = "staging"`、`GMEMO_SIGNUP = "closed"`、Access の値を追加)を作り、`npx wrangler deploy -c wrangler.stg.toml` でデプロイします。

`cf` と Wrangler は同じ Worker・同じ D1 を扱えます(名前を揃えれば途中で切り替えても構いません)。D1 の SQL エクスポートは今のところ Wrangler だけにあります:`npx wrangler d1 export gmemo --remote --output backup.sql`
