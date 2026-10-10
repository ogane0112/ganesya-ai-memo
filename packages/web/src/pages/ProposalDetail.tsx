import { useEffect, useMemo, useReducer, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, describeError } from '../api/client';
import type { Choice, ProposalFile, UnresolvedConflict } from '../api/types';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/MarkdownView';
import { Badge, ErrorBox, Loading, PageHeader, Spinner } from '../components/ui';
import {
  binaryFileChoice,
  choiceLabel,
  countUnresolved,
  isBinaryClash,
  needsDecision,
  previewMerged,
  resolutionReducer,
  type ResolutionState,
  toRequest,
} from '../lib/conflicts';
import { displayValue } from '../lib/format';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { noteUrl } from '../lib/paths';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { ProposalMeta } from '../components/ProposalCard';

const STATUS_LABEL = { added: '追加', modified: '変更', deleted: '削除' } as const;

export function ProposalDetailPage() {
  const { id = '' } = useParams();
  const detail = useAsync(() => api.proposal(id), [id]);
  const [state, dispatch] = useReducer(resolutionReducer, {} as ResolutionState);
  const [busy, setBusy] = useState(false);
  const [serverUnresolved, setServerUnresolved] = useState<UnresolvedConflict[] | null>(null);
  const { refreshProposals, paths } = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  useDocumentTitle(detail.data?.proposal.title ?? '提案');

  useEffect(() => {
    dispatch({ type: 'reset' });
  }, [id]);

  const files = useMemo(() => detail.data?.files ?? [], [detail.data]);
  const remaining = countUnresolved(files, state);
  const open = detail.data?.proposal.status === 'open';

  if (detail.loading && !detail.data) return <Loading />;
  if (detail.error) return <ErrorBox error={detail.error} onRetry={detail.reload} />;
  const { proposal } = detail.data!;

  const merge = async () => {
    setBusy(true);
    setServerUnresolved(null);
    try {
      await api.mergeProposal(proposal.id, toRequest(state));
      toast.show('取り込みました', { kind: 'success' });
      refreshProposals();
      navigate('/review', { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && Array.isArray(e.details)) {
        setServerUnresolved(e.details as UnresolvedConflict[]);
        detail.reload();
      } else toast.show(describeError(e), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!confirm('この提案を却下しますか?')) return;
    setBusy(true);
    try {
      await api.rejectProposal(proposal.id);
      toast.show('却下しました');
      refreshProposals();
      navigate('/review', { replace: true });
    } catch (e) {
      toast.show(describeError(e), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const anyConflict = files.some(needsDecision);

  return (
    <div className="page proposal-page">
      <PageHeader
        title={proposal.title}
        back={() => navigate('/review')}
        sub={<ProposalMeta p={proposal} />}
      />
      {proposal.description && <p className="proposal-desc">{proposal.description}</p>}
      {proposal.status !== 'open' && (
        <p className="notice notice-info">
          この提案は{proposal.status === 'merged' ? '取り込み済み' : '却下済み'}です。
        </p>
      )}
      {open && anyConflict && (
        <div className="notice notice-warn">
          <p>
            <strong>競合があります。</strong>
            同じ段落が両方で変更されています。段落ごとに、残す方をタップしてください。
          </p>
          <div className="row wrap">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => dispatch({ type: 'all', files, choice: 'ours' })}
            >
              すべて「いまの内容」
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => dispatch({ type: 'all', files, choice: 'theirs' })}
            >
              すべて「提案」
            </button>
          </div>
        </div>
      )}
      {serverUnresolved && (
        <p className="notice notice-error" role="alert">
          まだ選ばれていない競合があります: {serverUnresolved.map((u) => u.path).join(', ')}
        </p>
      )}
      {files.length === 0 && <p className="hint">変更されたファイルはありません。</p>}
      {files.map((f) => (
        <FileReview
          key={f.path}
          file={f}
          state={state}
          dispatch={dispatch}
          open={open}
          paths={paths}
        />
      ))}
      {open && (
        <div className="action-bar">
          <button
            type="button"
            className="btn btn-danger-text"
            onClick={() => void reject()}
            disabled={busy}
          >
            <Icon name="x" size={18} />
            却下
          </button>
          <span className="hint">
            {remaining > 0 ? `あと ${remaining} か所 選んでください` : '準備完了'}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void merge()}
            disabled={busy || remaining > 0}
          >
            {busy ? <Spinner /> : <Icon name="check" size={18} />}
            取り込む
          </button>
        </div>
      )}
    </div>
  );
}

type Dispatch = React.Dispatch<Parameters<typeof resolutionReducer>[1]>;

function FileReview({
  file: f,
  state,
  dispatch,
  open,
  paths,
}: {
  file: ProposalFile;
  state: ResolutionState;
  dispatch: Dispatch;
  open: boolean;
  paths: readonly string[];
}) {
  const r = state[f.path];
  const rejected = !!r?.reject;
  const [showPreview, setShowPreview] = useState(false);
  const decision = open && needsDecision(f);
  const preview = showPreview ? previewMerged(f, r) : null;
  return (
    <section className={rejected ? 'file-review rejected' : 'file-review'} aria-label={f.path}>
      <header className="file-head">
        <Badge tone={f.status === 'deleted' ? 'danger' : f.status === 'added' ? 'ok' : 'neutral'}>
          {STATUS_LABEL[f.status]}
        </Badge>
        {f.path.endsWith('.md') && f.status !== 'deleted' ? (
          <Link className="mono ellipsis" to={noteUrl(f.path)}>
            {f.path}
          </Link>
        ) : (
          <span className="mono ellipsis">{f.path}</span>
        )}
        {open && (
          <label className="check small">
            <input
              type="checkbox"
              checked={rejected}
              onChange={(e) => dispatch({ type: 'reject', path: f.path, reject: e.target.checked })}
            />
            このファイルは取り込まない
          </label>
        )}
      </header>
      {!rejected && (
        <>
          {decision && f.deleteConflict && (
            <div className="conflict">
              <p>
                {f.proposed === null
                  ? '提案はこのノートを削除しますが、その後いまの内容が変更されています。'
                  : '提案はこのノートを変更しますが、いまの内容では削除されています。'}
              </p>
              <div className="choice-row">
                <ChoiceButton
                  active={r?.file === 'keep'}
                  onClick={() => dispatch({ type: 'file', path: f.path, choice: 'keep' })}
                >
                  ノートを残す
                </ChoiceButton>
                <ChoiceButton
                  active={r?.file === 'delete'}
                  onClick={() => dispatch({ type: 'file', path: f.path, choice: 'delete' })}
                >
                  削除する
                </ChoiceButton>
              </div>
            </div>
          )}
          {decision && isBinaryClash(f) && (
            <div className="conflict">
              <p>このファイルは両方で変更されています。</p>
              <div className="choice-row">
                <ChoiceButton
                  active={r?.file === binaryFileChoice('ours')}
                  onClick={() =>
                    dispatch({ type: 'file', path: f.path, choice: binaryFileChoice('ours') })
                  }
                >
                  いまの内容を残す
                </ChoiceButton>
                <ChoiceButton
                  active={r?.file === binaryFileChoice('theirs')}
                  onClick={() =>
                    dispatch({ type: 'file', path: f.path, choice: binaryFileChoice('theirs') })
                  }
                >
                  提案を採用
                </ChoiceButton>
              </div>
            </div>
          )}
          {open && f.mainChanged && f.merge && !f.merge.clean ? (
            <MergeView file={f} r={r} dispatch={dispatch} paths={paths} />
          ) : (
            <DiffView file={f} paths={paths} />
          )}
          {open && f.merge && f.mainChanged && (
            <div className="preview-toggle">
              <button
                type="button"
                className="btn btn-small btn-text"
                aria-expanded={showPreview}
                onClick={() => setShowPreview((v) => !v)}
              >
                {showPreview ? '統合結果を隠す' : '統合結果をプレビュー'}
              </button>
              {preview !== null && <pre className="merged-preview">{preview}</pre>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** One side of a conflict. A div with radio semantics, because it contains rendered blocks. */
function SideOption({
  side,
  active,
  onSelect,
  children,
}: {
  side: 'ours' | 'theirs';
  active: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="radio"
      aria-checked={active}
      tabIndex={0}
      className={`side side-${side}${active ? ' active' : ''}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a')) return;
        onSelect();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {children}
    </div>
  );
}

function ChoiceButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={active ? 'btn choice active' : 'btn choice'}
      aria-pressed={active}
      onClick={onClick}
    >
      {active && <Icon name="check" size={16} />}
      {children}
    </button>
  );
}

function MergeView({
  file: f,
  r,
  dispatch,
  paths,
}: {
  file: ProposalFile;
  r: ResolutionState[string] | undefined;
  dispatch: Dispatch;
  paths: readonly string[];
}) {
  const merge = f.merge!;
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  return (
    <div className="merge-view">
      {merge.frontmatterConflicts.map((c) => {
        const chosen = r?.frontmatter?.[c.key];
        return (
          <div key={c.key} className="conflict">
            <p className="conflict-title">
              プロパティ <code>{c.key}</code>
            </p>
            <div className="choice-stack" role="radiogroup" aria-label="どちらを残すか">
              <SideOption
                side="ours"
                active={chosen === 'ours'}
                onSelect={() =>
                  dispatch({ type: 'frontmatter', path: f.path, key: c.key, choice: 'ours' })
                }
              >
                <span className="side-label">上: いまの内容</span>
                <span className="side-body mono">
                  {c.ours === undefined ? '(なし)' : displayValue(c.ours)}
                </span>
              </SideOption>
              <SideOption
                side="theirs"
                active={chosen === 'theirs'}
                onSelect={() =>
                  dispatch({ type: 'frontmatter', path: f.path, key: c.key, choice: 'theirs' })
                }
              >
                <span className="side-label">下: 提案</span>
                <span className="side-body mono">
                  {c.theirs === undefined ? '(なし)' : displayValue(c.theirs)}
                </span>
              </SideOption>
            </div>
          </div>
        );
      })}
      {merge.segments.map((s, i) => {
        if (s.type === 'stable') {
          return (
            <details key={`s${i}`} className="stable">
              <summary>変更のない部分</summary>
              <Markdown text={s.text} paths={paths} className="small" />
            </details>
          );
        }
        const c = s.conflict;
        const chosen: Choice | undefined = r?.blocks?.[s.index];
        const isCustom = typeof chosen === 'object';
        return (
          <div
            key={`c${s.index}`}
            className="conflict"
            role="group"
            aria-label={`競合 ${s.index + 1}`}
          >
            <p className="conflict-title">
              競合 {s.index + 1}
              <span className={chosen === undefined ? 'pill pill-warn' : 'pill pill-ok'}>
                {choiceLabel(chosen)}
              </span>
            </p>
            <div className="choice-stack" role="radiogroup" aria-label="どちらを残すか">
              <SideOption
                side="ours"
                active={chosen === 'ours'}
                onSelect={() =>
                  dispatch({ type: 'block', path: f.path, index: s.index, choice: 'ours' })
                }
              >
                <span className="side-label">上: いまの内容</span>
                {c.ours.trim() ? (
                  <Markdown text={c.ours} paths={paths} className="side-body" />
                ) : (
                  <span className="side-body hint">(削除されています)</span>
                )}
              </SideOption>
              <SideOption
                side="theirs"
                active={chosen === 'theirs'}
                onSelect={() =>
                  dispatch({ type: 'block', path: f.path, index: s.index, choice: 'theirs' })
                }
              >
                <span className="side-label">下: 提案</span>
                {c.theirs.trim() ? (
                  <Markdown text={c.theirs} paths={paths} className="side-body" />
                ) : (
                  <span className="side-body hint">(削除されています)</span>
                )}
              </SideOption>
            </div>
            <div className="row wrap">
              <button
                type="button"
                className={chosen === 'both' ? 'btn btn-small active' : 'btn btn-small'}
                aria-pressed={chosen === 'both'}
                onClick={() =>
                  dispatch({ type: 'block', path: f.path, index: s.index, choice: 'both' })
                }
              >
                両方
              </button>
              <button
                type="button"
                className={isCustom ? 'btn btn-small active' : 'btn btn-small'}
                onClick={() => {
                  setDraft(
                    isCustom
                      ? (chosen as { custom: string }).custom
                      : [c.ours.trimEnd(), c.theirs.trimEnd()].filter(Boolean).join('\n\n'),
                  );
                  setEditing(s.index);
                }}
              >
                自分で編集
              </button>
            </div>
            {editing === s.index && (
              <div className="custom-edit">
                <label className="visually-hidden" htmlFor={`custom-${s.index}`}>
                  統合後の文章
                </label>
                <textarea
                  id={`custom-${s.index}`}
                  className="input textarea mono"
                  rows={6}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <div className="row">
                  <button type="button" className="btn btn-small" onClick={() => setEditing(null)}>
                    キャンセル
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-primary"
                    onClick={() => {
                      dispatch({
                        type: 'block',
                        path: f.path,
                        index: s.index,
                        choice: { custom: draft.endsWith('\n') ? draft : draft + '\n' },
                      });
                      setEditing(null);
                    }}
                  >
                    これを使う
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DiffView({ file: f, paths }: { file: ProposalFile; paths: readonly string[] }) {
  if (!f.path.match(/\.(md|ya?ml|txt)$/i)) return <p className="hint">(テキスト以外のファイル)</p>;
  if (f.status === 'deleted') return <p className="hint">このファイルを削除します。</p>;
  if (!f.diff.length) return <p className="hint">内容の変更はありません。</p>;
  return (
    <div className="diff">
      {f.diff.map((op, i) => {
        switch (op.op) {
          case 'equal':
            return (
              <details key={i} className="stable">
                <summary>変更のない {op.items.length} 段落</summary>
                <Markdown text={op.items.join('\n\n')} paths={paths} className="small" />
              </details>
            );
          case 'delete':
            return (
              <div key={i} className="diff-del" aria-label="削除">
                <span className="diff-sign" aria-hidden="true">
                  −
                </span>
                <Markdown text={op.items.join('\n\n')} paths={paths} />
              </div>
            );
          case 'insert':
            return (
              <div key={i} className="diff-ins" aria-label="追加">
                <span className="diff-sign" aria-hidden="true">
                  +
                </span>
                <Markdown text={op.items.join('\n\n')} paths={paths} />
              </div>
            );
          case 'replace':
            return (
              <div key={i} className="diff-rep">
                <div className="diff-del" aria-label="変更前">
                  <span className="diff-sign" aria-hidden="true">
                    −
                  </span>
                  <Markdown text={op.from.join('\n\n')} paths={paths} />
                </div>
                <div className="diff-ins" aria-label="変更後">
                  <span className="diff-sign" aria-hidden="true">
                    +
                  </span>
                  <Markdown text={op.to.join('\n\n')} paths={paths} />
                </div>
              </div>
            );
        }
        return null;
      })}
    </div>
  );
}
