# セルフホスト(Node.js / Docker)

Cloudflare を使わず、自分のサーバーで動かす方法です。サーバー管理をしたくない場合は [Cloudflare にデプロイする](deploy-cloudflare.md) を使ってください。機能は同じです(データベースが D1 か SQLite ファイルかの違いだけ)。

## 必要なもの

- 自分で管理できるサーバー(VPS、自宅サーバー、NASなど)
- ドメイン名(例:`notes.example.com`)とそのDNSレコード
- Docker と Docker Compose、または Node.js 22 以上

## パスキーの制約(先に読んでください)

認証はパスキーのみです。パスキーには次の制約があります。

- **HTTPSが必須**です(`localhost` だけは例外)。同梱の `docker-compose.yml` はCaddyで自動的に証明書を取得します。
- **パスキーはドメイン(RP ID)に紐づきます。** 運用開始後にドメインを変えると、登録済みのパスキーはすべて使えなくなり、再登録が必要です。最初に長く使うドメインを決めてください。
- **IPアドレス直打ちの運用はできません。** `https://203.0.113.5` のようなURLではパスキーを登録できません。
- 端末をなくしたときのために、**パスキーは2つ以上(スマホとPCなど)登録**し、リカバリーコードを安全な場所に保管してください。

## Docker Compose で起動

```sh
cp .env.example .env
# .env の GMEMO_DOMAIN を自分のドメインにする
docker compose up -d
docker compose logs app
```

ログに次のような行が出ます。

```
No account exists yet. Create the first (admin) account with this token:
  https://notes.example.com/setup?token=XXXXXXXX
```

このURLを開いてユーザー名を決め、パスキーを登録します。このアカウントが管理者になります。登録直後に**リカバリーコード(10個)**が一度だけ表示されるので保存してください。セットアップトークンは24時間有効で、最初のアカウント作成に使うと無効になります。`GMEMO_SETUP_TOKEN` を環境変数で指定した場合は、その値がトークンになります。

2人目以降は、`GMEMO_SIGNUP`(既定 `invite`)に従って登録します。招待制の場合、管理者が **設定 → サーバー管理** で招待リンクを作って渡します。

### ローカルLLM(Ollama)も動かす

```sh
docker compose --profile ollama up -d
docker compose exec ollama ollama pull qwen2.5:7b
docker compose exec ollama ollama pull nomic-embed-text
```

`.env` に次を追加して `docker compose up -d` し直します。

```sh
GMEMO_LOCAL_LLM_URL=http://ollama:11434
GMEMO_LOCAL_LLM_MODEL=qwen2.5:7b
GMEMO_LOCAL_EMBED_MODEL=nomic-embed-text
```

埋め込みモデルを設定しない場合は、依存なしで動く文字n-gramベースの簡易ベクトル検索が使われます(語彙的な類似のみ。意味検索の精度はローカル埋め込みモデルの方が高い)。

## Dockerを使わない場合

```sh
npm ci
npm run build
GMEMO_DATA_DIR=/var/lib/gmemo GMEMO_ORIGIN=https://notes.example.com node packages/server/dist/cli.js serve
```

HTTPSはリバースプロキシ(Caddy、nginx など)で終端してください。MCP用に、プロキシのバッファリングは無効にしてください。

## データの場所

`GMEMO_DATA_DIR`(Dockerでは `/data` ボリューム)に次が入ります。

| パス         | 中身                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `gmemo.db`   | すべて(アカウント、パスキー公開鍵、エージェント、トークンのハッシュ、ノートとその履歴、検索インデックス) |
| `secret.key` | GitHubトークンの暗号化キー(`GMEMO_SECRET_KEY` を指定しない場合に自動生成)                                |

GitHub 保存を選んだユーザーのノートは、そのユーザーの GitHub リポジトリにあります([保存先](storage.md))。

## バックアップ

- サーバー全体:`gmemo.db` と `secret.key` をコピーします。SQLite は WAL モードなので、稼働中は `sqlite3 gmemo.db ".backup backup.db"` を使うか、サーバーを止めてからコピーしてください。
- 各ユーザー:**設定 → データ・アカウント → エクスポート** で、自分のノートを .tar.gz でダウンロードできます。

サーバーのディスク自体も、OSの機能(LUKS、FileVault、BitLockerなど)で暗号化することを推奨します。

## 管理者CLI

```sh
docker compose exec app gmemo admin users                  # アカウント一覧
docker compose exec app gmemo admin reset-user <ユーザー名>  # サインアウトさせ、新しいリカバリーコードを表示
docker compose exec app gmemo admin make-admin <ユーザー名>  # 管理者にする
docker compose exec app gmemo admin setup-token            # 最初のアカウント用のトークンを再発行
docker compose exec app gmemo reindex [<ユーザー名>]         # 検索インデックスを作り直す
```

パスキーをすべて失い、リカバリーコードもない利用者には、管理者が `reset-user`(または画面の **サーバー管理 → 復旧コードを再発行**)で新しいリカバリーコードを発行し、本人に直接渡します。

## アップデート

```sh
git pull
docker compose up -d --build
```

データベースのマイグレーションは起動時に自動で実行されます。念のため、アップデート前にバックアップを取ってください。

> 以前のバージョン(1人用、`notes/` のGitリポジトリと `app.db` / `index.db`)からは自動では移行しません。新しいバージョンで管理者アカウントを作り、**設定 → 保存先** で以前の `notes/` を push した GitHub リポジトリに接続するか、ノートを取り込み直してください。
