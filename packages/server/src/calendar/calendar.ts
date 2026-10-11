import {
  addDaysKey,
  applyView,
  type CalendarOccurrence,
  effectiveAccess,
  expandEvents,
  type FeedEvent,
  generateIcal,
  getProperty,
  isValidTimeZone,
  parseIcal,
  parseNoteDate,
  parseView,
  scanText,
  type WorkspacePolicy,
} from '@gmemo/core';
import type { Config } from '../config.js';
import { type Db, nowIso } from '../db/db.js';
import type { NoteService } from '../notes/service.js';
import type { Indexer } from '../search/indexer.js';
import { randomId, randomToken, sha256 } from '../util/crypto.js';

export class CalendarError extends Error {}

export interface CalendarFeed {
  id: string;
  viewId: string;
  label: string;
  includeLinks: boolean;
  createdAt: string;
  lastFetchedAt: string | null;
}

export interface CalendarSubscription {
  id: string;
  name: string;
  /** Shown masked; the full URL is a secret. */
  urlPreview: string;
  color: string;
  enabled: boolean;
  createdAt: string;
  fetchedAt: string | null;
  lastError: string | null;
  eventCount: number | null;
}

export interface ExternalEvent extends CalendarOccurrence {
  subscriptionId: string;
  calendar: string;
  color: string;
}

interface FeedRow {
  id: string;
  token_hash: string;
  view_id: string;
  label: string;
  include_links: number;
  created_at: string;
  last_fetched_at: string | null;
  revoked_at: string | null;
}

interface SubRow {
  id: string;
  name: string;
  url: string;
  color: string;
  enabled: number;
  created_at: string;
  fetched_at: string | null;
  etag: string | null;
  body: string | null;
  last_error: string | null;
}

/** D1 stores at most 2 MB per value. */
const MAX_FEED_BYTES = 1_900_000;
const REFRESH_MS = 15 * 60_000;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

/** IP literals in private, loopback and link-local ranges (DNS names are not resolved). */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) return isPrivateV4(v4.slice(1).map(Number));
  if (!h.includes(':')) return false;
  const words = ipv6Words(h);
  if (!words) return true; // not a valid IPv6 literal: refuse rather than guess
  const [a] = words;
  // ::, ::1, IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible and NAT64 (64:ff9b::/96) carry an
  // IPv4 address in the last 32 bits: judge that address.
  const zeros5 = words.slice(0, 5).every((w) => w === 0);
  if (zeros5 && (words[5] === 0 || words[5] === 0xffff)) {
    if (words[5] === 0 && words[6] === 0 && words[7]! <= 1) return true;
    return isPrivateV4([words[6]! >> 8, words[6]! & 255, words[7]! >> 8, words[7]! & 255]);
  }
  if (a === 0x64 && words[1] === 0xff9b)
    return isPrivateV4([words[6]! >> 8, words[6]! & 255, words[7]! >> 8, words[7]! & 255]);
  return (
    (a! & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (a! & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (a! & 0xff00) === 0xff00 || // multicast
    (a === 0x2001 && words[1] === 0x0db8) // documentation
  );
}

function isPrivateV4([a, b]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a! >= 224
  );
}

/** The eight 16-bit words of an IPv6 literal (with an optional trailing IPv4 part), or null. */
function ipv6Words(h: string): number[] | null {
  let s = h.replace(/%.*$/, '');
  const tail = /:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const p = tail[1]!.split('.').map(Number);
    if (p.some((n) => n > 255)) return null;
    s = `${s.slice(0, tail.index)}:${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (x: string) => (x ? x.split(':') : []);
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...rest];
  if (all.some((w) => !/^[0-9a-f]{1,4}$/.test(w))) return null;
  return all.map((w) => parseInt(w, 16));
}

/** Read a response body as text, stopping as soon as it exceeds `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error('カレンダーが大きすぎます(2MBまで)');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '…';
  }
}

/**
 * Calendar integration.
 *
 * - Feeds (notes → Google Calendar etc.): a view is published as an .ics URL
 *   with an unguessable token. This sends note titles to whoever fetches the
 *   URL, so only notes whose AI policy is "external" are included, titles that
 *   trip the sensitive-data scan are replaced, and links are opt-in.
 * - Subscriptions (Google Calendar etc. → app): an iCal URL is fetched by the
 *   server and shown on calendar views. Nothing is sent out.
 */
export class CalendarService {
  private inflight = new Map<string, Promise<void>>();
  readonly timeZone: string;

  constructor(
    private readonly db: Db,
    private readonly userId: string,
    private readonly cfg: Config,
    private readonly notes: NoteService,
    private readonly indexer: Indexer,
    /** Resolves a host name to addresses (Node.js), so names pointing inside are refused too. */
    private readonly resolveHost?: (host: string) => Promise<string[]>,
  ) {
    this.timeZone = isValidTimeZone(cfg.timeZone) ? cfg.timeZone : 'UTC';
  }

