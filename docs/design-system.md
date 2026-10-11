# デザインシステム(部品カタログ)

画面の部品を一覧で確認できる、Storybook のような簡易カタログを `packages/web` に用意しています。スクリーンショットを撮らなくても、ブラウザで部品ごとの見た目と動きを確認できます。

```sh
npm run design -w @gmemo/web          # http://localhost:6006 で開く(編集すると即反映)
npm run build:design -w @gmemo/web    # packages/web/dist-design/ に静的ファイルを書き出す
```

## できること

- 左のサイドバーから部品(ストーリー)を選ぶ。検索もできる
- 上のツールバーで切り替える
  - 画面の幅:自動 / スマホ(390px)/ タブレット(768px)/ PC(1280px)
  - ライト / ダーク
  - アクセント色(設定画面で選べる6色)
- 下のパネルで、部品の説明を読み、値(文字、種類、オン/オフなど)を変えて試す
- 「単体で開く」で、その部品だけのページを開く

プレビューは iframe の中で本物の `app.css` を使って描画するので、スマホ幅のレイアウトも実際のアプリと同じになります。

## ストーリーの書き方

部品の隣に `*.stories.tsx` を置き、`defineStories` を default export します(1つのファイルで配列にして複数登録することもできます)。カタログとテストが自動で拾います。

```tsx
// src/components/Badge.stories.tsx
import { defineStories, story } from '../design/story';
import { Badge } from './ui';

export default defineStories({
  id: 'badge', // URLに使う英数字のID
  title: 'バッジ',
  group: 'コンポーネント', // ファウンデーション | コンポーネント | パターン
  description: 'AIが関わるものは ai の色で示します。',
  source: 'src/components/ui.tsx (Badge)',
  stories: [
    story({
      name: '基本',
      controls: {
        text: { type: 'text', label: '文字', default: 'Claude' },
        tone: { type: 'select', label: '色', default: 'ai', options: ['neutral', 'ai', 'ok'] },
      },
      render: ({ text, tone }) => <Badge tone={tone as 'ai'}>{text}</Badge>,
    }),
  ],
});
```

- コントロールの種類:`text` / `boolean` / `number` / `select`。`render` の引数の型は自動で付きます
- `layout`:`padded`(既定、周りに余白)/ `centered` / `fullscreen`
- サンプルデータは `src/design/fixtures.ts` にまとめています
- API を呼ぶ部品(ページ全体など)はストーリーにせず、表示用の部品に分けてから載せてください

## テスト

`packages/web/test/stories.test.tsx` が、すべてのストーリーを既定の値で描画できることを確かめます(`npm test`)。ストーリーを追加すると自動でテストも増えます。

## 構成

| 場所                                 | 役割                                                     |
| ------------------------------------ | -------------------------------------------------------- |
| `src/design/story.ts`                | ストーリーの型と `defineStories` / `story`               |
| `src/design/registry.ts`             | `src/**/*.stories.tsx` を集める                          |
| `src/design/foundations.stories.tsx` | 色・文字・形・アイコン(デザイントークン)                 |
| `src/components/*.stories.tsx`       | 部品と画面パターンのストーリー                           |
| `design/`                            | カタログの画面(`index.html`)とプレビュー(`preview.html`) |
| `vite.design.config.ts`              | カタログ用の Vite 設定                                   |
