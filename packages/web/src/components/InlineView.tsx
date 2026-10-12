import {
  parseView,
  patchInlineViewSource,
  serializeNote,
  type ViewDefinition,
  type ViewType,
} from '@gmemo/core';
import { useEffect, useId, useMemo, useState } from 'react';
import { api, describeError } from '../api/client';
import { useAsync } from '../lib/hooks';
import { uniquePath } from '../lib/newNote';
import { displayPath } from '../lib/paths';
import { syncQueue } from '../lib/sync';
import { VIEW_TYPES } from '../lib/viewYaml';
import { ViewBody } from '../pages/Views';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { Icon } from './Icon';

function parse(source: string): { view: ViewDefinition } | { error: string } {
  try {
    return { view: parseView('inline', source) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * A list of notes inside a note, like an inline database in Notion: the
 * ```gmemo-view block of the Markdown, shown as a table, kanban, calendar or
 * list. The tabs, the settings and "+ 新規" all rewrite that block (through
 * `onChange`) or add notes to its folder; the YAML can still be edited by hand.
 * Without `onChange` (an old version of a note) the block is read-only.
 */
export function InlineView({
  source,
  onChange,
}: {
  source: string;
  onChange?: (next: string) => void;
}) {
  // Shown at once while the change is being saved.
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => setLocal(null), [source]);
  const current = local ?? source;
  const parsed = useMemo(() => parse(current), [current]);
  const { changeTick } = useApp();
  const data = useAsync(
    () =>
      'view' in parsed ? api.inlineViewRows(current) : Promise.reject(new Error(parsed.error)),
    [current, changeTick],
  );
  const [panel, setPanel] = useState<'none' | 'new' | 'settings'>('none');
  const toast = useToast();

  if ('error' in parsed)
    return (
      <div className="inline-view inline-view-broken" role="status">
        一覧の設定を読めません: {parsed.error}
        <span className="hint">「書く」で ```gmemo-view のブロックを直してください。</span>
      </div>
    );
  const view = parsed.view;

  const change = (patch: Record<string, unknown>) => {
    if (!onChange) return;
    try {
      const next = patchInlineViewSource(current, patch);
      setLocal(next);
      onChange(next);
    } catch (e) {
      toast.show(describeError(e), { kind: 'error' });
    }
  };

  return (
    <section className="inline-view" aria-label={view.name}>
      <div className="inline-view-head">
        <h3 className="inline-view-title">
          <Icon name="table" size={16} />
          {view.name === 'inline' ? '一覧' : view.name}
        </h3>
        <div className="segmented inline-view-tabs" role="tablist" aria-label="表示">
          {VIEW_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={view.type === t.value}
              className={view.type === t.value ? 'active' : ''}
              disabled={!onChange}
              onClick={() => change({ type: t.value as ViewType })}
            >
              {t.label}
            </button>
          ))}
        </div>
        {onChange && (
          <span className="row inline-view-actions">
            <button
              type="button"
              className="btn btn-small btn-primary"
              aria-expanded={panel === 'new'}
              onClick={() => setPanel(panel === 'new' ? 'none' : 'new')}
            >
              <Icon name="plus" size={16} />
              新規
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="一覧の設定"
              title="一覧の設定"
              aria-expanded={panel === 'settings'}
              onClick={() => setPanel(panel === 'settings' ? 'none' : 'settings')}
            >
              <Icon name="settings" size={18} />
            </button>
          </span>
        )}
      </div>
      {panel === 'new' && (
        <NewItem
          view={view}
          groups={(data.data?.groups ?? []).map((g) => g.key)}
          onDone={() => {
            setPanel('none');
            data.reload();
          }}
        />
      )}
      {panel === 'settings' && <Settings view={view} onChange={change} />}
      {data.error && !data.data ? (
        <p className="hint">読み込めませんでした: {describeError(data.error)}</p>
      ) : !data.data ? (
        <p className="hint">読み込み中…</p>
      ) : (
        <ViewBody
          data={data}
          empty={
            <p className="hint inline-view-empty">
              まだありません。{onChange ? '「+ 新規」で追加できます。' : ''}
            </p>
          }
        />
      )}
    </section>
  );
}

