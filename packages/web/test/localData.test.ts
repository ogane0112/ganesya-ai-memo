// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const load = async () => {
  vi.resetModules();
  return import('../src/lib/localData');
};

describe('device data belongs to one account', () => {
  beforeEach(() => localStorage.clear());

  it('keeps data for the same account and on first use', async () => {
    const { claimDevice } = await load();
    expect(await claimDevice({ id: 'u1', username: 'taro' })).toBe(false);
    localStorage.setItem('gmemo.treeOpen', '["work"]');
    expect(await claimDevice({ id: 'u1', username: 'taro' })).toBe(false);
    expect(localStorage.getItem('gmemo.treeOpen')).toBe('["work"]');
  });

  it('clears another account’s data before a new account uses it', async () => {
    const { claimDevice } = await load();
    await claimDevice({ id: 'u1', username: 'taro' });
    localStorage.setItem('gmemo.treeOpen', '["work"]');
    localStorage.setItem('gmemo.lastAuth', '{"user":{"username":"taro"}}');
    expect(await claimDevice({ id: 'u2', username: 'hanako' })).toBe(true);
    expect(localStorage.getItem('gmemo.treeOpen')).toBeNull();
    expect(localStorage.getItem('gmemo.lastAuth')).toBeNull();
    expect(localStorage.getItem('gmemo.deviceOwner')).toBe('u2');
  });

  it('uses the cached sign-in of older versions to recognise another account', async () => {
    localStorage.setItem('gmemo.lastAuth', '{"user":{"username":"taro"}}');
    localStorage.setItem('gmemo.treeOpen', '["work"]');
    const { claimDevice } = await load();
    // The new visit overwrites the cached state before the device is claimed.
    localStorage.setItem('gmemo.lastAuth', '{"user":{"username":"hanako"}}');
    expect(await claimDevice({ id: 'u2', username: 'hanako' })).toBe(true);
    expect(localStorage.getItem('gmemo.treeOpen')).toBeNull();
  });

  it('does not send queued writes before an account claims the device', async () => {
    const { syncQueue } = await import('../src/lib/sync');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await syncQueue.enqueue({ kind: 'capture', text: 'メモ' } as never);
    await syncQueue.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    await syncQueue.reset();
    expect(syncQueue.snapshot.items).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});
