import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError } from '../src/notes/service.js';
import { setup } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.cleanup();
});

describe('NoteService', () => {
  it('saves human notes, records creator and mirrors to working tree', async () => {
    const r = await ctx.service.saveAsHuman('a/Hello.md', '# Hello\n\nworld [[Welcome]]\n');
    expect(r.status).toBe('committed');
    const doc = await ctx.service.read('a/Hello.md');
    expect(doc.content).toContain('created_by: human');
    expect(await readFile(join(ctx.repo.dir, 'a/Hello.md'), 'utf8')).toBe(doc.content);
    expect(ctx.indexer.backlinks('Welcome.md').map((b) => b.path)).toEqual(['a/Hello.md']);
    expect(ctx.indexer.textSearch('world').map((h) => h.path)).toContain('a/Hello.md');
  });

  it('merges a stale save paragraph-by-paragraph', async () => {
    await ctx.service.saveAsHuman('n.md', 'p1\n\np2\n\np3\n');
    const v1 = await ctx.service.read('n.md');
    await ctx.service.saveAsHuman('n.md', v1.content.replace('p1', 'p1 phone'), { baseSha: v1.sha });
    const r = await ctx.service.saveAsHuman('n.md', v1.content.replace('p3', 'p3 laptop'), { baseSha: v1.sha });
    expect(r.status).toBe('committed');
    const v3 = await ctx.service.read('n.md');
    expect(v3.content).toContain('p1 phone');
    expect(v3.content).toContain('p3 laptop');
  });

  it('turns an unmergeable offline edit into a proposal', async () => {
    await ctx.service.saveAsHuman('n.md', 'p1\n');
    const v1 = await ctx.service.read('n.md');
    await ctx.service.saveAsHuman('n.md', v1.content.replace('p1', 'A'), { baseSha: v1.sha });
    const r = await ctx.service.saveAsHuman('n.md', v1.content.replace('p1', 'B'), { baseSha: v1.sha, device: 'iPhone' });
    expect(r.status).toBe('proposed');
    if (r.status !== 'proposed') return;
    const files = await ctx.service.proposalFiles(r.proposalId);
    expect(files[0]!.merge!.clean).toBe(false);
    await expect(ctx.service.mergeProposal(r.proposalId)).rejects.toBeInstanceOf(ConflictError);
    await ctx.service.mergeProposal(r.proposalId, { 'n.md': { blocks: { 0: 'theirs' } } });
    expect((await ctx.service.read('n.md')).content).toContain('B');
  });

  it('agent proposals, auto merge and direct writes', async () => {
    const agent = ctx.agents.create({ name: 'claude', writeMode: 'propose' });
    const r = await ctx.service.writeAsAgent(agent, [{ path: 'ai/Idea.md', content: '# Idea\n\nfrom ai\n' }], { title: 'Add idea' });
    expect(r.status).toBe('proposed');
    expect(await ctx.service.exists('ai/Idea.md')).toBe(false);
    if (r.status !== 'proposed') return;
    const files = await ctx.service.proposalFiles(r.proposalId);
    expect(files[0]!.status).toBe('added');
    await ctx.service.mergeProposal(r.proposalId);
    const doc = await ctx.service.read('ai/Idea.md');
    expect(doc.content).toContain('created_by: ai');
    expect(doc.content).toContain('ai_agent: claude');
    const hist = await ctx.service.history({ path: 'ai/Idea.md' });
    expect(hist[0]!.authorKind).toBe('ai');
    expect(hist[0]!.author).toBe('claude');

    const auto = ctx.agents.create({ name: 'tidy', writeMode: 'propose', autoMerge: true });
    const r2 = await ctx.service.writeAsAgent(auto, [{ path: 'ai/Idea.md', content: doc.content + '\nmore\n' }], { title: 'tidy' });
    expect(r2).toMatchObject({ status: 'proposed', merged: true });

    const direct = ctx.agents.create({ name: 'direct', writeMode: 'direct' });
    const cur = await ctx.service.read('ai/Idea.md');
    ctx.service.markEditing('ai/Idea.md');
    const r3 = await ctx.service.writeAsAgent(direct, [{ path: 'ai/Idea.md', content: cur.content + '\nx\n' }], { title: 'd', baseShas: { 'ai/Idea.md': cur.sha } });
    expect(r3.status).toBe('proposed');
    ctx.service.stopEditing('ai/Idea.md');
    const r4 = await ctx.service.writeAsAgent(direct, [{ path: 'ai/Idea.md', content: cur.content + '\ny\n' }], { title: 'd2', baseShas: { 'ai/Idea.md': cur.sha } });
    expect(r4.status).toBe('committed');
    const r5 = await ctx.service.writeAsAgent(direct, [{ path: 'ai/Idea.md', content: cur.content + '\nz\n' }], { title: 'd3', baseShas: { 'ai/Idea.md': cur.sha } });
    expect(r5.status).toBe('proposed');
  });

  it('enforces folder restrictions', async () => {
    const agent = ctx.agents.create({ name: 'scoped', folders: ['work'] });
    await expect(ctx.service.writeAsAgent(agent, [{ path: 'private/x.md', content: 'x' }], { title: 't' })).rejects.toThrow(/no access/);
  });

  it('blames AI paragraphs and reverts agent changes', async () => {
    await ctx.service.saveAsHuman('n.md', 'human para\n');
    const agent = ctx.agents.create({ name: 'bot', writeMode: 'direct' });
    const cur = await ctx.service.read('n.md');
    await ctx.service.writeAsAgent(agent, [{ path: 'n.md', content: cur.content + '\nai para\n' }], { title: 'append' });
    await ctx.service.saveAsHuman('n.md', (await ctx.service.read('n.md')).content.replace('human para', 'human para edited'));
    const blame = await ctx.service.blame('n.md');
    expect(blame.map((b) => [b.text.trim(), b.author.kind])).toEqual([
      ['human para edited', 'human'],
      ['ai para', 'ai'],
    ]);
    const res = await ctx.service.revertAgent(agent.id);
    expect(res[0]).toMatchObject({ merged: true });
    const after = (await ctx.service.read('n.md')).content;
    expect(after).toContain('human para edited');
    expect(after).not.toContain('ai para');
  });

  it('commits edits made outside the app as human', async () => {
    await writeFile(join(ctx.repo.dir, 'External.md'), '# From Obsidian\n');
    const paths = await ctx.service.syncExternal();
    expect(paths).toEqual(['External.md']);
    const hist = await ctx.service.history({ path: 'External.md' });
    expect(hist[0]!.authorKind).toBe('human');
    expect(ctx.indexer.listNotes().map((n) => n.path)).toContain('External.md');
  });

  it('renames and rewrites links', async () => {
    await ctx.service.saveAsHuman('Target.md', 'target\n');
    await ctx.service.saveAsHuman('Src.md', 'see [[Target]]\n');
    await ctx.service.rename({ kind: 'human', name: 'me' }, 'Target.md', 'dir/Renamed.md');
    expect((await ctx.service.read('Src.md')).content).toContain('[[Renamed]]');
    expect(ctx.indexer.backlinks('dir/Renamed.md').map((b) => b.path)).toEqual(['Src.md']);
  });

  it('captures quick notes into the inbox', async () => {
    const r = await ctx.service.capture('milk');
    const r2 = await ctx.service.capture('eggs');
    expect(r2.path).toBe(r.path);
    const c = (await ctx.service.read(r.path)).content;
    expect(c).toMatch(/milk[\s\S]*eggs/);
  });

  it('rebuilds index from scratch', async () => {
    await ctx.service.saveAsHuman('x.md', '---\nstatus: todo\ntags: [task]\n---\n# X\n');
    ctx.indexDb.exec('DELETE FROM notes; DELETE FROM meta;');
    await ctx.indexer.sync();
    expect(ctx.indexer.viewNotes().find((n) => n.path === 'x.md')?.properties['status']).toBe('todo');
    await ctx.indexer.flushEmbeddings();
    const hits = await ctx.indexer.vectorSearch('X');
    expect(hits.length).toBeGreaterThan(0);
  });
});