  // ---- feeds (export) ------------------------------------------------------

  /** Which user a feed token belongs to (public /cal/<token>.ics requests). */
  static async feedOwner(db: Db, token: string): Promise<string | null> {
    const r = await db.first<{ user_id: string }>(
      'SELECT user_id FROM calendar_feeds WHERE token_hash = ? AND revoked_at IS NULL',
      await sha256(token),
    );
    return r?.user_id ?? null;
  }

  async feeds(): Promise<CalendarFeed[]> {
    return (
      await this.db.all<FeedRow>(
        'SELECT * FROM calendar_feeds WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at',
        this.userId,
      )
    ).map((r) => ({
      id: r.id,
      viewId: r.view_id,
      label: r.label,
      includeLinks: !!r.include_links,
      createdAt: r.created_at,
      lastFetchedAt: r.last_fetched_at,
    }));
  }

  /** Create a feed; the URL (with its token) is returned only once. */
  async createFeed(
    viewId: string,
    opts: { label?: string; includeLinks?: boolean },
  ): Promise<{ feed: CalendarFeed; url: string }> {
    const view = await this.loadView(viewId);
    if (view.type !== 'calendar') throw new CalendarError('カレンダー型のビューだけを公開できます');
    const token = randomToken(24);
    const id = randomId('cf_');
    await this.db.run(
      'INSERT INTO calendar_feeds(id, user_id, token_hash, view_id, label, include_links, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      this.userId,
      await sha256(token),
      viewId,
      (opts.label ?? view.name).slice(0, 80),
      opts.includeLinks ? 1 : 0,
      nowIso(),
    );
    return {
      feed: (await this.feeds()).find((f) => f.id === id)!,
      url: `${this.cfg.origin}/cal/${token}.ics`,
    };
  }

  async revokeFeed(id: string): Promise<void> {
    await this.db.run(
      'UPDATE calendar_feeds SET revoked_at = ? WHERE id = ? AND user_id = ?',
      nowIso(),
      id,
      this.userId,
    );
  }

  private async loadView(viewId: string) {
    const f = (await this.notes.listViewFiles()).find((v) => v.id === viewId);
    if (!f) throw new CalendarError('ビューが見つかりません');
    return parseView(f.id, f.text);
  }

  /** Render the .ics body for a feed token, or null if the token is unknown/revoked. */
  async renderFeed(token: string): Promise<string | null> {
    const row = await this.db.first<FeedRow>(
      'SELECT * FROM calendar_feeds WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL',
      await sha256(token),
      this.userId,
    );
    if (!row) return null;
    await this.db.run(
      'UPDATE calendar_feeds SET last_fetched_at = ? WHERE id = ?',
      nowIso(),
      row.id,
    );
    let view;
    try {
      view = await this.loadView(row.view_id);
    } catch {
      return generateIcal(row.label, []);
    }
    const policy = await this.notes.loadPolicy();
    const events = await this.noteEvents(view, policy, {
      includeLinks: !!row.include_links,
      onlyExternal: true,
    });
    return generateIcal(row.label || view.name, events);
  }

  /** Notes of a calendar view as feed events. */
  async noteEvents(
    view: ReturnType<typeof parseView>,
    policy: WorkspacePolicy,
    opts: { includeLinks: boolean; onlyExternal: boolean },
  ): Promise<FeedEvent[]> {
    const prop = view.dateProperty ?? 'date';
    const out: FeedEvent[] = [];
    for (const n of applyView(view, await this.indexer.viewNotes())) {
      if (opts.onlyExternal && effectiveAccess(policy, n.path, n.properties) !== 'external')
        continue;
      const start = parseNoteDate(getProperty(n, prop), this.timeZone);
      if (!start) continue;
      const endRaw = view.endDateProperty
        ? parseNoteDate(getProperty(n, view.endDateProperty), this.timeZone)
        : null;
      const title = this.safeTitle(n.title, policy);
      const uid = `${(await sha256(`${this.userId}|${view.id}|${n.path}`)).slice(0, 32)}@gmemo`;
      const url = opts.includeLinks
        ? `${this.cfg.origin}/n/${n.path.split('/').map(encodeURIComponent).join('/')}`
        : undefined;
      if (start.allDay) {
        // An all-day end date in frontmatter is inclusive; iCal ends are exclusive.
        const end =
          endRaw?.allDay && endRaw.date >= start.date
            ? addDaysKey(endRaw.date, 1)
            : addDaysKey(start.date, 1);
        out.push({ uid, title, start: start.date, end, ...(url ? { url } : {}) });
      } else {
        const end =
          endRaw && !endRaw.allDay && endRaw.ms > start.ms ? endRaw.ms : start.ms + 3600_000;
        out.push({ uid, title, start: start.ms, end, ...(url ? { url } : {}) });
      }
    }
    return out;
  }

