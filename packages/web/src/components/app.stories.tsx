import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import type { AgentPermissions } from '../api/types';
import {
  sampleBlame,
  sampleBlameBody,
  sampleFindings,
  sampleMarkdown,
  sampleNotes,
  samplePaths,
  sampleProposal,
} from '../design/fixtures';
import { defineStories, story } from '../design/story';
import { ToastProvider, useToast } from '../state/toast';
import { AgentForm, defaultAgent } from './AgentForm';
import { Icon } from './Icon';
import { BlameView, Markdown } from './MarkdownView';
import { NoteCard } from './NoteCard';
import { NoteTree } from './NoteTree';
import { ProposalCard } from './ProposalCard';
import { FindingList } from './SensitiveConfirm';
import { SwipeCard } from './SwipeCard';
import { Badge } from './ui';
import logo from '../../public/icons/icon-192.png';

function AgentFormDemo() {
  const [v, setV] = useState<AgentPermissions>(defaultAgent('Claude'));
  return (
    <div style={{ maxWidth: 560 }}>
      <AgentForm value={v} onChange={setV} />
    </div>
  );
}

function ToastButtons() {
  const toast = useToast();
  return (
    <div className="row wrap">
      <button
        type="button"
        className="btn"
        onClick={() => toast.show('保存しました', { kind: 'success' })}
      >
        成功
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => toast.show('保存できませんでした', { kind: 'error' })}
      >
        エラー
      </button>
      <button
        type="button"
        className="btn"
        onClick={() =>
          toast.show('提案を取り込みました', {
            action: { label: '元に戻す', onClick: () => undefined },
          })
        }
      >
        操作つき
      </button>
    </div>
  );
}

function ShowToastOnMount() {
  const toast = useToast();
  const [done, setDone] = useState(false);
  if (!done) {
    setDone(true);
    queueMicrotask(() => toast.show('保存しました', { kind: 'success', duration: 0 }));
  }
  return <ToastButtons />;
}

