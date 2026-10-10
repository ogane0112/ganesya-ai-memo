import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, describeError } from '../../api/client';
import type { CalendarSubscription } from '../../api/types';
import { Badge, CopyButton, ErrorBox, Loading, Spinner } from '../../components/ui';
import { relativeTime } from '../../lib/format';
import { useAsync } from '../../lib/hooks';
import { useToast } from '../../state/toast';

const COLORS = ['#4f7cff', '#e5534b', '#2da44e', '#bf8700', '#8250df', '#1b9aaa'];

export function CalendarSettings() {
  return (
    <div className="stack">
      <SubscriptionsSection />
      <FeedsSection />
    </div>
  );
}

// ---- Google Calendar → this app ---------------------------------------------------

function SubscriptionsSection() {
  const toast = useToast();
  const subs = useAsync(() => api.calendarSubscriptions(), []);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [color, setColor] = useState(COLORS[0]!);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.show(describeError(e), { kind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    void run('add', async () => {
      const s = await api.addCalendarSubscription({ name, url, color });
      setName('');
      setUrl('');
      subs.reload();
      if (s.lastError)
        toast.show(`追加しましたが、取得に失敗しました: ${s.lastError}`, { kind: 'error' });
      else toast.show(`「${s.name}」を追加しました(${s.eventCount ?? 0} 件)`, { kind: 'success' });
    });
  };

  return (
    <section className="card">
      <h2>外部カレンダーを取り込む</h2>
      <p className="hint">
        Googleカレンダーなどの予定を、アプリのカレンダービューに重ねて表示します(読み取りのみ)。予定はこのサーバーが取得し、アプリから外へは何も送りません。
      </p>
      <details className="help">
        <summary>GoogleカレンダーのURLの調べ方</summary>
        <ol>
          <li>パソコンのブラウザで Googleカレンダーを開き、右上の歯車 →「設定」</li>
          <li>左の「マイカレンダーの設定」から取り込みたいカレンダーを選ぶ</li>
          <li>
            「カレンダーの統合」にある<strong>「iCal 形式の非公開URL」</strong>
            をコピーして、下に貼り付ける
          </li>
        </ol>
        <p className="hint">
          非公開URLを知っている人は誰でも予定を見られます。外部に共有しないでください。URLはこのサーバーの管理DBに保存されます(バックアップにも含まれます)。漏れた場合はGoogle側で「リセット」できます。
        </p>
      </details>

      {subs.loading && !subs.data ? (
        <Loading />
      ) : subs.error ? (
        <ErrorBox error={subs.error} onRetry={subs.reload} />
      ) : subs.data && subs.data.length > 0 ? (
        <ul className="item-list">
          {subs.data.map((s) => (
            <SubscriptionItem key={s.id} sub={s} busy={busy} run={run} onChange={subs.reload} />
          ))}
        </ul>
      ) : (
        <p className="hint">まだ取り込んでいるカレンダーはありません。</p>
      )}

      <form onSubmit={add} className="stack">
        <div className="field">
          <label htmlFor="cal-url">iCal 形式のURL</label>
          <input
            id="cal-url"
            className="input"
            type="url"
            inputMode="url"
            required
            placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="row wrap">
          <div className="field grow">
            <label htmlFor="cal-name">表示名(省略するとカレンダー名)</label>
            <input
              id="cal-name"
              className="input"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="cal-color">色</label>
            <input
              id="cal-color"
              className="color-input"
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </div>
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy !== null || !url.trim()}>
          {busy === 'add' && <Spinner />}
          追加して取得
        </button>
      </form>
    </section>
  );
}

function SubscriptionItem({
  sub: s,
  busy,
  run,
  onChange,
}: {
  sub: CalendarSubscription;
  busy: string | null;
  run: (key: string, fn: () => Promise<void>) => Promise<void>;
  onChange: () => void;
}) {
  const toast = useToast();
  return (
    <li className="item">
      <div className="item-main">
        <strong>
          <span className="color-dot" style={{ background: s.color }} aria-hidden="true" /> {s.name}
        </strong>
        <span className="hint">
          {s.urlPreview} ・ {s.eventCount ?? 0} 件 ・ 最終取得{' '}
          {s.fetchedAt ? relativeTime(s.fetchedAt) : '—'}
        </span>
        {s.lastError && <span className="text-danger">取得エラー: {s.lastError}</span>}
      </div>
      <div className="row wrap">
        {!s.enabled && <Badge tone="warn">非表示</Badge>}
        <label className="check small">
          <input
            type="checkbox"
            checked={s.enabled}
            onChange={(e) =>
              void run(`toggle-${s.id}`, async () => {
                await api.updateCalendarSubscription(s.id, { enabled: e.target.checked });
                onChange();
              })
            }
          />
          表示
        </label>
        <button
          type="button"
          className="btn btn-small"
          disabled={busy !== null}
          onClick={() =>
            void run(`refresh-${s.id}`, async () => {
              const r = await api.refreshCalendarSubscription(s.id);
              onChange();
              if (r?.lastError) toast.show(`取得に失敗しました: ${r.lastError}`, { kind: 'error' });
              else toast.show('更新しました', { kind: 'success' });
            })
          }
        >
          {busy === `refresh-${s.id}` && <Spinner />}
          今すぐ更新
        </button>
        <button
          type="button"
          className="btn btn-small btn-danger-text"
          disabled={busy !== null}
          onClick={() => {
            if (!confirm(`「${s.name}」の取り込みをやめますか?`)) return;
            void run(`del-${s.id}`, async () => {
              await api.deleteCalendarSubscription(s.id);
              onChange();
            });
          }}
        >
          削除
        </button>
      </div>
    </li>
  );
}

