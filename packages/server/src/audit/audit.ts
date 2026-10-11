import type { Config } from '../config.js';
import { type Db, nowIso } from '../db/db.js';
import { sha256 } from '../util/crypto.js';

/**
 * Security audit log: who did what, when, from where, and whether it worked.
 *
 * - Append-only table `security_events`; nothing in the app updates or deletes
 *   rows except the retention purge of the oldest ones.
 * - Each row carries an HMAC (key derived from GMEMO_SECRET_KEY) over its
 *   content, and ids only grow, so `verify()` finds edited rows and rows
 *   deleted from the middle.
 * - Every event is also written to the console as one JSON line, which lands
 *   in Workers Logs / the server's log collector: a copy outside the database.
 * - Never put note contents, tokens or secrets in `detail`.
 */
export type Outcome = 'success' | 'failure' | 'denied';

export interface AuditEvent {
  action: string;
  outcome?: Outcome;
  /** The account the event is about (null when unknown, e.g. a failed login). */
  userId?: string | null;
  /** Who acted: `user:<id>`, `agent:<id>`, `anonymous`, `system`. */
  actor: string;
  target?: string | null;
  detail?: Record<string, unknown>;
}

export interface RequestMeta {
  ip: string | null;
  ua: string | null;
}

export interface SecurityEvent {
  id: number;
  at: string;
  userId: string | null;
  actor: string;
  action: string;
  outcome: Outcome;
  target: string | null;
  ip: string | null;
  ua: string | null;
  detail: Record<string, unknown>;
}

interface Row {
  id: number;
  at: string;
  user_id: string | null;
  actor: string;
  action: string;
  outcome: Outcome;
  target: string | null;
  ip: string | null;
  ua: string | null;
  detail: string;
  mac: string;
}

