import { parseNote, parseNoteDate, updateFrontmatter } from '@gmemo/core';
import { describe, expect, it } from 'vitest';
import {
  fromDateField,
  otherProps,
  readProps,
  readTags,
  toDateField,
  toggleAllDay,
  typedValue,
  validPropName,
} from '../src/lib/properties';

describe('note properties panel', () => {
  it('reads the frontmatter and the exact block it came from', () => {
    const text = '---\ndate: 2026-10-15\ntags: [a, b]\n---\n# Body\n';
    const r = readProps(text);
    expect(r.ok && r.frontmatter['date']).toBe('2026-10-15');
    expect(r.ok && r.head).toBe('---\ndate: 2026-10-15\ntags: [a, b]\n---\n');
    const none = readProps('# Just a body\n');
    expect(none.ok && none.head).toBe('');
  });

  it('refuses to edit broken YAML instead of writing over it', () => {
    expect(readProps('---\ndate: [unclosed\n---\nbody').ok).toBe(false);
  });

  it('converts dates between the stored form and date inputs', () => {
    expect(toDateField('2026-10-15')).toEqual({ allDay: true, input: '2026-10-15' });
    expect(toDateField('2026-10-15 9:30')).toEqual({ allDay: false, input: '2026-10-15T09:30' });
    expect(toDateField('2026-10-15T10:00:00+09:00')).toEqual({
      allDay: false,
      input: '2026-10-15T10:00',
    });
    expect(toDateField('next week')).toBeNull();
    expect(fromDateField({ allDay: true, input: '2026-10-15' })).toBe('2026-10-15');
    expect(fromDateField({ allDay: false, input: '2026-10-15T09:30' })).toBe('2026-10-15 09:30');
    expect(fromDateField({ allDay: true, input: '' })).toBeUndefined();
    expect(toggleAllDay({ allDay: true, input: '2026-10-15' }, false)).toEqual({
      allDay: false,
      input: '2026-10-15T09:00',
    });
    expect(toggleAllDay({ allDay: false, input: '2026-10-15T14:00' }, true).input).toBe(
      '2026-10-15',
    );
  });

  it('writes dates the calendar view understands', () => {
    for (const f of [
      { allDay: true, input: '2026-10-15' },
      { allDay: false, input: '2026-10-15T09:30' },
    ]) {
      const text = updateFrontmatter('# Plan\n', { date: fromDateField(f) });
      const stored = parseNote(text).frontmatter['date'];
      expect(parseNoteDate(stored, 'Asia/Tokyo'), String(stored)).not.toBeNull();
      expect(toDateField(stored)).toEqual(f);
    }
  });

  it('keeps the body untouched and drops the block when the last property goes', () => {
    const body = '# Plan\n\n- [ ] item\n';
    const withDate = updateFrontmatter(body, { date: '2026-10-15' });
    expect(withDate.endsWith(body)).toBe(true);
    expect(updateFrontmatter(withDate, { date: undefined })).toBe(body);
  });

  it('reads tags written as a list or as text', () => {
    expect(readTags(['a', '#b', 'a', ' '])).toEqual(['a', 'b']);
    expect(readTags('x, y ,#z')).toEqual(['x', 'y', 'z']);
    expect(readTags(undefined)).toEqual([]);
  });

  it('lists the other properties and leaves the app’s own ones out', () => {
    const others = otherProps({
      title: 't',
      created_by: 'human',
      date: '2026-10-15',
      priority: 2,
      owner: 'me',
      links: ['a'],
    });
    expect(others.map((p) => [p.key, p.editable])).toEqual([
      ['priority', true],
      ['owner', true],
      ['links', false],
    ]);
    expect(typedValue(2, '5')).toBe(5);
    expect(typedValue(2, 'high')).toBe('high');
    expect(typedValue('a', '5')).toBe('5');
  });

  it('accepts sensible property names only', () => {
    expect(validPropName('priority')).toBe(true);
    expect(validPropName('担当者')).toBe(true);
    expect(validPropName('due-date')).toBe(true);
    expect(validPropName('1st')).toBe(false);
    expect(validPropName('a b')).toBe(false);
    expect(validPropName('a:b')).toBe(false);
  });
});