export default [
  defineStories({
    id: 'note-card',
    title: 'ノートカード',
    group: 'コンポーネント',
    description: 'ノート一覧の1件。AIが作ったノートには紫のバッジが付きます。',
    source: 'src/components/NoteCard.tsx',
    stories: [
      story({
        name: '一覧',
        render: () => (
          <ul className="card-list" style={{ maxWidth: 640 }}>
            {sampleNotes.map((n, i) => (
              <li key={n.path}>
                <NoteCard note={n} unsynced={i === 3} />
              </li>
            ))}
          </ul>
        ),
      }),
      story({
        name: '1件',
        controls: {
          title: { type: 'text', label: 'タイトル', default: '新サービス企画' },
          ai: { type: 'boolean', label: 'AIが作成', default: false },
          unsynced: { type: 'boolean', label: '未同期', default: false },
        },
        render: ({ title, ai, unsynced }) => (
          <ul className="card-list" style={{ maxWidth: 640 }}>
            <li>
              <NoteCard
                note={{
                  ...sampleNotes[0]!,
                  title,
                  createdBy: ai ? 'ai' : 'human',
                  aiAgent: ai ? 'Claude' : null,
                }}
                unsynced={unsynced}
              />
            </li>
          </ul>
        ),
      }),
    ],
  }),
  defineStories({
    id: 'proposal-card',
    title: '提案カード',
    group: 'コンポーネント',
    description:
      'レビュー画面の1件。スマホでは右にスワイプで取り込み、左で却下(ボタンでも同じ操作ができます)。',
    source: 'src/components/ProposalCard.tsx, SwipeCard.tsx',
    stories: [
      story({
        name: 'スワイプできるカード',
        controls: {
          title: { type: 'text', label: 'タイトル', default: '課題に解決案を追記' },
          ai: { type: 'boolean', label: 'AIの提案', default: true },
          source: {
            type: 'select',
            label: '種類',
            default: 'agent',
            options: ['agent', 'device', 'revert'],
          },
        },
        render: ({ title, ai, source }) => (
          <ul className="card-list" style={{ maxWidth: 640 }}>
            <li>
              <SwipeCard
                onSwipeRight={() => undefined}
                onSwipeLeft={() => undefined}
                rightLabel="取り込む"
              >
                <ProposalCard
                  p={sampleProposal({
                    title,
                    source,
                    author_kind: ai ? 'ai' : 'human',
                    author_name: ai ? 'Claude' : 'hanako',
                  })}
                />
                <div className="card-actions">
                  <button type="button" className="btn btn-small btn-danger-text">
                    <Icon name="x" size={16} />
                    却下
                  </button>
                  <button type="button" className="btn btn-small">
                    内容を見る
                  </button>
                  <button type="button" className="btn btn-small btn-primary">
                    <Icon name="check" size={16} />
                    取り込む
                  </button>
                </div>
              </SwipeCard>
            </li>
          </ul>
        ),
      }),
    ],
  }),
  defineStories({
    id: 'markdown',
    title: 'Markdown表示',
    group: 'コンポーネント',
    description:
      'ノート本文の表示。BlameView では、AIが最後に書いた段落の左に紫の線と「AI」が付き、押すと誰が書いたかが出ます。',
    source: 'src/components/MarkdownView.tsx',
    stories: [
      story({
        name: '本文',
        render: () => (
          <div style={{ maxWidth: 720 }}>
            <Markdown text={sampleMarkdown} paths={samplePaths} />
          </div>
        ),
      }),
      story({
        name: '段落ごとの作成者(blame)',
        render: () => (
          <div style={{ maxWidth: 720 }}>
            <BlameView body={sampleBlameBody} blame={sampleBlame} paths={samplePaths} />
          </div>
        ),
      }),
    ],
  }),
  defineStories({
    id: 'note-tree',
    title: 'ノートツリー',
    group: 'コンポーネント',
    description: 'サイドバーのフォルダとノート。',
    source: 'src/components/NoteTree.tsx',
    stories: [
      story({
        name: '基本',
        render: () => (
          <div
            className="side"
            style={{ width: 252, background: 'var(--bg-soft)', padding: 8, borderRadius: 12 }}
          >
            <NoteTree notes={sampleNotes} />
          </div>
        ),
      }),
    ],
  }),
  defineStories({
    id: 'agent',
    title: 'AIエージェントの権限',
    group: 'コンポーネント',
    description: '設定画面と、MCPの接続許可画面で使う権限の編集フォーム。',
    source: 'src/components/AgentForm.tsx',
    stories: [story({ name: '編集フォーム', render: () => <AgentFormDemo /> })],
  }),
  defineStories({
    id: 'findings',
    title: '機密情報の検出結果',
    group: 'コンポーネント',
    description: '外部AIに送る前に見つかった機密情報。値そのものは伏せて表示します。',
    source: 'src/components/SensitiveConfirm.tsx (FindingList)',
    stories: [story({ name: '一覧', render: () => <FindingList findings={sampleFindings} /> })],
  }),
  defineStories({
    id: 'toast',
    title: 'トースト',
    group: 'コンポーネント',
    description: '操作の結果を数秒だけ表示します。useToast().show(...) で出します。',
    source: 'src/state/toast.tsx',
    stories: [
      story({
        name: '表示',
        layout: 'fullscreen',
        render: () => (
          <ToastProvider>
            <div style={{ padding: 24 }}>
              <ShowToastOnMount />
            </div>
          </ToastProvider>
        ),
      }),
    ],
  }),
  defineStories({
    id: 'pattern-auth',
    title: 'サインイン画面',
    group: 'パターン',
    description:
      'サインイン・アカウント作成など、サイドバーのない画面の型(auth-page + auth-card)。',
    stories: [
      story({
        name: 'サインイン',
        layout: 'fullscreen',
        render: () => (
          <div className="auth-page">
            <div className="auth-card">
              <img src={logo} alt="" width={64} height={64} className="auth-logo" />
              <h1>AI Memo にサインイン</h1>
              <p className="hint">
                この端末に保存したパスキー(指紋・顔認証・PIN)でサインインします。
              </p>
              <button type="button" className="btn btn-primary btn-block btn-large">
                <Icon name="key" />
                パスキーでサインイン
              </button>
              <button type="button" className="btn btn-text btn-block">
                リカバリーコードでログイン
              </button>
            </div>
          </div>
        ),
      }),
    ],
  }),
  defineStories({
    id: 'pattern-settings',
    title: '設定のカード',
    group: 'パターン',
    description: '設定画面の型: タブ + card(見出し、説明、一覧、ボタン)。',
    stories: [
      story({
        name: 'タブとカード',
        render: () => (
          <div style={{ maxWidth: 760 }}>
            <nav className="tabs" aria-label="設定の項目">
              {['見た目', 'パスキー', 'AIエージェント', '保存先'].map((t, i) => (
                <NavLink key={t} to={i === 3 ? '/' : `/x${i}`} className="tab-link">
                  {t}
                </NavLink>
              ))}
            </nav>
            <div className="stack" style={{ marginTop: 16 }}>
              <section className="card">
                <h2>パスキー</h2>
                <p className="hint">2台以上の端末で登録しておくと安心です。</p>
                <ul className="item-list">
                  {[
                    ['iPhone', '同期パスキー', true],
                    ['仕事のPC', 'このデバイスのパスキー', false],
                  ].map(([name, kind, synced]) => (
                    <li key={String(name)} className="item">
                      <div className="item-main">
                        <strong>
                          {name} {synced && <Badge tone="ok">同期</Badge>}
                        </strong>
                        <span className="hint">{kind}</span>
                      </div>
                      <button type="button" className="btn btn-small btn-danger-text">
                        削除
                      </button>
                    </li>
                  ))}
                </ul>
                <button type="button" className="btn btn-primary">
                  <Icon name="plus" size={18} /> パスキーを追加
                </button>
              </section>
            </div>
          </div>
        ),
      }),
    ],
  }),
  defineStories({
    id: 'pattern-tabbar',
    title: 'スマホの下部ナビ',
    group: 'パターン',
    description:
      'スマホ幅でだけ表示される下部のタブバー。上のツールバーで「スマホ」に切り替えて確認してください。',
    source: 'src/components/Layout.tsx',
    stories: [
      story({
        name: 'タブバー',
        layout: 'fullscreen',
        controls: {
          badge: { type: 'number', label: '未処理の提案', default: 3, min: 0, max: 120 },
        },
        render: ({ badge }) => (
          <nav className="tabbar" aria-label="メイン">
            {(
              [
                ['/', 'pen', '書く'],
                ['/notes', 'notes', 'ノート'],
                ['/search', 'search', '検索'],
                ['/review', 'review', 'レビュー'],
                ['/more', 'more', 'その他'],
              ] as const
            ).map(([to, icon, label]) => (
              <NavLink key={to} to={to} end className="tab">
                <span className="tab-icon">
                  <Icon name={icon} size={22} />
                  {to === '/review' && badge > 0 && (
                    <span className="tab-badge">{badge > 99 ? '99+' : badge}</span>
                  )}
                </span>
                <span className="tab-label">{label}</span>
              </NavLink>
            ))}
          </nav>
        ),
      }),
    ],
  }),
];
