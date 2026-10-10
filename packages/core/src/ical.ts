/**
 * Minimal iCalendar (RFC 5545) support: parse VEVENTs from a feed (e.g. a
 * Google Calendar "secret address in iCal format"), expand common recurrence
 * rules into concrete occurrences, and generate a feed from notes.
 */

/** Wall-clock time (no zone). Months are 1-based. */
export interface WallTime {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export interface IcalDate {
  wall: WallTime;
  /** Date only (all-day). */
  dateOnly: boolean;
  /** 'UTC', an IANA zone, or undefined for floating time. */
  tz?: string;
}

export interface IcalEvent {
  uid: string;
  summary: string;
  location?: string;
  start: IcalDate;
  end?: IcalDate;
  /** Duration in seconds when DURATION was given instead of DTEND. */
  durationSec?: number;
  rrule?: string;
  exdates: IcalDate[];
  recurrenceId?: IcalDate;
  cancelled: boolean;
}

export interface CalendarOccurrence {
  uid: string;
  title: string;
  location?: string;
  allDay: boolean;
  /** All-day: 'YYYY-MM-DD'. Timed: ISO 8601 UTC. */
  start: string;
  /** Exclusive end, same format as start. */
  end: string;
}

// ---- line handling -------------------------------------------------------------

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function unfold(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
}

function parseProp(line: string): Prop | null {
  // NAME;PARAM=VALUE;PARAM="quoted:value":VALUE
  let i = 0;
  let inQuote = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ':' && !inQuote) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts = head.match(/(?:[^;"]|"[^"]*")+/g) ?? [];
  const name = (parts[0] ?? '').toUpperCase();
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

export function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

export function escapeText(v: string): string {
  return v.replace(/[\\;,]/g, (c) => '\\' + c).replace(/\r?\n/g, '\\n');
}

function parseDateValue(value: string, params: Record<string, string>): IcalDate | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const wall: WallTime = {
    y: +m[1]!,
    m: +m[2]!,
    d: +m[3]!,
    h: m[4] ? +m[4] : 0,
    mi: m[5] ? +m[5] : 0,
    s: m[6] ? +m[6] : 0,
  };
  const dateOnly = !m[4] || params['VALUE'] === 'DATE';
  if (dateOnly) return { wall, dateOnly: true };
  if (m[7]) return { wall, dateOnly: false, tz: 'UTC' };
  return params['TZID'] ? { wall, dateOnly: false, tz: params['TZID'] } : { wall, dateOnly: false };
}

function parseDuration(v: string): number | undefined {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    v.trim(),
  );
  if (!m) return undefined;
  const sec =
    (+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86400 +
    +(m[4] ?? 0) * 3600 +
    +(m[5] ?? 0) * 60 +
    +(m[6] ?? 0);
  return m[1] === '-' ? -sec : sec;
}

/** Parse all VEVENTs (nested components like VALARM are skipped). */
export function parseIcal(text: string): { name?: string; events: IcalEvent[] } {
  const events: IcalEvent[] = [];
  let name: string | undefined;
  let cur: IcalEvent | null = null;
  let depth = 0; // nesting inside the current VEVENT
  for (const line of unfold(text)) {
    if (!line) continue;
    const p = parseProp(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      if (p.value.toUpperCase() === 'VEVENT' && !cur) {
        cur = {
          uid: '',
          summary: '',
          start: null as unknown as IcalDate,
          exdates: [],
          cancelled: false,
        };
        depth = 0;
      } else if (cur) depth++;
      continue;
    }
    if (p.name === 'END') {
      if (cur && depth > 0) depth--;
      else if (cur && p.value.toUpperCase() === 'VEVENT') {
        if (cur.start) events.push(cur);
        cur = null;
      }
      continue;
    }
    if (!cur) {
      if (p.name === 'X-WR-CALNAME') name = unescapeText(p.value);
      continue;
    }
    if (depth > 0) continue;
    switch (p.name) {
      case 'UID':
        cur.uid = p.value;
        break;
      case 'SUMMARY':
        cur.summary = unescapeText(p.value);
        break;
      case 'LOCATION':
        if (p.value) cur.location = unescapeText(p.value);
        break;
      case 'DTSTART': {
        const d = parseDateValue(p.value, p.params);
        if (d) cur.start = d;
        break;
      }
      case 'DTEND': {
        const d = parseDateValue(p.value, p.params);
        if (d) cur.end = d;
        break;
      }
      case 'DURATION': {
        const d = parseDuration(p.value);
        if (d !== undefined) cur.durationSec = d;
        break;
      }
      case 'RRULE':
        cur.rrule = p.value;
        break;
      case 'EXDATE':
        for (const v of p.value.split(',')) {
          const d = parseDateValue(v, p.params);
          if (d) cur.exdates.push(d);
        }
        break;
      case 'RECURRENCE-ID': {
        const d = parseDateValue(p.value, p.params);
        if (d) cur.recurrenceId = d;
        break;
      }
      case 'STATUS':
        cur.cancelled = p.value.toUpperCase() === 'CANCELLED';
        break;
    }
  }
  return { ...(name ? { name } : {}), events };
}

// ---- time zones -----------------------------------------------------------------

const dtfCache = new Map<string, Intl.DateTimeFormat | null>();

function formatter(tz: string): Intl.DateTimeFormat | null {
  if (!dtfCache.has(tz)) {
    try {
      dtfCache.set(
        tz,
        new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          hourCycle: 'h23',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      );
    } catch {
      dtfCache.set(tz, null);
    }
  }
  return dtfCache.get(tz) ?? null;
}

export function isValidTimeZone(tz: string): boolean {
  return formatter(tz) !== null;
}

/** Offset of `tz` from UTC at instant `ts`, in ms. */
function tzOffset(ts: number, tz: string): number {
  const f = formatter(tz);
  if (!f) return 0;
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ts))) if (p.type !== 'literal') parts[p.type] = +p.value;
  const asUtc = Date.UTC(
    parts['year']!,
    parts['month']! - 1,
    parts['day']!,
    parts['hour']!,
    parts['minute']!,
    parts['second']!,
  );
  return asUtc - Math.floor(ts / 1000) * 1000;
}

