import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, describeError } from '../../api/client';
import { type AgentPermissions, type AgentWithAccess, type Scope, SCOPES } from '../../api/types';
import { AgentForm, defaultAgent, SCOPE_LABEL } from '../../components/AgentForm';
import { Icon } from '../../components/Icon';
import { Badge, EmptyState, ErrorBox, Loading, SecretReveal, Spinner } from '../../components/ui';
import { formatDate, relativeTime } from '../../lib/format';
import { ExternalShareWarning } from '../../components/ExternalShareWarning';
import { useAsync } from '../../lib/hooks';
import { useToast } from '../../state/toast';
import { revertMessage } from '../History';

const WRITE_LABEL = { none: '読むだけ', propose: '提案', direct: '直接書き込み' } as const;

function permsOf(a: AgentWithAccess): AgentPermissions {
  return {
    name: a.name,
    description: a.description,
    canRead: a.canRead,
    writeMode: a.writeMode,
    folders: a.folders,
    autoMerge: a.autoMerge,
    autoMergeFolders: a.autoMergeFolders,
    location: a.location,
  };
}

export function AgentsSettings() {
  const agents = useAsync(() => api.agents(), []);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<AgentPermissions>(defaultAgent());
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createAgent(draft);
      setCreating(false);
      setDraft(defaultAgent());
      agents.reload();
      toast.show('エージェントを作成しました。トークンを発行して接続してください', {
        kind: 'success',
      });
    } catch (err) {
      toast.show(describeError(err), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const active = agents.data?.filter((a) => !a.revokedAt) ?? [];
  const revoked = agents.data?.filter((a) => a.revokedAt) ?? [];

  return (
    <div className="stack">
      <section className="card">
        <h2>AIエージェント</h2>
        <p className="hint">
          ノートを読み書きする AI ごとに権限を設定します。MCP の OAuth で接続した AI
          もここに表示されます。
        </p>
        <ExternalShareWarning show={active.some((a) => a.location === 'external')} />
        {creating ? (
          <form onSubmit={(e) => void create(e)}>
            <AgentForm value={draft} onChange={setDraft} />
            <div className="row">
              <button type="button" className="btn" onClick={() => setCreating(false)}>
                キャンセル
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || !draft.name.trim()}
              >
                {busy && <Spinner />}
                作成
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={18} />
            エージェントを追加
          </button>
        )}
      </section>
      {agents.loading && !agents.data ? (
        <Loading />
      ) : agents.error ? (
        <ErrorBox error={agents.error} onRetry={agents.reload} />
      ) : active.length === 0 ? (
        <EmptyState icon="bot" title="エージェントはまだありません">
          <p>
            <Link to="/settings/mcp">MCP で接続</Link>するか、上のボタンから追加してください。
          </p>
        </EmptyState>
      ) : (
        active.map((a) => <AgentCard key={a.id} agent={a} onChanged={agents.reload} />)
      )}
      {revoked.length > 0 && (
        <details className="card">
          <summary>無効化したエージェント({revoked.length})</summary>
          <ul className="item-list">
            {revoked.map((a) => (
              <li key={a.id} className="item">
                <span>
                  {a.name} <span className="hint">無効化 {formatDate(a.revokedAt)}</span>
                </span>
                <Link className="btn btn-small" to={`/history?agent=${encodeURIComponent(a.id)}`}>
                  履歴
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function AgentCard({ agent: a, onChanged }: { agent: AgentWithAccess; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [perms, setPerms] = useState<AgentPermissions>(permsOf(a));
  const [issuing, setIssuing] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.updateAgent(a.id, perms);
      setEditing(false);
      onChanged();
      toast.show('権限を更新しました', { kind: 'success' });
    } catch (err) {
      toast.show(describeError(err), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!confirm(`「${a.name}」を無効化しますか?すべてのトークンと接続がすぐに使えなくなります。`))
      return;
    try {
      await api.revokeAgent(a.id);
      onChanged();
    } catch (err) {
      toast.show(describeError(err), { kind: 'error' });
    }
  };

  const revertAll = async () => {
    if (!confirm(`「${a.name}」がこれまでに行った変更をすべて取り消しますか?`)) return;
    setBusy(true);
    try {
      const { text, review } = revertMessage(await api.revertAgent(a.id));
      toast.show(
        text,
        review
          ? {
              action: {
                label: '確認',
                onClick: () => navigate(`/review/${encodeURIComponent(review)}`),
              },
              duration: 8000,
            }
          : { kind: 'success' },
      );
    } catch (err) {
      toast.show(describeError(err), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card agent-card" aria-labelledby={`agent-${a.id}`}>
      <header className="row between wrap">
        <h3 id={`agent-${a.id}`}>
          <Icon name="bot" size={18} /> {a.name}
        </h3>
        <span className="row wrap">
          <Badge tone={a.location === 'external' ? 'warn' : 'neutral'}>
            {a.location === 'external' ? '外部' : 'ローカル'}
          </Badge>
          <Badge
            tone={
              a.writeMode === 'direct' ? 'danger' : a.writeMode === 'propose' ? 'ai' : 'neutral'
            }
          >
            {WRITE_LABEL[a.writeMode]}
          </Badge>
          {a.autoMerge && <Badge tone="accent">自動取り込み</Badge>}
        </span>
      </header>
      {a.description && <p className="hint">{a.description}</p>}
      <p className="hint">
        読み取り: {a.canRead ? 'あり' : 'なし'} ・フォルダ:{' '}
        {a.folders.length ? a.folders.join(', ') : 'すべて'}
        {a.autoMerge &&
          ` ・自動取り込み: ${a.autoMergeFolders.length ? a.autoMergeFolders.join(', ') : '書ける場所すべて'}`}
      </p>

      {editing ? (
        <form onSubmit={(e) => void save(e)}>
          <AgentForm value={perms} onChange={setPerms} />
          <div className="row">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setPerms(permsOf(a));
                setEditing(false);
              }}
            >
              キャンセル
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              保存
            </button>
          </div>
        </form>
      ) : (
        <div className="row wrap">
          <button type="button" className="btn btn-small" onClick={() => setEditing(true)}>
            権限を編集
          </button>
          <button type="button" className="btn btn-small" onClick={() => setIssuing(true)}>
            トークンを発行
          </button>
          <Link className="btn btn-small" to={`/history?agent=${encodeURIComponent(a.id)}`}>
            変更履歴
          </Link>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => void revertAll()}
            disabled={busy}
          >
            このAIの変更をすべて取り消す
          </button>
          <button
            type="button"
            className="btn btn-small btn-danger-text"
            onClick={() => void revoke()}
          >
            無効化
          </button>
        </div>
      )}

      {token && (
        <SecretReveal
          title="アクセストークン"
          lines={[token]}
          note="このトークンは今だけ表示されます。AI の設定に貼り付けてください。"
          doneLabel="閉じる"
          onDone={() => {
            setToken(null);
            onChanged();
          }}
        />
      )}
      {issuing && !token && (
        <TokenForm
          agentId={a.id}
          onCancel={() => setIssuing(false)}
          onIssued={(t) => {
            setIssuing(false);
            setToken(t);
          }}
        />
      )}

      {(a.tokens.length > 0 || a.clients.length > 0) && (
        <ul className="item-list">
          {a.clients.map((c) => (
            <li key={c.clientId} className="item">
              <div className="item-main">
                <strong>{c.clientName}</strong>
                <span className="hint">OAuth 接続 ・{formatDate(c.createdAt)}</span>
              </div>
              <button
                type="button"
                className="btn btn-small btn-danger-text"
                onClick={async () => {
                  if (!confirm(`「${c.clientName}」の接続を解除しますか?`)) return;
                  try {
                    await api.deleteOAuthClient(c.clientId);
                    onChanged();
                  } catch (err) {
                    toast.show(describeError(err), { kind: 'error' });
                  }
                }}
              >
                接続解除
              </button>
            </li>
          ))}
          {a.tokens
            .filter((t) => t.kind !== 'refresh')
            .map((t) => (
              <li key={t.id} className="item">
                <div className="item-main">
                  <strong>
                    {t.label || (t.kind === 'access' ? 'OAuth アクセストークン' : 'トークン')}
                  </strong>
                  <span className="hint">
                    {t.scope.map((s) => SCOPE_LABEL[s] ?? s).join('・')} ・発行{' '}
                    {formatDate(t.createdAt)}
                    {t.expiresAt ? ` ・期限 ${formatDate(t.expiresAt)}` : ' ・無期限'}
                    {t.lastUsedAt ? ` ・最終使用 ${relativeTime(t.lastUsedAt)}` : ''}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-small btn-danger-text"
                  onClick={async () => {
                    if (!confirm('このトークンを無効にしますか?')) return;
                    try {
                      await api.revokeToken(t.id);
                      onChanged();
                    } catch (err) {
                      toast.show(describeError(err), { kind: 'error' });
                    }
                  }}
                >
                  無効化
                </button>
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

function TokenForm({
  agentId,
  onCancel,
  onIssued,
}: {
  agentId: string;
  onCancel: () => void;
  onIssued: (token: string) => void;
}) {
  const [scope, setScope] = useState<Set<Scope>>(new Set(['notes:read', 'notes:propose']));
  const [label, setLabel] = useState('');
  const [days, setDays] = useState('90');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.createToken(agentId, {
        scope: [...scope],
        label: label.trim(),
        ...(Number(days) > 0 ? { expiresInDays: Number(days) } : {}),
      });
      onIssued(r.token);
    } catch (err) {
      toast.show(describeError(err), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="inline-form" onSubmit={(e) => void submit(e)}>
      <fieldset className="fieldset">
        <legend>許可する操作</legend>
        {SCOPES.map((s) => (
          <label key={s} className="check">
            <input
              type="checkbox"
              checked={scope.has(s)}
              onChange={(e) =>
                setScope((prev) => {
                  const n = new Set(prev);
                  if (e.target.checked) n.add(s);
                  else n.delete(s);
                  return n;
                })
              }
            />
            {SCOPE_LABEL[s]} <code className="hint">{s}</code>
          </label>
        ))}
        <p className="hint">
          「メモを追記する」だけのトークンは、iOS
          ショートカットなど自分の端末からのキャプチャ用です(あなたの書き込みとして記録されます)。
        </p>
      </fieldset>
      <div className="row wrap">
        <div className="field grow">
          <label htmlFor={`tl-${agentId}`}>ラベル</label>
          <input
            id={`tl-${agentId}`}
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={60}
            placeholder="例: ノートPCの Claude"
          />
        </div>
        <div className="field">
          <label htmlFor={`td-${agentId}`}>有効期限</label>
          <select
            id={`td-${agentId}`}
            className="input select"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          >
            <option value="7">7日</option>
            <option value="30">30日</option>
            <option value="90">90日</option>
            <option value="365">1年</option>
            <option value="0">無期限</option>
          </select>
        </div>
      </div>
      <div className="row">
        <button type="button" className="btn" onClick={onCancel}>
          キャンセル
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || scope.size === 0}>
          発行
        </button>
      </div>
    </form>
  );
}
