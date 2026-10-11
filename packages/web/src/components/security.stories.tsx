import { sampleSecurityEvents } from '../design/fixtures';
import { defineStories, story } from '../design/story';
import { SecurityEventItem } from '../pages/settings/SecurityLog';
import { EnvBanner } from './EnvBanner';

export default [
  defineStories({
    id: 'env-banner',
    title: '環境の帯',
    group: 'コンポーネント',
    description:
      '本番以外(STG・DEV)では、すべての画面の上にこの帯が出ます。本番と取り違えて操作しないためのものです。',
    source: 'src/components/EnvBanner.tsx',
    stories: [
      story({
        name: '環境ごと',
        layout: 'fullscreen',
        controls: {
          env: {
            type: 'select',
            label: '環境',
            default: 'staging',
            options: ['staging', 'development', 'production'],
          },
        },
        render: ({ env }) => (
          <div>
            <EnvBanner env={env as 'staging'} />
            <p style={{ padding: 24 }} className="hint">
              (production では何も表示しません)
            </p>
          </div>
        ),
      }),
    ],
  }),
  defineStories({
    id: 'security-log',
    title: 'セキュリティログ',
    group: 'コンポーネント',
    description:
      '設定 → セキュリティログ の1行。失敗は赤、拒否は黄色の線で目立たせます。接続元は照合用の値だけを表示します。',
    source: 'src/pages/settings/SecurityLog.tsx (SecurityEventItem)',
    stories: [
      story({
        name: '一覧',
        controls: {
          showUser: { type: 'boolean', label: 'アカウントを表示(管理者)', default: false },
        },
        render: ({ showUser }) => (
          <section className="card" style={{ maxWidth: 760 }}>
            <ul className="item-list">
              {sampleSecurityEvents.map((e) => (
                <SecurityEventItem key={e.id} e={e} showUser={showUser} />
              ))}
            </ul>
          </section>
        ),
      }),
    ],
  }),
];
