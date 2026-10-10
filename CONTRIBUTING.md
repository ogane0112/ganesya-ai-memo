# Contributing

```sh
npm install
npm test          # vitest (core, server, web)
npm run typecheck
npm run lint
npm run format    # prettier
```

- Node.js 22+ と git が必要です。
- `packages/core` はブラウザでも動く純粋ロジックだけにしてください(Node API・DOMに依存しない)。
- データ形式(フロントマターのキー、`.views/*.yaml`、`.gmemo/policy.yaml`、コミットのトレーラー)を変えるときは互換性に注意し、`docs/` を更新してください。
- DBのスキーマ変更は `packages/server/src/db/db.ts` のマイグレーション配列に追記します(既存の要素は変更しない)。
