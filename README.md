# Ganesya AI Memo

**自分のノートのGitHub。** 人間と複数のAIエージェントが同じMarkdownノートを共同編集し、AIの変更はプルリクエストのように「提案」として届き、承認するとmainに入るノートアプリです。複数の人がそれぞれのアカウントで使えます。

- **ただのMarkdownファイル**:ノートは Markdown + YAMLフロントマター。`[[リンク]]` とバックリンクが使えます
- **履歴はGitの形式で**:ノートはユーザーごとに「このサービス内」か「自分のGitHubリポジトリ」に保存。どちらも本物のGitと同じコミット・ブランチ・マージで履歴を持ちます([保存先](docs/storage.md))
- **AIが一級の編集者**:MCP(OAuth)とREST APIでAIエージェントが接続。書き込みは原則「提案」になり、誰が書いたかは常に区別されます
- **競合はGitのマージモデルで**:フロントマターはキー単位、本文は段落単位で三方向マージ。AIでもオフラインの自分の別端末でも同じ仕組みで処理します
- **機密情報を外に出さない**:フォルダ単位の「外部AI可 / ローカルLLMのみ / AI不可」と、機密情報の検出・マスキング
- **スマホファースト**:PWA。起動直後に書ける、オフラインでも書ける、提案はスワイプで承認
- **パスキーのみの認証**:パスワードもメールアドレスも持ちません

> 機密情報の検出は補助であり完全ではありません。基本はフォルダ単位の送信制御で守ってください。詳しくは [利用上の注意](docs/usage-notes.md)。

## デプロイ(Cloudflare Workers + D1)

サーバー不要で、無料枠から動かせます。手順は [Cloudflare にデプロイする](docs/deploy-cloudflare.md)。

```sh
npm ci && npm run build -w @gmemo/core && npm run build -w @gmemo/web
cd packages/server
npx cf auth login
GMEMO_ORIGIN=https://gmemo.<サブドメイン>.workers.dev npx cf deploy   # D1 も自動で作られる
npx cf workers secrets update GMEMO_SETUP_TOKEN --worker gmemo --text '<長いランダム文字列>'
npx cf workers secrets update GMEMO_SECRET_KEY  --worker gmemo --text '<長いランダム文字列>'
```

Cloudflare の新しいCLI `cf`(ベータ)を使います。Wrangler でもデプロイできます(手順は同じページ)。

自分のサーバー(Node.js / Docker)で動かすこともできます:[セルフホスト](docs/setup.md)。

## ローカル開発

```sh
npm install
GMEMO_ORIGIN=http://localhost:5173 npm run dev   # API サーバー (Node, :8787)。パスキーはブラウザで開くURLに合わせる
npm run dev -w @gmemo/web                        # Web (Vite :5173、/api などをプロキシ)
npm test && npm run typecheck && npm run lint
```

Workers の実行環境で試すときは `cd packages/server && npx cf dev`([手順](docs/deploy-cloudflare.md#ローカルで試す))。

`localhost` はHTTPSなしでもパスキーが使えるので、開発はそのまま行えます。

## AIエージェントをつなぐ

MCPに対応したクライアント(Claude など)に、サーバーURL `https://<あなたのドメイン>/mcp` を追加するだけです。サインインしたアカウントのノートにだけつながります。OAuthの認可画面が開くので、エージェント名・読めるフォルダ・書き込み方法(提案のみ / 直接書き込み可)を選んで許可します。詳しくは [AIエージェント連携](docs/ai-agents.md)。

## ドキュメント

|                                                    |                                                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Cloudflare にデプロイ](docs/deploy-cloudflare.md) | Workers + D1、シークレット、料金と制限                                              |
| [保存先](docs/storage.md)                          | このサービス内 / 自分のGitHub、トークンの作り方                                     |
| [セルフホスト](docs/setup.md)                      | Node.js / Docker、HTTPS、パスキーの制約、管理者CLI                                  |
| [設定](docs/configuration.md)                      | 環境変数一覧、LLMの設定                                                             |
| [AIエージェント連携](docs/ai-agents.md)            | MCP、OAuth、トークン、提案と承認、iOSショートカット                                 |
| [利用上の注意](docs/usage-notes.md)                | 機密検出の限界、外部AIへの送信、データの扱い                                        |
| [セキュリティ](docs/security.md)                   | 脅威モデル、E2EEを採用しない理由、保存データ                                        |
| [運用方針](docs/operations.md)                     | ステージング/本番、リリース手順、監査ログ、漏洩時の対応                             |
| [セキュリティ開発方針](docs/secure-development.md) | 依存の更新、脆弱性(CVE)対応、台帳、コーディング規約                                 |
| [GitHub の設定手順](docs/github-setup.md)          | ブランチ保護、Dependabot、Secret scanning、CodeQL                                   |
| [アーキテクチャ](docs/architecture.md)             | データ設計、マージモデル、インデックス                                              |
| [デザインシステム](docs/design-system.md)          | 部品カタログ([公開版](https://ogane0112.github.io/ganesya-ai-memo/))                |
| [ノートの中の一覧](docs/inline-views.md)           | 表・カンバン・カレンダーをノートに埋め込む(Notion のインラインデータベースのように) |
| [画面の基本方針](docs/ui-baseline.md)              | GUIとテキストの両方で操作できるようにする方針と対応状況                             |
| [REST API](docs/api.md)                            | エンドポイント一覧                                                                  |
| [カレンダー連携](docs/calendar.md)                 | Googleカレンダーの取り込みと、ノートの予定の公開                                    |
| [設計判断](docs/decisions.md)                      | 要件定義の未決事項をどう決めたか                                                    |

## 構成

```
packages/core     ブラウザとサーバーで共有する純粋ロジック(フロントマター、リンク、段落マージ、機密検出、ビュー)
packages/server   API・MCP・OAuth・パスキー・ノートの保存(DB内のGitオブジェクト / GitHub API)・検索インデックス
                  Cloudflare Workers(src/worker.ts)と Node.js(src/cli.ts)の両方で動く
packages/web      スマホファーストのPWA
```

## ライセンス

MIT
