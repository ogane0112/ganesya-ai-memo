import { describe, expect, it } from 'vitest';
import { expandEvents, generateIcal, parseIcal, parseNoteDate, zonedToUtc } from '../src/index.js';

const TZ = 'Asia/Tokyo';
const range = (from: string, to: string) => ({
  from: Date.parse(from),
  to: Date.parse(to),
  timeZone: TZ,
});

const FEED = [
  'BEGIN:VCALENDAR',
  'X-WR-CALNAME:仕事',
  'BEGIN:VEVENT',
  'UID:single@x',
  'DTSTART;TZID=Asia/Tokyo:20261012T100000',
  'DTEND;TZID=Asia/Tokyo:20261012T113000',
  'SUMMARY:定例\\, 第1回',
  'LOCATION:会議室A',
  'BEGIN:VALARM',
  'SUMMARY:alarm should be ignored',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:allday@x',
  'DTSTART;VALUE=DATE:20261015',
  'DTEND;VALUE=DATE:20261017',
  'SUMMARY:出張',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:weekly@x',
  'DTSTART:20261005T000000Z',
  'DTEND:20261005T010000Z',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5',
  'EXDATE:20261007T000000Z',
  'SUMMARY:ジム',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:weekly@x',
  'RECURRENCE-ID:20261012T000000Z',
  'DTSTART:20261012T030000Z',
  'DTEND:20261012T040000Z',
  'SUMMARY:ジム(時間変更)',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:cancelled@x',
  'DTSTART:20261013T000000Z',
  'STATUS:CANCELLED',
  'SUMMARY:中止',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:monthly@x',
  'DTSTART;VALUE=DATE:20260101',
  'RRULE:FREQ=MONTHLY;BYDAY=-1FR',
  'SUMMARY:月末金曜',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('ical', () => {
  it('parses events, escapes and skips nested components', () => {
    const cal = parseIcal(FEED);
    expect(cal.name).toBe('仕事');
    expect(cal.events.find((e) => e.uid === 'single@x')).toMatchObject({
      summary: '定例, 第1回',
      location: '会議室A',
    });
  });

  it('expands recurrences, exdates, overrides and all-day spans', () => {
    const occ = expandEvents(
      parseIcal(FEED).events,
      range('2026-10-01T00:00:00+09:00', '2026-11-01T00:00:00+09:00'),
    );
    const pick = (uid: string) => occ.filter((o) => o.uid === uid);
    expect(pick('single@x')[0]).toMatchObject({
      start: '2026-10-12T01:00:00.000Z',
      end: '2026-10-12T02:30:00.000Z',
      allDay: false,
    });
    expect(pick('allday@x')[0]).toMatchObject({
      start: '2026-10-15',
      end: '2026-10-17',
      allDay: true,
    });
    // 5 occurrences: 10/5, (10/7 excluded), 10/12 overridden, 10/14, 10/19
    expect(pick('weekly@x').map((o) => [o.title, o.start.slice(0, 13)])).toEqual([
      ['ジム', '2026-10-05T00'],
      ['ジム(時間変更)', '2026-10-12T03'],
      ['ジム', '2026-10-14T00'],
      ['ジム', '2026-10-19T00'],
    ]);
    expect(pick('cancelled@x')).toEqual([]);
    expect(pick('monthly@x').map((o) => o.start)).toEqual(['2026-10-30']);
  });

  it('handles DST zones', () => {
    // 2026-03-08 is the US DST switch; 10:00 New York is 14:00 UTC after it.
    expect(
      new Date(
        zonedToUtc({ y: 2026, m: 3, d: 9, h: 10, mi: 0, s: 0 }, 'America/New_York'),
      ).toISOString(),
    ).toBe('2026-03-09T14:00:00.000Z');
    expect(
      new Date(
        zonedToUtc({ y: 2026, m: 3, d: 6, h: 10, mi: 0, s: 0 }, 'America/New_York'),
      ).toISOString(),
    ).toBe('2026-03-06T15:00:00.000Z');
  });

  it('parses note dates', () => {
    expect(parseNoteDate('2026-10-12', TZ)).toEqual({ allDay: true, date: '2026-10-12' });
    expect(parseNoteDate('2026-10-12 10:00', TZ)).toEqual({
      allDay: false,
      ms: Date.parse('2026-10-12T01:00:00Z'),
    });
    expect(parseNoteDate('2026-10-12T10:00+02:00', TZ)).toEqual({
      allDay: false,
      ms: Date.parse('2026-10-12T08:00:00Z'),
    });
    expect(parseNoteDate('2026-02-30', TZ)).toBeNull();
    expect(parseNoteDate('soon', TZ)).toBeNull();
  });

  it('generates a feed that parses back', () => {
    const text = generateIcal('ノート', [
      {
        uid: 'a@gmemo',
        title: 'とても長いタイトル'.repeat(10) + ', カンマ',
        start: '2026-10-12',
        end: '2026-10-13',
      },
      {
        uid: 'b@gmemo',
        title: 'timed',
        start: Date.parse('2026-10-12T01:00:00Z'),
        end: Date.parse('2026-10-12T02:00:00Z'),
        url: 'https://n.example/n/x.md',
      },
    ]);
    expect(text.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    const back = expandEvents(
      parseIcal(text).events,
      range('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'),
    );
    expect(back.map((o) => [o.title.endsWith(', カンマ'), o.start])).toEqual([
      [true, '2026-10-12'],
      [false, '2026-10-12T01:00:00.000Z'],
    ]);
  });
});
