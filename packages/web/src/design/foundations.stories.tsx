import { useEffect, useState } from 'react';
import { Icon, ICON_NAMES } from '../components/Icon';
import { ACCENTS } from '../lib/theme';
import { defineStories, story } from './story';

const TOKEN_GROUPS: { title: string; tokens: [string, string][] }[] = [
  {
    title: '背景',
    tokens: [
      ['--bg', 'ページの背景'],
      ['--bg-soft', 'サイドバー・控えめな面'],
      ['--bg-elev', 'カード・浮いた面'],
      ['--bg-hover', 'ホバー'],
      ['--bg-active', '選択中'],
      ['--bg-input', '入力欄'],
    ],
  },
  {
    title: '文字と線',
    tokens: [
      ['--fg-strong', '見出し'],
      ['--fg', '本文'],
      ['--muted', '補足'],
      ['--faint', 'さらに控えめ'],
      ['--border', '区切り線'],
      ['--border-strong', '強めの線'],
    ],
  },
  {
    title: 'アクセント(設定で変更可)',
    tokens: [
      ['--accent', '主要なボタン・選択'],
      ['--accent-hover', 'ホバー'],
      ['--accent-soft', '薄い背景'],
      ['--accent-text', '文字として使うとき'],
      ['--accent-fg', 'アクセントの上の文字'],
    ],
  },
  {
    title: '意味のある色',
    tokens: [
      ['--ai', 'AIが書いたもの'],
      ['--ai-soft', 'AIの薄い背景'],
      ['--ok', '成功'],
      ['--ok-soft', '成功の背景'],
      ['--warn', '注意'],
      ['--warn-soft', '注意の背景'],
      ['--danger', '危険・削除'],
      ['--danger-soft', '危険の背景'],
      ['--ins', '差分: 追加'],
      ['--del', '差分: 削除'],
    ],
  },
];

/** Reads a CSS custom property from the live document (follows theme switches). */
function useToken(name: string): string {
  const [v, setV] = useState('');
  useEffect(() => {
    setV(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
  }, [name]);
  return v;
}

function Swatch({ name, note }: { name: string; note: string }) {
  const value = useToken(name);
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '6px 0' }}>
      <span
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          background: `var(${name})`,
          boxShadow: 'var(--shadow-ring)',
          flex: 'none',
        }}
      />
      <span style={{ minWidth: 0 }}>
        <code className="mono" style={{ fontSize: 13 }}>
          {name}
        </code>
        <span className="hint" style={{ display: 'block' }}>
          {note} ・ <span className="mono">{value}</span>
        </span>
      </span>
    </div>
  );
}

export default defineStories({
  id: 'foundations',
  title: 'デザインの基礎',
  group: 'ファウンデーション',
  description:
    '色・文字・形はすべて src/styles/app.css の CSS 変数(トークン)で決まります。ライト/ダークとアクセント色の切り替えも、この変数を差し替えるだけです。',
  source: 'src/styles/app.css',
  stories: [
    story({
      name: '色',
      description: '上のツールバーでアクセント色やダークモードを切り替えると、値も変わります。',
      render: () => (
        <div
          style={{
            display: 'grid',
            gap: 24,
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          }}
        >
          {TOKEN_GROUPS.map((g) => (
            <section key={g.title}>
              <h3 style={{ margin: '0 0 8px' }}>{g.title}</h3>
              {g.tokens.map(([n, note]) => (
                <Swatch key={n} name={n} note={note} />
              ))}
            </section>
          ))}
        </div>
      ),
    }),
    story({
      name: 'アクセント色',
      description: '設定 → 見た目 で選べる6色。',
      render: () => (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {ACCENTS.map((a) => (
            <div key={a.id} style={{ textAlign: 'center' }}>
              <span
                style={{
                  display: 'block',
                  width: 64,
                  height: 64,
                  borderRadius: 20,
                  background: a.color,
                  marginBottom: 6,
                }}
              />
              <strong>{a.label}</strong>
              <span className="hint mono" style={{ display: 'block' }}>
                {a.id}
              </span>
            </div>
          ))}
        </div>
      ),
    }),
    story({
      name: '文字',
      description:
        '欧文は Nunito、和文は Zen Maru Gothic(本文500・太字700)、コードは JetBrains Mono。',
      controls: {
        sample: { type: 'text', label: 'サンプル文', default: 'AIと一緒に書く、自分のノート。' },
      },
      render: ({ sample }) => (
        <div className="md" style={{ maxWidth: 680 }}>
          <h1>{sample}</h1>
          <h2>{sample}</h2>
          <h3>{sample}</h3>
          <p>
            {sample} 本文はゆったりした行間で、長く読んでも疲れにくくしています。Latin text uses
            Nunito.
          </p>
          <p className="hint">補足のテキスト(.hint)</p>
          <p>
            インラインの <code>code</code> と <strong>太字</strong>、<a href="#">リンク</a>
          </p>
          <pre>
            <code>{'const note = await api.note(path);'}</code>
          </pre>
        </div>
      ),
    }),
    story({
      name: '形と影',
      render: () => (
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          {[
            ['--radius-xs', '8px'],
            ['--radius-sm', '12px'],
            ['--radius', '18px'],
            ['--radius-pill', '999px'],
          ].map(([n, v]) => (
            <div key={n} style={{ textAlign: 'center' }}>
              <span
                style={{
                  display: 'block',
                  width: 96,
                  height: 64,
                  background: 'var(--bg-elev)',
                  borderRadius: `var(${n})`,
                  boxShadow: 'var(--shadow)',
                  marginBottom: 8,
                }}
              />
              <code className="mono">{n}</code>
              <span className="hint" style={{ display: 'block' }}>
                {v}
              </span>
            </div>
          ))}
          {['--shadow-ring', '--shadow', '--shadow-pop'].map((n) => (
            <div key={n} style={{ textAlign: 'center' }}>
              <span
                style={{
                  display: 'block',
                  width: 96,
                  height: 64,
                  background: 'var(--bg-elev)',
                  borderRadius: 'var(--radius-sm)',
                  boxShadow: `var(${n})`,
                  marginBottom: 8,
                }}
              />
              <code className="mono">{n}</code>
            </div>
          ))}
        </div>
      ),
    }),
    story({
      name: 'アイコン',
      description: '24×24 の線アイコン。<Icon name="..." /> で使います。',
      controls: { size: { type: 'number', label: '大きさ', default: 24, min: 12, max: 48 } },
      render: ({ size }) => (
        <div
          style={{
            display: 'grid',
            gap: 12,
            gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
          }}
        >
          {ICON_NAMES.map((n) => (
            <div
              key={n}
              style={{
                display: 'grid',
                justifyItems: 'center',
                gap: 6,
                padding: 12,
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-soft)',
              }}
            >
              <Icon name={n} size={size} />
              <span className="mono hint" style={{ fontSize: 12 }}>
                {n}
              </span>
            </div>
          ))}
        </div>
      ),
    }),
  ],
});
