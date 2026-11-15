import { describe, expect, it } from 'vitest';
import { pathForTitle, retitle, splitTitle, titleOf } from '../src/lib/title';

const L = (...l: string[]) => l.join('\n');

describe('titleOf', () => {
  it('prefers frontmatter title, then the first heading, then the file name', () => {
    expect(titleOf(L('---', 'title: 計画', '---', '# 別', ''), 'a.md')).toBe('計画');
    expect(titleOf(L('メモ', '# 会議', ''), 'a.md')).toBe('会議');
    expect(titleOf('本文だけ', 'Work/買い物.md')).toBe('買い物');
    expect(titleOf('', null)).toBe('');
  });
});

describe('splitTitle', () => {
  it('takes the leading heading out when it is the name', () => {
    expect(splitTitle(L('# 会議', '', '決めたこと'), '会議')).toEqual({
      heading: '# 会議',
      gap: '\n\n',
      rest: '決めたこと',
    });
    expect(splitTitle(L('# 会議', '決めたこと'), '会議').rest).toBe('決めたこと');
  });

  it('leaves the body alone otherwise', () => {
    expect(splitTitle(L('前書き', '# 会議'), '会議').heading).toBeNull();
    expect(splitTitle('# 別の見出し\n本文', '会議').rest).toBe('# 別の見出し\n本文');
  });

  it('puts back exactly what it took', () => {
    const body = L('# 会議', '', '決めたこと', '');
    const s = splitTitle(body, '会議');
    expect(s.heading! + s.gap + s.rest).toBe(body);
  });
});

describe('retitle', () => {
  it('renames the heading that carried the name', () => {
    expect(retitle(L('# 会議', '', '本文', '## 詳細'), '会議', '定例会議')).toBe(
      L('# 定例会議', '', '本文', '## 詳細'),
    );
  });

  it('renames the frontmatter title, and a heading only if it had the old name', () => {
    const a = retitle(L('---', 'title: 計画', '---', '# 計画', ''), '計画', '新計画');
    expect(a).toContain('title: 新計画');
    expect(a).toContain('# 新計画');
    const b = retitle(L('---', 'title: 計画', '---', '# 概要', ''), '計画', '新計画');
    expect(b).toContain('# 概要');
  });

  it('leaves notes named by their file name alone', () => {
    expect(retitle('本文だけ', '買い物', 'かいもの')).toBe('本文だけ');
  });
});

describe('pathForTitle', () => {
  it('keeps the folder and treats slashes as part of the name', () => {
    expect(pathForTitle(' 1/2の計画 ', 'Work')).toBe('Work/1-2の計画.md');
  });
});
