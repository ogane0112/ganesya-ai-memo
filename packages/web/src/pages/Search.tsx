import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, describeError } from '../api/client';
import type { AskResult, PublicFinding, SearchHit } from '../api/types';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/MarkdownView';
import { FindingList, SensitiveConfirm } from '../components/SensitiveConfirm';
import {
  Badge,
  EmptyState,
  ErrorBox,
  Loading,
  PageHeader,
  Segmented,
  Spinner,
} from '../components/ui';
import { useDocumentTitle, useOnline } from '../lib/hooks';
import { highlightSnippet, linkCitations } from '../lib/markdown';
import { folderOf, noteUrl } from '../lib/paths';
import { useApp } from '../state/app';

type Tab = 'search' | 'ask';
type Mode = 'hybrid' | 'text' | 'vector';

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'ask' ? 'ask' : 'search';
  useDocumentTitle(tab === 'ask' ? 'ノートに質問' : '検索');
  const online = useOnline();
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === 'ask') next.set('tab', 'ask');
    else next.delete('tab');
    setParams(next, { replace: true });
  };
  return (
    <div className="page">
      <PageHeader title={tab === 'ask' ? 'ノートに質問' : '検索'} />
      <Segmented<Tab>
        label="モード"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'search', label: '検索' },
          { value: 'ask', label: 'ノートに質問' },
        ]}
      />
      {!online && <p className="notice notice-warn">オフラインのため検索できません。</p>}
      {tab === 'search' ? <SearchTab /> : <AskTab />}
    </div>
  );
}