/** Add a note to the list's folder, already in the right column or on the right day. */
function NewItem({
  view,
  groups,
  onDone,
}: {
  view: ViewDefinition;
  groups: string[];
  onDone: () => void;
}) {
  const id = useId();
  const { notes, refreshNotes } = useApp();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [column, setColumn] = useState(groups[0] ?? '');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const prop = view.type === 'kanban' ? (view.groupBy ?? 'status') : null;
  const dateProp = view.type === 'calendar' ? (view.dateProperty ?? 'date') : null;

  if (!view.folder)
    return (
      <p className="hint inline-view-panel">
        この一覧には保存先のフォルダーがありません。設定でフォルダーを決めると追加できます。
      </p>
    );

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    // A "/" would put the note in a sub-folder (or outside the list's folder).
    const name = title.replace(/[\\/]+/g, ' ').trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const taken = new Set(notes.map((n) => n.path.toLowerCase()));
      const path = uniquePath(name, view.folder!, taken);
      const fm: Record<string, unknown> = {};
      if (prop && column && !prop.startsWith('$')) fm[prop] = column;
      if (dateProp && date) fm[dateProp] = date;
      await syncQueue.enqueue({
        kind: 'save',
        path,
        content: serializeNote(fm, `# ${name}\n`),
        baseSha: null,
      });
      await syncQueue.settled(path);
      refreshNotes();
      toast.show(`「${name}」を追加しました`, { kind: 'success', duration: 2000 });
      setTitle('');
      onDone();
    } catch (err) {
      toast.show(describeError(err), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="inline-view-panel props-form" onSubmit={(e) => void create(e)}>
      <div className="props-row">
        <label htmlFor={`${id}-t`}>タイトル</label>
        <input
          id={`${id}-t`}
          className="input"
          value={title}
          autoFocus
          enterKeyHint="done"
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      {prop && !prop.startsWith('$') && (
        <div className="props-row">
          <label htmlFor={`${id}-c`}>{prop === 'status' ? 'ステータス' : prop}</label>
          <input
            id={`${id}-c`}
            className="input"
            list={`${id}-cl`}
            value={column}
            onChange={(e) => setColumn(e.target.value)}
          />
          <datalist id={`${id}-cl`}>
            {[...new Set([...groups.filter(Boolean), '未着手', '進行中', '完了'])].map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </div>
      )}
      {dateProp && (
        <div className="props-row">
          <label htmlFor={`${id}-d`}>日付</label>
          <input
            id={`${id}-d`}
            className="input"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
      )}
      <div className="row">
        <button
          type="submit"
          className="btn btn-primary btn-small"
          disabled={!title.trim() || busy}
        >
          追加
        </button>
        <span className="hint">保存先: {displayPath(view.folder)}</span>
      </div>
    </form>
  );
}

/** The settings people change most; everything else stays editable in the Markdown. */
function Settings({
  view,
  onChange,
}: {
  view: ViewDefinition;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const id = useId();
  const [name, setName] = useState(view.name === 'inline' ? '' : view.name);
  const [folder, setFolder] = useState(view.folder ?? '');
  return (
    <form
      className="inline-view-panel props-form"
      onSubmit={(e) => {
        e.preventDefault();
        onChange({ name: name.trim(), folder: folder.trim().replace(/^\/+|\/+$/g, '') });
      }}
    >
      <div className="props-row">
        <label htmlFor={`${id}-n`}>名前</label>
        <input
          id={`${id}-n`}
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="props-row">
        <label htmlFor={`${id}-f`}>フォルダー</label>
        <input
          id={`${id}-f`}
          className="input"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
        />
      </div>
      {view.type === 'kanban' && (
        <div className="props-row">
          <label htmlFor={`${id}-g`}>列にする項目</label>
          <input
            id={`${id}-g`}
            className="input"
            defaultValue={view.groupBy ?? 'status'}
            onBlur={(e) => onChange({ groupBy: e.target.value.trim() || undefined })}
          />
        </div>
      )}
      {view.type === 'calendar' && (
        <div className="props-row">
          <label htmlFor={`${id}-d`}>日付の項目</label>
          <input
            id={`${id}-d`}
            className="input"
            defaultValue={view.dateProperty ?? 'date'}
            onBlur={(e) => onChange({ dateProperty: e.target.value.trim() || undefined })}
          />
        </div>
      )}
      <div className="row">
        <button type="submit" className="btn btn-small btn-primary">
          保存
        </button>
        <span className="hint">絞り込みや並び順は「書く」でブロックに書けます</span>
      </div>
    </form>
  );
}
