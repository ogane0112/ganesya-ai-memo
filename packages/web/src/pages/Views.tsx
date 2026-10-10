import { getProperty, type ViewDefinition, type ViewNote } from '@gmemo/core';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, describeError } from '../api/client';
import type { ViewRows } from '../api/types';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorBox, Loading, PageHeader } from '../components/ui';
import { displayValue, localDateKey } from '../lib/format';
import { useAsync, useDocumentTitle, useIsPhone } from '../lib/hooks';
import { noteUrl } from '../lib/paths';
import {
  emptyViewForm,
  FILTER_OPS,
  formFromView,
  formToYaml,
  propertyLabel,
  VIEW_TYPES,
  type ViewForm,
  yamlToForm,
} from '../lib/viewYaml';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';

const TYPE_ICON = { table: 'table', kanban: 'kanban', calendar: 'calendar', list: 'list' } as const;

export function ViewsPage() {
  useDocumentTitle('ビュー');
  const views = useAsync(() => api.views(), []);
  return (
    <div className="page">
      <PageHeader
        title="ビュー"
        sub="ノートのプロパティを表・カンバン・カレンダーで見る"
        actions={
          <Link to="/views/new" className="btn btn-primary">
            <Icon name="plus" size={18} />
            新規
          </Link>
        }
      />
      {views.loading ? (
        <Loading />
      ) : views.error ? (
        <ErrorBox error={views.error} onRetry={views.reload} />
      ) : !views.data?.length ? (
        <EmptyState icon="table" title="ビューはまだありません">
          <p>フォルダやタグ、プロパティ(frontmatter)で絞り込んだ一覧を作れます。</p>
          <Link to="/views/new" className="btn btn-primary">
            ビューを作る
          </Link>
        </EmptyState>
      ) : (
        <ul className="card-list">
          {views.data.map((v) => (
            <li key={v.id}>
              <Link to={`/views/${encodeURIComponent(v.id)}`} className="note-card">
                <span className="note-card-title">
                  <Icon name={v.view ? TYPE_ICON[v.view.type] : 'table'} size={18} />{' '}
                  {v.view?.name ?? v.id}
                </span>
                <span className="note-card-meta">
                  {v.error ? (
                    <span className="text-danger">エラー: {v.error}</span>
                  ) : (
                    <span>{VIEW_TYPES.find((t) => t.value === v.view?.type)?.label}</span>
                  )}
                  {v.view?.folder && <span className="mono">{v.view.folder}/</span>}
                  {v.view?.tag && <span className="tag">#{v.view.tag}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ViewPage() {
  const { id = '' } = useParams();
  const { changeTick } = useApp();
  const data = useAsync(() => api.viewRows(id), [id, changeTick]);
  const phone = useIsPhone();
  const navigate = useNavigate();
  useDocumentTitle(data.data?.view.name ?? 'ビュー');
  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  const { view, rows } = data.data!;
  return (
    <div className="page page-wide">
      <PageHeader
        title={view.name}
        back={() => navigate('/views')}
        sub={`${rows.length} 件${phone && view.type !== 'list' ? '(スマホではリスト表示)' : ''}`}
        actions={
          <Link to={`/views/${encodeURIComponent(id)}/edit`} className="btn">
            <Icon name="edit" size={18} />
            編集
          </Link>
        }
      />
      {rows.length === 0 ? (
        <EmptyState icon="table" title="条件に合うノートがありません" />
      ) : phone || view.type === 'list' ? (
        <RowList view={view} rows={rows} />
      ) : view.type === 'table' ? (
        <TableView view={view} rows={rows} />
      ) : view.type === 'kanban' ? (
        <KanbanView view={view} data={data.data!} />
      ) : (
        <CalendarView view={view} rows={rows} />
      )}
    </div>
  );
}

function RowList({ view, rows }: { view: ViewDefinition; rows: ViewNote[] }) {
  const cols = view.columns.filter((c) => c !== '$title');
  const extra =
    view.type === 'kanban'
      ? [view.groupBy ?? 'status']
      : view.type === 'calendar'
        ? [view.dateProperty ?? 'date']
        : [];
  const shown = [...new Set([...extra, ...cols])].slice(0, 4);
  return (
    <ul className="card-list">
      {rows.map((r) => (
        <li key={r.path}>
          <Link to={noteUrl(r.path)} className="note-card">
            <span className="note-card-title">{r.title}</span>
            <span className="note-card-meta">
              {shown.map((c) => {
                const v = displayValue(getProperty(r, c));
                return v ? (
                  <span key={c}>
                    <span className="hint">{propertyLabel(c)}:</span> {v}
                  </span>
                ) : null;
              })}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function TableView({ view, rows }: { view: ViewDefinition; rows: ViewNote[] }) {
  const cols = view.columns.length ? view.columns : ['$title'];
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} scope="col">
                {propertyLabel(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.path}>
              {cols.map((c, i) => (
                <td key={c}>
                  {i === 0 || c === '$title' ? (
                    <Link to={noteUrl(r.path)}>{displayValue(getProperty(r, c)) || r.title}</Link>
                  ) : (
                    displayValue(getProperty(r, c))
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KanbanView({ view, data }: { view: ViewDefinition; data: ViewRows }) {
  const groups = data.groups ?? [];
  const cols = view.columns.filter((c) => c !== '$title' && c !== view.groupBy).slice(0, 3);
  return (
    <div className="kanban" role="list">
      {groups.map((g) => (
        <section key={g.key} className="kanban-col" role="listitem" aria-label={g.key || '未設定'}>
          <h2 className="kanban-head">
            {g.key || '(未設定)'} <span className="count">{g.rows.length}</span>
          </h2>
          <ul className="kanban-cards">
            {g.rows.map((r) => (
              <li key={r.path}>
                <Link to={noteUrl(r.path)} className="kanban-card">
                  <span className="note-card-title">{r.title}</span>
                  {cols.map((c) => {
                    const v = displayValue(getProperty(r, c));
                    return v ? (
                      <span key={c} className="hint">
                        {propertyLabel(c)}: {v}
                      </span>
                    ) : null;
                  })}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function toDateKey(v: unknown): string | null {
  if (v instanceof Date) return localDateKey(v);
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function CalendarView({ view, rows }: { view: ViewDefinition; rows: ViewNote[] }) {
  const prop = view.dateProperty ?? 'date';
  const byDay = useMemo(() => {
    const m = new Map<string, ViewNote[]>();
    for (const r of rows) {
      const k = toDateKey(getProperty(r, prop));
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return m;
  }, [rows, prop]);
  const first = useMemo(() => {
    const keys = [...byDay.keys()].sort();
    const today = new Date();
    const thisMonth = localDateKey(today).slice(0, 7);
    const target =
      keys.some((k) => k.startsWith(thisMonth)) || !keys.length
        ? thisMonth
        : keys[keys.length - 1]!.slice(0, 7);
    return target;
  }, [byDay]);
  const [month, setMonth] = useState(first);
  useEffect(() => setMonth(first), [first]);
  const [y, mo] = month.split('-').map(Number) as [number, number];
  const start = new Date(y, mo - 1, 1);
  const offset = (start.getDay() + 6) % 7; // Monday first
  const days = new Date(y, mo, 0).getDate();
  const cells: (Date | null)[] = [
    ...Array<null>(offset).fill(null),
    ...Array.from({ length: days }, (_, i) => new Date(y, mo - 1, i + 1)),
  ];
  while (cells.length % 7) cells.push(null);
  const shift = (d: number) => {
    const n = new Date(y, mo - 1 + d, 1);
    setMonth(`${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`);
  };
  const today = localDateKey(new Date());
  const undated = rows.filter((r) => !toDateKey(getProperty(r, prop)));
  return (
    <div className="calendar">
      <div className="calendar-nav">
        <button type="button" className="icon-btn" onClick={() => shift(-1)} aria-label="前の月">
          <Icon name="back" />
        </button>
        <h2>
          {y}年{mo}月
        </h2>
        <button type="button" className="icon-btn" onClick={() => shift(1)} aria-label="次の月">
          <Icon name="chevron" />
        </button>
      </div>
      <div className="calendar-grid" role="grid" aria-label={`${y}年${mo}月`}>
        {['月', '火', '水', '木', '金', '土', '日'].map((d) => (
          <div key={d} className="calendar-dow" role="columnheader">
            {d}
          </div>
        ))}
        {cells.map((d, i) => {
          if (!d) return <div key={`e${i}`} className="calendar-cell empty" role="gridcell" />;
          const k = localDateKey(d);
          const items = byDay.get(k) ?? [];
          return (
            <div
              key={k}
              className={k === today ? 'calendar-cell today' : 'calendar-cell'}
              role="gridcell"
            >
              <span className="calendar-day">{d.getDate()}</span>
              {items.map((r) => (
                <Link key={r.path} to={noteUrl(r.path)} className="calendar-item" title={r.title}>
                  {r.title}
                </Link>
              ))}
            </div>
          );
        })}
      </div>
      {undated.length > 0 && (
        <p className="hint">
          日付({prop})のないノート: {undated.length} 件
        </p>
      )}
    </div>
  );
}

export function ViewEditPage() {
  const params = useParams();
  const isNew = !params['id'];
  const [id, setId] = useState(params['id'] ?? '');
  const existing = useAsync(
    async () => (isNew ? null : ((await api.views()).find((v) => v.id === params['id']) ?? null)),
    [params['id']],
  );
  const [form, setForm] = useState<ViewForm>(emptyViewForm);
  const [yaml, setYaml] = useState('');
  const [mode, setMode] = useState<'form' | 'yaml'>('form');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();
  useDocumentTitle(isNew ? '新しいビュー' : 'ビューを編集');

  useEffect(() => {
    if (existing.data) {
      setYaml(existing.data.source);
      if (existing.data.view) setForm(formFromView(existing.data.view));
      else setMode('yaml');
    }
  }, [existing.data]);

  const set = <K extends keyof ViewForm>(k: K, v: ViewForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const switchMode = (m: 'form' | 'yaml') => {
    setError(null);
    if (m === 'yaml') setYaml(formToYaml(form));
    else {
      try {
        setForm(yamlToForm(id || 'view', yaml));
      } catch (e) {
        setError(`YAMLを読み込めません: ${(e as Error).message}`);
        return;
      }
    }
    setMode(m);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const vid = id.trim();
    if (!/^[\w\-\u3000-\u9fff]+$/.test(vid)) {
      setError('IDは英数字・日本語・- _ のみ使えます');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.saveView(vid, mode === 'yaml' ? yaml : formToYaml(form));
      toast.show('保存しました', { kind: 'success' });
      navigate(`/views/${encodeURIComponent(vid)}`, { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm('このビューを削除しますか?')) return;
    try {
      await api.deleteView(id);
      navigate('/views', { replace: true });
    } catch (err) {
      setError(describeError(err));
    }
  };

  if (!isNew && existing.loading) return <Loading />;
  if (!isNew && existing.error)
    return <ErrorBox error={existing.error} onRetry={existing.reload} />;

  return (
    <form className="page" onSubmit={(e) => void save(e)}>
      <PageHeader
        title={isNew ? '新しいビュー' : `ビューを編集: ${form.name || id}`}
        back={() => navigate(isNew ? '/views' : `/views/${encodeURIComponent(id)}`)}
      />
      <div className="segmented" role="tablist" aria-label="編集方法">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'form'}
          className={mode === 'form' ? 'active' : ''}
          onClick={() => switchMode('form')}
        >
          フォーム
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'yaml'}
          className={mode === 'yaml' ? 'active' : ''}
          onClick={() => switchMode('yaml')}
        >
          YAML
        </button>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="v-id">ID(ファイル名)</label>
          <input
            id="v-id"
            className="input mono"
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={!isNew}
            required
            placeholder="tasks"
          />
        </div>
        {mode === 'form' ? (
          <>
            <div className="field">
              <label htmlFor="v-name">名前</label>
              <input
                id="v-name"
                className="input"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="タスク"
              />
            </div>
            <div className="field">
              <label htmlFor="v-type">表示</label>
              <select
                id="v-type"
                className="input select"
                value={form.type}
                onChange={(e) => set('type', e.target.value as ViewForm['type'])}
              >
                {VIEW_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="v-folder">フォルダ</label>
              <input
                id="v-folder"
                className="input"
                value={form.folder}
                onChange={(e) => set('folder', e.target.value)}
                placeholder="Projects"
              />
            </div>
            <div className="field">
              <label htmlFor="v-tag">タグ</label>
              <input
                id="v-tag"
                className="input"
                value={form.tag}
                onChange={(e) => set('tag', e.target.value)}
                placeholder="task"
              />
            </div>
            <div className="field">
              <label htmlFor="v-cols">列(カンマ区切り)</label>
              <input
                id="v-cols"
                className="input"
                value={form.columns}
                onChange={(e) => set('columns', e.target.value)}
                placeholder="$title, status, due"
              />
              <div className="hint">
                $title / $path / $tags / $folder または frontmatter のプロパティ名
              </div>
            </div>
            {form.type === 'kanban' && (
              <>
                <div className="field">
                  <label htmlFor="v-groupby">グループ化するプロパティ</label>
                  <input
                    id="v-groupby"
                    className="input"
                    value={form.groupBy}
                    onChange={(e) => set('groupBy', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="v-groups">列の順番(カンマ区切り)</label>
                  <input
                    id="v-groups"
                    className="input"
                    value={form.groups}
                    onChange={(e) => set('groups', e.target.value)}
                    placeholder="todo, doing, done"
                  />
                </div>
              </>
            )}
            {form.type === 'calendar' && (
              <div className="field">
                <label htmlFor="v-date">日付のプロパティ</label>
                <input
                  id="v-date"
                  className="input"
                  value={form.dateProperty}
                  onChange={(e) => set('dateProperty', e.target.value)}
                />
              </div>
            )}
            <fieldset className="fieldset">
              <legend>絞り込み条件</legend>
              {form.filters.map((f, i) => (
                <div key={i} className="row wrap filter-row">
                  <input
                    className="input"
                    aria-label={`条件${i + 1}のプロパティ`}
                    value={f.property}
                    placeholder="status"
                    onChange={(e) =>
                      set(
                        'filters',
                        form.filters.map((x, j) =>
                          j === i ? { ...x, property: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <select
                    className="input select"
                    aria-label={`条件${i + 1}の比較`}
                    value={f.op}
                    onChange={(e) =>
                      set(
                        'filters',
                        form.filters.map((x, j) =>
                          j === i ? { ...x, op: e.target.value as typeof f.op } : x,
                        ),
                      )
                    }
                  >
                    {FILTER_OPS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {f.op !== 'exists' && f.op !== 'not_exists' && (
                    <input
                      className="input"
                      aria-label={`条件${i + 1}の値`}
                      value={displayValue(f.value)}
                      onChange={(e) =>
                        set(
                          'filters',
                          form.filters.map((x, j) =>
                            j === i ? { ...x, value: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  )}
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`条件${i + 1}を削除`}
                    onClick={() =>
                      set(
                        'filters',
                        form.filters.filter((_, j) => j !== i),
                      )
                    }
                  >
                    <Icon name="trash" size={18} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn btn-small"
                onClick={() =>
                  set('filters', [...form.filters, { property: '', op: 'eq', value: '' }])
                }
              >
                <Icon name="plus" size={16} />
                条件を追加
              </button>
            </fieldset>
            <fieldset className="fieldset">
              <legend>並び順</legend>
              {form.sort.map((s, i) => (
                <div key={i} className="row wrap filter-row">
                  <input
                    className="input"
                    aria-label={`並び順${i + 1}のプロパティ`}
                    value={s.property}
                    onChange={(e) =>
                      set(
                        'sort',
                        form.sort.map((x, j) => (j === i ? { ...x, property: e.target.value } : x)),
                      )
                    }
                  />
                  <select
                    className="input select"
                    aria-label={`並び順${i + 1}の向き`}
                    value={s.direction}
                    onChange={(e) =>
                      set(
                        'sort',
                        form.sort.map((x, j) =>
                          j === i ? { ...x, direction: e.target.value as 'asc' | 'desc' } : x,
                        ),
                      )
                    }
                  >
                    <option value="asc">昇順</option>
                    <option value="desc">降順</option>
                  </select>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`並び順${i + 1}を削除`}
                    onClick={() =>
                      set(
                        'sort',
                        form.sort.filter((_, j) => j !== i),
                      )
                    }
                  >
                    <Icon name="trash" size={18} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn btn-small"
                onClick={() => set('sort', [...form.sort, { property: '', direction: 'asc' }])}
              >
                <Icon name="plus" size={16} />
                並び順を追加
              </button>
            </fieldset>
          </>
        ) : (
          <div className="field">
            <label htmlFor="v-yaml">YAML</label>
            <textarea
              id="v-yaml"
              className="input textarea mono"
              rows={16}
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
              spellCheck={false}
            />
          </div>
        )}
      </div>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      <div className="row between">
        {!isNew ? (
          <button type="button" className="btn btn-danger-text" onClick={() => void remove()}>
            削除
          </button>
        ) : (
          <span />
        )}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          保存
        </button>
      </div>
    </form>
  );
}
