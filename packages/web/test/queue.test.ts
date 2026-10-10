import { describe, expect, it } from 'vitest';
import {
  emptyQueue,
  nextSendable,
  pendingFor,
  type QueueAction,
  queueReducer,
  type QueueState,
  retryDelay,
} from '../src/lib/queue';

const run = (actions: QueueAction[], s: QueueState = emptyQueue) => actions.reduce(queueReducer, s);
const save = (
  id: string,
  path: string,
  content: string,
  baseSha: string | null | undefined,
  now = 1,
): QueueAction => ({ type: 'enqueue', id, now, op: { kind: 'save', path, content, baseSha } });

describe('offline queue reducer', () => {
  it('coalesces waiting saves of the same path but keeps the original base sha', () => {
    const s = run([
      save('a', 'n.md', 'v1', 'base0'),
      save('b', 'n.md', 'v2', 'ignored', 2),
      save('c', 'other.md', 'x', null),
    ]);
    expect(s.items).toHaveLength(2);
    const first = s.items[0]!;
    expect(first.id).toBe('a');
    expect(first.op).toMatchObject({ content: 'v2', baseSha: 'base0' });
    expect(first.updatedAt).toBe(2);
  });

  it('chains a save made while the previous one is in flight, then rebases it on the committed sha', () => {
    let s = run([
      save('a', 'n.md', 'v1', 'base0'),
      { type: 'sending', id: 'a' },
      save('b', 'n.md', 'v2', 'base0'),
    ]);
    expect(s.items.map((i) => [i.id, i.state, i.chained])).toEqual(
      [
        ['a', 'sending', 1],
        ['b', 'pending', true],
      ].map(([id, st, ch]) => [id, st, ch === 1 ? false : ch]),
    );
    expect(nextSendable(s)).toBeUndefined();
    s = queueReducer(s, {
      type: 'result',
      id: 'a',
      outcome: { type: 'committed', sha: 'sha1', commit: 'c1' },
      now: 3,
    });
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({
      id: 'b',
      chained: false,
      op: { baseSha: 'sha1', content: 'v2' },
    });
    expect(nextSendable(s)?.id).toBe('b');
  });

  it('records a conflict notice when the server turns the save into a proposal', () => {
    const s = run([
      save('a', 'n.md', 'v1', 'base0'),
      { type: 'sending', id: 'a' },
      {
        type: 'result',
        id: 'a',
        outcome: { type: 'proposed', proposalId: 'p1', reason: 'conflict' },
        now: 5,
      },
    ]);
    expect(s.items).toHaveLength(0);
    expect(s.conflicts).toEqual([
      { id: 'a', path: 'n.md', proposalId: 'p1', reason: 'conflict', at: 5 },
    ]);
    expect(queueReducer(s, { type: 'dismissConflict', id: 'a' }).conflicts).toHaveLength(0);
  });

  it('keeps items on temporary errors and marks permanent ones as failed', () => {
    let s = run([
      save('a', 'n.md', 'v1', null),
      { type: 'sending', id: 'a' },
      { type: 'result', id: 'a', outcome: { type: 'retry', error: 'offline' }, now: 2 },
    ]);
    expect(s.items[0]).toMatchObject({ state: 'pending', error: 'offline', attempts: 1 });
    s = run(
      [
        { type: 'sending', id: 'a' },
        { type: 'result', id: 'a', outcome: { type: 'failed', error: 'bad path' }, now: 3 },
      ],
      s,
    );
    expect(s.items[0]).toMatchObject({ state: 'failed', error: 'bad path' });
    expect(nextSendable(s)).toBeUndefined();
    // A new edit to a failed item revives it.
    s = queueReducer(s, save('b', 'n.md', 'v2', 'zzz'));
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({
      state: 'pending',
      attempts: 0,
      op: { content: 'v2', baseSha: null },
    });
  });

  it('resets in-flight items after a reload and exposes the newest pending content', () => {
    const s = run([
      save('a', 'n.md', 'v1', 's'),
      { type: 'sending', id: 'a' },
      { type: 'resetSending' },
    ]);
    expect(s.items[0]!.state).toBe('pending');
    expect(pendingFor(s, 'n.md')?.op).toMatchObject({ content: 'v1' });
    expect(pendingFor(s, 'x.md')).toBeUndefined();
  });

  it('never coalesces captures', () => {
    const s = run([
      { type: 'enqueue', id: 'a', now: 1, op: { kind: 'capture', text: 'one' } },
      { type: 'enqueue', id: 'b', now: 2, op: { kind: 'capture', text: 'two' } },
    ]);
    expect(s.items).toHaveLength(2);
  });

  it('backs off exponentially up to a minute', () => {
    expect(retryDelay(1)).toBe(2000);
    expect(retryDelay(3)).toBe(8000);
    expect(retryDelay(20)).toBe(60000);
  });
});