  /** Titles leave the machine: anything the sensitive scan flags is hidden. */
  private safeTitle(title: string, policy: WorkspacePolicy): string {
    const findings = scanText(title, {
      dictionary: policy.sensitive.dictionary,
      allow: policy.sensitive.allow,
      disabledRules: policy.sensitive.disabledRules,
    });
    return findings.length ? '予定' : title;
  }

  // ---- subscriptions (import) -----------------------------------------------

  async subscriptions(): Promise<CalendarSubscription[]> {
    return (
      await this.db.all<SubRow>(
        'SELECT * FROM calendar_subscriptions WHERE user_id = ? ORDER BY created_at',
        this.userId,
      )
    ).map((r) => this.toSub(r));
  }

  private toSub(r: SubRow): CalendarSubscription {
    let eventCount: number | null = null;
    if (r.body) {
      try {
        eventCount = parseIcal(r.body).events.length;
      } catch {
        eventCount = null;
      }
    }
    return {
      id: r.id,
      name: r.name,
      urlPreview: maskUrl(r.url),
      color: r.color,
      enabled: !!r.enabled,
      createdAt: r.created_at,
      fetchedAt: r.fetched_at,
      lastError: r.last_error,
      eventCount,
    };
  }

  /** Check a URL the server will fetch (also every redirect target). */
  private async checkFetchable(raw: string): Promise<string> {
    const url = this.validateUrl(raw);
    if (!this.cfg.insecureDev && this.resolveHost) {
      const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
      const addrs = await this.resolveHost(host).catch(() => {
        throw new CalendarError('URLのホスト名を解決できません');
      });
      if (addrs.length === 0 || addrs.some(isPrivateHost))
        throw new CalendarError('このURLは使えません');
    }
    return url;
  }

