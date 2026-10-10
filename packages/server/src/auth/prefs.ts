import type { Db } from '../db/db.js';

/** Display preferences, shared by all of a user's devices. */
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

export async function loadPrefs(db: Db, userId: string): Promise<UiPrefs> {
  const row = await db.first<{ value: string }>(
    'SELECT value FROM user_settings WHERE user_id = ? AND key = ?',
    userId,
    KEY,
  );
  if (!row) return DEFAULT_PREFS;
  try {
    return normalizePrefs(JSON.parse(row.value));
  } catch {
    return DEFAULT_PREFS;
  }
}

export async function savePrefs(db: Db, userId: string, input: unknown): Promise<UiPrefs> {
  const prefs = normalizePrefs(input);
  await db.run(
    'INSERT INTO user_settings(user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value',
    userId,
    KEY,
    JSON.stringify(prefs),
  );
  return prefs;
}
