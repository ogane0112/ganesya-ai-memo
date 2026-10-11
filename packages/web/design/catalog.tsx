/**
 * The design catalog: a small, self-made Storybook. Lists every story from
 * src/**\/*.stories.tsx, previews it in an iframe at phone / tablet / PC width
 * in light or dark mode with any accent color, and edits story arguments.
 */
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadStorySets } from '../src/design/registry';
import { type Control, defaultArgs, type Story, type StorySet, storyId } from '../src/design/story';
import { ACCENTS } from '../src/lib/theme';
import './catalog.css';
import { encodeState, type PreviewState, VIEWPORTS, type Viewport } from './state';

const sets = loadStorySets();
const entries = sets.flatMap((set) =>
  set.stories.map((story, i) => ({ id: storyId(set, i), set, story })),
);

interface ShellState {
  story: string;
  viewport: Viewport;
  mode: 'light' | 'dark';
  accent: string;
}

/** A theme chosen by the page host (data-theme), else the OS setting. */
function initialTheme(): 'light' | 'dark' {
  const host = document.documentElement.dataset['theme'];
  if (host === 'light' || host === 'dark') return host;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readShellState(): ShellState {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  const story = p.get('story') ?? '';
  const viewport = (p.get('vp') ?? 'auto') as Viewport;
  return {
    story: entries.some((e) => e.id === story) ? story : entries[0]!.id,
    viewport: viewport in VIEWPORTS ? viewport : 'auto',
    mode: (p.get('mode') ?? initialTheme()) === 'dark' ? 'dark' : 'light',
    accent: ACCENTS.some((a) => a.id === p.get('accent')) ? p.get('accent')! : 'green',
  };
}

function writeShellState(s: ShellState) {
  const p = new URLSearchParams({ story: s.story, vp: s.viewport, mode: s.mode, accent: s.accent });
  history.replaceState(null, '', `#${p.toString()}`);
}

function ControlInput({
  name,
  control,
  value,
  onChange,
}: {
  name: string;
  control: Control;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const id = `ctl-${name}`;
  switch (control.type) {
    case 'boolean':
      return (
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case 'number':
      return (
        <input
          id={id}
          type="number"
          value={Number(value)}
          min={control.min}
          max={control.max}
          step={control.step ?? 1}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      );
    case 'select':
      return (
        <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {control.options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      );
    default:
      return (
        <input
          id={id}
          type="text"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

function Sidebar({ current, onSelect }: { current: string; onSelect: (id: string) => void }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const query = q.trim().toLowerCase();
    const out = new Map<string, { set: StorySet; items: { id: string; story: Story }[] }[]>();
    for (const set of sets) {
      const items = set.stories
        .map((story, i) => ({ id: storyId(set, i), story }))
        .filter(
          ({ story }) =>
            !query || `${set.title} ${story.name} ${set.id}`.toLowerCase().includes(query),
        );
      if (!items.length) continue;
      const list = out.get(set.group) ?? [];
      list.push({ set, items });
      out.set(set.group, list);
    }
    return out;
  }, [q]);
  return (
    <nav className="ds-sidebar" aria-label="ストーリー">
      <div className="ds-brand">
        <span className="ds-logo" aria-hidden="true" />
        <div>
          <strong>AI Memo Design</strong>
          <span>{entries.length} ストーリー</span>
        </div>
      </div>
      <input
        className="ds-search"
        type="search"
        placeholder="検索(例: ボタン)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="ストーリーを検索"
      />
      {[...groups].map(([group, list]) => (
        <section key={group} className="ds-group">
          <h2>{group}</h2>
          {list.map(({ set, items }) => (
            <div key={set.id} className="ds-set">
              <div className="ds-set-title">{set.title}</div>
              {items.map(({ id, story }) => (
                <button
                  key={id}
                  type="button"
                  className={id === current ? 'ds-item active' : 'ds-item'}
                  aria-current={id === current ? 'page' : undefined}
                  onClick={() => onSelect(id)}
                >
                  {story.name}
                </button>
              ))}
            </div>
          ))}
        </section>
      ))}
    </nav>
  );
}

function Catalog() {
  const [shell, setShell] = useState(readShellState);
  const entry = entries.find((e) => e.id === shell.story) ?? entries[0]!;
  const [args, setArgs] = useState<Record<string, unknown>>(() =>
    defaultArgs(entry.story.controls),
  );
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => writeShellState(shell), [shell]);
  useEffect(() => {
    document.documentElement.dataset['theme'] = shell.mode;
  }, [shell.mode]);

  const select = (id: string) => {
    const next = entries.find((e) => e.id === id)!;
    setArgs(defaultArgs(next.story.controls));
    setShell((s) => ({ ...s, story: id }));
    setMenuOpen(false);
  };

  const preview: PreviewState = { story: entry.id, args, accent: shell.accent, mode: shell.mode };
  const src = `./preview.html#${encodeState(preview)}`;
  const vp = VIEWPORTS[shell.viewport];
  const controls = Object.entries((entry.story.controls ?? {}) as Record<string, Control>);

  return (
    <div className={menuOpen ? 'ds-app menu-open' : 'ds-app'}>
      <Sidebar current={entry.id} onSelect={select} />
      <main className="ds-main">
        <header className="ds-toolbar">
          <button
            type="button"
            className="ds-menu-btn"
            aria-label="ストーリー一覧"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            ☰
          </button>
          <div className="ds-title">
            <span>{entry.set.title}</span>
            <strong>{entry.story.name}</strong>
          </div>
          <div className="ds-tools">
            <div className="ds-seg" role="radiogroup" aria-label="画面の幅">
              {(Object.keys(VIEWPORTS) as Viewport[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={shell.viewport === v}
                  onClick={() => setShell((s) => ({ ...s, viewport: v }))}
                >
                  {VIEWPORTS[v].label}
                </button>
              ))}
            </div>
            <div className="ds-seg" role="radiogroup" aria-label="明るさ">
              {(['light', 'dark'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={shell.mode === m}
                  onClick={() => setShell((s) => ({ ...s, mode: m }))}
                >
                  {m === 'light' ? 'ライト' : 'ダーク'}
                </button>
              ))}
            </div>
            <div className="ds-swatches" role="radiogroup" aria-label="アクセント色">
              {ACCENTS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  aria-checked={shell.accent === a.id}
                  aria-label={a.label}
                  title={a.label}
                  style={{ background: a.color }}
                  onClick={() => setShell((s) => ({ ...s, accent: a.id }))}
                />
              ))}
            </div>
            <a className="ds-link" href={src} target="_blank" rel="noreferrer">
              単体で開く ↗
            </a>
          </div>
        </header>
        <div className={`ds-canvas ds-vp-${shell.viewport}`}>
          <iframe
            title={`${entry.set.title}: ${entry.story.name}`}
            src={src}
            style={vp.width ? { width: vp.width, height: vp.height } : undefined}
          />
        </div>
        <section className="ds-panel" aria-label="ストーリーの情報">
          <div className="ds-doc">
            <h2>{entry.set.title}</h2>
            {entry.set.description && <p>{entry.set.description}</p>}
            {entry.story.description && <p>{entry.story.description}</p>}
            {entry.set.source && (
              <p className="ds-source">
                <code>{entry.set.source}</code>
              </p>
            )}
          </div>
          <div className="ds-controls">
            <div className="ds-controls-head">
              <h2>コントロール</h2>
              {controls.length > 0 && (
                <button type="button" onClick={() => setArgs(defaultArgs(entry.story.controls))}>
                  初期値に戻す
                </button>
              )}
            </div>
            {controls.length === 0 ? (
              <p className="ds-muted">このストーリーには変更できる値がありません。</p>
            ) : (
              <table>
                <tbody>
                  {controls.map(([name, control]) => (
                    <tr key={name}>
                      <th>
                        <label htmlFor={`ctl-${name}`}>{control.label ?? name}</label>
                        <code>{name}</code>
                      </th>
                      <td>
                        <ControlInput
                          name={name}
                          control={control}
                          value={args[name]}
                          onChange={(v) => setArgs((a) => ({ ...a, [name]: v }))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Catalog />
  </StrictMode>,
);
