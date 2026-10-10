# 設定

設定は環境変数で行います。Cloudflare Workers では `packages/server/cloudflare.config.ts`(環境変数で上書き可。秘密の値は `cf workers secrets update`)、Node.js / Docker では環境変数か `.env` です。

各ユーザーのAIポリシー(フォルダごとの外部AI送信、機密検出のモードや辞書)は画面から設定し、そのユーザーのノート内 `.gmemo/policy.yaml` に保存されます。

## 共通

| 変数                         | 既定値                    | 説明                                                                                                       |
| ---------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GMEMO_ORIGIN`               | `http://localhost:8787`   | 公開URL。パスキーとOAuthの検証に使う。**HTTPSのドメイン**にする                                            |
| `GMEMO_RP_ID`                | `GMEMO_ORIGIN` のホスト名 | パスキーのRP ID。通常は変更不要                                                                            |
| `GMEMO_RP_NAME`              | `Ganesya AI Memo`         | パスキー登録時に表示される名前                                                                             |
| `GMEMO_SIGNUP`               | `invite`                  | 2人目以降の登録方法。`open`(誰でも)/ `invite`(管理者の招待リンクが必要)/ `closed`(新規登録停止)            |
| `GMEMO_SETUP_TOKEN`          |                           | 最初の(管理者)アカウントを作るためのトークン。**シークレット**。Node.js では未設定なら起動時に生成して表示 |
| `GMEMO_SECRET_KEY`           |                           | GitHubトークンを暗号化するキー。**シークレット**。未設定だとGitHub保存は使えない(Node.jsでは自動生成)      |
| `GMEMO_SESSION_DAYS`         | `30`                      | ログインセッションの有効日数                                                                               |
| `GMEMO_ACCESS_TOKEN_MINUTES` | `60`                      | OAuthアクセストークンの有効期間                                                                            |
| `GMEMO_GITHUB_CHECK_SECONDS` | `30`                      | GitHub保存のユーザーについて、アプリ外のpushを確認する間隔                                                 |
| `GMEMO_GITHUB_API`           | `https://api.github.com`  | GitHub API のURL(GitHub Enterprise Server を使う場合)                                                      |
| `GMEMO_TIMEZONE`             | `Asia/Tokyo`              | オフセットのない日時(ノートの `2026-10-12 10:00` など)を解釈するタイムゾーン                               |
| `GMEMO_INSECURE_DEV`         |                           | `1` で開発用の緩い設定(HTTPでの公開URL、社内アドレスのカレンダーURLを許可)。本番では使わない               |

## Node.js / Docker のみ

| 変数             | 既定値              | 説明                                           |
| ---------------- | ------------------- | ---------------------------------------------- |
| `GMEMO_DATA_DIR` | `./data`            | データディレクトリ(`gmemo.db` と `secret.key`) |
| `GMEMO_PORT`     | `8787`              | 待ち受けポート                                 |
| `GMEMO_HOST`     | `0.0.0.0`           | 待ち受けアドレス                               |
| `GMEMO_WEB_DIR`  | `packages/web/dist` | Webアプリのビルド出力                          |

Cloudflare Workers では、データベースは `cloudflare.config.ts` の D1 バインディング(`DB`)、Webアプリは静的アセット(`ASSETS`)です。

## ローカルLLM

| 変数                       | 例                    | 説明                                                                                  |
| -------------------------- | --------------------- | ------------------------------------------------------------------------------------- |
| `GMEMO_LOCAL_LLM_URL`      | `http://ollama:11434` | 未設定ならローカルLLMなし。Cloudflare Workers からはインターネット経由で届くURLが必要 |
| `GMEMO_LOCAL_LLM_PROVIDER` | `ollama`              | `ollama` または `openai`(LM Studio、llama.cpp server など OpenAI互換API)              |
| `GMEMO_LOCAL_LLM_MODEL`    | `qwen2.5:7b`          | 「ノートに質問」と機密検出(固有名詞)に使うモデル                                      |
| `GMEMO_LOCAL_LLM_API_KEY`  |                       | OpenAI互換サーバーがキーを要求する場合                                                |
| `GMEMO_LOCAL_EMBED_MODEL`  | `nomic-embed-text`    | ベクトル検索用。未設定なら内蔵の簡易ベクトル                                          |

## 外部LLM

| 変数                          | 例                  | 説明                                               |
| ----------------------------- | ------------------- | -------------------------------------------------- |
| `GMEMO_EXTERNAL_LLM_PROVIDER` | `anthropic`         | `anthropic` または `openai`。未設定なら外部LLMなし |
| `GMEMO_EXTERNAL_LLM_API_KEY`  |                     | APIキー                                            |
| `GMEMO_EXTERNAL_LLM_MODEL`    | `claude-sonnet-5-5` | モデル名                                           |
| `GMEMO_EXTERNAL_LLM_URL`      |                     | エンドポイントを変える場合                         |

LLMの接続先はサーバー全体で共通です(全ユーザーが同じLLMを使います)。外部LLMを設定しても、各ユーザーが設定画面で「外部AIを有効にする」を確認するまでは、そのユーザーのノートには使われません。また、送れるのはAIポリシーで「外部AI可」になっているフォルダのノートだけです。

## AIポリシー(`.gmemo/policy.yaml`、ユーザーごと)

```yaml
ai:
  default: local # external | local | none
  folders:
    work/: external
    private/: none
sensitive:
  mode: mask # warn | mask | block
  dictionary: [取引先A社, Project Falcon]
  allow: [] # 「問題なし」とした検出結果のフィンガープリント
  disabledRules: []
  useLocalModel: false # ローカルLLMで人名・住所・社名なども検出
externalAcknowledged: false
```

- フォルダは最長一致で決まります。
- ノートのフロントマターに `sensitivity: secret` があると、フォルダ設定にかかわらず「ローカルLLMのみ」以下になります。`ai: none` でAI不可にもできます。
- 初期値は `local`(外部AIには何も送らない)です。MCPでつないだ外部AIエージェントにノートを見せるには、対象フォルダを `external` にしてください。
