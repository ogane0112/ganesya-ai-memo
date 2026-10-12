import { describe, expect, it } from 'vitest';
import { extractNoteLinks, type NoteLink, resolveNoteLink } from '../src/index.js';

const targets = (links: NoteLink[], kind: NoteLink['kind']) =>
  links.filter((l) => l.kind === kind).map((l) => l.target);

describe('extractNoteLinks', () => {
  it('resolves Markdown links against the folder of the linking note', () => {
    const body = [
      '[詳細](./ai-rules-detail.md)',
      '[手順](../skills/updating-repo.md)',
      '[ルート相対](/profile/career.md)',
      '[アンカー](../README.md#更新ルール)',
      '[クエリ](../learning/proficiency-ranks.md?v=2)',
      '[空白](<../profile/context for ai.md> "title")',
    ].join('\n\n');
    expect(targets(extractNoteLinks('manuals/ai-prompt.md', body), 'markdown')).toEqual([
      'manuals/ai-rules-detail.md',
      'skills/updating-repo.md',
      'profile/career.md',
      'README.md',
      'learning/proficiency-ranks.md',
      'profile/context for ai.md',
    ]);
  });

  it('decodes percent-encoded paths', () => {
    const body = '[ガイド](calendar/%E3%82%AB%E3%83%AC%E3%83%B3%E3%83%80%E3%83%BC.md)';
    expect(targets(extractNoteLinks('README.md', body), 'markdown')).toEqual([
      'calendar/カレンダー.md',
    ]);
  });

  it('leaves out URLs, images, other file types, folders and code', () => {
    const body = [
      '[web](https://example.com/a.md)',
      '[mail](mailto:me@example.com)',
      '![図](assets/life-mgmt-overview.png)',
      '[図を直接](assets/life-mgmt-overview.png)',
      '[html](concept-map.html)',
      '[フォルダ](../skills/)',
      '[見出し](#section)',
      '[外](../../outside.md)',
      '```\n[code](a.md)\n```',
      '`[inline](b.md)`',
    ].join('\n\n');
    expect(targets(extractNoteLinks('manuals/ai-prompt.md', body), 'markdown')).toEqual([]);
  });

  it('follows reference-style links to their definition', () => {
    const body = [
      'see [詳細][rules] and [UPDATING-REPO][]',
      '',
      '[rules]: ./ai-rules-detail.md',
      '[updating-repo]: <../skills/updating-repo.md>',
      '[unused]: ../learning/proficiency-ranks.md',
      '[missing][nowhere]',
    ].join('\n');
    expect(targets(extractNoteLinks('manuals/ai-prompt.md', body), 'markdown')).toEqual([
      'manuals/ai-rules-detail.md',
      'skills/updating-repo.md',
    ]);
  });

  it('reads frontmatter related as paths from the repository root', () => {
    const links = extractNoteLinks('manuals/ai-prompt.md', '', {
      related: ['manuals/ai-rules-detail.md', './README.md', 'profile/context-for-ai', '  '],
    });
    expect(targets(links, 'related')).toEqual([
      'manuals/ai-rules-detail.md',
      'README.md',
      'profile/context-for-ai.md',
    ]);
    expect(
      targets(extractNoteLinks('manuals/ai-prompt.md', '', { related: 'README.md' }), 'related'),
    ).toEqual(['README.md']);
    expect(extractNoteLinks('a.md', '', { related: 42 })).toEqual([]);
  });

  it('keeps wiki links as written and de-duplicates per kind', () => {
    const links = extractNoteLinks(
      'manuals/ai-prompt.md',
      'x [[Note A]] ![[img.png]] [[Note A]] [a](./ai-rules-detail.md) [b](ai-rules-detail.md)',
      { related: ['manuals/ai-rules-detail.md', 'manuals/ai-rules-detail.md'] },
    );
    expect(links).toEqual([
      { target: 'Note A', kind: 'wikilink' },
      { target: 'img.png', kind: 'wikilink', embed: true },
      { target: 'manuals/ai-rules-detail.md', kind: 'markdown' },
      { target: 'manuals/ai-rules-detail.md', kind: 'related' },
    ]);
  });

  it('does not read a wiki link as a Markdown link as well', () => {
    expect(extractNoteLinks('a.md', '[[Note]](elsewhere.md) [[dir/B#h|alias]]')).toEqual([
      { target: 'Note', kind: 'wikilink' },
      { target: 'dir/B', kind: 'wikilink' },
    ]);
  });
});

describe('resolveNoteLink', () => {
  const paths = new Set(['manuals/ai-rules-detail.md', 'README.md', 'a/Note A.md']);

  it('matches paths exactly and wiki links loosely', () => {
    expect(resolveNoteLink({ target: 'README.md', kind: 'markdown' }, paths)).toBe('README.md');
    expect(resolveNoteLink({ target: 'readme.md', kind: 'markdown' }, paths)).toBeUndefined();
    expect(resolveNoteLink({ target: 'README.md', kind: 'related' }, paths)).toBe('README.md');
    expect(resolveNoteLink({ target: 'gone.md', kind: 'related' }, paths)).toBeUndefined();
    expect(resolveNoteLink({ target: 'note a', kind: 'wikilink' }, paths)).toBe('a/Note A.md');
  });
});
