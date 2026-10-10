import { describe, expect, it } from 'vitest';
import {
  applyView,
  blameBlocks,
  effectiveAccess,
  extractLinks,
  extractTags,
  groupRows,
  isMyNumber,
  maskText,
  normalizeNotePath,
  normalizePolicy,
  parseNote,
  parseView,
  renameLinks,
  resolveLink,
  scanText,
  serializeNote,
  unmaskText,
  updateFrontmatter,
} from '../src/index.js';

describe('frontmatter', () => {
  it('parses and serializes', () => {
    const p = parseNote('---\ntitle: Hello\ncreated_by: ai\n---\nbody\n');
    expect(p.frontmatter).toEqual({ title: 'Hello', created_by: 'ai' });
    expect(p.body).toBe('body\n');
    expect(serializeNote(p.frontmatter, p.body)).toBe('---\ntitle: Hello\ncreated_by: ai\n---\nbody\n');
  });
  it('handles notes without frontmatter', () => {
    expect(parseNote('# hi').hasFrontmatter).toBe(false);
    expect(updateFrontmatter('# hi\n', { a: 1 })).toBe('---\na: 1\n---\n# hi\n');
  });
  it('throws on broken yaml', () => {
    expect(() => parseNote('---\na: [\n---\n')).toThrow();
  });
});

describe('links', () => {
  it('extracts wiki links but not inside code', () => {
    const links = extractLinks('See [[Note A]] and [[dir/B#Head|alias]] ![[img.png]]\n\n```\n[[not]]\n```\n`[[no]]`');
    expect(links.map((l) => l.target)).toEqual(['Note A', 'dir/B', 'img.png']);
    expect(links[1]).toMatchObject({ heading: 'Head', alias: 'alias' });
    expect(links[2]?.embed).toBe(true);
  });
  it('resolves links by basename', () => {
    const paths = ['a/Note A.md', 'b/c/Note A.md', 'Other.md'];
    expect(resolveLink('Note A', paths)).toBe('a/Note A.md');
    expect(resolveLink('c/Note A', paths)).toBe('b/c/Note A.md');
    expect(resolveLink('other', paths)).toBe('Other.md');
    expect(resolveLink('missing', paths)).toBeUndefined();
  });
  it('renames links', () => {
    expect(renameLinks('x [[Old]] [[Old#h|a]] [[Other]]', 'Old.md', 'dir/New.md')).toBe('x [[New]] [[New#h|a]] [[Other]]');
  });
  it('extracts tags', () => {
    expect(extractTags('hello #todo and #日本語 #123 `#code`', ['Work'])).toEqual(['todo', '日本語', 'work']);
  });
});

describe('sensitive', () => {
  it('detects secrets and PII', () => {
    const text = [
      'key: AKIAIOSFODNN7EXAMPLE',
      'token ghp_' + 'a'.repeat(36),
      'password = hunter2xyz',
      'card 4111 1111 1111 1111',
      'tel 090-1234-5678',
      'mail me@example.com',
      'anthropic sk-ant-' + 'b'.repeat(30),
    ].join('\n');
    const rules = scanText(text).map((f) => f.rule);
    expect(rules).toEqual(['aws-access-key', 'github-token', 'password-assignment', 'credit-card', 'phone-jp', 'email', 'anthropic-key']);
  });
  it('validates my number check digit', () => {
    expect(isMyNumber('123456789018')).toBe(true);
    expect(isMyNumber('123456789012')).toBe(false);
  });
  it('supports dictionary and allow-list', () => {
    const f = scanText('Acme社との契約 me@example.com', { dictionary: ['Acme'] });
    expect(f.map((x) => x.rule)).toEqual(['dictionary', 'email']);
    const allowed = scanText('me@example.com', { allow: [f[1]!.fingerprint] });
    expect(allowed).toEqual([]);
  });
  it('masks and unmasks consistently', () => {
    const text = 'Acme and Acme, mail a@b.co';
    const findings = scanText(text, { dictionary: ['Acme'] });
    const { text: masked, mapping } = maskText(text, findings);
    expect(masked).toBe('[SECRET_1] and [SECRET_1], mail [SECRET_2]');
    expect(unmaskText('Reply about [SECRET_1]', mapping)).toBe('Reply about Acme');
  });
});

describe('policy', () => {
  const policy = normalizePolicy({ ai: { default: 'external', folders: { 'private/': 'none', work: 'local' } } });
  it('resolves by longest folder prefix and frontmatter', () => {
    expect(effectiveAccess(policy, 'a.md')).toBe('external');
    expect(effectiveAccess(policy, 'private/x.md')).toBe('none');
    expect(effectiveAccess(policy, 'work/x.md')).toBe('local');
    expect(effectiveAccess(policy, 'workshop/x.md')).toBe('external');
    expect(effectiveAccess(policy, 'a.md', { sensitivity: 'secret' })).toBe('local');
    expect(effectiveAccess(policy, 'private/a.md', { sensitivity: 'secret' })).toBe('none');
  });
});

describe('views', () => {
  const notes = [
    { path: 'p/a.md', title: 'A', tags: ['task'], properties: { status: 'todo', due: '2026-10-12', prio: 2 } },
    { path: 'p/b.md', title: 'B', tags: ['task'], properties: { status: 'done', due: '2026-10-11', prio: 1 } },
    { path: 'q/c.md', title: 'C', tags: [], properties: { status: 'todo' } },
  ];
  it('filters, sorts and groups', () => {
    const v = parseView('tasks', 'name: Tasks\ntype: kanban\nfolder: p\nsort: [{property: prio, direction: desc}]\ngroups: [todo, doing, done]');
    const rows = applyView(v, notes);
    expect(rows.map((r) => r.title)).toEqual(['A', 'B']);
    expect(groupRows(v, rows).map((g) => [g.key, g.rows.length])).toEqual([['todo', 1], ['doing', 0], ['done', 1]]);
    const v2 = parseView('x', 'filters: [{property: due, op: lt, value: "2026-10-12"}]');
    expect(applyView(v2, notes).map((r) => r.title)).toEqual(['B']);
  });
});

describe('blame', () => {
  it('attributes blocks to the last author', () => {
    const human = { kind: 'human' as const, name: 'me' };
    const ai = { kind: 'ai' as const, name: 'claude' };
    const res = blameBlocks([
      { text: 'p1\n\np2\n', author: human, commit: 'c1', date: 'd1' },
      { text: 'p1\n\np2 edited\n\np3\n', author: ai, commit: 'c2', date: 'd2' },
    ]);
    expect(res.map((r) => [r.author.name, r.commit])).toEqual([['me', 'c1'], ['claude', 'c2'], ['claude', 'c2']]);
  });
});

describe('paths', () => {
  it('rejects traversal', () => {
    expect(() => normalizeNotePath('../x.md')).toThrow();
    expect(() => normalizeNotePath('.git/config')).toThrow();
    expect(normalizeNotePath('/a//b.md')).toBe('a/b.md');
  });
});
