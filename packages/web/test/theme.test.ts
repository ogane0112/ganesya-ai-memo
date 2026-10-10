// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyPrefs, cachedPrefs, normalizePrefs } from '../src/lib/theme';

describe('theme prefs', () => {
  it('normalizes unknown values to defaults', () => {
    expect(normalizePrefs({ accent: 'red', mode: 'neon' })).toEqual({
      accent: 'green',
      mode: 'system',
    });
    expect(normalizePrefs({ accent: 'sky', mode: 'dark' })).toEqual({
      accent: 'sky',
      mode: 'dark',
    });
  });

  it('applies data attributes and remembers the choice', () => {
    const root = document.documentElement;
    applyPrefs({ accent: 'sakura', mode: 'dark' });
    expect(root.dataset['accent']).toBe('sakura');
    expect(root.dataset['mode']).toBe('dark');
    expect(cachedPrefs()).toEqual({ accent: 'sakura', mode: 'dark' });
    applyPrefs({ accent: 'green', mode: 'system' });
    expect(root.dataset['accent']).toBeUndefined();
    expect(root.dataset['mode']).toBeUndefined();
  });
});
