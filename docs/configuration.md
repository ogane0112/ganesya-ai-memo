# 設定

設定は環境変数で行います。ワークスペースのAIポリシー(フォルダごとの外部AI送信、機密検出のモードや辞書)は画面から設定し、ノートのリポジトリ内 `.gmemo/policy.yaml` に保存されます。

## サーバー

| 変数                          | 既定値                    | 説明                                                                                          |
| ----------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| `GMEMO_DATA_DIR`              | `./data`                  | データディレクトリ                                                                            |
| `GMEMO_ORIGIN`                | `http://localhost:<port>` | 公開URL。パスキーとOAuthの検証に使う。**HTTPSのドメイン**にする                               |
| `GMEMO_RP_ID`                 | `GMEMO_ORIGIN` のホスト名 | パスキーのRP ID。通常は変更不要                                                               |
| `GMEMO_RP_NAME`               | `Ganesya AI Memo`         | パスキー登録時に表示される名前                                                                |
| `GMEMO_PORT`                  | `8787`                    | 待ち受けポート                                                                                |
| `GMEMO_HOST`                  | `0.0.0.0`                 | 待ち受けアドレス                                                                              |
| `GMEMO_WEB_DIR`               | `packages/web/dist`       | Webアプリのビルド出力                                                                         |
| `GMEMO_PLUGINS_DIR`           | `$GMEMO_DATA_DIR/plugins` | プラグインの場所                                                                              |
| `GMEMO_EXTERNAL_SCAN_SECONDS` | `15`                      | アプリ外での編集を検出する間隔(0で無効)                                                       |
| `GMEMO_SESSION_DAYS`          | `30`                      | ログインセッションの有効日数                                                                  |
| `GMEMO_ACCESS_TOKEN_MINUTES`  | `60`                      | OAuthアクセストークンの有効期間                                                               |
| `GMEMO_TIMEZONE`              | サーバーのタイムゾーン    | オフセットのない日時(ノートの `2026-10-12 10:00` など)を解釈するタイムゾーン。例:`Asia/Tokyo` |

## ローカルLLM

| 変数                       | 例                    | 説明                                                                     |
| -------------------------- | --------------------- | ------------------------------------------------------------------------ |
| `GMEMO_LOCAL_LLM_URL`      | `http://ollama:11434` | 未設定ならローカルLLMなし                                                |
| `GMEMO_LOCAL_LLM_PROVIDER` | `ollama`              | `ollama` または `openai`(LM Studio、llama.cpp server など OpenAI互換API) |
| `GMEMO_LOCAL_LLM_MODEL`    | `qwen2.5:7b`          | 「ノートに質問」と機密検出(固有名詞)に使うモデル                         |
| `GMEMO_LOCAL_LLM_API_KEY`  |                       | OpenAI互換サーバーがキーを要求する場合                                   |
| `GMEMO_LOCAL_EMBED_MODEL`  | `nomic-embed-text`    | ベクトル検索用。未設定なら内蔵の簡易ベクトル                             |

## 外部LLM

| 変数                          | 例                  | 説明                                               |
| ----------------------------- | ------------------- | -------------------------------------------------- |
| `GMEMO_EXTERNAL_LLM_PROVIDER` | `anthropic`         | `anthropic` または `openai`。未設定なら外部LLMなし |
| `GMEMO_EXTERNAL_LLM_API_KEY`  |                     | APIキー                                            |
| `GMEMO_EXTERNAL_LLM_MODEL`    | `claude-sonnet-5-5` | モデル名                                           |
| `GMEMO_EXTERNAL_LLM_URL`      |                     | エンドポイントを変える場合                         |

外部LLMを設定しても、設定画面で「外部AIを有効にする」を確認するまでは使われません。また、送れるのはAIポリシーで「外部AI可」になっているフォルダのノートだけです。

## AIポリシー(`.gmemo/policy.yaml`)

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
