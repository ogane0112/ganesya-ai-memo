// @vitest-environment jsdom
import type { BlockAttribution } from '@gmemo/core';
import { describe, expect, it } from 'vitest';
import {
  attributeBlocks,
  highlightSnippet,
  linkCitations,
  renderMarkdown,
  renderWikiLink,
} from '../src/lib/markdown';

const ctx = { paths: ['Projects/Project A.md', 'Inbox/2026-01-01.md', 'Notes/Ideas.md'] };

describe('wiki links', () => {
  it('resolves [[links]] to in-app note URLs', () => {
    const html = renderMarkdown('See [[Project A]] and [[Notes/Ideas|my ideas]].', ctx);
    expect(html).toContain('href="/n/Projects/Project%20A.md"');
    expect(html).toContain('>Project A</a>');
    expect(html).toContain('href="/n/Notes/Ideas.md"');
    expect(html).toContain('>my ideas</a>');
    expect(html).toContain('data-internal="1"');
  });

  it('marks unresolved links', () => {
    const html = renderWikiLink({ embed: false, target: 'Missing note' }, ctx);
    expect(html).toContain('unresolved');
    expect(html).toContain('href="/n/Missing%20note.md"');
  });

  it('renders image embeds through the file API', () => {
    const html = renderMarkdown('![[attachments/x y.png]]', ctx);
    expect(html).toContain('<img');
    expect(html).toContain('src="/api/file?path=attachments%2Fx+y.png"');
  });

  it('links non-image attachments', () => {
    const html = renderMarkdown('[[attachments/doc.pdf]]', ctx);
    expect(html).toContain('href="/api/file?path=attachments%2Fdoc.pdf"');
    expect(html).not.toContain('<img');
  });

  it('escapes link labels and sanitizes HTML', () => {
    const html = renderMarkdown(
      '[[<b>x</b>]] <script>alert(1)</script> <img src=x onerror=alert(1)>',
      ctx,
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<b>x</b>');
  });

  it('opens external links in a new tab', () => {
    const html = renderMarkdown('[site](https://example.com)', ctx);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe('block attribution', () => {
  const author = (kind: 'ai' | 'human', name: string) => ({ kind, name });
  it('matches blame entries to non-empty blocks by index and text', () => {
    const body = '# Title\n\nHuman paragraph.\n\nAI paragraph.\n';
    const blame: BlockAttribution[] = [
      {
        index: 0,
        text: '# Title\n\n',
        author: author('human', 'me'),
        commit: 'c1',
        date: '2026-01-01',
      },
      {
        index: 1,
        text: 'Human paragraph.\n\n',
        author: author('human', 'me'),
        commit: 'c1',
        date: '2026-01-01',
      },
      {
        index: 2,
        text: 'AI paragraph.\n',
        author: author('ai', 'claude'),
        commit: 'c2',
        date: '2026-01-02',
      },
    ];
    const blocks = attributeBlocks(body, blame);
    expect(blocks).toHaveLength(3);
    expect(blocks[2]!.author).toEqual({ kind: 'ai', name: 'claude' });
    expect(blocks[0]!.author?.kind).toBe('human');
  });

  it('ignores stale attribution whose text no longer matches', () => {
    const blocks = attributeBlocks('Changed text.\n', [
      { index: 0, text: 'Old text.', author: author('ai', 'bot'), commit: 'c', date: 'd' },
    ]);
    expect(blocks[0]!.author).toBeUndefined();
  });
});

describe('snippets and citations', () => {
  it('highlights «matches» and escapes the rest', () => {
    expect(highlightSnippet('a «b» <c>')).toBe('a <mark>b</mark> &lt;c&gt;');
  });

  it('turns [n] into links to the cited notes', () => {
    const md = linkCitations('答えです [1][2]。[9] は無し', [
      { n: 1, path: 'A.md' },
      { n: 2, path: 'Folder/B c.md' },
    ]);
    expect(md).toContain('[\\[1\\]](/n/A.md)');
    expect(md).toContain('[\\[2\\]](/n/Folder/B%20c.md)');
    expect(md).toContain('[9]');
  });
});
