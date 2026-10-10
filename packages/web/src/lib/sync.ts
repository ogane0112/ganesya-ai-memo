import { api, ApiError, NetworkError } from '../api/client';
import { deviceName } from './device';
import {
  emptyQueue,
  nextSendable,
  type QueueAction,
  type QueueItem,
  type QueueOp,
  queueReducer,
  type QueueState,
  retryDelay,
  type SendOutcome,
} from './queue';
import { loadQueue, saveQueue } from './queueStore';

type Listener = (s: QueueState) => void;
type ResultListener = (item: QueueItem, outcome: SendOutcome) => void;

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function send(item: QueueItem): Promise<SendOutcome> {
  try {
    const op = item.op;
    if (op.kind === 'capture') {
      const r = await api.capture({
        text: op.text,
        ...(op.title ? { title: op.title } : {}),
        ...(op.folder ? { folder: op.folder } : {}),
        ...(op.url ? { url: op.url } : {}),
      });
      return { type: 'captured', path: r.path };
    }
    const r = await api.saveNote({
      path: op.path,
      content: op.content,
      ...(op.baseSha !== undefined ? { baseSha: op.baseSha } : {}),
      ...(op.baseCommit ? { baseCommit: op.baseCommit } : {}),
      ...(op.message ? { message: op.message } : {}),
      device: deviceName(),
    });
    if (r.status === 'proposed')
      return { type: 'proposed', proposalId: r.proposalId, reason: r.reason };
    return { type: 'committed', sha: r.sha, commit: r.commit };
  } catch (e) {
    if (e instanceof NetworkError) return { type: 'retry', error: 'オフライン' };
    if (e instanceof ApiError) {
      if (e.status === 401) return { type: 'retry', error: 'サインインが必要です' };
      if (e.status >= 500 || e.status === 408 || e.status === 429)
        return { type: 'retry', error: `サーバーエラー (${e.status})` };
      return { type: 'failed', error: e.message };
    }
    return { type: 'retry', error: (e as Error).message };
  }
}

/** The persistent offline write queue (singleton). */
class SyncQueue {
  private state: QueueState = emptyQueue;
  private listeners = new Set<Listener>();
  private resultListeners = new Set<ResultListener>();
  private ready: Promise<void>;
  private flushing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private authPaused = false;
  /** Paths this device created/saved in this session (the note index may lag behind). */
  private saved = new Set<string>();

  constructor() {
    this.ready = loadQueue().then((s) => {
      // Merge with anything enqueued before loading finished.
      const loaded = queueReducer(s, { type: 'resetSending' });
      this.state = {
        items: [...loaded.items, ...this.state.items],
        conflicts: [...loaded.conflicts, ...this.state.conflicts],
      };
      this.emit();
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => void this.flush());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void this.flush();
      });
      setInterval(() => {
        if (this.state.items.some((i) => i.state === 'pending')) void this.flush();
      }, 30_000);
    }
  }

  get snapshot(): QueueState {
    return this.state;
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onResult(fn: ResultListener): () => void {
    this.resultListeners.add(fn);
    return () => this.resultListeners.delete(fn);
  }

  private emit() {
    for (const l of this.listeners) l(this.state);
  }

  private dispatch(action: QueueAction) {
    this.state = queueReducer(this.state, action);
    const snapshot = this.state;
    this.persistChain = this.persistChain.then(() => saveQueue(snapshot)).catch(() => undefined);
    this.emit();
  }

  /** Add a write; it is sent right away when online. Resolves once persisted locally. */
  async enqueue(op: QueueOp): Promise<string> {
    await this.ready;
    const id = uid();
    this.dispatch({ type: 'enqueue', id, op, now: Date.now() });
    await this.persistChain;
    void this.flush();
    return id;
  }

  discard(id: string) {
    this.dispatch({ type: 'discard', id });
  }

  retry(id: string) {
    this.dispatch({ type: 'retryFailed', id });
    void this.flush();
  }

  dismissConflict(id: string) {
    this.dispatch({ type: 'dismissConflict', id });
  }

  wasSaved(path: string): boolean {
    return this.saved.has(path);
  }

  /** Resolves once nothing is queued or in flight for `path` (or after `timeoutMs`, or right away when offline). */
  settled(path: string, timeoutMs = 5000): Promise<void> {
    const busy = (st: QueueState) =>
      st.items.some((i) => i.op.kind === 'save' && i.op.path === path && i.state !== 'failed');
    if (!busy(this.state) || (typeof navigator !== 'undefined' && !navigator.onLine))
      return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        off();
        clearTimeout(t);
        resolve();
      };
      const off = this.subscribe((st) => {
        if (!busy(st)) done();
      });
      const t = setTimeout(done, timeoutMs);
    });
  }

  /** Call after signing in again so paused writes resume. */
  resume() {
    this.authPaused = false;
    void this.flush();
  }

  async flush(): Promise<void> {
    await this.ready;
    if (this.flushing) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    this.flushing = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      for (;;) {
        if (this.authPaused) break;
        const item = nextSendable(this.state);
        if (!item) break;
        this.dispatch({ type: 'sending', id: item.id });
        const outcome = await send(item);
        this.dispatch({ type: 'result', id: item.id, outcome, now: Date.now() });
        if (outcome.type === 'committed' && item.op.kind === 'save') this.saved.add(item.op.path);
        for (const l of this.resultListeners) l(item, outcome);
        if (outcome.type === 'retry') {
          if (outcome.error === 'サインインが必要です') this.authPaused = true;
          else this.timer = setTimeout(() => void this.flush(), retryDelay(item.attempts + 1));
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

export const syncQueue = new SyncQueue();
