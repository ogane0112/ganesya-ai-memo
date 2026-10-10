# アーキテクチャ

## 全体

```
                 ┌──────────── HTTP(Hono)────────────┐
ブラウザ(PWA) ──▶│ /api  /mcp  /oauth  /cal  静的ファイル │
AIエージェント ──▶│                                        │
                 └──┬─────────────────────────────┬───┘
                    │ Platform(全体で1つ)          │ Workspace(ユーザーごと、リクエスト単位で開く)
                    │  AuthService(パスキー、招待) │  NoteService(保存・提案・マージ・履歴)
                    │  TokenService / OAuthService   │  Indexer(全文検索・ベクトル・リンク)
                    │                                │  AgentStore / AiGateway / AgentLens / Calendar
                    ▼                                ▼
                 Db(D1 または SQLite)            NoteStore(DbGitStore または GitHubStore)
```

同じコードが2つの実行環境で動きます。

| 実行環境           | 入口                            | データベース                | Webアプリ              |
| ------------------ | ------------------------------- | --------------------------- | ---------------------- |
| Cloudflare Workers | `packages/server/src/worker.ts` | D1(`D1Db`)                  | Workers の静的アセット |
| Node.js / Docker   | `packages/server/src/cli.ts`    | SQLite ファイル(`SqliteDb`) | `node.ts` が配信       |

サーバーのコードは Web 標準(`fetch`、WebCrypto、Compression Streams)だけで書いてあり、Node 固有のAPIは `node.ts` / `cli.ts` / `db/sqlite.ts` に閉じ込めています。プロセス内の状態(ロックやイベント)には頼りません。Workers では同じユーザーのリクエストが別々のインスタンスで処理されることがあるためです。

## データ設計

すべての表に `user_id` があり、ユーザーごとに完全に分かれています。

| 層                     | 置き場所                                                                                | 役割                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| ノートと履歴           | `git_objects` / `git_commits` / `git_refs`、または GitHub リポジトリ                    | 正のデータ。Markdown + YAMLフロントマター、コミット、提案ブランチ         |
| ビュー定義・AIポリシー | ノート内の `.views/*.yaml`、`.gmemo/policy.yaml`                                        | ファイルとして保存し、履歴も残る                                          |
| インデックス           | `notes` / `notes_fts` / `tags` / `links` / `chunks` / `index_state`                     | 全文検索(FTS5 trigram)、埋め込みベクトル、リンクグラフ、プロパティ        |
| アカウント             | `users` / `credentials` / `recovery_codes` / `sessions` / `invites`                     | パスキー公開鍵、各種ハッシュ                                              |
| エージェント           | `agents` / `tokens` / `oauth_*`                                                         | エージェントの権限、トークンのハッシュ、OAuthクライアントとユーザーの対応 |
| その他                 | `proposals` / `editing` / `audit` / `secret_placeholders` / `calendar_*` / `workspaces` | 提案のメタデータ、編集中の表示、監査ログ、保存先の設定                    |

インデックスは最後にインデックスしたコミット(`index_state`)を記録し、差分だけを更新します。壊れても **設定 → データ → 検索インデックスを再構築** で作り直せます。

スキーマは `schema_migrations` で管理するマイグレーションで、最初のリクエスト(Node.js では起動時)に自動適用されます。D1 は対話的なトランザクションを持たないため、まとめて書く処理はすべて `batch()`(原子的に実行される文の列)にしています。インデックスの大量書き込みは、行を JSON で1つのパラメータに入れて `json_each` で展開し、D1 の「1リクエストあたりのクエリ数」の制限に収まるようにしています。

## ノートの保存(NoteStore)

`NoteStore` は「Gitの意味で」ノートを保存するインターフェースです(コミット、ブランチ、マージコミット、ファイルの読み出し、差分、履歴)。実装は2つあり、同じ契約テストを両方に対して実行しています。

