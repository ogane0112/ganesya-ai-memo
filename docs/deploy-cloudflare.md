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

## 2. 環境と公開URL

ステージング(自分だけが使う確認用)と本番の2つの環境を、別々の Worker・D1・シークレットで動かします。運用のルールは [運用方針](operations.md) にあります。

| 環境         | Worker / D1 | コマンド              | 公開URLの環境変数  | 新規登録              |
| ------------ | ----------- | --------------------- | ------------------ | --------------------- |
| ステージング | `gmemo-stg` | `npm run deploy:stg`  | `GMEMO_STG_ORIGIN` | 停止(`closed`)        |
| 本番         | `gmemo`     | `npm run deploy:prod` | `GMEMO_ORIGIN`     | `GMEMO_SIGNUP` に従う |

`--mode` を付けない `npx cf deploy` は、どちらでもない `gmemo-dev` に向かいます(本番の上書きを防ぐため)。

設定は `packages/server/cloudflare.config.ts` にあります。値は環境変数で上書きできるので、ファイルを編集しなくても構いません。

| 環境変数                   | 既定値       | 説明                                                                          |
| -------------------------- | ------------ | ----------------------------------------------------------------------------- |
| `GMEMO_ORIGIN`             | (必須)       | 本番の公開URL。`https://gmemo.<サブドメイン>.workers.dev` か独自ドメイン      |
| `GMEMO_STG_ORIGIN`         | (必須)       | ステージングの公開URL。`https://gmemo-stg.<サブドメイン>.workers.dev` など    |
| `GMEMO_SIGNUP`             | `invite`     | 本番の登録方法。`open`(誰でも)/ `invite`(招待制)/ `closed`(新規登録停止)      |
| `GMEMO_TIMEZONE`           | `Asia/Tokyo` | タイムゾーン                                                                  |
| `GMEMO_ACCESS_TEAM_DOMAIN` |              | Cloudflare Access のチームドメイン(`<チーム名>.cloudflareaccess.com`)         |
| `GMEMO_STG_ACCESS_AUD`     |              | ステージングの Access アプリケーションの AUD タグ(手順5)                      |
| `GMEMO_ACCESS_AUD`         |              | 本番も Access の内側に置く場合だけ(通常は空)                                  |
| `GMEMO_R2`                 |              | `on` にすると、添付ファイルを R2 に保存する(下の「添付ファイルを R2 に置く」) |

公開URLが `https://` でないと、デプロイは止まります(パスキーが使えなくなるのを防ぐため)。毎回指定するのが面倒なら、シェルの設定や `.envrc` に書いておくか、`cloudflare.config.ts` の既定値を書き換えてください。

> **パスキーはドメインに紐づきます。** 後からドメインを変えると、全員のパスキーが使えなくなります(リカバリーコードで入り直して再登録は可能)。独自ドメインを使う予定なら、最初から独自ドメインで始めてください。

`*.workers.dev` のサブドメインは、Cloudflare ダッシュボードの Workers & Pages → 概要の右側に表示されています。

## 3. デプロイ

```sh
export GMEMO_STG_ORIGIN=https://gmemo-stg.<サブドメイン>.workers.dev
export GMEMO_ORIGIN=https://gmemo.<サブドメイン>.workers.dev
npm run deploy:stg    # ステージング
npm run deploy:prod   # 本番
```

初回のデプロイで D1 データベース(`gmemo-stg` / `gmemo`)が自動的に作られます。テーブルも最初のリクエストで自動的に作られます(マイグレーションも同様)。手作業のSQLは不要です。

ステージングは、次の手順5で Cloudflare Access を設定するまで **すべてのリクエストを拒否します**(503)。これは意図した動作です。

## 4. シークレットを設定する

環境ごとに**別の値**を設定します(`--worker gmemo-stg` と `--worker gmemo` でそれぞれ実行)。

```sh
# 最初の(管理者)アカウントを作るためのトークン。推測されない長い文字列にする
npx cf workers secrets update GMEMO_SETUP_TOKEN --worker gmemo --text "$(openssl rand -base64 24)"

# GitHub トークンの暗号化と、セキュリティログの署名に使うキー
npx cf workers secrets update GMEMO_SECRET_KEY --worker gmemo --text "$(openssl rand -base64 32)"
```

