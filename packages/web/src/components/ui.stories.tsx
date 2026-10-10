import { useState } from 'react';
import { defineStories, story } from '../design/story';
import { Icon } from './Icon';
import {
  Badge,
  CopyButton,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHeader,
  SecretReveal,
  Segmented,
  Spinner,
} from './ui';

const BUTTON_KINDS = ['default', 'primary', 'danger', 'danger-text', 'text'] as const;

function SegmentedDemo() {
  const [v, setV] = useState<'builtin' | 'github'>('builtin');
  return (
    <Segmented
      label="保存先"
      value={v}
      onChange={setV}
      options={[
        { value: 'builtin', label: 'このサービス内' },
        { value: 'github', label: '自分のGitHub' },
      ]}
    />
  );
}

function ModalDemo({ wide }: { wide: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        モーダルを開く
      </button>
      <Modal
        open={open}
        wide={wide}
        onClose={() => setOpen(false)}
        title="新しいノート"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              キャンセル
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>
              作成
            </button>
          </>
        }
      >
        <Field label="タイトル" htmlFor="modal-title-input">
          <input id="modal-title-input" className="input" defaultValue="週次ミーティング" />
        </Field>
      </Modal>
    </>
  );
}

export default [
  defineStories({
    id: 'button',
    title: 'ボタン',
    group: 'コンポーネント',
    description:
      'class="btn" に種類(btn-primary など)と大きさ(btn-small / btn-large / btn-block)を足して使います。主要な操作は1画面に1つだけ btn-primary にします。',
    source: 'src/styles/app.css (.btn)',
    stories: [
      story({
        name: '操作できるボタン',
        controls: {
          label: { type: 'text', label: '文字', default: '保存' },
          kind: { type: 'select', label: '種類', default: 'primary', options: BUTTON_KINDS },
          size: {
            type: 'select',
            label: '大きさ',
            default: 'normal',
            options: ['small', 'normal', 'large'],
          },
          icon: { type: 'boolean', label: 'アイコン', default: true },
          block: { type: 'boolean', label: '幅いっぱい', default: false },
          disabled: { type: 'boolean', label: '無効', default: false },
        },
        render: ({ label, kind, size, icon, block, disabled }) => (
          <button
            type="button"
            disabled={disabled}
            className={[
              'btn',
              kind !== 'default' && `btn-${kind}`,
              size !== 'normal' && `btn-${size}`,
              block && 'btn-block',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {icon && <Icon name="check" size={size === 'small' ? 16 : 20} />}
            {label}
          </button>
        ),
      }),
      story({
        name: '種類の一覧',
        render: () => (
          <div className="stack">
            {(['small', 'normal', 'large'] as const).map((size) => (
              <div key={size} className="row wrap">
                {BUTTON_KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={[
                      'btn',
                      k !== 'default' && `btn-${k}`,
                      size !== 'normal' && `btn-${size}`,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {k}
                  </button>
                ))}
                <button type="button" className="icon-btn" aria-label="設定">
                  <Icon name="settings" />
                </button>
              </div>
            ))}
          </div>
        ),
      }),
      story({
        name: 'コピーボタン',
        render: () => <CopyButton text="https://example.com/signup?invite=abc" />,
      }),
    ],
  }),
  defineStories({
    id: 'badge',
    title: 'バッジとタグ',
    group: 'コンポーネント',
    description: 'AIが関わるものは必ず ai の色(紫)で示します。',
    source: 'src/components/ui.tsx (Badge)',
    stories: [
      story({
        name: 'バッジ',
        controls: {
          text: { type: 'text', label: '文字', default: 'Claude' },
          tone: {
            type: 'select',
            label: '色',
            default: 'ai',
            options: ['neutral', 'ai', 'ok', 'warn', 'danger', 'accent'],
          },
        },
        render: ({ text, tone }) => (
          <Badge tone={tone as 'ai'}>
            {tone === 'ai' && <Icon name="bot" size={12} />} {text}
          </Badge>
        ),
      }),
      story({
        name: '一覧',
        render: () => (
          <div className="row wrap">
            <Badge>neutral</Badge>
            <Badge tone="ai">ai</Badge>
            <Badge tone="ok">ok</Badge>
            <Badge tone="warn">warn</Badge>
            <Badge tone="danger">danger</Badge>
            <Badge tone="accent">accent</Badge>
            <span className="tags">
              <span className="tag">#企画</span>
              <span className="tag">#会議</span>
            </span>
          </div>
        ),
      }),
    ],
  }),
  defineStories({
    id: 'form',
    title: '入力',
    group: 'コンポーネント',
    description:
      'ラベルとヒントは Field でまとめます。入力欄は class="input"(select / textarea も同じ見た目)。',
    source: 'src/components/ui.tsx (Field, Segmented)',
    stories: [
      story({
        name: 'テキスト入力',
        controls: {
          label: { type: 'text', label: 'ラベル', default: 'ユーザー名' },
          hint: {
            type: 'text',
            label: 'ヒント',
            default: '2〜32文字。リカバリーのときに使います。',
          },
          placeholder: { type: 'text', label: 'プレースホルダー', default: '例: hanako' },
        },
        render: ({ label, hint, placeholder }) => (
          <div style={{ maxWidth: 420 }}>
            <Field label={label} hint={hint || undefined} htmlFor="demo-input">
              <input id="demo-input" className="input" placeholder={placeholder} />
            </Field>
          </div>
        ),
      }),
      story({
        name: 'いろいろな入力',
        render: () => (
          <div style={{ maxWidth: 420 }} className="stack">
            <Field label="フォルダ" htmlFor="demo-select">
              <select id="demo-select" className="input select" defaultValue="Projects">
                <option>Inbox</option>
                <option>Projects</option>
              </select>
            </Field>
            <Field label="メモ" htmlFor="demo-textarea">
              <textarea
                id="demo-textarea"
                className="input textarea"
                rows={3}
                defaultValue="複数行の入力"
              />
            </Field>
            <label className="check">
              <input type="checkbox" defaultChecked /> 今のノートをリポジトリにコピーする
            </label>
            <input className="input mono" defaultValue="github_pat_…" aria-label="トークン" />
          </div>
        ),
      }),
      story({ name: '切り替え(Segmented)', render: () => <SegmentedDemo /> }),
    ],
  }),
  defineStories({
    id: 'feedback',
    title: 'お知らせと状態',
    group: 'コンポーネント',
    description: '読み込み中・エラー・空の状態・注意書き。',
    source: 'src/components/ui.tsx',
    stories: [
      story({
        name: 'お知らせ(notice)',
        controls: {
          kind: {
            type: 'select',
            label: '種類',
            default: 'info',
            options: ['plain', 'info', 'ok', 'warn', 'error'],
          },
          text: {
            type: 'text',
            label: '文字',
            default: 'GitHub に保存している場合、他の場所からの push は自動で取り込まれます。',
          },
        },
        render: ({ kind, text }) => (
          <p className={kind === 'plain' ? 'notice' : `notice notice-${kind}`}>{text}</p>
        ),
      }),
      story({
        name: '帯(banner)',
        layout: 'fullscreen',
        render: () => (
          <div>
            <div className="banner banner-info">
              <span>このノートは別の端末で更新されました。</span>
              <button type="button" className="btn btn-small">
                読み直す
              </button>
            </div>
            <div className="banner banner-warn">
              <span>オフラインです。保存はあとで送信されます。</span>
            </div>
            <div className="banner banner-danger">
              <span>保存できませんでした。</span>
            </div>
          </div>
        ),
      }),
      story({
        name: '読み込み中',
        render: () => (
          <div className="stack">
            <Spinner />
            <Loading />
          </div>
        ),
      }),
      story({
        name: 'エラー',
        render: () => (
          <ErrorBox error={new Error('サーバーに接続できません。')} onRetry={() => undefined} />
        ),
      }),
      story({
        name: '空の状態',
        controls: {
          title: { type: 'text', label: '見出し', default: 'まだノートがありません' },
          icon: { type: 'text', label: 'アイコン名', default: 'notes' },
        },
        render: ({ title, icon }) => (
          <EmptyState icon={icon} title={title}>
            <button type="button" className="btn btn-primary">
              最初のメモを書く
            </button>
          </EmptyState>
        ),
      }),
    ],
  }),
  defineStories({
    id: 'page-header',
    title: 'ページ見出し',
    group: 'コンポーネント',
    source: 'src/components/ui.tsx (PageHeader)',
    stories: [
      story({
        name: '基本',
        controls: {
          title: { type: 'text', label: '見出し', default: 'レビュー' },
          sub: {
            type: 'text',
            label: '補足',
            default: 'AIの提案や、自動で統合できなかった編集を確認します',
          },
          back: { type: 'boolean', label: '戻るボタン', default: false },
          actions: { type: 'boolean', label: '右側のボタン', default: true },
        },
        render: ({ title, sub, back, actions }) => (
          <PageHeader
            title={title}
            sub={sub || undefined}
            {...(back ? { back: () => undefined } : {})}
            actions={
              actions ? (
                <button type="button" className="btn">
                  <Icon name="edit" size={16} /> 編集
                </button>
              ) : undefined
            }
          />
        ),
      }),
    ],
  }),
  defineStories({
    id: 'modal',
    title: 'モーダル',
    group: 'コンポーネント',
    description: '<dialog> を使った Modal。Esc と閉じるボタンで閉じます。',
    source: 'src/components/ui.tsx (Modal)',
    stories: [
      story({
        name: '基本',
        layout: 'fullscreen',
        controls: { wide: { type: 'boolean', label: '幅広', default: false } },
        render: ({ wide }) => <ModalDemo wide={wide} />,
      }),
    ],
  }),
  defineStories({
    id: 'secret-reveal',
    title: '一度だけ表示する秘密',
    group: 'コンポーネント',
    description:
      'リカバリーコードやトークンなど、二度と表示できない値。「保存した」にチェックするまで先に進めません。',
    source: 'src/components/ui.tsx (SecretReveal)',
    stories: [
      story({
        name: 'リカバリーコード',
        render: () => (
          <div style={{ maxWidth: 520 }}>
            <SecretReveal
              title="リカバリーコード(各コード1回のみ使用可)"
              lines={['ABCD-EFGH-JKLM-NPQR', 'STUV-WXYZ-2345-6789', 'QWER-TYUP-ASDF-GHJK']}
              filename="gmemo-recovery-codes.txt"
              note="パスワードマネージャーや紙に控えて、安全な場所に保管してください。"
              onDone={() => undefined}
            />
          </div>
        ),
      }),
    ],
  }),
];
