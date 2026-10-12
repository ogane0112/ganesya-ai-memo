import type { Frontmatter } from '@gmemo/core';
import { useId, useState } from 'react';
import {
  AI_OPTIONS,
  type DateField,
  fromDateField,
  otherProps,
  readProps,
  readTags,
  STATUS_SUGGESTIONS,
  toDateField,
  toggleAllDay,
  typedValue,
  validPropName,
} from '../lib/properties';
import { Icon } from './Icon';

/**
 * Note properties as a form: the same frontmatter the Markdown source holds,
 * for when writing YAML is more than the moment needs. Every change is handed
 * to `onPatch` as a frontmatter patch (`undefined` deletes a key).
 */
export function PropertiesPanel({
  text,
  onPatch,
}: {
  text: string;
  onPatch: (patch: Frontmatter) => void;
}) {
  const read = readProps(text);
  const id = useId();
  const [open, setOpen] = useState(false);

  if (!read.ok)
    return (
      <div className="props-panel props-broken" role="status">
        <span>
          プロパティの書き方に誤りがあるため、ここでは編集できません。「書く」で先頭の
          <code>---</code> から <code>---</code> までを直してください。
        </span>
      </div>
    );

  const fm = read.frontmatter;
  const date = toDateField(fm['date']);
  const end = toDateField(fm['end']);
  const tags = readTags(fm['tags']);
  const status = typeof fm['status'] === 'string' ? fm['status'] : '';
  const ai = typeof fm['ai'] === 'string' ? fm['ai'] : '';
  const secret = fm['sensitivity'] === 'secret';
  const others = otherProps(fm);

  const summary = [
    date && `日付 ${date.input.replace('T', ' ')}`,
    tags.length > 0 && `タグ ${tags.length}`,
    status && status,
    secret && '機密',
    others.length > 0 && `ほか ${others.length}`,
  ].filter(Boolean);

  const setDate = (key: 'date' | 'end', f: DateField) => onPatch({ [key]: fromDateField(f) });

  return (
    <details
      className="props-panel"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary>
        <Icon name={open ? 'down' : 'chevron'} size={14} />
        <span className="props-panel-title">プロパティ</span>
        <span className="hint ellipsis">
          {summary.length ? summary.join('・') : '日付・タグ・ステータスなどを設定'}
        </span>
      </summary>

      <div className="props-form">
        <DateRow
          id={`${id}-date`}
          label="日付"
          hint="カレンダーのビューに表示されます"
          value={date}
          onChange={(f) => setDate('date', f)}
        />
        {(date || end) && (
          <DateRow
            id={`${id}-end`}
            label="終了"
            hint="任意。終日なら「その日を含む」"
            value={end}
            onChange={(f) => setDate('end', f)}
            allDayDefault={date?.allDay ?? true}
          />
        )}

        <div className="props-row">
          <label htmlFor={`${id}-tags`}>タグ</label>
          <TagInput
            id={`${id}-tags`}
            tags={tags}
            onChange={(next) => onPatch({ tags: next.length ? next : undefined })}
          />
        </div>

        <div className="props-row">
          <label htmlFor={`${id}-status`}>ステータス</label>
          <input
            id={`${id}-status`}
            className="input"
            list={`${id}-status-list`}
            value={status}
            placeholder="カンバンの列になります"
            onChange={(e) => onPatch({ status: e.target.value || undefined })}
          />
          <datalist id={`${id}-status-list`}>
            {STATUS_SUGGESTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>

        <div className="props-row">
          <label htmlFor={`${id}-ai`}>AIへの送信</label>
          <select
            id={`${id}-ai`}
            className="input select"
            value={ai}
            onChange={(e) => onPatch({ ai: e.target.value || undefined })}
          >
            {AI_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className="props-row props-check">
          <label>
            <input
              type="checkbox"
              checked={secret}
              onChange={(e) => onPatch({ sensitivity: e.target.checked ? 'secret' : undefined })}
            />
            機密ノート(外部のAIには送らない)
          </label>
        </div>

        {others.map((p) => (
          <div key={p.key} className="props-row">
            <label htmlFor={`${id}-p-${p.key}`}>{p.key}</label>
            {p.editable ? (
              <input
                id={`${id}-p-${p.key}`}
                className="input"
                value={p.value === null ? '' : String(p.value)}
                onChange={(e) => onPatch({ [p.key]: typedValue(p.value, e.target.value) })}
              />
            ) : (
              <span id={`${id}-p-${p.key}`} className="hint">
                リストなどの値です。「書く」で編集できます
              </span>
            )}
            <button
              type="button"
              className="icon-btn"
              aria-label={`${p.key} を削除`}
              title="削除"
              onClick={() => onPatch({ [p.key]: undefined })}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        ))}

        <AddProperty taken={Object.keys(fm)} onAdd={(key) => onPatch({ [key]: '' })} />
      </div>
    </details>
  );
}

function DateRow({
  id,
  label,
  hint,
  value,
  onChange,
  allDayDefault = true,
}: {
  id: string;
  label: string;
  hint: string;
  value: DateField | null;
  onChange: (f: DateField) => void;
  allDayDefault?: boolean;
}) {
  const f = value ?? { allDay: allDayDefault, input: '' };
  return (
    <div className="props-row props-date">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input"
        type={f.allDay ? 'date' : 'datetime-local'}
        value={f.input}
        aria-describedby={`${id}-hint`}
        onChange={(e) => onChange({ ...f, input: e.target.value })}
      />
      <label className="props-inline">
        <input
          type="checkbox"
          checked={f.allDay}
          onChange={(e) => onChange(toggleAllDay(f, e.target.checked))}
        />
        終日
      </label>
      {f.input && (
        <button
          type="button"
          className="icon-btn"
          aria-label={`${label}を消す`}
          title="消す"
          onClick={() => onChange({ ...f, input: '' })}
        >
          <Icon name="x" size={16} />
        </button>
      )}
      <span id={`${id}-hint`} className="hint props-hint">
        {hint}
      </span>
    </div>
  );
}

function TagInput({
  id,
  tags,
  onChange,
}: {
  id: string;
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const more = readTags(draft);
    if (more.length) onChange([...new Set([...tags, ...more])]);
    setDraft('');
  };
  return (
    <div className="tag-input">
      {tags.map((t) => (
        <span key={t} className="tag">
          #{t}
          <button
            type="button"
            aria-label={`タグ ${t} を外す`}
            onClick={() => onChange(tags.filter((x) => x !== t))}
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
      <input
        id={id}
        className="input"
        value={draft}
        placeholder={tags.length ? '追加' : 'タグを入力して Enter'}
        enterKeyHint="done"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ',') && !e.nativeEvent.isComposing) {
            e.preventDefault();
            add();
          } else if (e.key === 'Backspace' && !draft && tags.length) {
            onChange(tags.slice(0, -1));
          }
        }}
        onBlur={add}
      />
    </div>
  );
}

function AddProperty({ taken, onAdd }: { taken: string[]; onAdd: (key: string) => void }) {
  const [name, setName] = useState('');
  const key = name.trim();
  const problem = !key
    ? null
    : !validPropName(key)
      ? '使えるのは文字・数字・_ と - です'
      : taken.includes(key)
        ? 'すでにあります'
        : null;
  return (
    <form
      className="props-row props-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (!key || problem) return;
        onAdd(key);
        setName('');
      }}
    >
      <input
        className="input"
        aria-label="追加するプロパティの名前"
        placeholder="プロパティを追加(名前)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" className="btn btn-small" disabled={!key || !!problem}>
        追加
      </button>
      {problem && <span className="hint">{problem}</span>}
    </form>
  );
}
