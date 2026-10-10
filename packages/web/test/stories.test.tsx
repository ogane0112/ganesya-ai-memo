// @vitest-environment jsdom
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { loadStorySets } from '../src/design/registry';
import { defaultArgs, storyId } from '../src/design/story';

/** Every story in the design catalog renders with its default arguments. */
const sets = loadStorySets();

describe('design catalog', () => {
  it('finds the story files', () => {
    expect(sets.length).toBeGreaterThan(10);
    const ids = sets.flatMap((s) => s.stories.map((_, i) => storyId(s, i)));
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const set of sets) {
    describe(`${set.group} / ${set.title}`, () => {
      for (const story of set.stories) {
        it(story.name, () => {
          const html = renderToString(
            <MemoryRouter>{story.render(defaultArgs(story.controls) as never)}</MemoryRouter>,
          );
          expect(html.length).toBeGreaterThan(0);
        });
      }
    });
  }
});