export type IpMode = 'off' | 'hash' | 'full';

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Coarse browser / OS label, enough to recognise "that is not my device". */
export function summarizeUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : /claude|anthropic/i.test(ua)
            ? 'Claude'
            : /curl|python|node|undici|okhttp|go-http/i.test(ua)
              ? 'プログラム'
              : 'その他';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} / ${os}` : browser;
}

/** Client address and device from a request (Cloudflare first, then a proxy header). */
export function requestMeta(headers: Headers): RequestMeta {
  const ip =
    headers.get('cf-connecting-ip') ??
    headers.get('x-real-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    null;
  return { ip: ip || null, ua: summarizeUserAgent(headers.get('user-agent')) };
}

export class AuditLog {
  private keys: Promise<Awaited<ReturnType<typeof crypto.subtle.importKey>>[]> | null = null;

  constructor(
    private readonly db: Db,
    private readonly cfg: Pick<Config, 'secretKey' | 'previousSecretKey'> & {
      auditIp: IpMode;
      env: string;
    },
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {}

  /** Current key first; the pre-rotation key is only used to verify older rows. */
  private hmacKeys() {
    this.keys ??= Promise.all(
      [this.cfg.secretKey, this.cfg.previousSecretKey]
        .filter((k): k is string => !!k)
        .map((k) =>
          crypto.subtle.importKey(
            'raw',
            enc.encode(`gmemo-audit:${k}`),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign', 'verify'],
          ),
        ),
    );
    return this.keys;
  }

  private static macText(r: Omit<Row, 'id' | 'mac'>): string {
    return JSON.stringify([
      r.at,
      r.user_id,
      r.actor,
      r.action,
      r.outcome,
      r.target,
      r.ip,
      r.ua,
      r.detail,
    ]);
  }

  private async mac(r: Omit<Row, 'id' | 'mac'>): Promise<string> {
    const text = AuditLog.macText(r);
    const [key] = await this.hmacKeys();
    if (!key) return `nokey:${await sha256(text)}`;
    return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
  }

  private async macMatches(r: Omit<Row, 'id' | 'mac'>, mac: string): Promise<boolean> {
    const text = AuditLog.macText(r);
    if (mac.startsWith('nokey:')) return mac === `nokey:${await sha256(text)}`;
    for (const key of await this.hmacKeys())
      if (hex(await crypto.subtle.sign('HMAC', key, enc.encode(text))) === mac) return true;
    return false;
  }

  private async ip(raw: string | null): Promise<string | null> {
    if (!raw || this.cfg.auditIp === 'off') return null;
    if (this.cfg.auditIp === 'full') return raw;
    // Same address → same value, without storing the address itself.
    return `h:${(await sha256(`gmemo-ip:${this.cfg.secretKey ?? ''}:${raw}`)).slice(0, 16)}`;
  }

  /** Log-only event (not stored), for high-volume denials such as requests without Access. */
  note(fields: Record<string, unknown>): void {
    this.log(JSON.stringify({ type: 'audit', env: this.cfg.env, at: nowIso(), ...fields }));
  }

  /** Record an event. Never throws: an audit failure must not break the request. */
  async record(ev: AuditEvent, meta?: RequestMeta): Promise<void> {
    try {
      const row: Omit<Row, 'id' | 'mac'> = {
        at: nowIso(),
        user_id: ev.userId ?? null,
        actor: ev.actor,
        action: ev.action,
        outcome: ev.outcome ?? 'success',
        target: ev.target ? String(ev.target).slice(0, 300) : null,
        ip: await this.ip(meta?.ip ?? null),
        ua: meta?.ua ?? null,
        detail: JSON.stringify(ev.detail ?? {}).slice(0, 4000),
      };
      const mac = await this.mac(row);
      this.log(
        JSON.stringify({
          type: 'audit',
          env: this.cfg.env,
          ...row,
          detail: ev.detail ?? {},
        }),
      );
      await this.db.run(
        `INSERT INTO security_events(at, user_id, actor, action, outcome, target, ip, ua, detail, mac)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.at,
        row.user_id,
        row.actor,
        row.action,
        row.outcome,
        row.target,
        row.ip,
        row.ua,
        row.detail,
        mac,
      );
    } catch (e) {
      console.error('[audit] could not record event', ev.action, (e as Error).message);
    }
  }

  async list(
    opts: {
      userId?: string;
      action?: string;
      outcome?: Outcome;
      before?: number;
      limit?: number;
    } = {},
  ): Promise<SecurityEvent[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.userId) {
      where.push('user_id = ?');
      params.push(opts.userId);
    }
    if (opts.action) {
      where.push(`action LIKE ? ESCAPE '\\'`);
      params.push(`${opts.action.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    }
    if (opts.outcome) {
      where.push('outcome = ?');
      params.push(opts.outcome);
    }
    if (opts.before) {
      where.push('id < ?');
      params.push(opts.before);
    }
    // Conditions above are fixed text; their values are in params.
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = await this.db.all<Row>(
      `SELECT * FROM security_events ${whereSql}
       ORDER BY id DESC LIMIT ?`,
      ...params,
      Math.min(Math.max(opts.limit ?? 100, 1), 500),
    );
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      userId: r.user_id,
      actor: r.actor,
      action: r.action,
      outcome: r.outcome,
      target: r.target,
      ip: r.ip,
      ua: r.ua,
      detail: JSON.parse(r.detail) as Record<string, unknown>,
    }));
  }

  /**
   * Check every stored row: HMAC matches its content, and no ids are missing
   * between the oldest and newest row (the retention purge only removes the oldest).
   */
  async verify(): Promise<{
    checked: number;
    firstId: number | null;
    lastId: number | null;
    tampered: number[];
    missing: { from: number; to: number }[];
    unsigned: number;
  }> {
    const tampered: number[] = [];
    const missing: { from: number; to: number }[] = [];
    let checked = 0;
    let unsigned = 0;
    let prev: number | null = null;
    let first: number | null = null;
    let after = 0;
    for (;;) {
      const rows = await this.db.all<Row>(
        'SELECT * FROM security_events WHERE id > ? ORDER BY id LIMIT 500',
        after,
      );
      if (rows.length === 0) break;
      for (const r of rows) {
        first ??= r.id;
        if (prev !== null && r.id !== prev + 1) missing.push({ from: prev + 1, to: r.id - 1 });
        prev = r.id;
        checked++;
        if (r.mac.startsWith('nokey:')) unsigned++;
        const { id: _id, mac, ...rest } = r;
        if (!(await this.macMatches(rest, mac))) tampered.push(r.id);
      }
      after = rows[rows.length - 1]!.id;
    }
    return { checked, firstId: first, lastId: prev, tampered, missing, unsigned };
  }

  /** Delete events older than `days` (retention). Returns how many were removed. */
  async purge(days: number): Promise<number> {
    if (!(days > 0)) return 0;
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    return (await this.db.run('DELETE FROM security_events WHERE at < ?', cutoff)).changes;
  }
}
