import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDb } from '../src/db/sqlite.js';
import { MemoryFileStore } from '../src/files/file-store.js';
import { createHttpApp } from '../src/http-app.js';
import { Platform } from '../src/platform.js';
import { HashingEmbedder } from '../src/search/embedder.js';
import { testConfig } from './helpers.js';

const ORIGIN = 'http://localhost:8787';

describe('uploaded files', () => {
  let db: SqliteDb;
  let files: MemoryFileStore | null;
  let platform: Platform;
  let app: ReturnType<typeof createHttpApp>;

  async function make(withFiles: boolean) {
    db = new SqliteDb(':memory:');
    files = withFiles ? new MemoryFileStore() : null;
    platform = await Platform.create(testConfig({}), db, {
      auditConsole: () => undefined,
      embedder: new HashingEmbedder(),
      ...(files ? { files } : {}),
    });
    app = createHttpApp(platform);
  }

  async function signIn(username: string): Promise<string> {
    await db.run(
      'INSERT INTO users(id, username, is_admin, created_at) VALUES (?, ?, ?, ?)',
      `u_${username}`,
      username,
      0,
      new Date().toISOString(),
    );
    return `gm_session=${await platform.auth.createSession(`u_${username}`, 'passkey')}`;
  }

  async function upload(cookie: string, name: string, data: Uint8Array | string, type = '') {
    const body = new FormData();
    body.append('file', new File([data], name, { type }));
    const res = await app.request(`${ORIGIN}/api/attachments`, {
      method: 'POST',
      headers: { cookie },
      body,
    });
    return { status: res.status, json: (await res.json()) as { path: string; markdown: string } };
  }

  const fetchFile = (cookie: string, path: string) =>
    app.request(`${ORIGIN}/api/file?path=${encodeURIComponent(path)}`, { headers: { cookie } });

  beforeEach(() => make(true));
  afterEach(() => db.close());

  it('keeps an upload in object storage, not in the note history', async () => {
    const me = await signIn('me');
    const bytes = new Uint8Array(3_000_000).fill(7);
    const up = await upload(me, 'report 2026.xlsx', bytes);
    expect(up.status).toBe(200);
    expect(up.json.path).toMatch(/^files\/\d{4}-\d\d-\d\d-\w+-report_2026\.xlsx$/);
    expect(up.json.markdown).toBe(`[[${up.json.path}]]`);
    expect([...files!.objects.keys()]).toEqual([`u_me/${up.json.path}`]);
    const inHistory = await db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM git_commits WHERE message LIKE 'Attach%'`,
    );
    expect(inHistory?.n).toBe(0);

    const res = await fetchFile(me, up.json.path);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it('embeds images and makes everything else a link with a short extension', async () => {
    const me = await signIn('me');
    const image = await upload(me, 'photo.PNG', 'x');
    expect(image.json.markdown).toBe(`![[${image.json.path}]]`);
    expect((await upload(me, 'archive.tar.numbers', 'x')).json.path).toMatch(/\.numbers\.bin$/);
    expect((await upload(me, 'notes.md', 'x')).json.path).toMatch(/notes\.md\.bin$/);
    expect((await upload(me, 'README', 'x')).json.path).toMatch(/README\.bin$/);
  });

  it('hands over anything a browser could run as a download', async () => {
    const me = await signIn('me');
    const html = await upload(me, 'page.html', '<script>alert(1)</script>', 'text/html');
    const res = await fetchFile(me, html.json.path);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename\*=UTF-8''/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");

    const pdf = await upload(me, 'doc.pdf', '%PDF-1.7', 'text/html');
    const shown = await fetchFile(me, pdf.json.path);
    expect(shown.headers.get('content-type')).toBe('application/pdf');
    expect(shown.headers.get('content-disposition')).toBeNull();
  });

  it('keeps each account to its own files and removes them with the account', async () => {
    const me = await signIn('me');
    const other = await signIn('other');
    const mine = await upload(me, 'secret.pdf', 'mine');
    await upload(other, 'theirs.pdf', 'theirs');
    expect((await fetchFile(other, mine.json.path)).status).toBe(404);
    expect((await fetchFile('', mine.json.path)).status).toBe(401);

    await platform.deleteUser('u_me');
    expect([...files!.objects.keys()].every((k) => k.startsWith('u_other/'))).toBe(true);
    expect(files!.objects.size).toBe(1);
  });

  it('refuses files over the limit', async () => {
    const me = await signIn('me');
    const res = await upload(me, 'huge.bin', new Uint8Array(50 * 1024 * 1024 + 1));
    expect(res.status).toBe(413);
    expect(files!.objects.size).toBe(0);
  });

  it('without object storage, files still go into the note store', async () => {
    db.close();
    await make(false);
    const me = await signIn('me');
    const up = await upload(me, 'photo.png', 'png-bytes');
    expect(up.json.path).toMatch(/^attachments\//);
    const res = await fetchFile(me, up.json.path);
    expect(await res.text()).toBe('png-bytes');
    expect((await upload(me, 'big.zip', new Uint8Array(2_000_000))).status).toBe(413);
  });
});
