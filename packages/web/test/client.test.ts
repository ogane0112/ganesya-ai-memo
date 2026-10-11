// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkError, request } from '../src/api/client';

describe('Cloudflare Access sign-in', () => {
  const assign = vi.fn();

  beforeEach(() => {
    sessionStorage.clear();
    assign.mockClear();
    vi.stubGlobal('location', { pathname: '/search', search: '?q=メモ', assign });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ type: 'opaqueredirect', ok: false, status: 0 })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('navigates through the server once when an API call is redirected', async () => {
    await expect(request('PUT', '/api/note', {})).rejects.toBeInstanceOf(NetworkError);
    expect(assign).toHaveBeenCalledWith(
      `/api/access/return?to=${encodeURIComponent('/search?q=メモ').replace(/%20/g, '+')}`,
    );
    await expect(request('GET', '/api/notes')).rejects.toBeInstanceOf(NetworkError);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('asks fetch not to follow redirects', async () => {
    await request('GET', '/api/notes').catch(() => undefined);
    expect(vi.mocked(fetch).mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
  });
});
