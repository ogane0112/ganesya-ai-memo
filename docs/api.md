# REST API

すべて JSON。人間はパスキーでログインしたクッキーセッション、エージェントは `Authorization: Bearer <token>` で呼びます。エージェントから呼んだ場合、結果はそのエージェントのフォルダ制限・AIポリシー・マスキングが適用されたものになります。

エラーは `{ "error": "..." }` と次のステータスで返ります:400(入力不正)、401(未認証)、403(権限なし)、404、409(競合。`details` に未解決の箇所)、413(大きすぎる)、422(機密情報によりブロック、`findings` 付き)、428(機密情報の送信確認が必要、`findings` 付き)、503(AI未設定)。

## 認証(人間)

| メソッド             | パス                                                 | 内容                                                                              |
| -------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| GET                  | `/api/auth/state`                                    | セットアップ要否、ログイン状態                                                    |
| POST                 | `/api/auth/register/options`                         | パスキー登録開始 `{ setupToken?, username? }`                                     |
| POST                 | `/api/auth/register/verify`                          | 登録完了 `{ challengeId, response, name?, setupToken? }` → 初回は `recoveryCodes` |
| POST                 | `/api/auth/login/options` / `/api/auth/login/verify` | パスキーでログイン                                                                |
| POST                 | `/api/auth/recovery`                                 | リカバリーコードでログイン `{ code }`                                             |
| POST                 | `/api/auth/logout` / `/api/auth/logout-all`          | ログアウト                                                                        |
| GET / PATCH / DELETE | `/api/auth/passkeys[/:id]`                           | パスキーの一覧・名前変更・削除                                                    |
| POST                 | `/api/auth/recovery-codes`                           | リカバリーコードの再発行                                                          |

## ノート

| メソッド | パス                                       | 人間 | エージェント      | 内容                                                                              |
| -------- | ------------------------------------------ | ---- | ----------------- | --------------------------------------------------------------------------------- |
| GET      | `/api/notes?folder=`                       | ✓    | read              | 一覧                                                                              |
| GET      | `/api/note?path=&commit=`                  | ✓    | read              | 本文、`sha`、`commit`、フロントマター                                             |
| PUT      | `/api/note`                                | ✓    | propose           | 保存 `{ path, content, baseSha?, baseCommit?, device?, message? }` → `SaveResult` |
| DELETE   | `/api/note?path=`                          | ✓    | propose           | 削除(エージェントは提案)                                                          |
| POST     | `/api/changes`                             |      | propose           | 複数ファイルの変更 `{ title, description?, changes, baseShas?, mode? }`           |
| POST     | `/api/note/rename`                         | ✓    |                   | 名前変更とリンクの書き換え `{ from, to }`                                         |
| POST     | `/api/note/editing`                        | ✓    |                   | 編集中の通知 `{ path, active }`                                                   |
| GET      | `/api/note/backlinks?path=`                | ✓    | read              | バックリンクと発リンク                                                            |
| GET      | `/api/note/history?path=`                  | ✓    | read              | 履歴                                                                              |
| GET      | `/api/note/blame?path=`                    | ✓    | read              | 段落ごとの作成者                                                                  |
| GET      | `/api/file?path=`                          | ✓    | read              | 添付ファイル                                                                      |
| POST     | `/api/attachments`                         | ✓    |                   | 添付のアップロード(multipart `file`)                                              |
| POST     | `/api/capture`                             | ✓    | capture / propose | クイックメモ `{ text, title?, folder?, url? }`                                    |
| GET      | `/api/search?q=&mode=hybrid\|text\|vector` | ✓    | read              | 検索                                                                              |
| GET      | `/api/tags` / `/api/graph`                 | ✓    | read              | タグ、リンクグラフ                                                                |
| GET      | `/api/history?agentId=`                    | ✓    |                   | 全体の履歴                                                                        |
| POST     | `/api/revert` / `/api/revert-agent`        | ✓    |                   | コミット / エージェントの変更を取り消す                                           |
| POST     | `/api/sync`                                | ✓    |                   | アプリ外の編集を今すぐ取り込む                                                    |
| GET      | `/api/events`                              | ✓    |                   | Server-Sent Events(`change`, `proposal`)                                          |

`SaveResult` は `{ status: 'committed', commit, sha, merged }`、`{ status: 'unchanged' }`、`{ status: 'proposed', proposalId, reason, merged? }` のいずれかです。

## 提案

| メソッド | パス                                           | 内容                                                                          |
| -------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| GET      | `/api/proposals?status=open\|merged\|rejected` | 一覧(エージェントは自分のものだけ)                                            |
| GET      | `/api/proposals/:id`                           | 詳細。ファイルごとの段落差分と、mainとのマージ結果                            |
| POST     | `/api/proposals/:id/merge`                     | 承認 `{ resolutions: { [path]: { blocks?, frontmatter?, reject?, file? } } }` |
| POST     | `/api/proposals/:id/reject`                    | 却下                                                                          |

