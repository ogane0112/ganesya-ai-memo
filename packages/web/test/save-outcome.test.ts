// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The sync queue against a fake server that answers note saves as told. */
async function queueWith(answer: (n: number) => { status: number; body: unknown }) {
  vi.resetModules();
  let n = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const a = answer(n++);
      return new Response(JSON.stringify(a.body), {
        status: a.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  const { syncQueue } = await import('../src/lib/sync');
  await syncQueue.reset();
  syncQueue.resume();
  return syncQueue;
}

const save = (content: string) => ({ kind: 'save', path: 'a.md', content, baseSha: null }) as const;

describe('waiting for a save to reach the server', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('is saved at once when nothing is queued', async () => {
    const q = await queueWith(() => ({ status: 200, body: {} }));
    expect(await q.outcome('a.md')).toBe('saved');
  });

  it('waits for the commit, including newer edits of the same note', async () => {
    const q = await queueWith((n) => ({
      status: 200,
      body: { status: 'committed', commit: `c${n}`, sha: `s${n}` },
    }));
    await q.enqueue(save('one'));
    await q.enqueue(save('two'));
    expect(await q.outcome('a.md')).toBe('saved');
    expect(q.snapshot.items).toHaveLength(0);
  });

  it('reports a refused save, and a temporary failure as "later"', async () => {
    const refused = await queueWith(() => ({ status: 409, body: { error: 'clash' } }));
    await refused.enqueue(save('x'));
    expect(await refused.outcome('a.md')).toBe('failed');

    const down = await queueWith(() => ({ status: 503, body: { error: 'down' } }));
    await down.enqueue(save('x'));
    expect(await down.outcome('a.md')).toBe('later');
  });
});
