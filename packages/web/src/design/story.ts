import type { ReactNode } from 'react';

/**
 * Minimal Storybook-style stories. A `*.stories.tsx` file next to a component
 * default-exports `defineStories({...})`; the design catalog (npm run design)
 * and the story smoke test pick every file up automatically.
 */
export type Control =
  | { type: 'text'; label?: string; default: string }
  | { type: 'boolean'; label?: string; default: boolean }
  | { type: 'number'; label?: string; default: number; min?: number; max?: number; step?: number }
  | { type: 'select'; label?: string; default: string; options: readonly string[] };

export type Controls = Record<string, Control>;
export type ArgsOf<C extends Controls> = {
  [K in keyof C]: C[K] extends { type: 'boolean' }
    ? boolean
    : C[K] extends { type: 'number' }
      ? number
      : string;
};

export interface Story<C extends Controls = Controls> {
  name: string;
  description?: string;
  /** padded (default): 24px around; centered; fullscreen: no padding. */
  layout?: 'padded' | 'centered' | 'fullscreen';
  controls?: C;
  render: (args: ArgsOf<C>) => ReactNode;
}

export type Group = 'ファウンデーション' | 'コンポーネント' | 'パターン';

export interface StorySet {
  /** Stable ASCII id used in URLs, e.g. "button". */
  id: string;
  title: string;
  group: Group;
  description?: string;
  /** Where the component lives, shown in the catalog. */
  source?: string;
  // Each story keeps its own controls type; the catalog treats them uniformly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stories: Story<any>[];
}

/** Helper that keeps each story's `controls` and `render(args)` types in sync. */
export function story<const C extends Controls>(s: Story<C>): Story<C> {
  return s;
}

export function defineStories(set: StorySet): StorySet {
  return set;
}

export function defaultArgs(controls: Controls | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, c] of Object.entries(controls ?? {})) out[k] = c.default;
  return out;
}

export const storyId = (set: StorySet, index: number) => `${set.id}--${index}`;