競合の解決は、ブロック競合の番号ごとに `'ours'`(いまのmain)/ `'theirs'`(提案)/ `'both'` / `{ custom: "..." }`、フロントマターのキーごとに `'ours'` / `'theirs'` を指定します。

## ビュー

| メソッド     | パス                  | 内容                               |
| ------------ | --------------------- | ---------------------------------- |
| GET          | `/api/views`          | 定義の一覧                         |
| GET          | `/api/views/:id/rows` | 実行結果(カンバンは `groups` 付き) |
| PUT / DELETE | `/api/views/:id`      | 保存 `{ source: "<YAML>" }` / 削除 |

```yaml
# .views/tasks.yaml
name: タスク
type: kanban # table | kanban | calendar | list
folder: Projects
tag: task
filters:
  - { property: status, op: neq, value: archived } # eq neq contains not_contains exists not_exists gt gte lt lte
sort:
  - { property: due, direction: asc }
columns: [$title, status, due]
groupBy: status
groups: [todo, doing, done]
dateProperty: due # calendar
```

## AI

| メソッド | パス                  | 内容                                                                         |
| -------- | --------------------- | ---------------------------------------------------------------------------- |
| GET      | `/api/ai/status`      | ローカル/外部LLMの設定状況                                                   |
| POST     | `/api/ask`            | ノートに質問 `{ question, prefer: auto\|local\|external, confirm?, paths? }` |
| POST     | `/api/sensitive/scan` | ローカルで機密検出 `{ text, useModel? }`                                     |
| GET      | `/api/ai/audit`       | 外部送信の監査ログ                                                           |

## カレンダー

| メソッド       | パス                                                 | 内容                                                                                     |
| -------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| GET            | `/api/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD` | 取り込んだ外部カレンダーの予定(繰り返しを展開済み)                                       |
| GET / POST     | `/api/admin/calendar/subscriptions`                  | 取り込むカレンダーの一覧・追加 `{ url, name?, color? }`                                  |
| PATCH / DELETE | `/api/admin/calendar/subscriptions/:id`              | 変更 `{ name?, url?, color?, enabled? }`・削除                                           |
| POST           | `/api/admin/calendar/subscriptions/:id/refresh`      | 今すぐ取得                                                                               |
| GET / POST     | `/api/admin/calendar/feeds`                          | 公開URLの一覧・作成 `{ viewId, label?, includeLinks? }` → `{ feed, url }`(URLは一度だけ) |
| DELETE         | `/api/admin/calendar/feeds/:id`                      | 公開URLを無効にする                                                                      |
| GET            | `/cal/<token>.ics`                                   | 公開フィード(認証なし、トークンで保護)                                                   |

## 管理(人間のみ)

| メソッド       | パス                           | 内容                                           |
| -------------- | ------------------------------ | ---------------------------------------------- |
| GET / POST     | `/api/admin/agents`            | エージェント一覧・作成                         |
| PATCH / DELETE | `/api/admin/agents/:id`        | 設定変更・失効                                 |
| POST           | `/api/admin/agents/:id/tokens` | トークン発行 `{ scope, label, expiresInDays }` |
| DELETE         | `/api/admin/tokens/:id`        | トークン失効                                   |
| GET / PUT      | `/api/admin/preferences`       | 見た目の設定 `{ accent, mode }`(全端末で共有)  |
| GET / PUT      | `/api/admin/policy`            | AIポリシー                                     |
| POST           | `/api/admin/policy/allow`      | 検出結果を「問題なし」にする `{ fingerprint }` |
| POST           | `/api/admin/backup`            | バックアップのダウンロード `{ passphrase? }`   |
| POST           | `/api/admin/reindex`           | インデックス再構築                             |
| GET            | `/api/admin/plugins`           | プラグインの状態                               |

## OAuth / MCP

| パス                                      | 内容                                               |
| ----------------------------------------- | -------------------------------------------------- |
| `/.well-known/oauth-authorization-server` | 認可サーバーメタデータ                             |
| `/.well-known/oauth-protected-resource`   | 保護リソースメタデータ                             |
| `/oauth/register`                         | 動的クライアント登録                               |
| `/oauth/authorize`                        | 認可(Web画面の同意ページへ)                        |
| `/oauth/token`                            | トークン(authorization_code + PKCE、refresh_token) |
| `/oauth/revoke`                           | 失効                                               |
| `/mcp`                                    | MCP(Streamable HTTP)                               |
