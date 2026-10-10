import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIcal } from '@gmemo/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AppContext, createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createHttpApp } from '../src/server.js';

const ORIGIN = 'http://localhost:8787';
let dir: string;
let ctx: AppContext;
let app: ReturnType<typeof createHttpApp>;
let cookie: string;
let icsServer: Server;
let icsBody = '';
let icsHits = 0;

async function req(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  if (cookie) headers.set('cookie', cookie);
  return app.request(`${ORIGIN}${path}`, {
    ...init,
    headers,
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gmemo-cal-'));
  ctx = await createApp(
    loadConfig({
      dataDir: dir,
      notesDir: join(dir, 'notes'),
      appDbFile: join(dir, 'app.db'),
      indexDbFile: join(dir, 'index.db'),
      origin: ORIGIN,
      rpId: 'localhost',
      pluginsDir: join(dir, 'p'),
      webDir: join(dir, 'w'),
      timeZone: 'Asia/Tokyo',
    }),
    { loadPlugins: false },
  );
  app = createHttpApp(ctx);
  ctx.appDb.prepare(`INSERT INTO users(id, username, created_at) VALUES ('u1', 'me', 'now')`).run();
  cookie = `gm_session=${ctx.auth.createSession('u1', 'passkey')}`;
  icsHits = 0;
  icsServer = createServer((_req, res) => {
    icsHits++;
    res.writeHead(200, { 'content-type': 'text/calendar', etag: '"v1"' });
    res.end(icsBody);
  });
  await new Promise<void>((r) => icsServer.listen(0, '127.0.0.1', r));
});

afterEach(async () => {
  icsServer.close();
  ctx.close();
  await rm(dir, { recursive: true, force: true });
});

describe('calendar', () => {
  it('publishes a calendar view as an .ics feed, respecting the AI policy', async () => {
    await req('/api/admin/policy', {
      method: 'PUT',
      json: { ai: { default: 'external', folders: { 'private/': 'local' } } },
    });
    await req('/api/note', {
      method: 'PUT',
      json: { path: 'ev/Launch.md', content: '---\ndate: 2026-10-12 10:00\n---\n# リリース\n' },
    });
    await req('/api/note', {
      method: 'PUT',
      json: {
        path: 'ev/Trip.md',
        content: '---\ndate: 2026-10-15\nend: 2026-10-16\n---\n# 出張\n',
      },
    });
    await req('/api/note', {
      method: 'PUT',
      json: {
        path: 'ev/Key.md',
        content: '---\ndate: 2026-10-20\n---\n# key AKIAIOSFODNN7EXAMPLE\n',
      },
    });
    await req('/api/note', {
      method: 'PUT',
      json: { path: 'private/Doctor.md', content: '---\ndate: 2026-10-13\n---\n# 通院\n' },
    });
    await req('/api/note', {
      method: 'PUT',
      json: {
        path: 'ev/Secret.md',
        content: '---\ndate: 2026-10-14\nsensitivity: secret\n---\n# 秘密\n',
      },
    });
    await req('/api/views/cal', {
      method: 'PUT',
      json: { source: 'name: 予定\ntype: calendar\ndateProperty: date\nendDateProperty: end\n' },
    });
    await req('/api/views/tbl', { method: 'PUT', json: { source: 'name: 表\ntype: table\n' } });

    expect(
      (await req('/api/admin/calendar/feeds', { method: 'POST', json: { viewId: 'tbl' } })).status,
    ).toBe(400);
    const created = (await (
      await req('/api/admin/calendar/feeds', {
        method: 'POST',
        json: { viewId: 'cal', includeLinks: true },
      })
    ).json()) as { url: string; feed: { id: string } };
    expect(created.url).toMatch(/^http:\/\/localhost:8787\/cal\/[\w-]+\.ics$/);

    const saved = cookie;
    cookie = ''; // Google fetches the feed without a session.
    const res = await req(new URL(created.url).pathname);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    const text = await res.text();
    const events = parseIcal(text).events;
    expect(events.map((e) => e.summary).sort()).toEqual(['予定', '出張', 'リリース'].sort());
    expect(text).not.toContain('通院');
    expect(text).not.toContain('秘密');
    expect(text).not.toContain('AKIA');
    const trip = events.find((e) => e.summary === '出張')!;
    expect([trip.start.wall.d, trip.end!.wall.d]).toEqual([15, 17]); // inclusive end → exclusive
    expect(text).toContain('URL:http://localhost:8787/n/ev/Launch.md');
    expect((await req('/cal/doesnotexist0000000.ics')).status).toBe(404);

    cookie = saved;
    await req(`/api/admin/calendar/feeds/${created.feed.id}`, { method: 'DELETE' });
    cookie = '';
    expect((await req(new URL(created.url).pathname)).status).toBe(404);
    cookie = saved;
  });

  it('imports a subscribed iCal URL and expands events', async () => {
    icsBody = [
      'BEGIN:VCALENDAR',
      'X-WR-CALNAME:Google',
      'BEGIN:VEVENT',
      'UID:g1',
      'DTSTART;TZID=Asia/Tokyo:20261012T090000',
      'DTEND;TZID=Asia/Tokyo:20261012T100000',
      'RRULE:FREQ=DAILY;COUNT=3',
      'SUMMARY:朝会',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const port = (icsServer.address() as AddressInfo).port;
    expect(
      (
        await req('/api/admin/calendar/subscriptions', {
          method: 'POST',
          json: { url: 'http://example.com/x.ics' },
        })
      ).status,
    ).toBe(400);
    const sub = (await (
      await req('/api/admin/calendar/subscriptions', {
        method: 'POST',
        json: { url: `http://127.0.0.1:${port}/basic.ics`, color: '#ff0000' },
      })
    ).json()) as {
      id: string;
      name: string;
      eventCount: number;
      lastError: string | null;
      urlPreview: string;
    };
    expect(sub).toMatchObject({ name: 'Google', eventCount: 1, lastError: null });
    expect(sub.urlPreview).not.toContain('basic.ics');

    const r = (await (await req('/api/calendar/events?from=2026-10-01&to=2026-11-01')).json()) as {
      events: { title: string; start: string; color: string }[];
    };
    expect(r.events.map((e) => e.start)).toEqual([
      '2026-10-12T00:00:00.000Z',
      '2026-10-13T00:00:00.000Z',
      '2026-10-14T00:00:00.000Z',
    ]);
    expect(r.events[0]).toMatchObject({ title: '朝会', color: '#ff0000' });

    icsBody = 'not a calendar';
    const refreshed = (await (
      await req(`/api/admin/calendar/subscriptions/${sub.id}/refresh`, { method: 'POST', json: {} })
    ).json()) as { lastError: string | null; eventCount: number };
    expect(refreshed.lastError).toContain('iCal');
    expect(refreshed.eventCount).toBe(1); // last good copy is kept
    expect(icsHits).toBe(2);

    await req(`/api/admin/calendar/subscriptions/${sub.id}`, {
      method: 'PATCH',
      json: { enabled: false },
    });
    const off = (await (
      await req('/api/calendar/events?from=2026-10-01&to=2026-11-01')
    ).json()) as { events: unknown[] };
    expect(off.events).toEqual([]);
    expect((await req('/api/calendar/events?from=bad&to=2026-11-01')).status).toBe(400);
  });
});
