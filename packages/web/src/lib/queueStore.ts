import { createStore, get, set, type UseStore } from 'idb-keyval';
import { emptyQueue, type QueueState } from './queue';

let store: UseStore | null = null;
function db(): UseStore | null {
  if (typeof indexedDB === 'undefined') return null;
  store ??= createStore('gmemo', 'kv');
  return store;
}

const QUEUE_KEY = 'queue';

export async function loadQueue(): Promise<QueueState> {
  const s = db();
  if (!s) return emptyQueue;
  try {
    const v = await get<QueueState>(QUEUE_KEY, s);
    return v && Array.isArray(v.items)
      ? { items: v.items, conflicts: v.conflicts ?? [] }
      : emptyQueue;
  } catch {
    return emptyQueue;
  }
}

export async function saveQueue(state: QueueState): Promise<void> {
  const s = db();
  if (!s) return;
  await set(QUEUE_KEY, state, s);
}

export interface Draft {
  path: string;
  content: string;
  baseSha: string | null | undefined;
  updatedAt: number;
}

/** Unsaved editor text, so nothing typed is ever lost (tab closed, crash…). */
export async function loadDraft(key: string): Promise<Draft | undefined> {
  const s = db();
  if (!s) return undefined;
  try {
    return await get<Draft>(`draft:${key}`, s);
  } catch {
    return undefined;
  }
}

export async function saveDraft(key: string, draft: Draft | undefined): Promise<void> {
  const s = db();
  if (!s) return;
  try {
    await set(`draft:${key}`, draft, s);
  } catch {
    /* storage full or unavailable: drafts are best effort */
  }
}
