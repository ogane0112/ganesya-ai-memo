# Ganesya AI Memo

**自分のノートのGitHub。** 人間1人と複数のAIエージェントが同じMarkdownノートを共同編集し、AIの変更はプルリクエストのように「提案」として届き、承認するとmainに入るセルフホスト型ノートアプリです。

- **ただのMarkdownファイル**:ノートはGitリポジトリ内の Markdown + YAMLフロントマター。そのままObsidianで開けて、`[[リンク]]` とバックリンクが使えます
- **AIが一級の編集者**:MCP(OAuth)とREST APIでAIエージェントが接続。書き込みは原則「提案」になり、誰が書いたかは常にGitのauthorとフロントマターで区別されます
- **競合はGitのマージモデルで**:フロントマターはキー単位、本文は段落単位で三方向マージ。AIでもオフラインの自分の別端末でも同じ仕組みで処理します
- **機密情報を外に出さない**:フォルダ単位の「外部AI可 / ローカルLLMのみ / AI不可」と、ローカルでの機密情報検出・マスキング
- **スマホファースト**:PWA。起動直後に書ける、オフラインでも書ける、提案はスワイプで承認
- **パスキーのみの認証**:パスワードもメールアドレスも持ちません

> 機密情報の検出は補助であり完全ではありません。基本はフォルダ単位の送信制御で守ってください。詳しくは [利用上の注意](docs/usage-notes.md)。

## クイックスタート(Docker)

パスキーはHTTPSとドメイン名が必須です(IPアドレス直打ちでは動きません)。

```sh
git clone https://github.com/ogane0112/ganesya-ai-memo && cd ganesya-ai-memo
cp .env.example .env          # GMEMO_DOMAIN=notes.example.com を設定
docker compose up -d
docker compose logs app       # 表示されたセットアップURLを開いて最初のパスキーを登録
```

詳細は [セットアップ](docs/setup.md) を参照してください。

## ローカル開発

```sh
npm install
GMEMO_ORIGIN=http://localhost:5173 npm run dev   # API サーバー (:8787)。パスキーはブラウザで開くURLに合わせる
npm run dev -w @gmemo/web                        # Web (Vite :5173、/api などをプロキシ)
npm test && npm run typecheck && npm run lint
```

`localhost` はHTTPSなしでもパスキーが使えるので、開発はそのまま行えます。

## AIエージェントをつなぐ

MCPに対応したクライアント(Claude など)に、サーバーURL `https://<あなたのドメイン>/mcp` を追加するだけです。OAuthの認可画面が開くので、エージェント名・読めるフォルダ・書き込み方法(提案のみ / 直接書き込み可)を選んで許可します。詳しくは [AIエージェント連携](docs/ai-agents.md)。

## ドキュメント

|                                         |                                                     |
| --------------------------------------- | --------------------------------------------------- |
| [セットアップ](docs/setup.md)           | Docker、HTTPS、パスキーの制約、バックアップ         |
| [設定](docs/configuration.md)           | 環境変数一覧、LLMの設定                             |
| [AIエージェント連携](docs/ai-agents.md) | MCP、OAuth、トークン、提案と承認、iOSショートカット |
| [利用上の注意](docs/usage-notes.md)     | 機密検出の限界、外部AIへの送信、データの扱い        |
| [セキュリティ](docs/security.md)        | 脅威モデル、E2EEを採用しない理由、保存データ        |
| [アーキテクチャ](docs/architecture.md)  | データ設計、マージモデル、インデックス              |
| [REST API](docs/api.md)                 | エンドポイント一覧                                  |
| [プラグイン](docs/plugins.md)           | 拡張API                                             |
| [設計判断](docs/decisions.md)           | 要件定義の未決事項をどう決めたか                    |

## 構成

```
packages/core     ブラウザとサーバーで共有する純粋ロジック(フロントマター、リンク、段落マージ、機密検出、ビュー)
packages/server   API・MCP・OAuth・パスキー・Gitストレージ・SQLiteインデックス・CLI
packages/web      スマホファーストのPWA
examples/plugins  プラグインの例
```

## ライセンス

MIT
