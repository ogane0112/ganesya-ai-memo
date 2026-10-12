import {
  applyView,
  effectiveAccess,
  groupRows,
  inFolders,
  normalizeNotePath,
  parseNoteLenient,
  parseView,
  scanText,
} from '@gmemo/core';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { stringify as stringifyYaml } from 'yaml';
import { ASK_SYSTEM_PROMPT, publicFinding } from '../ai/gateway.js';
import type { Principal } from '../auth/tokens.js';
import { nowIso } from '../db/db.js';
import { fileKey } from '../files/file-store.js';
import type { FileResolution } from '../notes/service.js';
import type { Platform } from '../platform.js';
import type { Workspace } from '../workspace.js';
import { AgentOps } from './agent-ops.js';
import {
  audit,
  deferTo,
  type Env,
  jsonBody,
  requireHuman,
  requireReader,
  str,
  workspaceOf,
} from './http.js';

/** The built-in store keeps each file in one database value (D1: 2 MB at most). */
const MAX_BUILTIN_BYTES = 1_900_000;
const MAX_NOTE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Object storage: the form upload is held in memory once; from there it is streamed. */
const MAX_STORED_FILE_BYTES = 50 * 1024 * 1024;
/** Files in object storage are linked from notes under this folder. */
const STORED_PREFIX = 'files/';

function sizeLimit(w: Workspace, max: number): number {
  return w.store.kind === 'builtin' ? Math.min(max, MAX_BUILTIN_BYTES) : max;
}