- **DbGitStore(このサービス内)**:Gitと同じ形式のオブジェクト(blob / tree / commit、SHA-1も同じ)をデータベースに保存します。コミットには「最初の親から変わったパス」を記録しておき、ファイルごとの履歴を安く引けるようにしています。
- **GitHubStore(自分のGitHub)**:GitHub の Git Data API(blobs / trees / commits / refs)で本物のコミットを作ります。全ファイルの読み込みはtarballを1回ダウンロードするだけで済ませます。空のリポジトリへの最初のコミットだけは Contents API を使います。提案ブランチは `gmemo/` の下に作ります。

### 同時書き込み(ロックを使わない)

書き込みは「読んだときの main の先頭」を親として新しいコミットを作り、ブランチの更新を **compare-and-swap** で行います(DbGitStore は `UPDATE ... WHERE sha = <読んだ値>`、GitHub は fast-forward のみの ref 更新)。その間に main が動いていたら `ConcurrentUpdateError` になり、`NoteService` が新しい先頭の上で計算し直して再試行します。複数の端末・エージェント・Workersのインスタンスから同時に書いても、変更が消えることはありません。

### 作成者

- 作成者は Git の author で区別します:人間は `human@gmemo.local`、エージェントは `<agentId>@agents.gmemo.local`。
- コミットメッセージのトレーラー(`Gmemo-Author-Kind`、`Gmemo-Agent`、`Gmemo-Proposal`)にも記録します。
- 提案は `proposals/<id>` ブランチ。承認はマージコミット(親:main、提案ブランチ)で、authorはエージェントです。

## マージモデル

すべての競合を三方向マージで扱います。書き込み元は3種類、判定は1つです。

```
 AIエージェント ─┐
 オフラインの端末 ─┼─▶ base(読んだ時点)と main の差分を三方向マージ ─┬─ 自動マージ → main
 人間(別タブ等) ─┘                                                  └─ 競合 → 提案(承認画面)
```

- **フロントマター**:キー単位。片方だけが変えたキーはそのまま採用。タグのようなスカラー配列は集合としてマージ(両方の追加を残し、どちらかの削除を反映)。両方が別の値にした場合だけ競合。
- **本文**:段落(ブロック)単位。見出し、段落、リストの各項目、コードブロック、引用、表をそれぞれ1ブロックとし、ブロック列に対してLCSベースのdiff3を行う。**隣り合う段落**への同時編集は競合にしない。

保存時は、クライアントが編集を始めた時点のblob(`baseSha`)を送ります。サーバーはmainの現在のblobと比べ、違っていれば三方向マージします。

## 段落単位の作成者表示(blame)

ファイルの `main` 上の履歴(first-parent)を古い順にたどり、各バージョンのブロック列を前のバージョンとdiffします。変わらなかったブロックは前の作成者を引き継ぎ、新しく現れた・変わったブロックはそのコミットのauthorになります。GitHub 保存では、API の呼び出し回数を抑えるため直近25版までをたどります。

## 変更の通知

Web アプリは15秒ごと(画面が表示されているときだけ)に `/api/poll` を呼び、main の先頭と未処理の提案数を確認します。先頭が変わっていれば、変わったファイルの一覧を受け取って開いているノートを読み直します。サーバーレス環境では接続を張り続けるSSEが向かないため、この方式にしています。

GitHub 保存のユーザーは、アプリ外での push を `GMEMO_GITHUB_CHECK_SECONDS`(既定30秒)ごとに確認し、変わっていればインデックスを更新します。

## 検索

- 全文検索:SQLite FTS5(trigramトークナイザ)。2文字以下の語、またはFTS5が使えない環境では LIKE にフォールバック。
- ベクトル検索:ノートを段落単位で約900文字のチャンクにまとめて埋め込み。ローカル埋め込みモデル(Ollama等)か、内蔵の文字n-gramハッシュベクトル。
- ハイブリッド:Reciprocal Rank Fusion。
- 「ノートに質問」:ハイブリッド検索で関連チャンクを集め、AIゲートウェイ経由でLLMに渡す。

## パッケージ

- `packages/core`:DOMにもNodeにも依存しない純粋ロジック。サーバーとWebの両方で使う。
- `packages/server`:Hono(HTTP)、@simplewebauthn/server、MCP TypeScript SDK。Node.js では better-sqlite3。
- `packages/web`:React + Vite + CodeMirror 6 のPWA。