function SearchTab() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [mode, setMode] = useState<Mode>('hybrid');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const query = params.get('q') ?? '';

  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    api
      .search(query, mode, ctl.signal)
      .then(setHits)
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError(e);
      })
      .finally(() => setLoading(false));
    return () => ctl.abort();
  }, [query, mode]);

  // Search as you type (debounced).
  useEffect(() => {
    const t = setTimeout(() => {
      if (q === query) return;
      const next = new URLSearchParams(params);
      if (q.trim()) next.set('q', q);
      else next.delete('q');
      setParams(next, { replace: true });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <>
      <form
        role="search"
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          const next = new URLSearchParams(params);
          next.set('q', q);
          setParams(next, { replace: true });
        }}
      >
        <label className="visually-hidden" htmlFor="search-q">
          検索語
        </label>
        <input
          id="search-q"
          className="input input-large"
          type="search"
          placeholder="キーワード、#タグ、ふつうの文章でも"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
          enterKeyHint="search"
        />
        <label className="visually-hidden" htmlFor="search-mode">
          検索方式
        </label>
        <select
          id="search-mode"
          className="input select"
          value={mode}
          onChange={(e) => setMode(e.target.value as Mode)}
        >
          <option value="hybrid">おまかせ</option>
          <option value="text">キーワード</option>
          <option value="vector">意味で探す</option>
        </select>
      </form>
      {loading && <Loading label="検索中…" />}
      {error ? <ErrorBox error={error} /> : null}
      {!loading && hits && hits.length === 0 && (
        <EmptyState icon="search" title="見つかりませんでした" />
      )}
      {!loading && hits && hits.length > 0 && (
        <ul className="card-list" aria-label="検索結果">
          {hits.map((h) => (
            <li key={h.path}>
              <Link to={noteUrl(h.path)} className="note-card">
                <span className="note-card-title">{h.title}</span>
                <span className="note-card-meta">
                  <span className="mono ellipsis">{folderOf(h.path)}</span>
                  {h.matchedBy.includes('vector') && !h.matchedBy.includes('text') && (
                    <Badge>意味が近い</Badge>
                  )}
                </span>
                {h.snippet && (
                  <span
                    className="snippet"
                    dangerouslySetInnerHTML={{ __html: highlightSnippet(h.snippet) }}
                  />
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {!query && (
        <p className="hint pad">
          ノートの本文・タイトル・タグを検索します。「意味で探す」は言い回しが違っても近い内容を見つけます。
        </p>
      )}
    </>
  );
}

type Prefer = 'auto' | 'local' | 'external';

function AskTab() {
  const [params] = useSearchParams();
  const pinned = params.get('path');
  const { paths } = useApp();
  const [question, setQuestion] = useState('');
  const [prefer, setPrefer] = useState<Prefer>('auto');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<{
    kind: 'blocked' | 'unavailable' | 'other';
    message: string;
    findings?: PublicFinding[];
  } | null>(null);
  const [confirmFindings, setConfirmFindings] = useState<PublicFinding[] | null>(null);
  const status = useStatus();
  const noAi = status !== null && !status.local && !status.external;

  const ask = async (confirm = false) => {
    if (!question.trim()) return;
    setBusy(true);
    setError(null);
    if (!confirm) setResult(null);
    try {
      const r = await api.ask({
        question: question.trim(),
        prefer,
        ...(confirm ? { confirm: true } : {}),
        ...(pinned ? { paths: [pinned] } : {}),
      });
      setResult(r);
    } catch (e) {
      if (e instanceof ApiError && e.status === 428) setConfirmFindings(e.findings);
      else if (e instanceof ApiError && e.status === 422)
        setError({
          kind: 'blocked',
          message:
            '機密情報が含まれるため、外部AIへの送信はブロックされました。ローカルAIを使うか、ノートの送信設定を見直してください。',
          findings: e.findings,
        });
      else if (e instanceof ApiError && e.status === 503)
        setError({ kind: 'unavailable', message: e.message });
      else setError({ kind: 'other', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form
        className="ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        {pinned && (
          <p className="hint">
            対象: <Link to={noteUrl(pinned)}>{pinned}</Link> を優先して参照します
          </p>
        )}
        <label htmlFor="ask-q" className="visually-hidden">
          質問
        </label>
        <textarea
          id="ask-q"
          className="input textarea"
          rows={3}
          placeholder="例: 先月の打ち合わせで決まったことは?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void ask();
          }}
        />
        <div className="row wrap between">
          <label className="inline-field">
            <span>使うAI</span>
            <select
              className="input select"
              value={prefer}
              onChange={(e) => setPrefer(e.target.value as Prefer)}
            >
              <option value="auto">おまかせ</option>
              <option value="local" disabled={status !== null && !status.local}>
                ローカルAI{status?.local ? `(${status.local})` : '(未設定)'}
              </option>
              <option
                value="external"
                disabled={status !== null && (!status.external || !status.externalAcknowledged)}
              >
                外部AI{status?.external ? `(${status.external})` : '(未設定)'}
              </option>
            </select>
          </label>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !question.trim() || noAi}
          >
            {busy ? <Spinner /> : <Icon name="ask" size={18} />}
            質問する
          </button>
        </div>
      </form>
      {noAi && (
        <p className="notice notice-warn">
          AIが設定されていません。サーバーの環境変数でローカルLLMまたは外部AIを設定してください。
        </p>
      )}
      {busy && <Loading label="ノートを読んで考えています…" />}
      {error && (
        <div
          className={error.kind === 'blocked' ? 'notice notice-error' : 'notice notice-warn'}
          role="alert"
        >
          <strong>
            {error.kind === 'blocked'
              ? '送信をブロックしました'
              : error.kind === 'unavailable'
                ? 'AIを利用できません'
                : 'エラー'}
          </strong>
          <p>{error.message}</p>
          {error.findings && error.findings.length > 0 && <FindingList findings={error.findings} />}
        </div>
      )}
      {result && (
        <section className="answer" aria-label="回答">
          <Markdown text={linkCitations(result.answer, result.sources)} paths={paths} />
          {result.sources.length > 0 && (
            <>
              <h3>参照したノート</h3>
              <ol className="sources">
                {result.sources.map((s) => (
                  <li key={s.n} value={s.n}>
                    <Link to={noteUrl(s.path)}>{s.title}</Link>
                  </li>
                ))}
              </ol>
            </>
          )}
          <p className="hint">
            {result.target === 'external' ? '外部AI' : 'ローカルAI'}({result.model})で回答
            {result.masked && ' ・機密らしき部分は伏せて送信しました'}
            {result.excluded.length > 0 &&
              ` ・送信設定により ${result.excluded.length} 件のノートを除外しました`}
          </p>
        </section>
      )}
      <SensitiveConfirm
        open={!!confirmFindings}
        findings={confirmFindings ?? []}
        onCancel={() => setConfirmFindings(null)}
        onConfirm={() => {
          setConfirmFindings(null);
          void ask(true);
        }}
      />
    </>
  );
}

function useStatus() {
  const [s, setS] = useState<{
    local: string | null;
    external: string | null;
    externalAcknowledged: boolean;
  } | null>(null);
  useEffect(() => {
    api.aiStatus().then(setS, () => undefined);
  }, []);
  return s;
}
