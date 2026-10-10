# セットアップ

## 必要なもの

- 自分で管理できるサーバー(VPS、自宅サーバー、NASなど)
- ドメイン名(例:`notes.example.com`)とそのDNSレコード
- Docker と Docker Compose

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
No passkey is registered yet. Open the app and use this one-time setup token:
  https://notes.example.com/setup?token=XXXXXXXX
```

このURLを開いてユーザー名を決め、パスキーを登録します。登録直後に**リカバリーコード(10個)**が一度だけ表示されるので保存してください。セットアップトークンは24時間有効で、最初のパスキー登録に使うと無効になります。

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

Node.js 22 以上と git が必要です。

```sh
npm ci
npm run build
GMEMO_DATA_DIR=/var/lib/gmemo GMEMO_ORIGIN=https://notes.example.com node packages/server/dist/cli.js serve
```

HTTPSはリバースプロキシ(Caddy、nginx など)で終端してください。SSE(`/api/events`)とMCP用に、プロキシのバッファリングは無効にしてください。

## データの場所

`GMEMO_DATA_DIR`(Dockerでは `/data` ボリューム)に次が入ります。

| パス | 中身 | 消えたら |
| --- | --- | --- |
| `notes/` | ノートのGitリポジトリ(正のデータ) | **復元不可。必ずバックアップ** |
| `app.db` | パスキー公開鍵、エージェント、トークン(ハッシュ)、提案の管理情報 | パスキー再登録・エージェント再接続が必要 |
| `index.db` | 全文検索・埋め込み・リンクグラフ | `gmemo reindex` で再生成できる |
| `plugins/` | プラグイン | 入れ直せばよい |

`notes/` はそのままObsidianで開けます。サーバー外での編集(Obsidian、エディタ、`git pull` など)は数秒ごとに検出され、人間の編集としてコミットされます。

## バックアップ

設定画面の「バックアップ」から、ノートの全履歴(git bundle)と `app.db` を1ファイルにまとめてダウンロードできます。パスフレーズを入れるとAES-256-GCMで暗号化されます。CLIでも作れます。

```sh
docker compose exec -e PASS='長いパスフレーズ' app gmemo backup /data/backup.gmbk --passphrase-env PASS
```

復元は空のデータディレクトリに対して行います。

```sh
GMEMO_DATA_DIR=/var/lib/gmemo-new PASS='...' gmemo restore backup.gmbk --passphrase-env PASS
```

サーバーのディスク自体も、OSの機能(LUKS、FileVault、BitLockerなど)で暗号化することを推奨します。

## 管理者CLI

```sh
docker compose exec app gmemo admin reset-passkeys   # 全パスキーを削除して新しいセットアップトークンを表示
docker compose exec app gmemo admin recovery-codes   # リカバリーコードを作り直す
docker compose exec app gmemo admin revoke-agent <名前>
docker compose exec app gmemo reindex                # 検索インデックスを作り直す
```

パスキーをすべて失い、リカバリーコードもない場合は `reset-passkeys` を使います。サーバーに入れる人=管理者、という前提です。

## アップデート

```sh
git pull
docker compose up -d --build
```

データベースのマイグレーションは起動時に自動で実行されます。念のため、アップデート前にバックアップを取ってください。