  private validateUrl(raw: string): string {
    const url = raw.trim().replace(/^webcal:\/\//i, 'https://');
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new CalendarError('URLの形式が正しくありません');
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (local || this.cfg.insecureDev))) {
      throw new CalendarError('https:// のURLを指定してください');
    }
    // The server fetches this URL: keep it away from internal addresses.
    if (!this.cfg.insecureDev && (local || isPrivateHost(u.hostname))) {
      throw new CalendarError('このURLは使えません');
    }
    return u.toString();
  }

  async addSubscription(input: {
    name: string;
    url: string;
    color?: string;
  }): Promise<CalendarSubscription> {
    const url = this.validateUrl(input.url);
    const id = randomId('cs_');
    const color = input.color && COLOR_RE.test(input.color) ? input.color : '#4f7cff';
    const count = (
      await this.db.first<{ n: number }>(
        'SELECT COUNT(*) AS n FROM calendar_subscriptions WHERE user_id = ?',
        this.userId,
      )
    )?.n;
    if ((count ?? 0) >= 20) throw new CalendarError('登録できるカレンダーは20個までです');
    await this.db.run(
      'INSERT INTO calendar_subscriptions(id, user_id, name, url, color, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      this.userId,
      (input.name.trim() || 'カレンダー').slice(0, 60),
      url,
      color,
      nowIso(),
    );
    await this.refresh(id);
    return this.toSub((await this.subRow(id))!);
  }

  async updateSubscription(
    id: string,
    patch: { name?: string; color?: string; enabled?: boolean; url?: string },
  ): Promise<CalendarSubscription> {
    const cur = await this.subRow(id);
    if (!cur) throw new CalendarError('カレンダーが見つかりません');
    const url = patch.url ? this.validateUrl(patch.url) : cur.url;
    await this.db.run(
      'UPDATE calendar_subscriptions SET name = ?, color = ?, enabled = ?, url = ?, etag = CASE WHEN ? THEN NULL ELSE etag END, body = CASE WHEN ? THEN NULL ELSE body END WHERE id = ? AND user_id = ?',
      patch.name?.trim() ? patch.name.trim().slice(0, 60) : cur.name,
      patch.color && COLOR_RE.test(patch.color) ? patch.color : cur.color,
      patch.enabled === undefined ? cur.enabled : patch.enabled ? 1 : 0,
      url,
      url !== cur.url ? 1 : 0,
      url !== cur.url ? 1 : 0,
      id,
      this.userId,
    );
    return this.toSub((await this.subRow(id))!);
  }

  async deleteSubscription(id: string): Promise<void> {
    await this.db.run(
      'DELETE FROM calendar_subscriptions WHERE id = ? AND user_id = ?',
      id,
      this.userId,
    );
  }

  private async subRow(id: string): Promise<SubRow | null> {
    return this.db.first<SubRow>(
      'SELECT * FROM calendar_subscriptions WHERE id = ? AND user_id = ?',
      id,
      this.userId,
    );
  }

  /** Fetch one subscription (deduplicated while in flight). Errors are recorded, not thrown. */
  refresh(id: string): Promise<void> {
    const existing = this.inflight.get(id);
    if (existing) return existing;
    const p = this.doRefresh(id).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async doRefresh(id: string): Promise<void> {
    const row = await this.subRow(id);
    if (!row) return;
    try {
      // Follow redirects by hand so every hop is checked like the original URL.
      let url = await this.checkFetchable(row.url);
      let res: Response;
      for (let hop = 0; ; hop++) {
        res = await fetch(url, {
          headers: {
            accept: 'text/calendar, */*;q=0.5',
            ...(row.etag && row.body ? { 'if-none-match': row.etag } : {}),
          },
          signal: AbortSignal.timeout(20_000),
          redirect: 'manual',
        });
        const location = res.status >= 300 && res.status < 400 && res.headers.get('location');
        if (!location) break;
        await res.body?.cancel();
        if (hop >= 4) throw new Error('リダイレクトが多すぎます');
        url = await this.checkFetchable(new URL(location, url).toString());
      }
      if (res.status === 304) {
        await this.db.run(
          'UPDATE calendar_subscriptions SET fetched_at = ?, last_error = NULL WHERE id = ?',
          nowIso(),
          id,
        );
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > MAX_FEED_BYTES) throw new Error('カレンダーが大きすぎます(2MBまで)');
      const body = await readCapped(res, MAX_FEED_BYTES);
      if (!body.includes('BEGIN:VCALENDAR'))
        throw new Error('iCal 形式ではありません(「iCal形式の非公開URL」を指定してください)');
      const cal = parseIcal(body);
      const name = row.name === 'カレンダー' && cal.name ? cal.name.slice(0, 60) : row.name;
      await this.db.run(
        'UPDATE calendar_subscriptions SET body = ?, etag = ?, fetched_at = ?, last_error = NULL, name = ? WHERE id = ?',
        body,
        res.headers.get('etag'),
        nowIso(),
        name,
        id,
      );
    } catch (e) {
      const msg =
        (e as Error).name === 'TimeoutError' ? 'タイムアウトしました' : (e as Error).message;
      await this.db.run(
        'UPDATE calendar_subscriptions SET last_error = ?, fetched_at = ? WHERE id = ?',
        msg.slice(0, 200),
        nowIso(),
        id,
      );
    }
  }

  /** Refresh every enabled subscription older than the refresh interval. */
  async refreshStale(force = false): Promise<void> {
    const rows = await this.db.all<Pick<SubRow, 'id' | 'fetched_at'>>(
      'SELECT id, fetched_at FROM calendar_subscriptions WHERE user_id = ? AND enabled = 1',
      this.userId,
    );
    const cutoff = Date.now() - REFRESH_MS;
    await Promise.all(
      rows
        .filter((r) => force || !r.fetched_at || Date.parse(r.fetched_at) < cutoff)
        .map((r) => this.refresh(r.id)),
    );
  }

  /** Occurrences of all enabled subscriptions between two dates ('YYYY-MM-DD', end exclusive). */
  async events(
    from: string,
    to: string,
    defer: (p: Promise<unknown>) => void = (p) => void p,
  ): Promise<ExternalEvent[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
      throw new CalendarError('from/to は YYYY-MM-DD で指定してください');
    const fromMs = parseNoteDate(`${from} 00:00`, this.timeZone);
    const toMs = parseNoteDate(`${to} 00:00`, this.timeZone);
    if (!fromMs || fromMs.allDay || !toMs || toMs.allDay || toMs.ms <= fromMs.ms)
      throw new CalendarError('期間が正しくありません');
    if (toMs.ms - fromMs.ms > 400 * 86400_000) throw new CalendarError('期間が長すぎます');
    // Serve cached data right away; stale calendars refresh in the background.
    defer(this.refreshStale());
    const out: ExternalEvent[] = [];
    for (const r of await this.db.all<SubRow>(
      'SELECT * FROM calendar_subscriptions WHERE user_id = ? AND enabled = 1 AND body IS NOT NULL',
      this.userId,
    )) {
      try {
        for (const o of expandEvents(parseIcal(r.body!).events, {
          from: fromMs.ms,
          to: toMs.ms,
          timeZone: this.timeZone,
        })) {
          out.push({ ...o, subscriptionId: r.id, calendar: r.name, color: r.color });
        }
      } catch {
        // A broken feed should not hide the others.
      }
    }
    return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  }
}
