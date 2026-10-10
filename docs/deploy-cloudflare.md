# Cloudflare にデプロイする

Cloudflare Workers と D1(SQLite互換のデータベース)の上で動かすのがおすすめの構成です。サーバーの管理が要らず、無料枠から始められます。

```
ブラウザ / AIエージェント ──▶ Cloudflare Workers(このアプリ)──▶ D1(アカウント・ノート・履歴・検索インデックス)
                                                             └─▶ GitHub API(GitHub保存を選んだユーザーのみ)
```

- 複数の人がそれぞれアカウントを作って使えます(最初のアカウントが管理者)。
- ノートと変更履歴は、ユーザーごとに **D1 内**か**そのユーザーの GitHub リポジトリ**に保存されます([保存先](storage.md))。
- Webアプリ(PWA)は Workers の静的アセットとして同じドメインで配信されます。

## 必要なもの

- Cloudflare アカウント(無料で可)
- Node.js 22 以上
- このリポジトリ

デプロイには Cloudflare の新しいCLI **`cf`** を使います(依存関係として入っているので、別途インストールは不要です)。

> `cf` は 2026年9月に公開されたばかりのオープンベータです。コマンドや設定の書き方が変わる可能性があります。うまく動かない場合は、従来の Wrangler でもデプロイできます(末尾の「Wrangler を使う場合」)。

## 1. ビルドとログイン

```sh
git clone https://github.com/ogane0112/ganesya-ai-memo && cd ganesya-ai-memo
npm ci
npm run build -w @gmemo/core
npm run build -w @gmemo/web
cd packages/server
npx cf auth login
```

## 2. 公開URLを決める

設定は `packages/server/cloudflare.config.ts` にあります。値は環境変数で上書きできるので、ファイルを編集しなくても構いません。

| 環境変数         | 既定値                  | 説明                                                               |
| ---------------- | ----------------------- | ------------------------------------------------------------------ |
| `GMEMO_ORIGIN`   | `http://localhost:8787` | 公開URL。`https://gmemo.<サブドメイン>.workers.dev` か独自ドメイン |
| `GMEMO_SIGNUP`   | `invite`                | `open`(誰でも)/ `invite`(招待制)/ `closed`(新規登録停止)           |
| `GMEMO_TIMEZONE` | `Asia/Tokyo`            | タイムゾーン                                                       |

> **パスキーはドメインに紐づきます。** 後からドメインを変えると、全員のパスキーが使えなくなります(リカバリーコードで入り直して再登録は可能)。独自ドメインを使う予定なら、最初から独自ドメインで始めてください。

`*.workers.dev` のサブドメインは、Cloudflare ダッシュボードの Workers & Pages → 概要の右側に表示されています。

## 3. デプロイ

```sh
GMEMO_ORIGIN=https://gmemo.<サブドメイン>.workers.dev npx cf deploy
```

初回のデプロイで D1 データベース(`gmemo`)が自動的に作られます。テーブルも最初のリクエストで自動的に作られます(マイグレーションも同様)。手作業のSQLは不要です。

**2回目以降のデプロイでも、同じ `GMEMO_ORIGIN` を毎回付けてください**(付け忘れると `http://localhost:8787` に戻ってしまいます)。毎回付けるのが面倒なら、`cloudflare.config.ts` の既定値を書き換えてください。

## 4. シークレットを設定する

```sh
# 最初の(管理者)アカウントを作るためのトークン。推測されない長い文字列にする
npx cf workers secrets update GMEMO_SETUP_TOKEN --worker gmemo --text "$(openssl rand -base64 24)"

# GitHub トークンの暗号化キー。一度決めたら変えない(変えると保存済みの接続が復号できなくなる)
npx cf workers secrets update GMEMO_SECRET_KEY --worker gmemo --text "$(openssl rand -base64 32)"
```

セットアップトークンは次の手順で使うので、実行前に値を控えておく(またはコマンド内の値を自分で決める)ようにしてください。`GMEMO_SECRET_KEY` を設定しない場合、ユーザーは GitHub 保存を選べません(D1 保存だけになります)。

## 5. 最初のアカウントを作る

デプロイしたURLを開くと「セットアップが必要です」と出ます。**アカウントを作成する** から、ユーザー名とセットアップトークンを入れてパスキーを登録します。このアカウントが管理者になります。登録直後に表示される**リカバリーコード**は必ず保存してください。

最初のアカウントができたら、`GMEMO_SETUP_TOKEN` は使われなくなります。

## 6. ほかの人を招待する

`GMEMO_SIGNUP` が `invite` の場合、管理者が **設定 → サーバー管理 → 招待リンクを作成** でリンクを作って渡します。リンクは1回だけ・7日間有効です。`open` にすると招待なしで誰でも登録できます。

## アップデート

```sh
git pull
npm ci
npm run build -w @gmemo/core && npm run build -w @gmemo/web
cd packages/server && GMEMO_ORIGIN=https://... npx cf deploy
```

データベースのマイグレーションは、新しいバージョンへの最初のリクエストで自動的に実行されます。D1 には Time Travel(過去30日の任意の時点に戻す機能)があるので、問題があればその時点に戻せます(`npx cf d1 time-travel`)。

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
- `cf deploy --dry-run` でビルドとバインディング(D1、静的アセット、環境変数)の確認までしています。
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

[[d1_databases]]
binding = "DB"
database_name = "gmemo"
database_id = "<npx wrangler d1 create gmemo で表示されたID>"

[triggers]
crons = ["17 3 * * *"]

[vars]
GMEMO_ORIGIN = "https://gmemo.<サブドメイン>.workers.dev"
GMEMO_SIGNUP = "invite"
GMEMO_TIMEZONE = "Asia/Tokyo"
```

```sh
npx wrangler d1 create gmemo
npx wrangler secret put GMEMO_SETUP_TOKEN
npx wrangler secret put GMEMO_SECRET_KEY
npx wrangler deploy
```

`cf` と Wrangler は同じ Worker・同じ D1 を扱えます(名前を揃えれば途中で切り替えても構いません)。D1 の SQL エクスポートは今のところ Wrangler だけにあります:`npx wrangler d1 export gmemo --remote --output backup.sql`
