import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, describeError } from '../api/client';
import type { HistoryEntry, SaveResult } from '../api/types';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorBox, Loading, PageHeader } from '../components/ui';
import { formatDateTime, relativeTime } from '../lib/format';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';

export function revertMessage(results: SaveResult[]): { text: string; review: string | null } {
  const needs = results.filter((r) => r.status === 'proposed' && !r.merged);
  if (!results.length) return { text: '取り消す変更はありませんでした', review: null };
  if (!needs.length) return { text: `${results.length} 件の変更を取り消しました`, review: null };
  const first = needs[0];
  return {
    text: `${results.length - needs.length} 件を取り消し、${needs.length} 件は後の変更とぶつかるため確認待ちにしました`,
    review: first && first.status === 'proposed' ? first.proposalId : null,
  };
}

export function HistoryPage() {
  useDocumentTitle('履歴');
  const [params, setParams] = useSearchParams();
  const agentId = params.get('agent') ?? '';
  const { changeTick } = useApp();
  const agents = useAsync(() => api.agents(), []);
  const hist = useAsync(
    () => api.history({ limit: 200, ...(agentId ? { agentId } : {}) }),
    [agentId, changeTick],
  );
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const agent = agents.data?.find((a) => a.id === agentId);

  const revert = async (h: HistoryEntry) => {
    if (!confirm(`「${h.subject}」を取り消しますか?`)) return;
    setBusy(h.sha);
    try {
      const { text, review } = revertMessage([await api.revert(h.sha)]);
      toast.show(
        text,
        review
          ? {
              action: {
                label: '確認',
                onClick: () => navigate(`/review/${encodeURIComponent(review)}`),
              },
            }
          : { kind: 'success' },
      );
      hist.reload();
    } catch (e) {
      toast.show(describeError(e), { kind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const revertAll = async () => {
    if (!agent || !confirm(`「${agent.name}」がこれまでに行った変更をすべて取り消しますか?`))
      return;
    setBusy('all');
    try {
      const { text, review } = revertMessage(await api.revertAgent(agent.id));
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
      hist.reload();
    } catch (e) {
      toast.show(describeError(e), { kind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <PageHeader title="履歴" sub="すべての変更は Git に記録され、いつでも取り消せます" />
      <div className="toolbar-row">
        <label htmlFor="hist-agent" className="inline-field">
          <span>作成者</span>
          <select
            id="hist-agent"
            className="input select"
            value={agentId}
            onChange={(e) => {
              const next = new URLSearchParams(params);
              if (e.target.value) next.set('agent', e.target.value);
              else next.delete('agent');
              setParams(next, { replace: true });
            }}
          >
            <option value="">すべて</option>
            {agents.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.revokedAt ? '(無効)' : ''}
              </option>
            ))}
          </select>
        </label>
        {agent && (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void revertAll()}
            disabled={busy !== null}
          >
            <Icon name="undo" size={18} />
            このAIの変更をすべて取り消す
          </button>
        )}
      </div>
      {hist.loading && !hist.data ? (
        <Loading />
      ) : hist.error ? (
        <ErrorBox error={hist.error} onRetry={hist.reload} />
      ) : !hist.data?.length ? (
        <EmptyState icon="history" title="履歴はまだありません" />
      ) : (
        <ol className="history-list">
          {hist.data.map((h) => (
            <li key={h.sha} className="history-item">
              <div className="history-main">
                <span className={h.authorKind === 'ai' ? 'who who-ai' : 'who'}>
                  {h.authorKind === 'ai' && <Icon name="bot" size={14} />}
                  {h.agentId && !agentId ? (
                    <Link to={`/history?agent=${encodeURIComponent(h.agentId)}`}>{h.author}</Link>
                  ) : (
                    h.author
                  )}
                </span>
                <span className="history-subject">{h.subject}</span>
                <span className="hint">
                  <time dateTime={h.date} title={formatDateTime(h.date)}>
                    {relativeTime(h.date)}
                  </time>{' '}
                  <code>{h.sha.slice(0, 8)}</code>
                  {h.proposalId && (
                    <>
                      {' '}
                      ・<Link to={`/review/${encodeURIComponent(h.proposalId)}`}>提案</Link>
                    </>
                  )}
                </span>
              </div>
              {h.authorKind !== 'system' && (
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => void revert(h)}
                  disabled={busy !== null}
                >
                  取り消す
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
