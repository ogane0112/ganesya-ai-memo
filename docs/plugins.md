# プラグイン

プラグインはサーバーに機能を足すJavaScriptモジュールです。`$GMEMO_DATA_DIR/plugins/<名前>/` に置いて再起動すると読み込まれます。

> プラグインはサーバープロセス内で完全な権限で動きます。中身を読んで信頼できるものだけを入れてください。

## 最小の例

```js
// plugins/hello/index.js
export default {
  name: 'hello',
  setup(api) {
    api.registerRoute({
      method: 'GET',
      path: '/ping',
      handler: () => Response.json({ pong: true }),
    });
  },
};
```

`package.json` があれば `main` を、なければ `index.js` を読み込みます。完全な例は [`examples/plugins/inbox-tools`](../examples/plugins/inbox-tools/index.js) にあります。

## API

| メソッド                                                           | 内容                                                                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `api.notes.read(path)`                                             | ノートを読む(`{ path, content, sha }` または `null`)                                                             |
| `api.notes.list(folder?)`                                          | ノート一覧                                                                                                       |
| `api.notes.search(query)`                                          | ハイブリッド検索                                                                                                 |
| `api.notes.propose(changes, title, description?)`                  | 変更を提案する。`plugin:<名前>` というAIエージェントとして記録され、そのエージェントの設定(自動マージなど)に従う |
| `api.on('change' \| 'proposal', handler)`                          | ノートの変更・提案の作成/マージ/却下を受け取る                                                                   |
| `api.registerRoute({ method, path, handler })`                     | `/api/plugins/<名前><path>` にHTTPエンドポイントを追加(ログイン中の人間のみ)                                     |
| `api.registerMcpTool({ name, description, inputSchema, handler })` | MCPツールを追加(`<プラグイン名>_<name>` として公開)。`inputSchema` は `api.z`(zod)で書く                         |
| `api.registerSensitiveRule({ id, category, label, pattern })`      | 機密検出ルールを追加                                                                                             |
| `api.log(...)`                                                     | ログ出力                                                                                                         |

読み込み状況は設定画面、または `GET /api/admin/plugins` で確認できます。
