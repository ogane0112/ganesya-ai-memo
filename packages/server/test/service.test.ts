import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError } from '../src/notes/service.js';
import { MAIN } from '../src/store/types.js';
import { setup, STORE_KINDS } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;

describe.each(STORE_KINDS)('NoteService (%s store)', (kind) => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup(kind);
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('saves human notes, records creator and indexes them', async () => {
    const r = await ctx.service.saveAsHuman('a/Hello.md', '# Hello\n\nworld [[Welcome]]\n');
    expect(r.status).toBe('committed');
    const doc = await ctx.service.read('a/Hello.md');
    expect(doc.content).toContain('created_by: human');
    if (r.status === 'committed') expect(r.sha).toBe(doc.sha);
    expect((await ctx.indexer.backlinks('Welcome.md')).map((b) => b.path)).toEqual(['a/Hello.md']);
    expect((await ctx.indexer.textSearch('world')).map((h) => h.path)).toContain('a/Hello.md');
    expect((await ctx.indexer.textSearch('wo')).map((h) => h.path)).toContain('a/Hello.md');
  });

  it('merges a stale save paragraph-by-paragraph', async () => {
    await ctx.service.saveAsHuman('n.md', 'p1\n\np2\n\np3\n');
    const v1 = await ctx.service.read('n.md');
    await ctx.service.saveAsHuman('n.md', v1.content.replace('p1', 'p1 phone'), {
      baseSha: v1.sha,
    });
    const r = await ctx.service.saveAsHuman('n.md', v1.content.replace('p3', 'p3 laptop'), {
      baseSha: v1.sha,
    });
    expect(r.status).toBe('committed');
    const v3 = await ctx.service.read('n.md');
    expect(v3.content).toContain('p1 phone');
    expect(v3.content).toContain('p3 laptop');
  });

  it('turns an unmergeable offline edit into a proposal', async () => {
    await ctx.service.saveAsHuman('n.md', 'p1\n');
    const v1 = await ctx.service.read('n.md');
    await ctx.service.saveAsHuman('n.md', v1.content.replace('p1', 'A'), { baseSha: v1.sha });
    const r = await ctx.service.saveAsHuman('n.md', v1.content.replace('p1', 'B'), {
      baseSha: v1.sha,
      device: 'iPhone',
    });
    expect(r.status).toBe('proposed');
    if (r.status !== 'proposed') return;
    const files = await ctx.service.proposalFiles(r.proposalId);
    expect(files[0]!.merge!.clean).toBe(false);
    await expect(ctx.service.mergeProposal(r.proposalId)).rejects.toBeInstanceOf(ConflictError);
    await ctx.service.mergeProposal(r.proposalId, { 'n.md': { blocks: { 0: 'theirs' } } });
    expect((await ctx.service.read('n.md')).content).toContain('B');
  });

  it('agent proposals, auto merge and direct writes', async () => {
    const agent = await ctx.agents.create({ name: 'claude', writeMode: 'propose' });
    const r = await ctx.service.writeAsAgent(
      agent,
      [{ path: 'ai/Idea.md', content: '# Idea\n\nfrom ai\n' }],
      { title: 'Add idea' },
    );
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

    const auto = await ctx.agents.create({ name: 'tidy', writeMode: 'propose', autoMerge: true });
    const r2 = await ctx.service.writeAsAgent(
      auto,
      [{ path: 'ai/Idea.md', content: doc.content + '\nmore\n' }],
      { title: 'tidy' },
    );
    expect(r2).toMatchObject({ status: 'proposed', merged: true });

    const direct = await ctx.agents.create({ name: 'direct', writeMode: 'direct' });
    const cur = await ctx.service.read('ai/Idea.md');
    await ctx.service.markEditing('ai/Idea.md');
    const r3 = await ctx.service.writeAsAgent(
      direct,
      [{ path: 'ai/Idea.md', content: cur.content + '\nx\n' }],
      { title: 'd', baseShas: { 'ai/Idea.md': cur.sha } },
    );
    expect(r3.status).toBe('proposed');
    await ctx.service.stopEditing('ai/Idea.md');
    const r4 = await ctx.service.writeAsAgent(
      direct,
      [{ path: 'ai/Idea.md', content: cur.content + '\ny\n' }],
      { title: 'd2', baseShas: { 'ai/Idea.md': cur.sha } },
    );
    expect(r4.status).toBe('committed');
    const r5 = await ctx.service.writeAsAgent(
      direct,
      [{ path: 'ai/Idea.md', content: cur.content + '\nz\n' }],
      { title: 'd3', baseShas: { 'ai/Idea.md': cur.sha } },
    );
    expect(r5.status).toBe('proposed');
  });

  it('enforces folder restrictions', async () => {
    const agent = await ctx.agents.create({ name: 'scoped', folders: ['work'] });
    await expect(
      ctx.service.writeAsAgent(agent, [{ path: 'private/x.md', content: 'x' }], { title: 't' }),
    ).rejects.toThrow(/no access/);
  });

  it('blames AI paragraphs and reverts agent changes', async () => {
    await ctx.service.saveAsHuman('n.md', 'human para\n');
    const agent = await ctx.agents.create({ name: 'bot', writeMode: 'direct' });
    const cur = await ctx.service.read('n.md');
    await ctx.service.writeAsAgent(
      agent,
      [{ path: 'n.md', content: cur.content + '\nai para\n' }],
      { title: 'append' },
    );
    await ctx.service.saveAsHuman(
      'n.md',
      (await ctx.service.read('n.md')).content.replace('human para', 'human para edited'),
    );
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

  it('retries a write when main moves underneath it', async () => {
    await ctx.service.saveAsHuman('n.md', 'one\n');
    // Simulate another request committing between our read of head and our commit.
    const store = ctx.service.store;
    const original = store.commit.bind(store);
    let raced = false;
    store.commit = async (branch, changes, author, message, opts) => {
      if (!raced && branch === MAIN) {
        raced = true;
        const head = (await store.head(MAIN))!;
        await original(MAIN, [{ path: 'other.md', content: 'other\n' }], author, 'concurrent', {
          parent: head,
        });
      }
      return original(branch, changes, author, message, opts);
    };
    const r = await ctx.service.saveAsHuman('n.md', 'two\n');
    store.commit = original;
    expect(r.status).toBe('committed');
    expect((await ctx.service.read('n.md')).content).toContain('two');
    expect((await ctx.service.read('other.md')).content).toBe('other\n');
    expect((await ctx.indexer.listNotes()).map((n) => n.path)).toContain('other.md');
  });

  it('renames and rewrites links', async () => {
    await ctx.service.saveAsHuman('Target.md', 'target\n');
    await ctx.service.saveAsHuman('Src.md', 'see [[Target]]\n');
    await ctx.service.rename({ kind: 'human', name: 'me' }, 'Target.md', 'dir/Renamed.md');
    expect((await ctx.service.read('Src.md')).content).toContain('[[Renamed]]');
    expect((await ctx.indexer.backlinks('dir/Renamed.md')).map((b) => b.path)).toEqual(['Src.md']);
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
    await ctx.db.batch(ctx.indexer.clearStmts());
    await ctx.indexer.sync();
    expect(
      (await ctx.indexer.viewNotes()).find((n) => n.path === 'x.md')?.properties['status'],
    ).toBe('todo');
    expect((await ctx.indexer.tags()).map((t) => t.tag)).toContain('task');
    expect((await ctx.indexer.listNotes())[0]!.updatedAt).toBeTruthy();
    const hits = await ctx.indexer.vectorSearch('X');
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('GitHub storage', () => {
  it('picks up commits pushed to the repository from elsewhere', async () => {
    const ctx = await setup('github');
    await ctx.gh.pushExternal({ 'Pushed.md': '# Pushed\n\nfrom the laptop [[Welcome]]\n' });
    await ctx.service.currentHead();
    expect((await ctx.indexer.listNotes()).map((n) => n.path)).toContain('Pushed.md');
    expect((await ctx.indexer.backlinks('Welcome.md')).map((b) => b.path)).toContain('Pushed.md');
    // A save based on the pushed state goes on top of it.
    const doc = await ctx.service.read('Pushed.md');
    await ctx.service.saveAsHuman('Pushed.md', doc.content + '\nedit\n', { baseSha: doc.sha });
    expect(ctx.gh.refs.get('main')).toBe(await ctx.service.head());
    await ctx.cleanup();
  });

  it('keeps users apart', async () => {
    const ctx = await setup('builtin');
    const { addUser } = await import('./helpers.js');
    const other = await addUser(ctx.platform, 'other', 'builtin', ctx.gh);
    const ws2 = await ctx.platform.workspace(other);
    await ws2.notes.init();
    await ctx.service.saveAsHuman('Secret.md', 'mine\n');
    expect((await ws2.indexer.listNotes()).map((n) => n.path)).not.toContain('Secret.md');
    expect((await ws2.indexer.textSearch('mine')).length).toBe(0);
    await expect(ws2.notes.read('Secret.md')).rejects.toThrow(/not found/);
    await ctx.cleanup();
  });
});
