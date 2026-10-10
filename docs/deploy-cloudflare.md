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

## 1. ビルド

```sh
git clone https://github.com/ogane0112/ganesya-ai-memo && cd ganesya-ai-memo
npm ci
npm run build -w @gmemo/core
npm run build -w @gmemo/web
cd packages/server
npx wrangler login
```

## 2. D1 データベースを作る

```sh
npx wrangler d1 create gmemo
```

表示された `database_id` を `packages/server/wrangler.toml` の `[[d1_databases]]` に貼り付けます。

```toml
[[d1_databases]]
binding = "DB"
database_name = "gmemo"
database_id = "ここに貼る"
```

テーブルは最初のリクエストで自動的に作られます(マイグレーションも同様)。手作業のSQLは不要です。

## 3. 公開URLを決める

`wrangler.toml` の `GMEMO_ORIGIN` を、実際に使うURLにします。

```toml
[vars]
GMEMO_ORIGIN = "https://gmemo.<あなたのサブドメイン>.workers.dev"
GMEMO_SIGNUP = "invite"     # open(誰でも)| invite(招待制)| closed(新規登録停止)
GMEMO_TIMEZONE = "Asia/Tokyo"
```

> **パスキーはドメインに紐づきます。** 後からドメインを変えると、全員のパスキーが使えなくなります(リカバリーコードで入り直して再登録は可能)。独自ドメインを使う予定なら、最初から独自ドメインで始めてください(Workers の「Custom Domains」で設定できます)。

`*.workers.dev` のサブドメインは、Cloudflare ダッシュボードの Workers & Pages → 概要の右側に表示されています。

## 4. シークレットを設定する

```sh
# 最初の(管理者)アカウントを作るためのトークン。推測されない長い文字列にする
npx wrangler secret put GMEMO_SETUP_TOKEN

# GitHub トークンの暗号化キー。一度決めたら変えない(変えると保存済みの接続が復号できなくなる)
npx wrangler secret put GMEMO_SECRET_KEY
```

値は例えば `openssl rand -base64 32` で作れます。`GMEMO_SECRET_KEY` を設定しない場合、ユーザーは GitHub 保存を選べません(D1 保存だけになります)。

## 5. デプロイ

```sh
npx wrangler deploy
```

表示されたURLを開くと「セットアップが必要です」と出ます。**アカウントを作成する** から、ユーザー名と `GMEMO_SETUP_TOKEN` の値を入れてパスキーを登録します。このアカウントが管理者になります。登録直後に表示される**リカバリーコード**は必ず保存してください。

最初のアカウントができたら、`GMEMO_SETUP_TOKEN` は使われなくなります(消しても構いません)。

## 6. ほかの人を招待する

`GMEMO_SIGNUP = "invite"` の場合、管理者が **設定 → サーバー管理 → 招待リンクを作成** でリンクを作って渡します。リンクは1回だけ・7日間有効です。`open` にすると招待なしで誰でも登録できます。

## アップデート

```sh
git pull
npm ci
npm run build -w @gmemo/core && npm run build -w @gmemo/web
cd packages/server && npx wrangler deploy
```

データベースのマイグレーションは、新しいバージョンへの最初のリクエストで自動的に実行されます。念のため、アップデート前に D1 のバックアップを取っておくと安心です。

```sh
npx wrangler d1 export gmemo --remote --output backup.sql
```

D1 には Time Travel(過去30日の任意の時点に戻す機能)もあります:`npx wrangler d1 time-travel restore gmemo --timestamp=...`

## ローカルで試す

```sh
cd packages/server
printf 'GMEMO_SETUP_TOKEN=local-setup\nGMEMO_SECRET_KEY=local-secret\n' > .dev.vars
npx wrangler dev        # http://localhost:8787 (D1 はローカルのSQLiteで動く)
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

- `wrangler dev`(ローカルの workerd + D1)で、アカウント作成(パスキー)、招待、リカバリー、ノートの保存・検索(日本語の全文検索を含む)、MCP、提案と承認、エクスポートまで確認しています。
- 本番の Cloudflare 環境と、本物の GitHub API での動作は、開発時点では未確認です(GitHub API はテスト用の模擬サーバーで確認)。問題があれば Issue で教えてください。
- D1 の全文検索(FTS5 trigram)が使えない環境では、自動的に LIKE 検索に切り替わります。
