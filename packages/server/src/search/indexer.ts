import {
  type AiAccess,
  effectiveAccess,
  extractLinks,
  extractTags,
  markdownToPlain,
  noteTitle,
  parseNoteLenient,
  resolveLink,
  splitBlocks,
  type ViewNote,
  type WorkspacePolicy,
} from '@gmemo/core';
import type { DB } from '../db/db.js';
import { MAIN, type NoteRepo } from '../git/repo.js';
import { dot, type Embedder } from './embedder.js';

export interface NoteSummary {
  path: string;
  title: string;
  createdBy: string | null;
  aiAgent: string | null;
  updatedAt: string | null;
  tags: string[];
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  score: number;
  matchedBy: ('text' | 'vector')[];
}

interface NoteRow {
  path: string;
  title: string;
  frontmatter: string;
  body: string;
  sha: string;
  created_by: string | null;
  ai_agent: string | null;
  updated_at: string | null;
}

const CHUNK_CHARS = 900;

export function chunkBody(body: string): string[] {
  const chunks: string[] = [];
  let cur = '';
  for (const b of splitBlocks(body)) {
    const t = b.key;
    if (!t) continue;
    if (cur && cur.length + t.length > CHUNK_CHARS) {
      chunks.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${t}` : t;
    while (cur.length > CHUNK_CHARS * 2) {
      chunks.push(cur.slice(0, CHUNK_CHARS));
      cur = cur.slice(CHUNK_CHARS);
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * Derived index over the notes on `main`. Everything here can be thrown away
 * and rebuilt from the repository with `rebuild()`.
 */
export class Indexer {
  private embedQueue = new Set<string>();
  private embedding = false;

  constructor(
    private readonly db: DB,
    private readonly repo: NoteRepo,
    private readonly embedder: Embedder,
    private readonly policy: () => WorkspacePolicy,
  ) {}

  indexedCommit(): string | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'commit'`).get() as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  private setIndexedCommit(sha: string) {
    this.db
      .prepare(
        `INSERT INTO meta(key, value) VALUES ('commit', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(sha);
  }

  /** Bring the index up to date with main (incrementally when possible). */
  async sync(): Promise<void> {
    const head = await this.repo.head(MAIN);
    if (!head) return;
    const indexed = this.indexedCommit();
    if (indexed === head) return;
    if (!indexed || !(await this.repo.isAncestor(indexed, head))) {
      await this.rebuild();
      return;
    }
    const changed = await this.repo.changedFiles(indexed, head);
    await this.updatePaths(
      changed.map((c) => c.path),
      head,
    );
  }

  async rebuild(): Promise<void> {
    const head = await this.repo.head(MAIN);
    const files = head ? await this.repo.listFiles(head) : [];
    const keepVectors = this.embedder.id;
    this.db.transaction(() => {
      this.db.exec(
        'DELETE FROM notes; DELETE FROM notes_fts; DELETE FROM links; DELETE FROM tags;',
      );
      this.db.prepare('DELETE FROM chunks WHERE model != ?').run(keepVectors);
    })();
    if (head)
      await this.updatePaths(
        files.map((f) => f.path),
        head,
        true,
      );
  }

  async updatePaths(paths: string[], head: string, full = false): Promise<void> {
    const md = paths.filter((p) => p.toLowerCase().endsWith('.md'));
    const log = full ? new Map<string, string>() : await this.lastModified(md, head);
    const contents = new Map<string, string | null>();
    for (const p of md) contents.set(p, await this.repo.readFile(head, p));

    this.db.transaction(() => {
      for (const [path, text] of contents) {
        this.removeNote(path);
        if (text === null) continue;
        const parsed = parseNoteLenient(text);
        const fm = parsed.frontmatter;
        const createdBy = typeof fm['created_by'] === 'string' ? fm['created_by'] : null;
        const aiAgent = typeof fm['ai_agent'] === 'string' ? fm['ai_agent'] : null;
        const title = noteTitle(path, parsed);
        this.db
          .prepare(
            `INSERT INTO notes(path, title, frontmatter, body, sha, created_by, ai_agent, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            path,
            title,
            JSON.stringify(fm),
            parsed.body,
            '',
            createdBy,
            aiAgent,
            log.get(path) ?? null,
          );
        this.db
          .prepare(`INSERT INTO notes_fts(path, title, body) VALUES (?, ?, ?)`)
          .run(path, title, parsed.body);
        for (const tag of extractTags(parsed.body, fm['tags'])) {
          this.db.prepare(`INSERT INTO tags(path, tag) VALUES (?, ?)`).run(path, tag);
        }
        for (const l of extractLinks(parsed.body)) {
          this.db
            .prepare(`INSERT INTO links(src, target, target_path) VALUES (?, ?, NULL)`)
            .run(path, l.target);
        }
        this.embedQueue.add(path);
      }
      this.resolveAllLinks();
      this.setIndexedCommit(head);
    })();
    if (full) await this.fillUpdatedAt(head);
    void this.processEmbeddings();
  }

  private removeNote(path: string) {
    this.db.prepare('DELETE FROM notes WHERE path = ?').run(path);
    this.db.prepare('DELETE FROM notes_fts WHERE path = ?').run(path);
    this.db.prepare('DELETE FROM links WHERE src = ?').run(path);
    this.db.prepare('DELETE FROM tags WHERE path = ?').run(path);
    this.db.prepare('DELETE FROM chunks WHERE path = ?').run(path);
  }

  private resolveAllLinks() {
    const paths = (this.db.prepare('SELECT path FROM notes').all() as { path: string }[]).map(
      (r) => r.path,
    );
    const rows = this.db.prepare('SELECT rowid, target FROM links').all() as {
      rowid: number;
      target: string;
    }[];
    const cache = new Map<string, string | null>();
    const upd = this.db.prepare('UPDATE links SET target_path = ? WHERE rowid = ?');
    for (const r of rows) {
      if (!cache.has(r.target)) cache.set(r.target, resolveLink(r.target, paths) ?? null);
      upd.run(cache.get(r.target) ?? null, r.rowid);
    }
  }

  private async lastModified(paths: string[], head: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const p of paths) {
      const [c] = await this.repo.log(head, { path: p, limit: 1 });
      if (c) out.set(p, c.date);
    }
    return out;
  }

  private async fillUpdatedAt(head: string) {
    // One pass over history instead of one `git log` per file.
    const commits = await this.repo.log(head, { limit: 2000, firstParent: true });
    const missing = new Set(
      (
        this.db.prepare('SELECT path FROM notes WHERE updated_at IS NULL').all() as {
          path: string;
        }[]
      ).map((r) => r.path),
    );
    const upd = this.db.prepare('UPDATE notes SET updated_at = ? WHERE path = ?');
    for (const c of commits) {
      if (missing.size === 0) break;
      const changed = await this.repo.changedFiles(c.parents[0] ?? null, c.sha);
      for (const f of changed) {
        if (missing.delete(f.path)) upd.run(c.date, f.path);
      }
    }
  }

  /** Compute embeddings in the background. Notes with AI access "none" are skipped. */
  async processEmbeddings(): Promise<void> {
    if (this.embedding) return;
    this.embedding = true;
    try {
      while (this.embedQueue.size) {
        const path = this.embedQueue.values().next().value as string;
        this.embedQueue.delete(path);
        const row = this.db.prepare('SELECT * FROM notes WHERE path = ?').get(path) as
          NoteRow | undefined;
        if (!row) continue;
        const access = effectiveAccess(
          this.policy(),
          path,
          JSON.parse(row.frontmatter) as Record<string, unknown>,
        );
        if (access === 'none' && this.embedder.location !== 'builtin') continue;
        const chunks = chunkBody(`${row.title}\n\n${row.body}`);
        let vectors: Float32Array[];
        try {
          vectors = await this.embedder.embed(chunks);
        } catch (e) {
          console.warn(`[index] embedding failed for ${path}: ${(e as Error).message}`);
          continue;
        }
        this.db.transaction(() => {
          this.db.prepare('DELETE FROM chunks WHERE path = ?').run(path);
          const ins = this.db.prepare(
            'INSERT INTO chunks(path, idx, text, model, vector) VALUES (?, ?, ?, ?, ?)',
          );
          chunks.forEach((t, i) =>
            ins.run(path, i, t, this.embedder.id, Buffer.from(vectors[i]!.buffer)),
          );
        })();
      }
    } finally {
      this.embedding = false;
    }
  }

  /** Wait until queued embeddings are written (used by tests and reindex CLI). */
  async flushEmbeddings(): Promise<void> {
    while (this.embedding || this.embedQueue.size) {
      if (!this.embedding) await this.processEmbeddings();
      else await new Promise((r) => setTimeout(r, 20));
    }
  }

  // ---- queries -------------------------------------------------------------

  listNotes(folder?: string): NoteSummary[] {
    const rows = (
      folder
        ? this.db
            .prepare(`SELECT * FROM notes WHERE path LIKE ? ESCAPE '\\' ORDER BY updated_at DESC`)
            .all(likePrefix(folder))
        : this.db.prepare('SELECT * FROM notes ORDER BY updated_at DESC').all()
    ) as NoteRow[];
    const tags = this.tagsByPath();
    return rows.map((r) => ({
      path: r.path,
      title: r.title,
      createdBy: r.created_by,
      aiAgent: r.ai_agent,
      updatedAt: r.updated_at,
      tags: tags.get(r.path) ?? [],
    }));
  }

  private tagsByPath(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const r of this.db.prepare('SELECT path, tag FROM tags').all() as {
      path: string;
      tag: string;
    }[]) {
      const list = out.get(r.path) ?? [];
      list.push(r.tag);
      out.set(r.path, list);
    }
    return out;
  }

  viewNotes(): ViewNote[] {
    const tags = this.tagsByPath();
    return (this.db.prepare('SELECT path, title, frontmatter FROM notes').all() as NoteRow[]).map(
      (r) => ({
        path: r.path,
        title: r.title,
        tags: tags.get(r.path) ?? [],
        properties: JSON.parse(r.frontmatter) as Record<string, unknown>,
      }),
    );
  }

  getMeta(path: string): { title: string; frontmatter: Record<string, unknown> } | null {
    const r = this.db.prepare('SELECT title, frontmatter FROM notes WHERE path = ?').get(path) as
      NoteRow | undefined;
    return r
      ? { title: r.title, frontmatter: JSON.parse(r.frontmatter) as Record<string, unknown> }
      : null;
  }

  allPaths(): string[] {
    return (this.db.prepare('SELECT path FROM notes').all() as { path: string }[]).map(
      (r) => r.path,
    );
  }

  backlinks(path: string): { path: string; title: string; context: string }[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT l.src AS path, n.title AS title, n.body AS body, l.target AS target
         FROM links l JOIN notes n ON n.path = l.src WHERE l.target_path = ? AND l.src != ?`,
      )
      .all(path, path) as { path: string; title: string; body: string; target: string }[];
    return rows.map((r) => {
      const i = r.body.indexOf(`[[${r.target}`);
      const context =
        i >= 0 ? markdownToPlain(r.body.slice(Math.max(0, i - 60), i + r.target.length + 80)) : '';
      return { path: r.path, title: r.title, context };
    });
  }

  outgoingLinks(path: string): { target: string; path: string | null }[] {
    return (
      this.db.prepare('SELECT target, target_path FROM links WHERE src = ?').all(path) as {
        target: string;
        target_path: string | null;
      }[]
    ).map((r) => ({ target: r.target, path: r.target_path }));
  }

  graph(): {
    nodes: { id: string; title: string; createdBy: string | null; tags: string[] }[];
    edges: { source: string; target: string }[];
  } {
    const tags = this.tagsByPath();
    const nodes = (
      this.db.prepare('SELECT path, title, created_by FROM notes').all() as NoteRow[]
    ).map((r) => ({
      id: r.path,
      title: r.title,
      createdBy: r.created_by,
      tags: tags.get(r.path) ?? [],
    }));
    const edges = (
      this.db
        .prepare(
          'SELECT DISTINCT src, target_path FROM links WHERE target_path IS NOT NULL AND src != target_path',
        )
        .all() as {
        src: string;
        target_path: string;
      }[]
    ).map((r) => ({ source: r.src, target: r.target_path }));
    return { nodes, edges };
  }

  tags(): { tag: string; count: number }[] {
    return this.db
      .prepare('SELECT tag, COUNT(*) AS count FROM tags GROUP BY tag ORDER BY count DESC')
      .all() as { tag: string; count: number }[];
  }

  textSearch(query: string, limit = 20): SearchHit[] {
    const q = query.trim();
    if (!q) return [];
    let rows: { path: string; title: string; snippet: string; rank: number }[];
    if ([...q].length >= 3) {
      const fts = q
        .split(/\s+/)
        .filter((t) => [...t].length >= 3)
        .map((t) => `"${t.replace(/"/g, '""')}"`)
        .join(' AND ');
      rows = this.db
        .prepare(
          `SELECT path, title, snippet(notes_fts, 2, '«', '»', '…', 16) AS snippet, bm25(notes_fts, 0, 5, 1) AS rank
           FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(fts, limit) as typeof rows;
    } else {
      // Trigram FTS needs ≥3 characters; fall back to LIKE for short queries (common in Japanese).
      rows = (
        this.db
          .prepare(
            `SELECT path, title, body FROM notes WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' LIMIT ?`,
          )
          .all(likeContains(q), likeContains(q), limit) as {
          path: string;
          title: string;
          body: string;
        }[]
      ).map((r, i) => {
        const idx = r.body.indexOf(q);
        const snippet =
          idx >= 0
            ? '…' +
              r.body.slice(Math.max(0, idx - 30), idx) +
              '«' +
              q +
              '»' +
              r.body.slice(idx + q.length, idx + q.length + 30) +
              '…'
            : r.body.slice(0, 60);
        return { path: r.path, title: r.title, snippet, rank: i };
      });
    }
    return rows.map((r, i) => ({
      path: r.path,
      title: r.title,
      snippet: markdownToPlain(r.snippet),
      score: 1 / (i + 1),
      matchedBy: ['text'],
    }));
  }

  async vectorSearch(query: string, limit = 20): Promise<(SearchHit & { chunk: string })[]> {
    const [qv] = await this.embedder.embed([query]);
    if (!qv) return [];
    const rows = this.db
      .prepare(
        'SELECT c.path, c.text, c.vector, n.title FROM chunks c JOIN notes n ON n.path = c.path WHERE c.model = ?',
      )
      .all(this.embedder.id) as {
      path: string;
      text: string;
      vector: Buffer;
      title: string;
    }[];
    const scored = rows.map((r) => {
      const v = new Float32Array(
        r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength),
      );
      return { path: r.path, title: r.title, chunk: r.text, score: dot(qv, v) };
    });
    scored.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    const out: (SearchHit & { chunk: string })[] = [];
    for (const s of scored) {
      if (seen.has(s.path)) continue;
      seen.add(s.path);
      out.push({
        ...s,
        snippet: markdownToPlain(s.chunk.slice(0, 200)).slice(0, 160),
        matchedBy: ['vector'],
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Hybrid search: reciprocal-rank fusion of full-text and vector results. */
  async search(query: string, limit = 20): Promise<SearchHit[]> {
    const text = this.textSearch(query, limit * 2);
    const vec = await this.vectorSearch(query, limit * 2).catch(() => []);
    const fused = new Map<string, SearchHit>();
    const add = (hits: SearchHit[], weight: number) =>
      hits.forEach((h, rank) => {
        const prev = fused.get(h.path);
        const score = weight / (60 + rank);
        if (prev) {
          prev.score += score;
          prev.matchedBy = [...new Set([...prev.matchedBy, ...h.matchedBy])];
          if (h.matchedBy.includes('text')) prev.snippet = h.snippet;
        } else fused.set(h.path, { ...h, score });
      });
    add(text, 1.2);
    add(
      vec.filter((v) => v.score > 0.2),
      1,
    );
    return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Chunks most relevant to a question (for "ask your notes"). */
  async retrieve(
    question: string,
    limit = 8,
  ): Promise<{ path: string; title: string; text: string; access: AiAccess }[]> {
    const vec = await this.vectorSearch(question, limit).catch(() => []);
    const text = this.textSearch(question, limit);
    const out: { path: string; title: string; text: string; access: AiAccess }[] = [];
    const seen = new Set<string>();
    const policy = this.policy();
    for (const h of [...vec, ...text]) {
      if (seen.has(h.path) || out.length >= limit) continue;
      seen.add(h.path);
      const meta = this.getMeta(h.path);
      const body =
        'chunk' in h
          ? (h as { chunk: string }).chunk
          : ((
              this.db.prepare('SELECT body FROM notes WHERE path = ?').get(h.path) as
                { body: string } | undefined
            )?.body.slice(0, 1800) ?? '');
      out.push({
        path: h.path,
        title: h.title,
        text: body,
        access: effectiveAccess(policy, h.path, meta?.frontmatter ?? {}),
      });
    }
    return out;
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}
function likePrefix(folder: string): string {
  return escapeLike(folder.replace(/\/+$/, '') + '/') + '%';
}
function likeContains(s: string): string {
  return '%' + escapeLike(s) + '%';
}