export function notesRoutes(platform: Platform) {
  const app = new Hono<Env>();

  /** The caller's workspace plus agent-scoped helpers. */
  const open = async (c: Parameters<typeof workspaceOf>[1]) => {
    const w: Workspace = await workspaceOf(platform, c);
    const ops = new AgentOps(w, (ev) => audit(platform, c, ev));
    /** Keep only items the agent may see (folder limits + AI policy). Humans see everything. */
    const visibleTo = async <T>(
      p: Principal | null,
      items: T[],
      pathOf: (t: T) => string,
    ): Promise<T[]> => (p ? ops.filter(p.agent, items, pathOf) : items);
    /**
     * Normalize the path, then check it is visible to the agent (humans see everything).
     * Always use the returned path: checking one spelling and reading another
     * (`/Private/a.md`, `Pub//a.md`) would bypass folder and policy checks.
     */
    const assertVisible = async (
      p: Principal | null,
      rawPath: string,
      opts: { requireMarkdown?: boolean } = {},
    ): Promise<string> => {
      const path = normalizeNotePath(rawPath, opts);
      if (p && (await ops.filter(p.agent, [path], (x) => x)).length === 0)
        throw new HTTPException(403, { message: `no access to ${path}` });
      return path;
    };
    // Brings the index up to date (GitHub repositories are re-checked at most every few seconds).
    await w.notes.currentHead();
    return { w, notes: w.notes, indexer: w.indexer, ops, visibleTo, assertVisible };
  };

  // ---- reading -------------------------------------------------------------

  app.get('/notes', async (c) => {
    const $ = await open(c);
    const { principal } = requireReader(c);
    const folder = c.req.query('folder');
    return c.json(
      await $.visibleTo(principal, await $.indexer.listNotes(folder || undefined), (n) => n.path),
    );
  });

  // ---- folders -------------------------------------------------------------
  // A folder with notes in it exists by itself. These rows keep the folders a
  // person created on their own, so an empty one stays in the tree.

  const folderPath = (raw: unknown): string => {
    const path = normalizeNotePath(str(raw, 'path'), { requireMarkdown: false })
      .split('/')
      .map((s) => s.trim())
      .join('/');
    // Dot folders hold the app's own files (.gmemo, .views).
    if (path.length > 200 || path.split('/').some((s) => !s || s.startsWith('.')))
      throw new HTTPException(400, { message: 'このフォルダー名は使えません' });
    return path;
  };

  app.get('/folders', async (c) => {
    const { userId } = requireHuman(c);
    const rows = await platform.db.all<{ path: string }>(
      'SELECT path FROM folders WHERE user_id = ? ORDER BY path',
      userId,
    );
    return c.json(rows.map((r) => r.path));
  });

  app.post('/folders', async (c) => {
    const { userId } = requireHuman(c);
    const path = folderPath((await jsonBody<{ path: string }>(c)).path);
    await platform.db.run(
      `INSERT INTO folders(user_id, path, created_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, path) DO NOTHING`,
      userId,
      path,
      nowIso(),
    );
    return c.json({ path });
  });

  app.delete('/folders', async (c) => {
    const { userId } = requireHuman(c);
    const path = folderPath(c.req.query('path'));
    // Folders below it go too: they would have no parent to show under.
    await platform.db.run(
      `DELETE FROM folders WHERE user_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')`,
      userId,
      path,
      `${path.replace(/[\\%_]/g, (ch) => `\\${ch}`)}/%`,
    );
    return c.json({ ok: true });
  });

  app.get('/note', async (c) => {
    const $ = await open(c);
    const { principal } = requireReader(c);
    const path = normalizeNotePath(str(c.req.query('path'), 'path'));
    if (principal) {
      const doc = await $.ops.read(principal.agent, path);
      return c.json({ ...doc, frontmatter: parseNoteLenient(doc.content).frontmatter });
    }
    const ref = c.req.query('commit') ?? 'main';
    const doc = await $.notes.read(path, ref);
    const parsed = parseNoteLenient(doc.content);
    const policy = await $.notes.loadPolicy();
    return c.json({
      ...doc,
      frontmatter: parsed.frontmatter,
      access: effectiveAccess(policy, path, parsed.frontmatter),
    });
  });

  app.get('/note/backlinks', async (c) => {
    const $ = await open(c);
    const { principal } = requireReader(c);
    const path = normalizeNotePath(str(c.req.query('path'), 'path'));
    await $.assertVisible(principal, path);
    return c.json({
      backlinks: principal
        ? await $.ops.backlinks(principal.agent, path)
        : await $.indexer.backlinks(path),
      outgoing: await $.visibleTo(
        principal,
        await $.indexer.outgoingLinks(path),
        (l) => l.path ?? '',
      ),
    });
  });

  app.get('/note/history', async (c) => {
    const $ = await open(c);
    const { principal } = requireReader(c);
    const path = await $.assertVisible(principal, str(c.req.query('path'), 'path'), {
      requireMarkdown: false,
    });
    return c.json(await $.notes.history({ path, limit: Number(c.req.query('limit') ?? 50) }));
  });

  app.get('/note/blame', async (c) => {
    const $ = await open(c);
    const { principal } = requireReader(c);
    // Blame returns the note's text block by block, without masking: people only.
    if (principal) throw new HTTPException(403, { message: 'blame is not available to agents' });
    const path = normalizeNotePath(str(c.req.query('path'), 'path'));
    return c.json(await $.notes.blame(path));
  });

  app.get('/file', async (c) => {
    const $ = await open(c);
    const { principal } = requireReader(c);
    const path = await $.assertVisible(principal, str(c.req.query('path'), 'path'), {
      requireMarkdown: false,
    });
    // Agents get images and PDFs only. Notes and other text go through /note, where
    // secrets are masked; raw text is for people.
    if (principal && !AGENT_RAW_TYPES.has(contentType(path)))
      throw new HTTPException(403, { message: 'use /api/note to read notes' });
    const stored =
      platform.files && path.startsWith(STORED_PREFIX)
        ? await platform.files.get(fileKey($.w.userId, path))
        : null;
    const data = stored ? null : await $.notes.readRaw(path);
    if (!stored && !data) throw new HTTPException(404, { message: 'file not found' });
    // The type comes from the name, never from what the uploader claimed, and
    // anything a browser could run is handed over as a download.
    const type = contentType(path);
    const fileName = encodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
    return new Response(stored ? stored.body : new Uint8Array(data!), {
      headers: {
        'content-type': type,
        ...(stored ? { 'content-length': String(stored.size) } : {}),
        ...(INLINE_TYPES.has(type)
          ? {}
          : { 'content-disposition': `attachment; filename*=UTF-8''${fileName}` }),
        'cache-control': 'private, max-age=60',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      },
    });
  });

  app.get('/search', async (c) => {
    const $ = await open(c);
    const { principal } = requireReader(c);
    const q = c.req.query('q') ?? '';
    const mode = c.req.query('mode') ?? 'hybrid';
    if (principal) return c.json(await $.ops.search(principal.agent, q, 30));
    const hits =
      mode === 'text'
        ? await $.indexer.textSearch(q, 30)
        : mode === 'vector'
          ? await $.indexer.vectorSearch(q, 30)
          : await $.indexer.search(q, 30);
    return c.json(hits);
  });

  app.get('/tags', async (c) => {
    const $ = await open(c);
    const { principal } = requireReader(c);
    if (!principal) return c.json(await $.indexer.tags());
    const counts = new Map<string, number>();
    for (const n of await $.ops.list(principal.agent))
      for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return c.json(
      [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count),
    );
  });

  app.get('/graph', async (c) => {
    const $ = await open(c);
    const { principal } = requireReader(c);
    const g = await $.indexer.graph();
    const nodes = await $.visibleTo(principal, g.nodes, (n) => n.id);
    const ids = new Set(nodes.map((n) => n.id));
    return c.json({ nodes, edges: g.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) });
  });

  app.get('/history', async (c) => {
    const $ = await open(c);
    requireHuman(c);
    const agentId = c.req.query('agentId');
    return c.json(
      await $.notes.history({
        limit: Number(c.req.query('limit') ?? 100),
        ...(agentId ? { agentId } : {}),
      }),
    );
  });

  // ---- writing -------------------------------------------------------------

  app.put('/note', async (c) => {
    const $ = await open(c);
    const b = await jsonBody<{
      path: string;
      content: string;
      baseSha?: string | null;
      baseCommit?: string;
      device?: string;
      message?: string;
      mode?: 'direct' | 'propose';
      title?: string;
    }>(c);
    const content = str(b.content, 'content');
    if (new TextEncoder().encode(content).length > sizeLimit($.w, MAX_NOTE_BYTES))
      throw new HTTPException(413, { message: 'ノートが大きすぎます' });
    const principal = c.get('principal');
    if (principal) {
      const path = normalizeNotePath(str(b.path, 'path'));
      return c.json(
        await $.ops.write(principal, [{ path, content }], {
          title: b.title ?? b.message ?? `Update ${path}`,
          ...(b.baseSha !== undefined ? { baseShas: { [path]: b.baseSha } } : {}),
          ...(b.baseCommit ? { baseCommit: b.baseCommit } : {}),
          ...(b.mode ? { mode: b.mode } : {}),
        }),
      );
    }
    requireHuman(c);
    return c.json(
      await $.notes.saveAsHuman(str(b.path, 'path'), content, {
        ...(b.baseSha !== undefined ? { baseSha: b.baseSha } : {}),
        ...(b.baseCommit ? { baseCommit: b.baseCommit } : {}),
        ...(b.device ? { device: b.device } : {}),
        ...(b.message ? { message: b.message } : {}),
      }),
    );
  });

  app.delete('/note', async (c) => {
    const $ = await open(c);
    const path = str(c.req.query('path'), 'path');
    const principal = c.get('principal');
    if (principal)
      return c.json(
        await $.ops.write(principal, [{ path, content: null }], {
          title: `Delete ${path}`,
          mode: 'propose',
        }),
      );
    requireHuman(c);
    return c.json({ commit: await $.notes.deleteAsHuman(path) });
  });

  app.post('/note/rename', async (c) => {
    const $ = await open(c);
    requireHuman(c);
    const b = await jsonBody<{ from: string; to: string }>(c);
    return c.json({
      commit: await $.notes.rename($.w.human(), str(b.from, 'from'), str(b.to, 'to')),
    });
  });

  app.post('/note/editing', async (c) => {
    const $ = await open(c);
    requireHuman(c);
    const b = await jsonBody<{ path: string; active: boolean }>(c);
    const path = normalizeNotePath(str(b.path, 'path'));
    if (b.active) await $.notes.markEditing(path);
    else await $.notes.stopEditing(path);
    return c.json({ ok: true });
  });

  /** Agents: submit several file changes as one proposal (or direct write when permitted). */
  app.post('/changes', async (c) => {
    const $ = await open(c);
    const principal = c.get('principal');
    if (!principal) throw new HTTPException(401, { message: 'agent token required' });
    const b = await jsonBody<{
      title: string;
      description?: string;
      changes: { path: string; content: string | null }[];
      baseShas?: Record<string, string | null>;
      baseCommit?: string;
      mode?: 'direct' | 'propose';
    }>(c);
    if (!Array.isArray(b.changes) || b.changes.length === 0)
      throw new HTTPException(400, { message: 'changes required' });
    return c.json(
      await $.ops.write(principal, b.changes, {
        title: str(b.title, 'title'),
        ...(b.description ? { description: b.description } : {}),
        ...(b.baseShas ? { baseShas: b.baseShas } : {}),
        ...(b.baseCommit ? { baseCommit: b.baseCommit } : {}),
        mode: b.mode === 'direct' ? 'direct' : 'propose',
      }),
    );
  });

  /** Quick capture (PWA, share target, iOS Shortcuts with a capture token). */
  app.post('/capture', async (c) => {
    const $ = await open(c);
    const b = await jsonBody<{ text: string; title?: string; folder?: string; url?: string }>(c);
    const principal = c.get('principal');
    let text = str(b.text ?? '', 'text');
    if (b.url) text = `${text}\n${b.url}`.trim();
    if (!text.trim()) throw new HTTPException(400, { message: 'text is empty' });
    if (principal) {
      // Capture tokens belong to the user's own devices (share sheet, Shortcuts), so the
      // note is recorded as written by the human. Agents use /api/changes instead.
      if (!principal.scope.has('notes:capture'))
        throw new HTTPException(403, { message: 'token lacks notes:capture' });
      // The token's agent still limits where notes go.
      const target = `${(b.folder ?? 'Inbox').replace(/^\/+|\/+$/g, '')}/x.md`;
      if (!inFolders(target, principal.agent.folders))
        throw new HTTPException(403, { message: 'this token cannot write to that folder' });
      return c.json(
        await $.notes.capture(text, {
          ...(b.title ? { title: b.title } : {}),
          ...(b.folder ? { folder: b.folder } : {}),
          actor: $.w.human(),
          timeZone: $.w.calendar.timeZone,
        }),
      );
    }
    requireHuman(c);
    return c.json(
      await $.notes.capture(text, {
        ...(b.title ? { title: b.title } : {}),
        ...(b.folder ? { folder: b.folder } : {}),
        timeZone: $.w.calendar.timeZone,
      }),
    );
  });

  app.post('/attachments', async (c) => {
    const $ = await open(c);
    requireHuman(c);
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new HTTPException(400, { message: 'file required' });
    // Notes kept in this service: files go to object storage when there is one.
    // A GitHub workspace keeps its files in the repository, next to the notes.
    const files = $.w.store.kind === 'builtin' ? platform.files : null;
    const limit = files ? MAX_STORED_FILE_BYTES : sizeLimit($.w, MAX_ATTACHMENT_BYTES);
    if (file.size > limit)
      throw new HTTPException(413, {
        message: `ファイルが大きすぎます(${Math.floor(limit / 1_000_000)}MBまで)`,
      });
    let safe = file.name.replace(/[^\w.\-\u3000-\u9fff]/g, '_').slice(-80) || 'file';
    // Notes tell files from other notes by a short extension.
    if (!/\.[a-z0-9]{1,5}$/i.test(safe) || /\.md$/i.test(safe)) safe += '.bin';
    const name = `${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}-${safe}`;
    const path = files ? `${STORED_PREFIX}${name}` : `attachments/${name}`;
    if (files) await files.put(fileKey($.w.userId, path), file.stream(), file.size);
    else
      await $.notes.commitAs(
        $.w.human(),
        [{ path, content: new Uint8Array(await file.arrayBuffer()) }],
        `Attach ${safe}`,
      );
    return c.json({
      path,
      markdown: /\.(png|jpe?g|gif|webp|svg)$/i.test(safe) ? `![[${path}]]` : `[[${path}]]`,
    });
  });

  /** Check the store for changes made elsewhere (GitHub) right now. */
  app.post('/sync', async (c) => {
    const $ = await open(c);
    requireHuman(c);
    return c.json({ changed: await $.indexer.sync() });
  });

  /**
   * Cheap change check for the web app (polled instead of server-sent events,
   * which do not fit serverless runtimes).
   */
  app.get('/poll', async (c) => {
    const $ = await open(c);
    requireHuman(c);
    const state = await $.indexer.state();
    const since = c.req.query('since');
    let paths: string[] | null = [];
    if (since && state.commit && since !== state.commit) {
      paths = await $.w.store
        .changedFiles(since, state.commit)
        .then((files) => (files.length > 200 ? null : files.map((f) => f.path)))
        .catch(() => null);
    }
    return c.json({
      head: state.commit,
      openProposals: await $.notes.openProposalCount(),
      paths,
    });
  });

  // ---- proposals -----------------------------------------------------------

  app.get('/proposals', async (c) => {
    const $ = await open(c);
    const { principal } = requireReader(c);
    const status = c.req.query('status') as 'open' | 'merged' | 'rejected' | undefined;
    return c.json(
      principal
        ? await $.ops.proposals(principal.agent, status)
        : await $.notes.listProposals(status),
    );
  });

  app.get('/proposals/:id', async (c) => {
    const $ = await open(c);
    const { principal } = requireReader(c);
    if (principal) return c.json(await $.ops.proposal(principal.agent, c.req.param('id')));
    const p = await $.notes.getProposal(c.req.param('id'));
    return c.json({ proposal: p, files: await $.notes.proposalFiles(p.id) });
  });

  app.post('/proposals/:id/merge', async (c) => {
    const $ = await open(c);
    requireHuman(c);
    const b = await jsonBody<{ resolutions?: Record<string, FileResolution> }>(c).catch(() => ({
      resolutions: {},
    }));
    const commit = await $.notes.mergeProposal(c.req.param('id'), b.resolutions ?? {});
    const p = await $.notes.getProposal(c.req.param('id'));
    await audit(platform, c, {
      action: 'proposal.merge',
      target: p.id,
      detail: { author: p.author_name, kind: p.author_kind, title: p.title.slice(0, 80) },
    });
    return c.json({ commit });
  });

  app.post('/proposals/:id/reject', async (c) => {
    const $ = await open(c);
    requireHuman(c);
    await $.notes.rejectProposal(c.req.param('id'));
    await audit(platform, c, { action: 'proposal.reject', target: c.req.param('id') });
    return c.json({ ok: true });
  });

  app.post('/revert', async (c) => {
    const $ = await open(c);
    requireHuman(c);
    const b = await jsonBody<{ commit: string }>(c);
    return c.json(await $.notes.revertCommit(str(b.commit, 'commit')));
  });

  app.post('/revert-agent', async (c) => {
    const $ = await open(c);
    requireHuman(c);
    const b = await jsonBody<{ agentId: string; since?: string }>(c);
    const res = await $.notes.revertAgent(str(b.agentId, 'agentId'), b.since);
    await audit(platform, c, {
      action: 'agent.revert_all',
      target: b.agentId,
      detail: { since: b.since ?? null, commits: res.length },
    });
    return c.json(res);
  });

  // ---- views ---------------------------------------------------------------

  app.get('/views', async (c) => {
    const $ = await open(c);
    requireReader(c);
    const files = await $.notes.listViewFiles();
    return c.json(
      files.map((f) => {
        try {
          return { id: f.id, view: parseView(f.id, f.text), source: f.text };
        } catch (e) {
          return { id: f.id, error: (e as Error).message, source: f.text };
        }
      }),
    );
  });

  /**
   * Rows for an inline view (a view placed inside a note). The settings travel
   * in the query string, so this stays a read: it is GET, cached by nobody
   * (account data), and not counted against the write limit.
   */
  app.get('/views/inline/rows', async (c) => {
    const $ = await open(c);
    const { principal } = requireReader(c);
    const source = str(c.req.query('source'), 'source');
    if (source.length > 4000) throw new HTTPException(400, { message: 'view settings too long' });
    const view = parseView('inline', source);
    const rows = await $.visibleTo(
      principal,
      applyView(view, await $.indexer.viewNotes()),
      (r) => r.path,
    );
    return c.json({
      view,
      rows,
      ...(view.type === 'kanban' ? { groups: groupRows(view, rows) } : {}),
    });
  });

  app.get('/views/:id/rows', async (c) => {
    const $ = await open(c);
    const { principal } = requireReader(c);
    const f = (await $.notes.listViewFiles()).find((v) => v.id === c.req.param('id'));
    if (!f) throw new HTTPException(404, { message: 'view not found' });
    const view = parseView(f.id, f.text);
    const rows = await $.visibleTo(
      principal,
      applyView(view, await $.indexer.viewNotes()),
      (r) => r.path,
    );
    return c.json({
      view,
      rows,
      ...(view.type === 'kanban' ? { groups: groupRows(view, rows) } : {}),
    });
  });

  app.put('/views/:id', async (c) => {
    const $ = await open(c);
    requireHuman(c);
    const b = await jsonBody<{ source?: string; view?: unknown }>(c);
    const id = c.req.param('id');
    const text = b.source ?? stringifyYaml(b.view ?? {});
    parseView(id, text); // validate
    await $.notes.saveViewFile(id, text);
    return c.json({ ok: true });
  });

  app.delete('/views/:id', async (c) => {
    const $ = await open(c);
    requireHuman(c);
    await $.notes.deleteViewFile(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ---- AI ------------------------------------------------------------------

  /** Events from subscribed external calendars (Google Calendar etc.), human only. */
  app.get('/calendar/events', async (c) => {
    const $ = await open(c);
    requireHuman(c);
    const from = str(c.req.query('from'), 'from');
    const to = str(c.req.query('to'), 'to');
    return c.json({
      timeZone: $.w.calendar.timeZone,
      events: await $.w.calendar.events(from, to, deferTo(c)),
    });
  });

  app.get('/ai/status', async (c) => {
    const $ = await open(c);
    requireHuman(c);
    const policy = await $.notes.loadPolicy();
    return c.json({ ...$.w.ai.status(), externalAcknowledged: policy.externalAcknowledged });
  });

  app.get('/ai/audit', async (c) => {
    const $ = await open(c);
    requireHuman(c);
    return c.json(await $.w.ai.auditLog(Number(c.req.query('limit') ?? 100)));
  });

  /** "Ask your notes": retrieval + LLM, through the egress gateway. */
  app.post('/ask', async (c) => {
    const $ = await open(c);
    requireHuman(c);
    const b = await jsonBody<{
      question: string;
      prefer?: 'local' | 'external' | 'auto';
      confirm?: boolean;
      paths?: string[];
    }>(c);
    const question = str(b.question, 'question').slice(0, 4000);
    const policy = await $.notes.loadPolicy();
    let contexts = await $.indexer.retrieve(question, 8);
    if (b.paths?.length) {
      const pinned: typeof contexts = [];
      for (const p of b.paths.slice(0, 5)) {
        const doc = await $.notes.read(p).catch(() => null);
        if (!doc) continue;
        const parsed = parseNoteLenient(doc.content);
        pinned.push({
          path: doc.path,
          title: (await $.indexer.getMeta(doc.path))?.title ?? doc.path,
          text: parsed.body.slice(0, 6000),
          access: effectiveAccess(policy, doc.path, parsed.frontmatter),
        });
      }
      contexts = [...pinned, ...contexts.filter((x) => !pinned.some((p) => p.path === x.path))];
    }
    const res = await $.w.ai.chat({
      policy,
      prefer: b.prefer ?? 'auto',
      system: ASK_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: question }],
      contexts,
      confirmSensitive: b.confirm === true,
      actor: $.w.human().name,
      purpose: 'ask',
    });
    const used = res.used.map((p, i) => ({
      n: i + 1,
      path: p,
      title: contexts.find((x) => x.path === p)?.title ?? p,
    }));
    return c.json({ ...res, findings: res.findings.map(publicFinding), sources: used });
  });

  /** Local-only scan. Used on save to suggest `sensitivity: secret`. */
  app.post('/sensitive/scan', async (c) => {
    const $ = await open(c);
    requireHuman(c);
    const b = await jsonBody<{ text: string; useModel?: boolean }>(c);
    const policy = await $.notes.loadPolicy();
    const text = str(b.text, 'text');
    const findings = b.useModel
      ? await $.w.ai.scan(text, policy)
      : scanText(text, {
          dictionary: policy.sensitive.dictionary,
          allow: policy.sensitive.allow,
          disabledRules: policy.sensitive.disabledRules,
        });
    const strong = findings.some(
      (f) =>
        f.category === 'secret' ||
        f.category === 'credential' ||
        f.category === 'financial' ||
        f.rule === 'my-number',
    );
    return c.json({ findings: findings.map(publicFinding), suggestSecret: strong });
  });

  return app;
}

/** File types agents may download as they are (no text to mask). */
const AGENT_RAW_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

/** Shown in the browser; every other type is downloaded. */
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'text/markdown; charset=utf-8',
  'text/plain; charset=utf-8',
  'audio/mpeg',
  'audio/mp4',
  'video/mp4',
  'video/webm',
]);

function contentType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const types: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    md: 'text/markdown; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    webm: 'video/webm',
  };
  return types[ext] ?? 'application/octet-stream';
}
