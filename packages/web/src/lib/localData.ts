import { clearLocalStore } from './queueStore';
import { syncQueue } from './sync';

/**
 * What this device keeps between visits: offline copies of notes and files (Service
 * Worker caches), unsent writes and drafts (IndexedDB), and the last sign-in state.
 * It all belongs to one account, so it is cleared when that account signs out and when
 * a different account signs in on the same browser.
 */
const OWNER_KEY = 'gmemo.deviceOwner';
const CACHES = ['gmemo-notes', 'gmemo-files'];
const LOCAL_KEYS = ['gmemo.lastAuth', 'gmemo.treeOpen', OWNER_KEY];

/** The account the cached sign-in state belonged to, read before this visit overwrites it. */
const lastUsername: string | null = (() => {
  try {
    const raw = localStorage.getItem('gmemo.lastAuth');
    return raw
      ? ((JSON.parse(raw) as { user?: { username?: string } }).user?.username ?? null)
      : null;
  } catch {
    return null;
  }
})();

export async function clearLocalData(): Promise<void> {
  await syncQueue.reset();
  await clearLocalStore();
  if (typeof caches !== 'undefined')
    await Promise.all(CACHES.map((name) => caches.delete(name).catch(() => false)));
  for (const key of LOCAL_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  }
}

/**
 * Called once an account is signed in. If this browser was last used by another
 * account, its local data is removed before anything is shown or sent.
 * Returns true when data was cleared.
 */
export async function claimDevice(user: { id: string; username: string }): Promise<boolean> {
  let previous: string | null = null;
  try {
    previous = localStorage.getItem(OWNER_KEY);
  } catch {
    /* storage unavailable */
  }
  if (previous === user.id) return false;
  // No owner recorded yet (first visit, or data from before this check existed): fall back
  // to the account of the cached sign-in state, so unsent notes survive the update.
  const cleared = previous !== null || (lastUsername !== null && lastUsername !== user.username);
  if (cleared) await clearLocalData();
  try {
    localStorage.setItem(OWNER_KEY, user.id);
  } catch {
    /* storage unavailable */
  }
  return cleared;
}
