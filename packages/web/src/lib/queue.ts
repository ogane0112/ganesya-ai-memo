/**
 * Offline write queue — pure state transitions.
 *
 * Every save goes through the queue (online or not) so there is exactly one
 * code path. Items are persisted in IndexedDB by `queueStore.ts` and sent by
 * `sync.ts`. Rules:
 *  - Saves to the same path that are still waiting are coalesced: the newest
 *    content wins, but the *original* `baseSha` is kept (it is the version the
 *    edit started from, which the server needs for its three-way merge).
 *  - A save enqueued while an earlier save of the same path is in flight is
 *    "chained": once the earlier one commits, its new blob sha becomes the
 *    chained item's base.
 */

export type QueueOp =
  | {
      kind: 'save';
      path: string;
      content: string;
      baseSha: string | null | undefined;
      baseCommit?: string;
      message?: string;
    }
  | { kind: 'capture'; text: string; title?: string; folder?: string; url?: string };

export interface QueueItem {
  id: string;
  op: QueueOp;
  createdAt: number;
  updatedAt: number;
  state: 'pending' | 'sending' | 'failed';
  /** Base sha will be filled in from the result of the earlier in-flight save. */
  chained: boolean;
  attempts: number;
  error?: string;
}

/** A device edit the server could not merge: it became a proposal to review. */
export interface ConflictNotice {
  id: string;
  path: string;
  proposalId: string;
  reason: string;
  at: number;
}

export interface QueueState {
  items: QueueItem[];
  conflicts: ConflictNotice[];
}

export const emptyQueue: QueueState = { items: [], conflicts: [] };

export type SendOutcome =
  | { type: 'committed'; sha: string; commit: string }
  | { type: 'proposed'; proposalId: string; reason: string }
  | { type: 'captured'; path: string }
  /** Temporary failure (offline, 5xx): try again later. */
  | { type: 'retry'; error: string }
  /** Permanent failure (4xx): keep for the user to inspect / discard. */
  | { type: 'failed'; error: string };

export type QueueAction =
  | { type: 'enqueue'; id: string; op: QueueOp; now: number }
  | { type: 'sending'; id: string }
  | { type: 'result'; id: string; outcome: SendOutcome; now: number }
  | { type: 'discard'; id: string }
  | { type: 'retryFailed'; id: string }
  | { type: 'dismissConflict'; id: string }
  | { type: 'resetSending' };

const pathOf = (i: QueueItem) => (i.op.kind === 'save' ? i.op.path : null);

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'enqueue': {
      const { op } = action;
      if (op.kind === 'save') {
        const same = state.items.filter((i) => pathOf(i) === op.path);
        const waiting = same.find((i) => i.state === 'pending' || i.state === 'failed');
        if (waiting && waiting.op.kind === 'save') {
          // Coalesce: keep the original base, take the newest content.
          const merged: QueueItem = {
            ...waiting,
            op: {
              ...waiting.op,
              content: op.content,
              ...(op.message ? { message: op.message } : {}),
            },
            updatedAt: action.now,
            state: 'pending',
            attempts: waiting.state === 'failed' ? 0 : waiting.attempts,
          };
          delete merged.error;
          return { ...state, items: state.items.map((i) => (i.id === waiting.id ? merged : i)) };
        }
        const inFlight = same.some((i) => i.state === 'sending');
        const item: QueueItem = {
          id: action.id,
          op,
          createdAt: action.now,
          updatedAt: action.now,
          state: 'pending',
          chained: inFlight,
          attempts: 0,
        };
        return { ...state, items: [...state.items, item] };
      }
      const item: QueueItem = {
        id: action.id,
        op,
        createdAt: action.now,
        updatedAt: action.now,
        state: 'pending',
        chained: false,
        attempts: 0,
      };
      return { ...state, items: [...state.items, item] };
    }
    case 'sending':
      return {
        ...state,
        items: state.items.map((i) =>
          i.id === action.id ? { ...i, state: 'sending', attempts: i.attempts + 1 } : i,
        ),
      };
    case 'resetSending':
      // After a reload nothing is in flight any more.
      return {
        ...state,
        items: state.items.map((i) => (i.state === 'sending' ? { ...i, state: 'pending' } : i)),
      };
    case 'result': {
      const item = state.items.find((i) => i.id === action.id);
      if (!item) return state;
      const { outcome } = action;
      if (outcome.type === 'retry') {
        return {
          ...state,
          items: state.items.map((i) =>
            i.id === item.id ? { ...i, state: 'pending', error: outcome.error } : i,
          ),
        };
      }
      if (outcome.type === 'failed') {
        return {
          ...state,
          items: state.items.map((i) =>
            i.id === item.id ? { ...i, state: 'failed', error: outcome.error } : i,
          ),
        };
      }
      let items = state.items.filter((i) => i.id !== item.id);
      let conflicts = state.conflicts;
      const path = pathOf(item);
      if (path !== null) {
        // Unchain the next save of the same path.
        const next = items.find((i) => pathOf(i) === path && i.chained);
        if (next && next.op.kind === 'save') {
          const op = outcome.type === 'committed' ? { ...next.op, baseSha: outcome.sha } : next.op;
          if (outcome.type === 'committed') delete (op as { baseCommit?: string }).baseCommit;
          items = items.map((i) => (i.id === next.id ? { ...next, op, chained: false } : i));
        }
        if (outcome.type === 'proposed') {
          conflicts = [
            ...conflicts.filter((c) => c.proposalId !== outcome.proposalId),
            {
              id: item.id,
              path,
              proposalId: outcome.proposalId,
              reason: outcome.reason,
              at: action.now,
            },
          ];
        }
      }
      return { items, conflicts };
    }
    case 'discard':
      return { ...state, items: state.items.filter((i) => i.id !== action.id) };
    case 'retryFailed':
      return {
        ...state,
        items: state.items.map((i) =>
          i.id === action.id ? { ...i, state: 'pending', attempts: 0 } : i,
        ),
      };
    case 'dismissConflict':
      return { ...state, conflicts: state.conflicts.filter((c) => c.id !== action.id) };
  }
}

/** The next item that can be sent now (FIFO; chained items wait for their predecessor). */
export function nextSendable(state: QueueState): QueueItem | undefined {
  return state.items.find((i) => i.state === 'pending' && !i.chained);
}

/** The newest queued (unsent) content for a path, if any. */
export function pendingFor(state: QueueState, path: string): QueueItem | undefined {
  const items = state.items.filter((i) => pathOf(i) === path);
  return items[items.length - 1];
}

/** Backoff before retrying a temporary failure. */
export function retryDelay(attempts: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempts - 1));
}
