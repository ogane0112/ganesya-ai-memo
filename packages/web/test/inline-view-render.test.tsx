// @vitest-environment jsdom
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { BlameView, Markdown } from '../src/components/MarkdownView';

const body = [
  '# Plan',
  '',
  '```gmemo-view',
  'name: タスク',
  'type: kanban',
  '```',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '```gmemo-view',
  'type: calendar',
  '```',
  '',
].join('\n');

const view = (src: string, i: number) => <div data-view={i}>{src.split('\n').pop()}</div>;

describe('inline views in rendered notes', () => {
  it('turns each view block into the component, in order, and leaves other code alone', () => {
    for (const html of [
      renderToString(
        <MemoryRouter>
          <Markdown text={body} paths={[]} renderView={view} />
        </MemoryRouter>,
      ),
      renderToString(
        <MemoryRouter>
          <BlameView body={body} blame={[]} paths={[]} renderView={view} />
        </MemoryRouter>,
      ),
    ]) {
      expect(html).toContain('<div data-view="0">type: kanban</div>');
      expect(html).toContain('<div data-view="1">type: calendar</div>');
      expect(html).toContain('const x = 1;');
      expect(html).not.toContain('gmemo-view');
    }
  });

  it('shows the settings as code when nothing renders views (like any Markdown tool)', () => {
    const html = renderToString(
      <MemoryRouter>
        <Markdown text={body} paths={[]} />
      </MemoryRouter>,
    );
    expect(html).toContain('language-gmemo-view');
    expect(html).toContain('name: タスク');
  });
});
