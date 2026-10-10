import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, describeError } from '../../api/client';
import type { AiAccess, AiStatus, AuditEntry, WorkspacePolicy } from '../../api/types';
import { Badge, EmptyState, ErrorBox, Loading, Modal, Spinner } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { useAsync } from '../../lib/hooks';
import { noteUrl } from '../../lib/paths';
import { useToast } from '../../state/toast';

export const EXTERNAL_NOTICE =
  '機密検出は補助であり完全ではありません。基本はフォルダ単位の送信制御で守ってください。';

const ACCESS_OPTIONS: { value: AiAccess; label: string }[] = [
  { value: 'external', label: '外部AIにも送れる' },
  { value: 'local', label: 'ローカルAIのみ' },
  { value: 'none', label: 'AIに送らない' },
];

const MODES = [
  { value: 'warn', label: '確認する', desc: '見つかったら送信前に確認します' },
  {
    value: 'mask',
    label: '伏せて送る',
    desc: '該当部分を置き換えて送り、回答で元に戻します(おすすめ)',
  },
  { value: 'block', label: '送らない', desc: '見つかったら外部AIへの送信を止めます' },
] as const;

export function AiPolicySettings() {
  const policy = useAsync(() => api.policy(), []);
  const status = useAsync<AiStatus>(() => api.aiStatus(), []);
  const [p, setP] = useState<WorkspacePolicy | null>(null);
  const [dict, setDict] = useState('');
  const [notice, setNotice] = useState<null | (() => void)>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (policy.data) {
      setP(structuredClone(policy.data));
      setDict(policy.data.sensitive.dictionary.join('\n'));
    }
  }, [policy.data]);

  if (policy.loading && !policy.data) return <Loading />;
  if (policy.error) return <ErrorBox error={policy.error} onRetry={policy.reload} />;
  if (!p) return null;

  const dictionary = dict
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const dirty =
    JSON.stringify({ ...p, sensitive: { ...p.sensitive, dictionary } }) !==
    JSON.stringify(policy.data);

  /** Choosing external access for the first time shows the one-line notice and records the acknowledgement. */
  const withExternal = (next: WorkspacePolicy, usesExternal: boolean) => {
    if (usesExternal && !next.externalAcknowledged) {
      setNotice(() => () => setP({ ...next, externalAcknowledged: true }));
    } else setP(next);
  };

  const folders = Object.entries(p.ai.folders);

  const save = async () => {
    setBusy(true);
    try {
      const saved = await api.savePolicy({ ...p, sensitive: { ...p.sensitive, dictionary } });
      policy.setData(saved);
      toast.show('AIポリシーを保存しました', { kind: 'success' });
      status.reload();
    } catch (e) {
      toast.show(describeError(e), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <section className="card">
        <h2>使えるAI</h2>
        {status.data ? (
          <ul className="item-list">
            <li className="item">
              <span>ローカルAI</span>
              {status.data.local ? (
                <Badge tone="ok">{status.data.local}</Badge>
              ) : (
                <Badge>未設定</Badge>
              )}
            </li>
            <li className="item">
              <span>外部AI</span>
              {status.data.external ? (
                <Badge tone="warn">{status.data.external}</Badge>
              ) : (
                <Badge>未設定</Badge>
              )}
            </li>
          </ul>
        ) : (
          <Loading />
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={p.externalAcknowledged}
            disabled={!status.data?.external}
            onChange={(e) => {
              if (e.target.checked) withExternal(p, true);
              else setP({ ...p, externalAcknowledged: false });
            }}
          />
          外部AIを使う
        </label>
        <p className="hint">
          AIの接続先はサーバーの環境変数で設定します。外部AIを使うには、ここで有効化する必要があります。
        </p>
      </section>

      <section className="card">
        <h2>送信範囲(フォルダ単位)</h2>
        <p className="hint">
          ノートの中身をどこまでAIに送ってよいかを決めます。ノートの frontmatter に{' '}
          <code>sensitivity: secret</code> があると、常にローカルAIのみになります。
        </p>
        <div className="field">
          <label htmlFor="pol-default">ワークスペース全体の既定</label>
          <select
            id="pol-default"
            className="input select"
            value={p.ai.default}
            onChange={(e) =>
              withExternal(
                { ...p, ai: { ...p.ai, default: e.target.value as AiAccess } },
                e.target.value === 'external',
              )
            }
          >
            {ACCESS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="fieldset">
          <legend>フォルダごとの設定(長く一致するフォルダが優先)</legend>
          {folders.length === 0 && <p className="hint">まだありません。</p>}
          {folders.map(([folder, access], i) => (
            <div key={i} className="row wrap filter-row">
              <input
                className="input"
                aria-label={`フォルダ${i + 1}`}
                value={folder}
                placeholder="Private"
                onChange={(e) => {
                  const entries = folders.map(([f, a], j) =>
                    j === i ? [e.target.value, a] : [f, a],
                  );
                  setP({
                    ...p,
                    ai: {
                      ...p.ai,
                      folders: Object.fromEntries(entries) as Record<string, AiAccess>,
                    },
                  });
                }}
              />
              <select
                className="input select"
                aria-label={`フォルダ${i + 1}の送信範囲`}
                value={access}
                onChange={(e) =>
                  withExternal(
                    {
                      ...p,
                      ai: {
                        ...p.ai,
                        folders: { ...p.ai.folders, [folder]: e.target.value as AiAccess },
                      },
                    },
                    e.target.value === 'external',
                  )
                }
              >
                {ACCESS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-small btn-danger-text"
                onClick={() => {
                  const next = { ...p.ai.folders };
                  delete next[folder];
                  setP({ ...p, ai: { ...p.ai, folders: next } });
                }}
              >
                削除
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              let name = 'フォルダ';
              for (let n = 2; name in p.ai.folders; n++) name = `フォルダ${n}`;
              setP({ ...p, ai: { ...p.ai, folders: { ...p.ai.folders, [name]: 'none' } } });
            }}
          >
            フォルダを追加
          </button>
        </fieldset>
      </section>

      <section className="card">
        <h2>機密情報の検出</h2>
        <p className="hint">
          外部AIへ送る直前に、APIキー・パスワード・カード番号・個人番号などをこの端末側(サーバー内)で検出します。
        </p>
        <fieldset className="fieldset">
          <legend>見つかったとき</legend>
          {MODES.map((m) => (
            <label key={m.value} className="radio">
              <input
                type="radio"
                name="sens-mode"
                checked={p.sensitive.mode === m.value}
                onChange={() => setP({ ...p, sensitive: { ...p.sensitive, mode: m.value } })}
              />
              <span>
                <strong>{m.label}</strong> <span className="hint">{m.desc}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor="pol-dict">辞書(1行に1語。社名・人名・案件名など)</label>
          <textarea
            id="pol-dict"
            className="input textarea"
            rows={4}
            value={dict}
            onChange={(e) => setDict(e.target.value)}
          />
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={p.sensitive.useLocalModel}
            disabled={!status.data?.local}
            onChange={(e) =>
              setP({ ...p, sensitive: { ...p.sensitive, useLocalModel: e.target.checked } })
            }
          />
          ローカルAIでも固有名詞などを検出する{!status.data?.local && '(ローカルAI未設定)'}
        </label>
        {p.sensitive.allow.length > 0 && (
          <p className="hint">
            「問題なし」にした項目: {p.sensitive.allow.length} 件{' '}
            <button
              type="button"
              className="btn btn-small btn-text"
              onClick={() => setP({ ...p, sensitive: { ...p.sensitive, allow: [] } })}
            >
              すべて解除
            </button>
          </p>
        )}
        <p className="hint">{EXTERNAL_NOTICE}</p>
      </section>

      <div className="sticky-save">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!dirty || busy}
          onClick={() => void save()}
        >
          {busy && <Spinner />}
          {dirty ? '変更を保存' : '保存済み'}
        </button>
      </div>

      <Modal
        open={!!notice}
        onClose={() => setNotice(null)}
        title="外部AIを有効にします"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setNotice(null)}>
              やめる
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                notice?.();
                setNotice(null);
              }}
            >
              理解しました
            </button>
          </>
        }
      >
        <p>{EXTERNAL_NOTICE}</p>
      </Modal>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { egress: '送信', 'egress-blocked': 'ブロック' };

export function AuditLog() {
  const log = useAsync<AuditEntry[]>(() => api.aiAudit(200), []);
  if (log.loading && !log.data) return <Loading />;
  if (log.error) return <ErrorBox error={log.error} onRetry={log.reload} />;
  if (!log.data?.length) return <EmptyState icon="shield" title="AIへの送信記録はまだありません" />;
  return (
    <section className="card">
      <h2>AI送信ログ</h2>
      <p className="hint">
        ノートの内容をAIに送ったときの記録です(本文や検出した値そのものは記録しません)。
      </p>
      <ul className="item-list audit">
        {log.data.map((e, i) => {
          const d = e.detail;
          const paths = Array.isArray(d['paths']) ? (d['paths'] as string[]) : [];
          return (
            <li key={i} className="item audit-item">
              <div className="item-main">
                <span className="row wrap">
                  <Badge tone={e.kind === 'egress-blocked' ? 'danger' : 'neutral'}>
                    {KIND_LABEL[e.kind] ?? e.kind}
                  </Badge>
                  <strong>{String(d['target'] ?? '')}</strong>
                  <time className="hint" dateTime={e.at}>
                    {formatDateTime(e.at)}
                  </time>
                </span>
                <span className="hint">
                  {e.actor} ・{String(d['purpose'] ?? '')} ・ノート {paths.length} 件
                  {typeof d['findings'] === 'number' &&
                    d['findings'] > 0 &&
                    ` ・検出 ${d['findings']} 件`}
                  {d['masked'] === true && ' ・伏せ字あり'}
                </span>
                {paths.length > 0 && (
                  <details>
                    <summary className="hint">送ったノート</summary>
                    <ul className="bullets">
                      {paths.map((p) => (
                        <li key={p}>
                          <Link to={noteUrl(p)}>{p}</Link>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
