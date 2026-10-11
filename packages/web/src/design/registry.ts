import type { StorySet } from './story';

const GROUP_ORDER = ['ファウンデーション', 'コンポーネント', 'パターン'];

/** Every `*.stories.tsx` under src (one set or an array per file), sorted by group then title. */
export function loadStorySets(): StorySet[] {
  const modules = import.meta.glob<{ default: StorySet | StorySet[] }>('../**/*.stories.tsx', {
    eager: true,
  });
  return Object.values(modules)
    .flatMap((m) => m.default)
    .sort(
      (a, b) =>
        GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
        a.title.localeCompare(b.title, 'ja'),
    );
}