// ---- this app → Google Calendar ------------------------------------------------------

function FeedsSection() {
  const toast = useToast();
  const feeds = useAsync(() => api.calendarFeeds(), []);
  const views = useAsync(() => api.views(), []);
  const calendarViews = (views.data ?? []).filter((v) => v.view?.type === 'calendar');
  const [viewId, setViewId] = useState('');
  const [includeLinks, setIncludeLinks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = viewId || calendarViews[0]?.id;
    if (!id) return;
    setBusy(true);
    try {
      const r = await api.createCalendarFeed({ viewId: id, includeLinks });
      setCreated(r.url);
      feeds.reload();
    } catch (err) {
      toast.show(describeError(err), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const viewName = (id: string) => views.data?.find((v) => v.id === id)?.view?.name ?? id;

  return (
    <section className="card">
      <h2>ノートの予定をGoogleカレンダーに表示する</h2>
      <p className="hint">
        カレンダー型のビューを、Googleカレンダーなどで購読できるURLとして公開します(読み取りのみ。Google側の反映には数時間かかることがあります)。
      </p>
      <div className="notice notice-warn">
        <strong>外に出る情報:</strong>
        予定のタイトルと日時(と、選んだ場合はノートへのリンク)。対象は
        <Link to="/settings/ai">AIポリシー</Link>で<strong>「外部AI可」</strong>
        のフォルダにあるノートだけで、
        <code>sensitivity: secret</code>
        のノートは含まれません。機密情報が検出されたタイトルは「予定」に置き換わります。Googleがこのサーバーに取りに来るので、サーバーがインターネットから見えている必要があります。
      </div>

      {created && (
        <div className="secret-reveal">
          <h3>購読URL</h3>
          <p className="hint">
            このURLは今だけ表示されます。Googleカレンダーの「他のカレンダー」→「＋」→「URLで追加」に貼り付けてください。
          </p>
          <pre className="secret-box feed-url" tabIndex={0}>
            {created}
          </pre>
          <div className="row wrap">
            <CopyButton text={created} />
            <button type="button" className="btn btn-small" onClick={() => setCreated(null)}>
              閉じる
            </button>
          </div>
        </div>
      )}

      {feeds.data && feeds.data.length > 0 && (
        <ul className="item-list">
          {feeds.data.map((f) => (
            <li key={f.id} className="item">
              <div className="item-main">
                <strong>{f.label || viewName(f.viewId)}</strong>
                <span className="hint">
                  ビュー: {viewName(f.viewId)} ・ {f.includeLinks ? 'リンクあり' : 'リンクなし'} ・
                  最終アクセス {f.lastFetchedAt ? relativeTime(f.lastFetchedAt) : 'まだなし'}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-small btn-danger-text"
                onClick={async () => {
                  if (
                    !confirm(
                      'このURLを無効にしますか?購読しているカレンダーには表示されなくなります。',
                    )
                  )
                    return;
                  try {
                    await api.revokeCalendarFeed(f.id);
                    feeds.reload();
                  } catch (err) {
                    toast.show(describeError(err), { kind: 'error' });
                  }
                }}
              >
                無効にする
              </button>
            </li>
          ))}
        </ul>
      )}

      {views.loading && !views.data ? (
        <Loading />
      ) : calendarViews.length === 0 ? (
        <p className="hint">
          カレンダー型のビューがありません。<Link to="/views/new">ビューを作成</Link>してください。
        </p>
      ) : (
        <form onSubmit={create} className="stack">
          <div className="field">
            <label htmlFor="feed-view">公開するビュー</label>
            <select
              id="feed-view"
              className="input"
              value={viewId || calendarViews[0]!.id}
              onChange={(e) => setViewId(e.target.value)}
            >
              {calendarViews.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.view?.name ?? v.id}
                </option>
              ))}
            </select>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={includeLinks}
              onChange={(e) => setIncludeLinks(e.target.checked)}
            />
            予定にノートへのリンクを含める(リンクにはノートのファイル名が含まれます)
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <Spinner />}
            購読URLを作成
          </button>
        </form>
      )}
    </section>
  );
}
