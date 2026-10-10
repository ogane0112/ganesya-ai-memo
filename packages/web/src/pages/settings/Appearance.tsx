import { useState } from 'react';
import { api, describeError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { Badge, Segmented } from '../../components/ui';
import { ACCENTS, applyPrefs, cachedPrefs, MODES, type UiPrefs } from '../../lib/theme';
import { useToast } from '../../state/toast';

/** Accent color and light/dark mode. Saved on the server, so every device follows. */
export function AppearanceSettings() {
  const toast = useToast();
  const [prefs, setPrefs] = useState<UiPrefs>(cachedPrefs);

  const change = (patch: Partial<UiPrefs>) => {
    const next = { ...prefs, ...patch };
    const prev = prefs;
    setPrefs(next);
    applyPrefs(next);
    api.savePreferences(next).catch((e: unknown) => {
      setPrefs(prev);
      applyPrefs(prev);
      toast.show(`保存できませんでした: ${describeError(e)}`, { kind: 'error' });
    });
  };

  return (
    <div className="stack">
      <section className="card">
        <h2>テーマカラー</h2>
        <p className="hint">ボタンや選択中の項目の色です。スマホとPCで同じ色になります。</p>
        <div className="swatches" role="radiogroup" aria-label="テーマカラー">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={prefs.accent === a.id}
              className="swatch"
              onClick={() => change({ accent: a.id })}
            >
              <span className="swatch-dot" style={{ background: a.color }}>
                {prefs.accent === a.id && <Icon name="check" size={18} />}
              </span>
              {a.label}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>明るさ</h2>
        <Segmented
          label="明るさ"
          value={prefs.mode}
          options={MODES}
          onChange={(mode) => change({ mode })}
        />
      </section>

      <section className="card">
        <h2>プレビュー</h2>
        <div className="theme-preview">
          <button type="button" className="btn btn-primary">
            <Icon name="check" size={16} />
            取り込む
          </button>
          <button type="button" className="btn">
            内容を見る
          </button>
          <span className="tag">#メモ</span>
          <Badge tone="accent">選択中</Badge>
          <Badge tone="ai">AIの提案</Badge>
        </div>
      </section>
    </div>
  );
}
