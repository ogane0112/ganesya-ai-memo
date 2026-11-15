import { describe, expect, it } from 'vitest';
import { newNotePlan } from '../src/lib/newNote';

describe('newNotePlan', () => {
  const none = new Set<string>();

  it('creates nothing until there is a first line', () => {
    expect(newNotePlan('', 'Inbox', none)).toBeNull();
    expect(newNotePlan('  \n\n ', 'Inbox', none)).toBeNull();
  });

  it('names the note after the first line and makes it the heading', () => {
    expect(newNotePlan('買い物\n牛乳', 'Inbox', none)).toEqual({
      path: 'Inbox/買い物.md',
      heading: 0,
    });
    expect(newNotePlan('\n\n  旅行の計画\n', '', none)).toEqual({
      path: '旅行の計画.md',
      heading: 2,
    });
  });

  it('leaves headings and lists as written', () => {
    expect(newNotePlan('# 会議\n内容', '', none)).toEqual({ path: '会議.md', heading: null });
    expect(newNotePlan('- [ ] 牛乳\n- 卵', '', none)).toEqual({ path: '牛乳.md', heading: null });
  });

  it('does not overwrite an existing note, whatever its case', () => {
    expect(newNotePlan('Plan', 'Projects', new Set(['projects/plan.md']))?.path).toBe(
      'Projects/Plan 2.md',
    );
  });

  it('keeps file names safe', () => {
    expect(newNotePlan('a/b: c?', '', none)?.path).not.toMatch(/[/:?].*\.md$|^a\//);
  });
});
