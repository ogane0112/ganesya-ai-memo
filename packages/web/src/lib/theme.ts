/** Display preferences (accent color + light/dark), applied to <html> as data attributes. */
export type Accent = 'green' | 'coral' | 'sky' | 'sakura' | 'honey' | 'sumi';
export type ColorMode = 'system' | 'light' | 'dark';

export interface UiPrefs {
  accent: Accent;
  mode: ColorMode;
}

export const ACCENTS: { id: Accent; label: string; color: string }[] = [
  { id: 'green', label: 'まっちゃ', color: '#52a874' },
  { id: 'coral', label: 'さんご', color: '#f08a64' },
  { id: 'sky', label: 'そら', color: '#4b9ee0' },
  { id: 'sakura', label: 'さくら', color: '#e57a9c' },
  { id: 'honey', label: 'はちみつ', color: '#e0a12b' },
  { id: 'sumi', label: 'すみ', color: '#5b5048' },
];

export const MODES: { value: ColorMode; label: string }[] = [
  { value: 'system', label: '端末に合わせる' },
  { value: 'light', label: 'ライト' },
  { value: 'dark', label: 'ダーク' },
];

export const DEFAULT_PREFS: UiPrefs = { accent: 'green', mode: 'system' };
const KEY = 'gmemo.uiPrefs';

export function normalizePrefs(input: unknown): UiPrefs {
  const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const accent = ACCENTS.some((a) => a.id === r['accent'])
    ? (r['accent'] as Accent)
    : DEFAULT_PREFS.accent;
  const mode = MODES.some((m) => m.value === r['mode'])
    ? (r['mode'] as ColorMode)
    : DEFAULT_PREFS.mode;
  return { accent, mode };
}

/** Last applied prefs on this device, so the right colors show before the server answers. */
export function cachedPrefs(): UiPrefs {
  try {
    return normalizePrefs(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return DEFAULT_PREFS;
  }
}

export function applyPrefs(prefs: UiPrefs, root: HTMLElement = document.documentElement): void {
  if (prefs.accent === DEFAULT_PREFS.accent) delete root.dataset['accent'];
  else root.dataset['accent'] = prefs.accent;
  if (prefs.mode === 'system') delete root.dataset['mode'];
  else root.dataset['mode'] = prefs.mode;
  // Keep the browser chrome (status bar on phones) in step with the page background.
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (bg) {
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.content = bg;
    }
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // storage unavailable: the server copy still applies on next load
  }
}
