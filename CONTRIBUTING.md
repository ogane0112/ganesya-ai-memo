# Contributing

```sh
npm install
npm test          # vitest (core, server, web)
npm run typecheck
npm run lint
npm run format    # prettier
npm run security:check  # 脆弱性・依存・脅威の台帳と実際の状態の突き合わせ
```

- Node.js 22+ と git が必要です。
- `packages/core` はブラウザでも動く純粋ロジックだけにしてください(Node API・DOMに依存しない)。
- データ形式(フロントマターのキー、`.views/*.yaml`、`.gmemo/policy.yaml`、コミットのトレーラー)を変えるときは互換性に注意し、`docs/` を更新してください。
- DBのスキーマ変更は `packages/server/src/db/db.ts` のマイグレーション配列に追記します(既存の要素は変更しない)。
- セキュリティに関わる規約、依存の追加、脆弱性の扱いは [ソースコードのセキュリティ方針](docs/secure-development.md) に従ってください。依存を追加・削除したら `security/dependencies.yaml` も更新します。
