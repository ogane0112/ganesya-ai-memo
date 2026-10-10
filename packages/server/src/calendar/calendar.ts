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
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return (
    h.includes(':') &&
    (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80'))
  );
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
      const res = await fetch(row.url, {
        headers: {
          accept: 'text/calendar, */*;q=0.5',
          ...(row.etag && row.body ? { 'if-none-match': row.etag } : {}),
        },
        signal: AbortSignal.timeout(20_000),
        redirect: 'follow',
      });
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
      const body = await res.text();
      if (new TextEncoder().encode(body).length > MAX_FEED_BYTES)
        throw new Error('カレンダーが大きすぎます(2MBまで)');
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
