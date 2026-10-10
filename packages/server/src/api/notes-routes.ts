import { applyView, effectiveAccess, groupRows, inFolders, normalizeNotePath, parseNoteLenient, parseView, scanText } from '@gmemo/core';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { stringify as stringifyYaml } from 'yaml';
import { ASK_SYSTEM_PROMPT, publicFinding } from '../ai/gateway.js';
import type { AppContext } from '../app.js';
import { capabilities, type Principal } from '../auth/tokens.js';
import type { FileResolution } from '../notes/service.js';
import type { AgentOps } from './agent-ops.js';
import { type Env, jsonBody, requireHuman, requireReader, str } from './http.js';

const MAX_NOTE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function notesRoutes(ctx: AppContext, ops: AgentOps) {
  const app = new Hono<Env>();
  const { notes, indexer } = ctx;

  /** Keep only items the agent may see (folder limits + AI policy). Humans see everything. */
  const visibleTo = async <T>(p: Principal | null, items: T[], pathOf: (t: T) => string): Promise<T[]> => (p ? ops.filter(p.agent, items, pathOf) : items);
  const assertVisible = async (p: Principal | null, path: string) => {
    if (p && (await ops.filter(p.agent, [path], (x) => x)).length === 0) throw new HTTPException(403, { message: `no access to ${path}` });
  };

  // ---- reading -------------------------------------------------------------

  app.get('/notes', async (c) => {
    const { principal } = requireReader(c);
    const folder = c.req.query('folder');
    return c.json(await visibleTo(principal, indexer.listNotes(folder || undefined), (n) => n.path));
  });

  app.get('/note', async (c) => {
    const { principal } = requireReader(c);
    const path = normalizeNotePath(str(c.req.query('path'), 'path'));
    if (principal) {
      const doc = await ops.read(principal.agent, path);
      return c.json({ ...doc, frontmatter: parseNoteLenient(doc.content).frontmatter });
    }
    const ref = c.req.query('commit') ?? 'main';
    const doc = await notes.read(path, ref);
    const parsed = parseNoteLenient(doc.content);
    const policy = await notes.loadPolicy();
    return c.json({ ...doc, frontmatter: parsed.frontmatter, access: effectiveAccess(policy, path, parsed.frontmatter) });
  });

  app.get('/note/backlinks', async (c) => {
    const { principal } = requireReader(c);
    const path = normalizeNotePath(str(c.req.query('path'), 'path'));
    await assertVisible(principal, path);
    return c.json({
      backlinks: principal ? await ops.backlinks(principal.agent, path) : indexer.backlinks(path),
      outgoing: await visibleTo(principal, indexer.outgoingLinks(path), (l) => l.path ?? ''),
    });
  });

  app.get('/note/history', async (c) => {
    const { principal } = requireReader(c);
    const path = str(c.req.query('path'), 'path');
    await assertVisible(principal, path);
    return c.json(await notes.history({ path, limit: Number(c.req.query('limit') ?? 50) }));
  });

  app.get('/note/blame', async (c) => {
    const { principal } = requireReader(c);
    const path = str(c.req.query('path'), 'path');
    await assertVisible(principal, path);
    return c.json(await notes.blame(path));
  });

  app.get('/file', async (c) => {
    const { principal } = requireReader(c);
    const path = normalizeNotePath(str(c.req.query('path'), 'path'), { requireMarkdown: false });
    if (principal && !inFolders(path, principal.agent.folders)) throw new HTTPException(403, { message: `no access to ${path}` });
    const data = await ctx.repo.readRaw('main', path);
    if (!data) throw new HTTPException(404, { message: 'file not found' });
    return new Response(new Uint8Array(data), {
      headers: { 'content-type': contentType(path), 'cache-control': 'private, max-age=60', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" },
    });
  });

  app.get('/search', async (c) => {
    const { principal } = requireReader(c);
    const q = c.req.query('q') ?? '';
    const mode = c.req.query('mode') ?? 'hybrid';
    if (principal) return c.json(await ops.search(principal.agent, q, 30));
    const hits = mode === 'text' ? indexer.textSearch(q, 30) : mode === 'vector' ? await indexer.vectorSearch(q, 30) : await indexer.search(q, 30);
    return c.json(hits);
  });

  app.get('/tags', (c) => {
    requireReader(c);
    return c.json(indexer.tags());
  });

  app.get('/graph', async (c) => {
    const { principal } = requireReader(c);
    const g = indexer.graph();
    const nodes = await visibleTo(principal, g.nodes, (n) => n.id);
    const ids = new Set(nodes.map((n) => n.id));
    return c.json({ nodes, edges: g.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) });
  });

  app.get('/history', async (c) => {
    requireHuman(c);
    const agentId = c.req.query('agentId');
    return c.json(await notes.history({ limit: Number(c.req.query('limit') ?? 100), ...(agentId ? { agentId } : {}) }));
  });

  // ---- writing -------------------------------------------------------------

  app.put('/note', async (c) => {
    const b = await jsonBody<{ path: string; content: string; baseSha?: string | null; baseCommit?: string; device?: string; message?: string; mode?: 'direct' | 'propose'; title?: string }>(c);
    const content = str(b.content, 'content');
    if (Buffer.byteLength(content) > MAX_NOTE_BYTES) throw new HTTPException(413, { message: 'note too large' });
    const principal = c.get('principal');
    if (principal) {
      const path = normalizeNotePath(str(b.path, 'path'));
      return c.json(
        await ops.write(principal, [{ path, content }], {
          title: b.title ?? b.message ?? `Update ${path}`,
          ...(b.baseSha !== undefined ? { baseShas: { [path]: b.baseSha } } : {}),
          ...(b.baseCommit ? { baseCommit: b.baseCommit } : {}),
          ...(b.mode ? { mode: b.mode } : {}),
        }),
      );
    }
    requireHuman(c);
    return c.json(
      await notes.saveAsHuman(str(b.path, 'path'), content, {
        ...(b.baseSha !== undefined ? { baseSha: b.baseSha } : {}),
        ...(b.baseCommit ? { baseCommit: b.baseCommit } : {}),
        ...(b.device ? { device: b.device } : {}),
        ...(b.message ? { message: b.message } : {}),
      }),
    );
  });

  app.delete('/note', async (c) => {
    const path = str(c.req.query('path'), 'path');
    const principal = c.get('principal');
    if (principal) return c.json(await ops.write(principal, [{ path, content: null }], { title: `Delete ${path}`, mode: 'propose' }));
    requireHuman(c);
    return c.json({ commit: await notes.deleteAsHuman(path) });
  });

  app.post('/note/rename', async (c) => {
    requireHuman(c);
    const b = await jsonBody<{ from: string; to: string }>(c);
    return c.json({ commit: await notes.rename(ctx.human(), str(b.from, 'from'), str(b.to, 'to')) });
  });

  app.post('/note/editing', async (c) => {
    requireHuman(c);
    const b = await jsonBody<{ path: string; active: boolean }>(c);
    const path = normalizeNotePath(str(b.path, 'path'));
    if (b.active) notes.markEditing(path);
    else notes.stopEditing(path);
    return c.json({ ok: true });
  });

  /** Agents: submit several file changes as one proposal (or direct write when permitted). */
  app.post('/changes', async (c) => {
    const principal = c.get('principal');
    if (!principal) throw new HTTPException(401, { message: 'agent token required' });
    const b = await jsonBody<{ title: string; description?: string; changes: { path: string; content: string | null }[]; baseShas?: Record<string, string | null>; baseCommit?: string; mode?: 'direct' | 'propose' }>(c);
    if (!Array.isArray(b.changes) || b.changes.length === 0) throw new HTTPException(400, { message: 'changes required' });
    return c.json(
      await ops.write(principal, b.changes, {
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
    const b = await jsonBody<{ text: string; title?: string; folder?: string; url?: string }>(c);
    const principal = c.get('principal');
    let text = str(b.text ?? '', 'text');
    if (b.url) text = `${text}\n${b.url}`.trim();
    if (!text.trim()) throw new HTTPException(400, { message: 'text is empty' });
    if (principal) {
      if (!principal.scope.has('notes:capture') && !capabilities(principal).canPropose) throw new HTTPException(403, { message: 'token cannot capture' });
      // A capture token belongs to the user's own device: recorded as the human.
      const actor = principal.scope.has('notes:capture') ? ctx.human() : { kind: 'ai' as const, agentId: principal.agent.id, name: principal.agent.name };
      if (actor.kind === 'ai') notes.assertAgentCan(principal.agent, 'write', [`${b.folder ?? 'Inbox'}/x.md`]);
      return c.json(await notes.capture(text, { ...(b.title ? { title: b.title } : {}), ...(b.folder ? { folder: b.folder } : {}), actor }));
    }
    requireHuman(c);
    return c.json(await notes.capture(text, { ...(b.title ? { title: b.title } : {}), ...(b.folder ? { folder: b.folder } : {}) }));
  });

  app.post('/attachments', async (c) => {
    requireHuman(c);
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new HTTPException(400, { message: 'file required' });
    if (file.size > MAX_ATTACHMENT_BYTES) throw new HTTPException(413, { message: 'file too large' });
    const safe = file.name.replace(/[^\w.\-\u3000-\u9fff]/g, '_').slice(-80) || 'file';
    const path = `attachments/${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}-${safe}`;
    await notes.commitAs(ctx.human(), [{ path, content: Buffer.from(await file.arrayBuffer()) }], `Attach ${safe}`);
    return c.json({ path, markdown: /\.(png|jpe?g|gif|webp|svg)$/i.test(safe) ? `![[${path}]]` : `[[${path}]]` });
  });

  app.post('/sync', async (c) => {
    requireHuman(c);
    return c.json({ committed: await notes.syncExternal() });
  });

  // ---- proposals -----------------------------------------------------------

  app.get('/proposals', (c) => {
    const { principal } = requireReader(c);
    const status = c.req.query('status') as 'open' | 'merged' | 'rejected' | undefined;
    return c.json(principal ? ops.proposals(principal.agent, status) : notes.listProposals(status));
  });

  app.get('/proposals/:id', async (c) => {
    const { principal } = requireReader(c);
    if (principal) return c.json(await ops.proposal(principal.agent, c.req.param('id')));
    const p = notes.getProposal(c.req.param('id'));
    return c.json({ proposal: p, files: await notes.proposalFiles(p.id) });
  });

  app.post('/proposals/:id/merge', async (c) => {
    requireHuman(c);
    const b = await jsonBody<{ resolutions?: Record<string, FileResolution> }>(c).catch(() => ({ resolutions: {} }));
    return c.json({ commit: await notes.mergeProposal(c.req.param('id'), b.resolutions ?? {}) });
  });

  app.post('/proposals/:id/reject', async (c) => {
    requireHuman(c);
    await notes.rejectProposal(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/revert', async (c) => {
    requireHuman(c);
    const b = await jsonBody<{ commit: string }>(c);
    return c.json(await notes.revertCommit(str(b.commit, 'commit')));
  });

  app.post('/revert-agent', async (c) => {
    requireHuman(c);
    const b = await jsonBody<{ agentId: string; since?: string }>(c);
    return c.json(await notes.revertAgent(str(b.agentId, 'agentId'), b.since));
  });

  // ---- views ---------------------------------------------------------------

  app.get('/views', async (c) => {
    requireReader(c);
    const files = await notes.listViewFiles();
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

  app.get('/views/:id/rows', async (c) => {
    const { principal } = requireReader(c);
    const f = (await notes.listViewFiles()).find((v) => v.id === c.req.param('id'));
    if (!f) throw new HTTPException(404, { message: 'view not found' });
    const view = parseView(f.id, f.text);
    const rows = await visibleTo(principal, applyView(view, indexer.viewNotes()), (r) => r.path);
    return c.json({ view, rows, ...(view.type === 'kanban' ? { groups: groupRows(view, rows) } : {}) });
  });

  app.put('/views/:id', async (c) => {
    requireHuman(c);
    const b = await jsonBody<{ source?: string; view?: unknown }>(c);
    const id = c.req.param('id');
    const text = b.source ?? stringifyYaml(b.view ?? {});
    parseView(id, text); // validate
    await notes.saveViewFile(id, text);
    return c.json({ ok: true });
  });

  app.delete('/views/:id', async (c) => {
    requireHuman(c);
    await notes.deleteViewFile(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ---- AI ------------------------------------------------------------------

  app.get('/ai/status', async (c) => {
    requireHuman(c);
    const policy = await notes.loadPolicy();
    return c.json({ ...ctx.ai.status(), externalAcknowledged: policy.externalAcknowledged });
  });

  app.get('/ai/audit', (c) => {
    requireHuman(c);
    return c.json(ctx.ai.auditLog(Number(c.req.query('limit') ?? 100)));
  });

  /** "Ask your notes": retrieval + LLM, through the egress gateway. */
  app.post('/ask', async (c) => {
    requireHuman(c);
    const b = await jsonBody<{ question: string; prefer?: 'local' | 'external' | 'auto'; confirm?: boolean; paths?: string[] }>(c);
    const question = str(b.question, 'question').slice(0, 4000);
    const policy = await notes.loadPolicy();
    let contexts = await indexer.retrieve(question, 8);
    if (b.paths?.length) {
      const pinned: typeof contexts = [];
      for (const p of b.paths.slice(0, 5)) {
        const doc = await notes.read(p).catch(() => null);
        if (!doc) continue;
        const parsed = parseNoteLenient(doc.content);
        pinned.push({ path: doc.path, title: indexer.getMeta(doc.path)?.title ?? doc.path, text: parsed.body.slice(0, 6000), access: effectiveAccess(policy, doc.path, parsed.frontmatter) });
      }
      contexts = [...pinned, ...contexts.filter((x) => !pinned.some((p) => p.path === x.path))];
    }
    const res = await ctx.ai.chat({
      policy,
      prefer: b.prefer ?? 'auto',
      system: ASK_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: question }],
      contexts,
      confirmSensitive: b.confirm === true,
      actor: ctx.human().name,
      purpose: 'ask',
    });
    const used = res.used.map((p, i) => ({ n: i + 1, path: p, title: contexts.find((x) => x.path === p)?.title ?? p }));
    return c.json({ ...res, findings: res.findings.map(publicFinding), sources: used });
  });

  /** Local-only scan. Used on save to suggest `sensitivity: secret`. */
  app.post('/sensitive/scan', async (c) => {
    requireHuman(c);
    const b = await jsonBody<{ text: string; useModel?: boolean }>(c);
    const policy = await notes.loadPolicy();
    const text = str(b.text, 'text');
    const findings = b.useModel ? await ctx.ai.scan(text, policy) : scanText(text, { dictionary: policy.sensitive.dictionary, allow: policy.sensitive.allow, disabledRules: policy.sensitive.disabledRules, extraRules: ctx.extraRules });
    const strong = findings.some((f) => f.category === 'secret' || f.category === 'credential' || f.category === 'financial' || f.rule === 'my-number');
    return c.json({ findings: findings.map(publicFinding), suggestSecret: strong });
  });

  // ---- live updates --------------------------------------------------------

  app.get('/events', (c) => {
    requireHuman(c);
    return streamSSE(c, async (stream) => {
      const onChange = (e: unknown) => void stream.writeSSE({ event: 'change', data: JSON.stringify(e) });
      const onProposal = (e: unknown) => void stream.writeSSE({ event: 'proposal', data: JSON.stringify(e) });
      notes.events.on('change', onChange);
      notes.events.on('proposal', onProposal);
      stream.onAbort(() => {
        notes.events.off('change', onChange);
        notes.events.off('proposal', onProposal);
      });
      while (!stream.aborted) {
        await stream.writeSSE({ event: 'ping', data: '{}' });
        await stream.sleep(25_000);
      }
    });
  });

  return app;
}

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
  };
  return types[ext] ?? 'application/octet-stream';
}
