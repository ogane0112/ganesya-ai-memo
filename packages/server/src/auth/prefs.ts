import type { DB } from '../db/db.js';

/** Display preferences, shared by all of the owner's devices. */
export interface UiPrefs {
  accent: Accent;
  mode: 'system' | 'light' | 'dark';
}

export const ACCENTS = ['green', 'coral', 'sky', 'sakura', 'honey', 'sumi'] as const;
export type Accent = (typeof ACCENTS)[number];

export const DEFAULT_PREFS: UiPrefs = { accent: 'green', mode: 'system' };
const KEY = 'ui_prefs';

export function normalizePrefs(input: unknown): UiPrefs {
  const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const accent = ACCENTS.includes(r['accent'] as Accent)
    ? (r['accent'] as Accent)
    : DEFAULT_PREFS.accent;
  const mode =
    r['mode'] === 'light' || r['mode'] === 'dark' || r['mode'] === 'system'
      ? r['mode']
      : DEFAULT_PREFS.mode;
  return { accent, mode };
}

export function loadPrefs(db: DB): UiPrefs {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as
    { value: string } | undefined;
  if (!row) return DEFAULT_PREFS;
  try {
    return normalizePrefs(JSON.parse(row.value));
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(db: DB, input: unknown): UiPrefs {
  const prefs = normalizePrefs(input);
  db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(KEY, JSON.stringify(prefs));
  return prefs;
}
