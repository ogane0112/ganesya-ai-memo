import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, describeError } from '../api/client';
import type { ProposalRow, ProposalStatus } from '../api/types';
import { Icon } from '../components/Icon';
import { ProposalCard } from '../components/ProposalCard';
import { SwipeCard } from '../components/SwipeCard';
import { EmptyState, ErrorBox, Loading, PageHeader, Segmented } from '../components/ui';
import { needsDecision } from '../lib/conflicts';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';

/** AI proposals and device conflicts to review. Swipe right to merge, left to reject. */
export function ReviewPage() {
  useDocumentTitle('レビュー');
  const [status, setStatus] = useState<ProposalStatus>('open');
  const { changeTick, openProposals, refreshProposals } = useApp();
  const list = useAsync(() => api.proposals(status), [status]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const toast = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    list.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeTick, openProposals]);

  useEffect(() => {
    const t = timers.current;
    // Leaving the page commits pending rejections immediately.
    return () => {
      for (const [, timer] of t) clearTimeout(timer);
    };
  }, []);

  const hide = (id: string, on: boolean) =>
    setHidden((h) => {
      const n = new Set(h);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const approve = async (p: ProposalRow) => {
    hide(p.id, true);
    try {
      // Conflicts need a decision per paragraph: open the detail instead of merging blindly.
      const detail = await api.proposal(p.id);
      if (detail.files.some(needsDecision)) {
        hide(p.id, false);
        toast.show('競合があります。どちらを採用するか選んでください', { kind: 'info' });
        navigate(`/review/${encodeURIComponent(p.id)}`);
        return;
      }
      await api.mergeProposal(p.id, {});
      toast.show(`「${p.title}」を取り込みました`, { kind: 'success' });
      refreshProposals();
      list.reload();
    } catch (e) {
      hide(p.id, false);
      if (e instanceof ApiError && e.status === 409) {
        toast.show('競合があります。どちらを採用するか選んでください', { kind: 'info' });
        navigate(`/review/${encodeURIComponent(p.id)}`);
      } else toast.show(describeError(e), { kind: 'error' });
    }
  };

  const reject = (p: ProposalRow) => {
    hide(p.id, true);
    const timer = setTimeout(() => {
      timers.current.delete(p.id);
      api
        .rejectProposal(p.id)
        .then(() => {
          refreshProposals();
          list.reload();
        })
        .catch((e: unknown) => {
          hide(p.id, false);
          toast.show(describeError(e), { kind: 'error' });
        });
    }, 5000);
    timers.current.set(p.id, timer);
    toast.show(`「${p.title}」を却下しました`, {
      duration: 5000,
      action: {
        label: '元に戻す',
        onClick: () => {
          clearTimeout(timer);
          timers.current.delete(p.id);
          hide(p.id, false);
        },
      },
    });
  };

  const items = (list.data ?? []).filter((p) => !hidden.has(p.id));

  return (
    <div className="page">
      <PageHeader
        title="レビュー"
        sub={status === 'open' ? 'AIの提案や、自動で統合できなかった編集を確認します' : undefined}
      />
      <Segmented<ProposalStatus>
        label="状態"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'open', label: `未処理${openProposals ? ` (${openProposals})` : ''}` },
          { value: 'merged', label: '取り込み済み' },
          { value: 'rejected', label: '却下' },
        ]}
      />
      {status === 'open' && items.length > 0 && (
        <p className="hint swipe-hint">
          <span aria-hidden="true">→</span> 右にスワイプで取り込み、
          <span aria-hidden="true">←</span> 左にスワイプで却下
        </p>
      )}
      {list.loading && !list.data ? (
        <Loading />
      ) : list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : items.length === 0 ? (
        <EmptyState
          icon="review"
          title={status === 'open' ? '確認待ちはありません' : 'まだありません'}
        >
          {status === 'open' && <p>AIエージェントが変更を提案すると、ここに表示されます。</p>}
        </EmptyState>
      ) : (
        <ul className="card-list">
          {items.map((p) => (
            <li key={p.id}>
              {status === 'open' ? (
                <SwipeCard
                  onSwipeRight={() => void approve(p)}
                  onSwipeLeft={() => reject(p)}
                  rightLabel="取り込む"
                  leftLabel="却下"
                >
                  <ProposalCard p={p} />
                  <div className="card-actions">
                    <button
                      type="button"
                      className="btn btn-small btn-danger-text"
                      onClick={() => reject(p)}
                    >
                      <Icon name="x" size={16} />
                      却下
                    </button>
                    <Link className="btn btn-small" to={`/review/${encodeURIComponent(p.id)}`}>
                      内容を見る
                    </Link>
                    <button
                      type="button"
                      className="btn btn-small btn-primary"
                      onClick={() => void approve(p)}
                    >
                      <Icon name="check" size={16} />
                      取り込む
                    </button>
                  </div>
                </SwipeCard>
              ) : (
                <Link to={`/review/${encodeURIComponent(p.id)}`} className="card card-link">
                  <ProposalCard p={p} />
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
