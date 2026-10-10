import { describe, expect, it } from 'vitest';
import type { ExternalEvent } from '../src/api/types';
import { bucketEvents, eventDayKeys, monthRange } from '../src/lib/calendar';

const ev = (p: Partial<ExternalEvent>): ExternalEvent => ({
  uid: 'u',
  title: 't',
  allDay: false,
  start: '',
  end: '',
  subscriptionId: 's',
  calendar: 'c',
  color: '#000000',
  ...p,
});

describe('calendar helpers', () => {
  it('spans all-day events over every covered day (end exclusive)', () => {
    expect(eventDayKeys(ev({ allDay: true, start: '2026-10-15', end: '2026-10-17' }))).toEqual([
      '2026-10-15',
      '2026-10-16',
    ]);
    expect(eventDayKeys(ev({ allDay: true, start: '2026-10-31', end: '2026-11-01' }))).toEqual([
      '2026-10-31',
    ]);
  });

  it('puts timed events on their local days', () => {
    const s = new Date(2026, 9, 12, 10, 0).toISOString();
    const e = new Date(2026, 9, 12, 11, 0).toISOString();
    expect(eventDayKeys(ev({ start: s, end: e }))).toEqual(['2026-10-12']);
    const midnight = new Date(2026, 9, 13, 0, 0).toISOString();
    expect(eventDayKeys(ev({ start: s, end: midnight }))).toEqual(['2026-10-12']);
  });

  it('sorts all-day events first', () => {
    const timed = ev({
      uid: 'a',
      start: new Date(2026, 9, 12, 9).toISOString(),
      end: new Date(2026, 9, 12, 10).toISOString(),
    });
    const allDay = ev({ uid: 'b', allDay: true, start: '2026-10-12', end: '2026-10-13' });
    expect(
      bucketEvents([timed, allDay])
        .get('2026-10-12')!
        .map((x) => x.uid),
    ).toEqual(['b', 'a']);
  });

  it('computes the month range', () => {
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2027-01-01' });
  });
});
