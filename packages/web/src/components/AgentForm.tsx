import { useEffect, useId, useState } from 'react';
import type { AgentPermissions, WriteMode } from '../api/types';

export const defaultAgent = (name = ''): AgentPermissions => ({
  name,
  description: '',
  canRead: true,
  writeMode: 'propose',
  folders: [],
  autoMerge: false,
  autoMergeFolders: [],
  location: 'external',
});

const WRITE_MODES: { value: WriteMode; label: string; desc: string }[] = [
  { value: 'none', label: '書き込まない', desc: '読むだけ' },
  { value: 'propose', label: '提案する', desc: '変更はレビューで承認してから反映(おすすめ)' },
  { value: 'direct', label: '直接書く', desc: '競合がなければそのまま反映。いつでも取り消せます' },
];

const toList = (s: string) =>
  s
    .split(/[,、\n]/)
    .map((x) => x.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);

/** Comma separated list input that keeps what the user is typing. */
function ListInput({
  id,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(value.join(', '));
  useEffect(() => {
    if (toList(text).join(',') !== value.join(',')) setText(value.join(', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      id={id}
      className="input"
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onChange(toList(e.target.value));
      }}
    />
  );
}

/** Permission editor for an AI agent (used in settings and on the OAuth consent screen). */
export function AgentForm({
  value,
  onChange,
  showName = true,
}: {
  value: AgentPermissions;
  onChange: (v: AgentPermissions) => void;
  showName?: boolean;
}) {
  const id = useId();
  const set = <K extends keyof AgentPermissions>(k: K, v: AgentPermissions[K]) =>
    onChange({ ...value, [k]: v });
  return (
    <div className="agent-form">
      {showName && (
        <>
          <div className="field">
            <label htmlFor={`${id}-name`}>名前</label>
            <input
              id={`${id}-name`}
              className="input"
              value={value.name}
              onChange={(e) => set('name', e.target.value)}
              required
              maxLength={60}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-desc`}>説明(任意)</label>
            <input
              id={`${id}-desc`}
              className="input"
              value={value.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </div>
        </>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={value.canRead}
          onChange={(e) => set('canRead', e.target.checked)}
        />
        ノートを読める
      </label>
      <fieldset className="fieldset">
        <legend>書き込み</legend>
        {WRITE_MODES.map((m) => (
          <label key={m.value} className="radio">
            <input
              type="radio"
              name={`${id}-write`}
              value={m.value}
              checked={value.writeMode === m.value}
              onChange={() => set('writeMode', m.value)}
            />
            <span>
              <strong>{m.label}</strong> <span className="hint">{m.desc}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor={`${id}-folders`}>アクセスできるフォルダ(カンマ区切り・空欄 = すべて)</label>
        <ListInput
          id={`${id}-folders`}
          value={value.folders}
          onChange={(v) => set('folders', v)}
          placeholder="Projects, Inbox"
        />
      </div>
      {value.writeMode === 'propose' && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={value.autoMerge}
              onChange={(e) => set('autoMerge', e.target.checked)}
            />
            競合のない提案は自動で取り込む
          </label>
          {value.autoMerge && (
            <div className="field">
              <label htmlFor={`${id}-amf`}>自動で取り込むフォルダ(空欄 = 書けるすべての場所)</label>
              <ListInput
                id={`${id}-amf`}
                value={value.autoMergeFolders}
                onChange={(v) => set('autoMergeFolders', v)}
                placeholder="Inbox"
              />
            </div>
          )}
        </>
      )}
      <fieldset className="fieldset">
        <legend>AIの実行場所</legend>
        <label className="radio">
          <input
            type="radio"
            name={`${id}-loc`}
            checked={value.location === 'external'}
            onChange={() => set('location', 'external')}
          />
          <span>
            <strong>外部(クラウド)</strong>{' '}
            <span className="hint">外部AIへの送信が許可されたノートだけ読めます</span>
          </span>
        </label>
        <label className="radio">
          <input
            type="radio"
            name={`${id}-loc`}
            checked={value.location === 'local'}
            onChange={() => set('location', 'local')}
          />
          <span>
            <strong>ローカル</strong>{' '}
            <span className="hint">手元で動くAI。ローカル送信可のノートも読めます</span>
          </span>
        </label>
      </fieldset>
    </div>
  );
}

export const SCOPE_LABEL: Record<string, string> = {
  'notes:read': 'ノートを読む',
  'notes:propose': '変更を提案する',
  'notes:write': '直接書き込む',
  'notes:capture': 'メモを追記する(キャプチャ)',
};
