# @gmemo/web

Mobile-first PWA for Ganesya AI Memo (React 18 + TypeScript + Vite 7). Japanese UI.
The server (`packages/server`) serves the built `dist/` with an SPA fallback.

## Development

```sh
# terminal 1: the API server on :8787
npm run dev -w @gmemo/server
# terminal 2: Vite on :5173, proxying /api, /oauth/*, /mcp and /.well-known to :8787
npm run dev -w @gmemo/web
```

Set `GMEMO_DEV_BACKEND` to proxy to another backend. Passkeys require the page
origin to match `GMEMO_ORIGIN` on the server, so for passkey flows either open the
app through the server (`npm run build -w @gmemo/web`, then http://localhost:8787)
or start the server with `GMEMO_ORIGIN=http://localhost:5173`.

## Scripts

| command                           | what it does                                                              |
| --------------------------------- | ------------------------------------------------------------------------- |
| `npm run build -w @gmemo/web`     | type-check, then build to `dist/` (app shell + service worker + manifest) |
| `npm run typecheck -w @gmemo/web` | `tsc --noEmit`                                                            |
| `npm run test -w @gmemo/web`      | Vitest unit tests (`test/`)                                               |
| `npm run icons -w @gmemo/web`     | regenerate the PNG icons in `public/icons` (Node built-ins only)          |

`@gmemo/core` is consumed from source through a Vite/TS alias (`../core/src/index.ts`), so it needs no build step.

## Structure

```
src/
  main.tsx, App.tsx        entry, routes, auth gate, service-worker update prompt
  api/                     typed fetch client (ApiError carries status + body) and response types
  state/                   app context (auth, note list, live updates via /api/events, queue) and toasts
  lib/
    queue.ts               offline write queue — pure reducer (coalescing, chaining of base shas)
    queueStore.ts, sync.ts IndexedDB persistence and the sender (retries, 401 pause, results)
    markdown.ts            marked + DOMPurify, [[wiki links]], ![[embeds]], per-paragraph blame rendering
    conflicts.ts           proposal conflict-resolution state → merge request body
    forceGraph.ts          tiny force-directed layout for the graph view
    viewYaml.ts            form ⇄ YAML for database views
  components/              Layout (sidebar / bottom tabs), CodeMirror editor + toolbar, swipe card, …
  pages/                   書く (start screen), notes, note view/editor, search + ノートに質問, review,
                           proposal detail, views, graph, history, settings/*, login, setup,
                           recovery passkey registration, OAuth consent, share-target capture
  styles/app.css           plain CSS with variables, light/dark
```

## Behaviour notes

- **Offline writing**: every save goes through the IndexedDB queue with the `baseSha` the edit
  started from and the device name; the server merges paragraph by paragraph. If it cannot,
  the save becomes a proposal and the app shows 「競合を確認」.
- **PWA**: `start_url` opens the quick-write screen. The app shell is precached; `GET /api/note`
  and `/api/notes` use NetworkFirst so recently opened notes can be read offline. The share
  target (`/capture`) accepts `title`, `text` and `url`.
- **CSP**: the server sends `script-src 'self'`; nothing is inlined and no CDN is used.
