import type { ExternalEvent } from '../api/types';
import { localDateKey } from './format';

function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return localDateKey(new Date(y, m - 1, d + n));
}

/** Local day keys an event covers (all-day spans every day; timed events up to their end). */
export function eventDayKeys(e: ExternalEvent): string[] {
  let first: string;
  let lastExclusive: string;
  if (e.allDay) {
    first = e.start;
    lastExclusive = e.end > e.start ? e.end : addDays(e.start, 1);
  } else {
    const s = new Date(e.start);
    const en = new Date(e.end);
    first = localDateKey(s);
    // An event ending exactly at midnight does not cover the next day.
    const endKey = localDateKey(new Date(Math.max(s.getTime(), en.getTime() - 1)));
    lastExclusive = addDays(endKey, 1);
  }
  const out: string[] = [];
  for (let k = first; k < lastExclusive && out.length < 62; k = addDays(k, 1)) out.push(k);
  return out;
}

/** Group events by local day key, all-day events first. */
export function bucketEvents(events: readonly ExternalEvent[]): Map<string, ExternalEvent[]> {
  const map = new Map<string, ExternalEvent[]>();
  for (const e of events) {
    for (const k of eventDayKeys(e)) {
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(e);
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.allDay === b.allDay ? (a.start < b.start ? -1 : 1) : a.allDay ? -1 : 1));
  }
  return map;
}

/** "10:00" for timed events, "終日" for all-day ones. */
export function eventTimeLabel(e: ExternalEvent): string {
  if (e.allDay) return '終日';
  const d = new Date(e.start);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** [from, to) date keys for the visible month grid. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { from: localDateKey(new Date(y, m - 1, 1)), to: localDateKey(new Date(y, m, 1)) };
}

export { addDays as addDayKey };