セットアップトークンは手順6で使うので、実行前に値を控えておく(またはコマンド内の値を自分で決める)ようにしてください。`GMEMO_SECRET_KEY` を設定しない場合、ユーザーは GitHub 保存を選べず、セキュリティログにも署名が付きません。キーを変えるときは [運用方針の「入れ替え」](operations.md#gmemo_secret_key-の入れ替え年1回または漏洩の疑いがあるとき) の手順で行ってください(いきなり変えると保存済みの GitHub 接続が復号できなくなります)。

## 5. ステージングを自分だけに制限する(Cloudflare Access)

1. ダッシュボードの **Zero Trust** を開き、初回ならチーム名を決める(無料プランで可、50人まで)。チームドメインは `<チーム名>.cloudflareaccess.com`。
2. **Workers & Pages → `gmemo-stg` → 設定 → ドメインとルート** で、`workers.dev` の行の「Cloudflare Access」を有効にする。独自ドメインの場合は Zero Trust → Access → アプリケーション で「セルフホスト」アプリを作り、ステージングのホスト名を指定する。
3. 作られた Access アプリケーションのポリシーを **「Allow」・「Emails」= 自分のメールアドレスだけ** にする(ほかのルールは消す)。
4. アプリケーションの概要にある **アプリケーション対象者(AUD)タグ** をコピーする。
5. 再デプロイする:

```sh
export GMEMO_ACCESS_TEAM_DOMAIN=<チーム名>.cloudflareaccess.com
export GMEMO_STG_ACCESS_AUD=<コピーしたAUDタグ>
npm run deploy:stg
```

アプリは Cloudflare Access の署名付きトークン(`Cf-Access-Jwt-Assertion`)を自分でも検証します。Access を通らない経路(設定ミスや、Access を外してしまった場合)でも、トークンがなければ 403 を返します。

ステージングの URL を開くと、Access のログイン画面(メールに届くコード)→ アプリの順に進みます。画面上部に「STG」の帯が出ていればステージングです。

> ステージングは Access の内側にあるので、Claude などの MCP クライアントからは接続できません。MCP の確認は `npx cf dev`(ローカル)で行ってください。

## 6. 最初のアカウントを作る

デプロイしたURLを開くと「セットアップが必要です」と出ます(ステージングと本番で1回ずつ)。**アカウントを作成する** から、ユーザー名とセットアップトークンを入れてパスキーを登録します。このアカウントが管理者になります。登録直後に表示される**リカバリーコード**は必ず保存してください。

最初のアカウントができたら、`GMEMO_SETUP_TOKEN` は使われなくなります。

## 7. ほかの人を招待する

`GMEMO_SIGNUP` が `invite` の場合、管理者が **設定 → サーバー管理 → 招待リンクを作成** でリンクを作って渡します。リンクは1回だけ・7日間有効です。`open` にすると招待なしで誰でも登録できます。

## 添付ファイルを R2 に置く(任意)

何もしなければ、添付ファイルはノートと同じ D1 に入り、1ファイル約1.9MBまでです。R2(Cloudflare のオブジェクトストレージ)を使うと、種類を問わず1ファイル50MBまで添付できます。

1. ダッシュボードの **R2 オブジェクトストレージ** を開いて R2 を有効にする(支払い方法の登録が必要。毎月10GBまでは無料)。
2. `GMEMO_R2=on` を付けてデプロイする。バケット(`gmemo-stg-files` / `gmemo-files`)は初回のデプロイで作られます。

```sh
export GMEMO_R2=on
npm run deploy:stg
npm run deploy:prod
```

- R2 に入るのは、ノートを「このサービス内」に保存しているユーザーの添付です。GitHub 保存のユーザーの添付は、これまでどおりそのリポジトリに入ります。
- ファイルは**暗号化してから** R2 に保存します(AES-256-GCM。鍵は `GMEMO_SECRET_KEY` から作り、ユーザーごとに別)。R2 に入るのは暗号文だけです。鍵を持つアプリ自身は復号できるので、エンドツーエンド暗号化ではありません。
- そのため `GMEMO_SECRET_KEY` が必要です(未設定なら R2 は使われず、添付はノートと同じ場所に入ります)。**この鍵を失うと、R2 のファイルは二度と開けません。** 鍵を入れ替えるときは、[運用方針の手順](operations.md#gmemo_secret_key-の入れ替え年1回または漏洩の疑いがあるとき)どおり `GMEMO_SECRET_KEY_PREVIOUS` に前の鍵を残してください(前の鍵で保存したファイルは、前の鍵で開きます)。
- ファイルはユーザーごとに分けて保存され、アカウントを削除すると一緒に消えます。
- R2 のファイルは、エクスポート(.tar.gz)には含まれません。
- 一度 `GMEMO_R2=on` でデプロイしたら、以後のデプロイでも付けてください。外すと、R2 に置いたファイルがノートから開けなくなります(ファイル自体は R2 に残ります)。

## アップデート

```sh
git pull
npm ci
npm run build -w @gmemo/core && npm run build -w @gmemo/web
cd packages/server
npm run deploy:stg    # まずステージングで確認して
npm run deploy:prod   # 問題なければ本番へ
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

- D1 に保存する場合、1つのファイルは約1.9MBまでです。大きな添付ファイルを扱うなら、R2 を有効にする(50MBまで、上の「添付ファイルを R2 に置く」)か、GitHub 保存にしてください(20MBまで)。
- ノート数が数千を超えると、ベクトル検索(全チャンクとの比較)が重くなります。

## 動作確認済みの範囲

- `cf dev` / `wrangler dev`(ローカルの workerd + D1)で、アカウント作成(パスキー)、招待、リカバリー、ノートの保存・検索(日本語の全文検索を含む)、MCP、提案と承認、エクスポートまで確認しています。
- `cf deploy --dry-run --mode staging` / `--mode production` でビルドとバインディング(D1、静的アセット、環境変数、レート制限)の確認までしています。
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

[[ratelimits]]
name = "WRITE_LIMITER"
namespace_id = "7011"
simple = { limit = 120, period = 60 }

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