function wallMs(w: WallTime): number {
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
}

function msToWall(ms: number): WallTime {
  const d = new Date(ms);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
}

/** Convert a wall-clock time in `tz` to a UTC timestamp. Unknown zones fall back to `fallbackTz`. */
export function zonedToUtc(w: WallTime, tz: string | undefined, fallbackTz = 'UTC'): number {
  const zone = tz === 'UTC' ? 'UTC' : tz && isValidTimeZone(tz) ? tz : fallbackTz;
  const guess = wallMs(w);
  if (zone === 'UTC') return guess;
  let ts = guess - tzOffset(guess, zone);
  // Second pass handles DST transitions between the guess and the result.
  ts = guess - tzOffset(ts, zone);
  return ts;
}

/** Wall-clock time of instant `ts` in `tz`. */
export function utcToZoned(ts: number, tz: string): WallTime {
  return msToWall(ts + (tz === 'UTC' ? 0 : tzOffset(ts, tz)));
}

export function dateKey(w: Pick<WallTime, 'y' | 'm' | 'd'>): string {
  return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}

// ---- recurrence -----------------------------------------------------------------

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count?: number;
  until?: IcalDate;
  byDay: { n: number; wd: number }[];
  byMonthDay: number[];
  byMonth: number[];
}

function parseRule(s: string): Rule | null {
  const kv: Record<string, string> = {};
  for (const part of s.split(';')) {
    const [k, v] = part.split('=');
    if (k && v) kv[k.toUpperCase()] = v;
  }
  const freq = kv['FREQ'] as Rule['freq'];
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
  const rule: Rule = {
    freq,
    interval: Math.max(1, +(kv['INTERVAL'] ?? 1) || 1),
    byDay: (kv['BYDAY'] ?? '')
      .split(',')
      .filter(Boolean)
      .map((d) => {
        const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(d);
        return m ? { n: m[1] ? +m[1] : 0, wd: WEEKDAYS.indexOf(m[2]!) } : null;
      })
      .filter((x): x is { n: number; wd: number } => x !== null),
    byMonthDay: (kv['BYMONTHDAY'] ?? '').split(',').filter(Boolean).map(Number),
    byMonth: (kv['BYMONTH'] ?? '').split(',').filter(Boolean).map(Number),
  };
  if (kv['COUNT']) rule.count = +kv['COUNT'];
  if (kv['UNTIL']) {
    const u = parseDateValue(kv['UNTIL'], {});
    if (u) rule.until = u;
  }
  return rule;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function weekday(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Days of month `m` matching BYDAY entries like 2TU, -1FR or plain MO. */
function monthDaysByWeekday(y: number, m: number, byDay: Rule['byDay']): number[] {
  const dim = daysInMonth(y, m);
  const out = new Set<number>();
  for (const { n, wd } of byDay) {
    const matches: number[] = [];
    for (let d = 1; d <= dim; d++) if (weekday(y, m, d) === wd) matches.push(d);
    if (n === 0) matches.forEach((d) => out.add(d));
    else {
      const d = n > 0 ? matches[n - 1] : matches[matches.length + n];
      if (d) out.add(d);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function monthDays(y: number, m: number, byMonthDay: number[]): number[] {
  const dim = daysInMonth(y, m);
  return [
    ...new Set(byMonthDay.map((d) => (d < 0 ? dim + d + 1 : d)).filter((d) => d >= 1 && d <= dim)),
  ].sort((a, b) => a - b);
}

const MAX_ITERATIONS = 20000;

/**
 * Candidate start dates (wall time, same time of day as DTSTART) in order.
 * Stops after `limit` dates or once past `stopAfterMs` (wall-clock ms).
 */
function* ruleDates(start: WallTime, rule: Rule): Generator<WallTime> {
  const time = { h: start.h, mi: start.mi, s: start.s };
  let iterations = 0;
  if (rule.freq === 'DAILY') {
    for (let k = 0; iterations++ < MAX_ITERATIONS; k += rule.interval) {
      const w = msToWall(Date.UTC(start.y, start.m - 1, start.d + k, time.h, time.mi, time.s));
      if (rule.byMonth.length && !rule.byMonth.includes(w.m)) continue;
      if (rule.byDay.length && !rule.byDay.some((b) => b.wd === weekday(w.y, w.m, w.d))) continue;
      yield w;
    }
    return;
  }
  if (rule.freq === 'WEEKLY') {
    const days = rule.byDay.length
      ? rule.byDay.map((b) => b.wd)
      : [weekday(start.y, start.m, start.d)];
    // Week starts on Monday (WKST=MO default).
    const startWd = (weekday(start.y, start.m, start.d) + 6) % 7;
    const weekStart = Date.UTC(start.y, start.m - 1, start.d - startWd);
    const offsets = [...new Set(days.map((wd) => (wd + 6) % 7))].sort((a, b) => a - b);
    for (let wk = 0; iterations++ < MAX_ITERATIONS; wk += rule.interval) {
      for (const off of offsets) {
        const base = new Date(weekStart + (wk * 7 + off) * 86400000);
        yield {
          y: base.getUTCFullYear(),
          m: base.getUTCMonth() + 1,
          d: base.getUTCDate(),
          ...time,
        };
      }
    }
    return;
  }
  if (rule.freq === 'MONTHLY') {
    for (let k = 0; iterations++ < MAX_ITERATIONS; k += rule.interval) {
      const y = start.y + Math.floor((start.m - 1 + k) / 12);
      const m = ((start.m - 1 + k) % 12) + 1;
      if (rule.byMonth.length && !rule.byMonth.includes(m)) continue;
      let days: number[];
      if (rule.byDay.length) days = monthDaysByWeekday(y, m, rule.byDay);
      else if (rule.byMonthDay.length) days = monthDays(y, m, rule.byMonthDay);
      else days = start.d <= daysInMonth(y, m) ? [start.d] : [];
      if (rule.byDay.length && rule.byMonthDay.length)
        days = days.filter((d) => monthDays(y, m, rule.byMonthDay).includes(d));
      for (const d of days) yield { y, m, d, ...time };
    }
    return;
  }
  // YEARLY
  for (let k = 0; iterations++ < MAX_ITERATIONS; k += rule.interval) {
    const y = start.y + k;
    const months = rule.byMonth.length ? rule.byMonth : [start.m];
    for (const m of [...months].sort((a, b) => a - b)) {
      let days: number[];
      if (rule.byDay.length) days = monthDaysByWeekday(y, m, rule.byDay);
      else if (rule.byMonthDay.length) days = monthDays(y, m, rule.byMonthDay);
      else days = start.d <= daysInMonth(y, m) ? [start.d] : [];
      for (const d of days) yield { y, m, d, ...time };
    }
  }
}

export interface ExpandOptions {
  /** Window start/end as UTC ms (end exclusive). */
  from: number;
  to: number;
  /** Zone for floating times and all-day dates. */
  timeZone: string;
  /** Safety cap on returned occurrences. */
  limit?: number;
}

function toInstant(d: IcalDate, tz: string): number {
  return d.dateOnly
    ? zonedToUtc({ ...d.wall, h: 0, mi: 0, s: 0 }, tz, tz)
    : zonedToUtc(d.wall, d.tz, tz);
}

function occurrenceKey(d: IcalDate, tz: string): string {
  return d.dateOnly ? dateKey(d.wall) : String(toInstant(d, tz));
}

/** Expand events (including recurrences and overrides) into occurrences inside the window. */
export function expandEvents(
  events: readonly IcalEvent[],
  opts: ExpandOptions,
): CalendarOccurrence[] {
  const tz = isValidTimeZone(opts.timeZone) ? opts.timeZone : 'UTC';
  const limit = opts.limit ?? 2000;
  const out: CalendarOccurrence[] = [];

  // Overrides (RECURRENCE-ID) replace the matching generated occurrence.
  const overridden = new Set<string>();
  for (const e of events)
    if (e.recurrenceId) overridden.add(`${e.uid}|${occurrenceKey(e.recurrenceId, tz)}`);

  const emit = (e: IcalEvent, startWall: WallTime) => {
    const allDay = e.start.dateOnly;
    if (allDay) {
      const startMs = Date.UTC(startWall.y, startWall.m - 1, startWall.d);
      const lenDays = e.end?.dateOnly
        ? Math.max(1, Math.round((wallMs(e.end.wall) - wallMs(e.start.wall)) / 86400000))
        : e.durationSec
          ? Math.max(1, Math.round(e.durationSec / 86400))
          : 1;
      const endW = msToWall(startMs + lenDays * 86400000);
      const s = toInstant({ wall: startWall, dateOnly: true }, tz);
      const en = toInstant({ wall: endW, dateOnly: true }, tz);
      if (en <= opts.from || s >= opts.to) return;
      out.push({
        uid: e.uid,
        title: e.summary,
        ...(e.location ? { location: e.location } : {}),
        allDay: true,
        start: dateKey(startWall),
        end: dateKey(endW),
      });
      return;
    }
    const s = zonedToUtc(startWall, e.start.tz, tz);
    const len = e.end
      ? toInstant(e.end, tz) - toInstant(e.start, tz)
      : (e.durationSec ?? 3600) * 1000;
    const en = s + Math.max(0, len);
    if (en <= opts.from && !(len === 0 && s >= opts.from)) return;
    if (s >= opts.to) return;
    out.push({
      uid: e.uid,
      title: e.summary,
      ...(e.location ? { location: e.location } : {}),
      allDay: false,
      start: new Date(s).toISOString(),
      end: new Date(en).toISOString(),
    });
  };

  for (const e of events) {
    if (e.cancelled) continue;
    const rule = e.rrule && !e.recurrenceId ? parseRule(e.rrule) : null;
    if (!rule) {
      emit(e, e.start.wall);
      continue;
    }
    const ex = new Set(e.exdates.map((d) => occurrenceKey(d, tz)));
    const untilMs = rule.until ? toInstant(rule.until, tz) : Infinity;
    const startMs = toInstant(e.start, tz);
    let count = 0;
    for (const w of ruleDates(e.start.wall, rule)) {
      const cand: IcalDate = {
        wall: w,
        dateOnly: e.start.dateOnly,
        ...(e.start.tz ? { tz: e.start.tz } : {}),
      };
      const ms = toInstant(cand, tz);
      if (ms < startMs) continue;
      if (ms > untilMs) break;
      if (rule.count !== undefined && count >= rule.count) break;
      count++;
      if (ms >= opts.to) break;
      const key = occurrenceKey(cand, tz);
      if (ex.has(key) || overridden.has(`${e.uid}|${key}`)) continue;
      emit(e, w);
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

// ---- generation -------------------------------------------------------------------

export interface FeedEvent {
  uid: string;
  title: string;
  /** All-day: 'YYYY-MM-DD'; timed: UTC ms. */
  start: string | number;
  /** Exclusive end; same kind as start. */
  end: string | number;
  url?: string;
  description?: string;
}

function foldLine(line: string): string {
  // Fold at 75 octets without splitting UTF-8 sequences.
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  let max = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > max) {
      out.push(cur);
      cur = '';
      bytes = 0;
      max = 74; // continuation lines start with a space
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function fmtUtc(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function fmtDate(key: string): string {
  return key.replace(/-/g, '');
}

export function generateIcal(
  calName: string,
  events: readonly FeedEvent[],
  now = Date.now(),
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ganesya-ai-memo//gmemo//JA',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calName)}`,
  ];
  const stamp = fmtUtc(now);
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${stamp}`);
    if (typeof e.start === 'string') {
      lines.push(
        `DTSTART;VALUE=DATE:${fmtDate(e.start)}`,
        `DTEND;VALUE=DATE:${fmtDate(String(e.end))}`,
      );
    } else {
      lines.push(`DTSTART:${fmtUtc(e.start)}`, `DTEND:${fmtUtc(Number(e.end))}`);
    }
    lines.push(`SUMMARY:${escapeText(e.title)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// ---- note dates ---------------------------------------------------------------------

export type NoteDate = { allDay: true; date: string } | { allDay: false; ms: number };

/**
 * Interpret a frontmatter value as a date: `2026-10-12` (all-day),
 * `2026-10-12 10:00` / `2026-10-12T10:00` (in `timeZone`), or with an explicit offset.
 */
export function parseNoteDate(v: unknown, timeZone: string): NoteDate | null {
  if (v instanceof Date) return { allDay: false, ms: v.getTime() };
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      s,
    );
  if (!m) return null;
  const y = +m[1]!;
  const mo = +m[2]!;
  const d = +m[3]!;
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  if (!m[4]) return { allDay: true, date: dateKey({ y, m: mo, d }) };
  const wall = { y, m: mo, d, h: +m[4], mi: +m[5]!, s: m[6] ? +m[6] : 0 };
  if (m[7]) {
    const off =
      m[7] === 'Z'
        ? 0
        : (m[7][0] === '-' ? -1 : 1) * (+m[7].slice(1, 3) * 60 + +m[7].slice(-2)) * 60000;
    return { allDay: false, ms: wallMs(wall) - off };
  }
  return { allDay: false, ms: zonedToUtc(wall, timeZone, timeZone) };
}

export function addDaysKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return dateKey(msToWall(Date.UTC(y, m - 1, d + days)));
}
