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
import { type Db, nowIso, type SqlValue, type Stmt, stmt, toBytes } from '../db/db.js';
import { fromUtf8, MAIN, type NoteStore } from '../store/types.js';
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
  created_by: string | null;
  ai_agent: string | null;
  updated_at: string | null;
}

const CHUNK_CHARS = 900;
/** Above this many changed files, read the whole snapshot in one go. */
const SNAPSHOT_THRESHOLD = 25;
/** Keep each JSON parameter well below D1's 2 MB value limit. */
const JSON_PARAM_BYTES = 700_000;

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
 * Bulk statements: rows travel as one JSON parameter and are unpacked with
 * json_each, so a rebuild is a handful of statements instead of one per row
 * (D1 counts every statement against the per-request query limit).
 */
function jsonRows(
  sql: (src: string) => string,
  rows: unknown[][],
  params: SqlValue[] = [],
): Stmt[] {
  const out: Stmt[] = [];
  let batch: unknown[][] = [];
  let size = 0;
  const flush = () => {
    if (batch.length) {
      const text = sql('json_each(?)');
      // Each json_each(?) takes the batch; every other ? takes the next of `params`.
      const json = JSON.stringify(batch);
      let next = 0;
      const args = [...text.matchAll(/json_each\(\?\)|\?/g)].map((m) =>
        m[0] === '?' ? (params[next++] ?? null) : json,
      );
      out.push(stmt(text, ...args));
    }
    batch = [];
    size = 0;
  };
  for (const r of rows) {
    const len = JSON.stringify(r).length;
    if (size + len > JSON_PARAM_BYTES) flush();
    batch.push(r);
    size += len;
  }
  flush();
  return out;
}

const colSql = (i: number) => `json_extract(value, '$[${i}]')`;

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
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

/**
 * One user's derived index over the notes on `main` (titles, tags, links,
 * full text, embeddings). Everything here can be thrown away and rebuilt from
 * the note store with `rebuild()`.
 */
export class Indexer {
  constructor(
    private readonly db: Db,
    readonly userId: string,
    private readonly store: NoteStore,
    private readonly embedder: Embedder,
    private readonly policy: () => WorkspacePolicy,
    private readonly opts: { fts: boolean },
  ) {
    // Interpolated into bulk statements below; ids are generated, never user input.
    if (!/^[\w-]+$/.test(userId)) throw new Error('invalid user id');
  }

  private get model(): string {
    return this.embedder.id.replace(/'/g, "''");
  }

  async state(): Promise<{ commit: string | null; checkedAt: string | null }> {
    const r = await this.db.first<{ commit_sha: string | null; checked_at: string | null }>(
      'SELECT commit_sha, checked_at FROM index_state WHERE user_id = ?',
      this.userId,
    );
    return { commit: r?.commit_sha ?? null, checkedAt: r?.checked_at ?? null };
  }

  private stateStmt(commit: string | null): Stmt {
    return stmt(
      `INSERT INTO index_state(user_id, commit_sha, checked_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET commit_sha = excluded.commit_sha, checked_at = excluded.checked_at`,
      this.userId,
      commit,
      nowIso(),
    );
  }

  /** Record that the store was checked just now (throttles GitHub polling). */
  async touch(): Promise<void> {
    await this.db.run(
      'UPDATE index_state SET checked_at = ? WHERE user_id = ?',
      nowIso(),
      this.userId,
    );
  }

  /** Bring the index up to date with main (incrementally when possible). */
  async sync(head?: string | null): Promise<boolean> {
    const h = head === undefined ? await this.store.head(MAIN) : head;
    if (!h) return false;
    const { commit } = await this.state();
    if (commit === h) {
      await this.touch();
      return false;
    }
    if (!commit || !(await this.store.isAncestor(commit, h))) {
      await this.rebuild(h);
      return true;
    }
    const changed = await this.store.changedFiles(commit, h);
    const [c] = await this.store.log(h, { limit: 1 });
    await this.updatePaths(
      changed.map((x) => x.path),
      h,
      c?.date,
    );
    return true;
  }

  /** Remove everything indexed for this user. */
  clearStmts(): Stmt[] {
    const u = this.userId;
    return [
      ...(this.opts.fts
        ? [
            stmt(
              'DELETE FROM notes_fts WHERE rowid IN (SELECT rowid FROM notes WHERE user_id = ?)',
              u,
            ),
          ]
        : []),
      stmt('DELETE FROM notes WHERE user_id = ?', u),
      stmt('DELETE FROM links WHERE user_id = ?', u),
      stmt('DELETE FROM tags WHERE user_id = ?', u),
      stmt('DELETE FROM chunks WHERE user_id = ?', u),
      stmt('DELETE FROM index_state WHERE user_id = ?', u),
    ];
  }

  async rebuild(head?: string): Promise<void> {
    const h = head ?? (await this.store.head(MAIN));
    await this.db.batch(this.clearStmts());
    if (!h) return;
    const snapshot = await this.store.snapshot(h);
    const contents = new Map<string, string | null>();
    for (const [p, data] of snapshot)
      if (p.toLowerCase().endsWith('.md')) contents.set(p, fromUtf8(data));
    await this.write(contents, h, null);
    await this.fillUpdatedAt(h);
  }

  /**
   * Re-index the given paths at `head`. `date` is used as their update time
   * (the commit that changed them); omitted, it is looked up per file.
   * `samePaths`: no note was added or removed, only edited.
   */
  async updatePaths(
    paths: string[],
    head: string,
    date?: string,
    opts: { samePaths?: boolean } = {},
  ): Promise<void> {
    const md = [...new Set(paths.filter((p) => p.toLowerCase().endsWith('.md')))];
    const contents = new Map<string, string | null>();
    if (md.length > SNAPSHOT_THRESHOLD) {
      const snapshot = await this.store.snapshot(head);
      for (const p of md) {
        const data = snapshot.get(p);
        contents.set(p, data ? fromUtf8(data) : null);
      }
    } else {
      for (const p of md) contents.set(p, await this.store.readFile(head, p));
    }
    const dates = new Map<string, string>();
    if (date) for (const p of md) dates.set(p, date);
    else
      for (const p of md) {
        const [c] = await this.store.log(head, { path: p, limit: 1 });
        if (c) dates.set(p, c.date);
      }
    await this.write(contents, head, dates, opts.samePaths);
  }

  private async write(
    contents: Map<string, string | null>,
    head: string,
    dates: Map<string, string> | null,
    samePaths = false,
  ): Promise<void> {
    const u = this.userId;
    const changed = [...contents.keys()];
    const changedJson = JSON.stringify(changed);
    const notes: unknown[][] = [];
    const tags: unknown[][] = [];
    const newLinks: { src: string; target: string }[] = [];
    const chunkRows: unknown[][] = [];
    const policy = this.policy();

    for (const [path, text] of contents) {
      if (text === null) continue;
      const parsed = parseNoteLenient(text);
      const fm = parsed.frontmatter;
      const title = noteTitle(path, parsed);
      notes.push([
        path,
        title,
        JSON.stringify(fm),
        parsed.body,
        typeof fm['created_by'] === 'string' ? fm['created_by'] : null,
        typeof fm['ai_agent'] === 'string' ? fm['ai_agent'] : null,
        dates?.get(path) ?? null,
      ]);
      for (const tag of extractTags(parsed.body, fm['tags'])) tags.push([path, tag]);
      for (const l of extractLinks(parsed.body)) newLinks.push({ src: path, target: l.target });

      const access = effectiveAccess(policy, path, fm);
      if (access === 'none' && this.embedder.location !== 'builtin') continue;
      const chunks = chunkBody(`${title}\n\n${parsed.body}`);
      try {
        const vectors = await this.embedder.embed(chunks);
        chunks.forEach((t, i) =>
          chunkRows.push([path, i, t, hex(new Uint8Array(vectors[i]!.buffer))]),
        );
      } catch (e) {
        console.warn(`[index] embedding failed for ${path}: ${(e as Error).message}`);
      }
    }

    // Link targets resolve against the full set of paths after this change. With
    // the same set of notes as before, links of other notes resolve as they did,
    // and the paths are only needed when the edited notes link somewhere.
    const [known, kept] = await Promise.all([
      samePaths && newLinks.length === 0
        ? []
        : this.db.all<{ path: string }>('SELECT path FROM notes WHERE user_id = ?', u),
      samePaths
        ? []
        : this.db.all<{
            rowid: number;
            src: string;
            target: string;
            target_path: string | null;
          }>('SELECT rowid, src, target, target_path FROM links WHERE user_id = ?', u),
    ]);
    const remaining = known.map((r) => r.path).filter((p) => !contents.has(p));
    const allPaths = [...remaining, ...notes.map((n) => n[0] as string)];
    const cache = new Map<string, string | null>();
    const resolve = (target: string) => {
      if (!cache.has(target)) cache.set(target, resolveLink(target, allPaths) ?? null);
      return cache.get(target)!;
    };
    const relinks: unknown[][] = [];
    for (const l of kept) {
      if (contents.has(l.src)) continue;
      const next = resolve(l.target);
      if (next !== l.target_path) relinks.push([l.rowid, next]);
    }

    const pathsInSql = `(SELECT value FROM json_each(?))`;
    const stmts: Stmt[] = [];
    if (this.opts.fts)
      stmts.push(
        stmt(
          `DELETE FROM notes_fts WHERE rowid IN (SELECT rowid FROM notes WHERE user_id = ? AND path IN ${pathsInSql})`,
          u,
          changedJson,
        ),
      );
    for (const tableSql of ['notes', 'tags', 'chunks'])
      stmts.push(
        stmt(`DELETE FROM ${tableSql} WHERE user_id = ? AND path IN ${pathsInSql}`, u, changedJson),
      );
    stmts.push(
      stmt(`DELETE FROM links WHERE user_id = ? AND src IN ${pathsInSql}`, u, changedJson),
    );
    stmts.push(
      ...jsonRows(
        (srcSql) =>
          `INSERT INTO notes(user_id, path, title, frontmatter, body, sha, created_by, ai_agent, updated_at)
           SELECT ?, ${colSql(0)}, ${colSql(1)}, ${colSql(2)}, ${colSql(3)}, '', ${colSql(4)}, ${colSql(5)}, ${colSql(6)} FROM ${srcSql}`,
        notes,
        [u],
      ),
      ...jsonRows(
        (srcSql) =>
          `INSERT INTO tags(user_id, path, tag) SELECT ?, ${colSql(0)}, ${colSql(1)} FROM ${srcSql}`,
        tags,
        [u],
      ),
      ...jsonRows(
        (srcSql) =>
          `INSERT INTO links(user_id, src, target, target_path) SELECT ?, ${colSql(0)}, ${colSql(1)}, ${colSql(2)} FROM ${srcSql}`,
        newLinks.map((l) => [l.src, l.target, resolve(l.target)]),
        [u],
      ),
      ...jsonRows(
        (srcSql) =>
          `UPDATE links SET target_path = (SELECT ${colSql(1)} FROM ${srcSql} WHERE ${colSql(0)} = links.rowid)
           WHERE user_id = ? AND rowid IN (SELECT ${colSql(0)} FROM ${srcSql})`,
        relinks,
        [u],
      ),
      ...jsonRows(
        (srcSql) =>
          `INSERT INTO chunks(user_id, path, idx, text, model, vector)
           SELECT ?, ${colSql(0)}, ${colSql(1)}, ${colSql(2)}, ?, unhex(${colSql(3)}) FROM ${srcSql}`,
        chunkRows,
        [u, this.model],
      ),
    );
    if (this.opts.fts)
      stmts.push(
        stmt(
          `INSERT INTO notes_fts(rowid, user_id, path, title, body)
           SELECT rowid, user_id, path, title, body FROM notes WHERE user_id = ? AND path IN ${pathsInSql}`,
          u,
          changedJson,
        ),
      );
    stmts.push(this.stateStmt(head));
    await this.db.batch(stmts);
  }

  /** Fill in update times after a rebuild from one pass over history. */
  private async fillUpdatedAt(head: string): Promise<void> {
    const missing = new Set(
      (
        await this.db.all<{ path: string }>(
          'SELECT path FROM notes WHERE user_id = ? AND updated_at IS NULL',
          this.userId,
        )
      ).map((r) => r.path),
    );
    if (missing.size === 0) return;
    // GitHub needs one request per commit for its changed files, so look less far back there.
    const cheap = this.store.kind === 'builtin';
    const commits = await this.store.log(head, { limit: cheap ? 5000 : 30, firstParent: true });
    const found: unknown[][] = [];
    for (const c of commits) {
      if (missing.size === 0) break;
      const paths =
        c.paths ?? (await this.store.changedFiles(c.parents[0] ?? null, c.sha)).map((f) => f.path);
      for (const p of paths) if (missing.delete(p)) found.push([p, c.date]);
    }
    // Older than we looked: use the oldest date seen so they still sort last.
    const oldest = commits[commits.length - 1]?.date;
    if (oldest) for (const p of missing) found.push([p, oldest]);
    await this.db.batch(
      jsonRows(
        (srcSql) =>
          `UPDATE notes SET updated_at = (SELECT ${colSql(1)} FROM ${srcSql} WHERE ${colSql(0)} = notes.path)
           WHERE user_id = ? AND path IN (SELECT ${colSql(0)} FROM ${srcSql})`,
        found,
        [this.userId],
      ),
    );
  }

  // ---- queries -------------------------------------------------------------

  async listNotes(folder?: string): Promise<NoteSummary[]> {
    const rows = folder
      ? await this.db.all<NoteRow>(
          `SELECT * FROM notes WHERE user_id = ? AND path LIKE ? ESCAPE '\\' ORDER BY updated_at DESC`,
          this.userId,
          likePrefix(folder),
        )
      : await this.db.all<NoteRow>(
          'SELECT * FROM notes WHERE user_id = ? ORDER BY updated_at DESC',
          this.userId,
        );
    const tags = await this.tagsByPath();
    return rows.map((r) => ({
      path: r.path,
      title: r.title,
      createdBy: r.created_by,
      aiAgent: r.ai_agent,
      updatedAt: r.updated_at,
      tags: tags.get(r.path) ?? [],
    }));
  }

  private async tagsByPath(): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (const r of await this.db.all<{ path: string; tag: string }>(
      'SELECT path, tag FROM tags WHERE user_id = ?',
      this.userId,
    )) {
      const list = out.get(r.path) ?? [];
      list.push(r.tag);
      out.set(r.path, list);
    }
    return out;
  }

  async viewNotes(): Promise<ViewNote[]> {
    const tags = await this.tagsByPath();
    return (
      await this.db.all<NoteRow>(
        'SELECT path, title, frontmatter FROM notes WHERE user_id = ?',
        this.userId,
      )
    ).map((r) => ({
      path: r.path,
      title: r.title,
      tags: tags.get(r.path) ?? [],
      properties: JSON.parse(r.frontmatter) as Record<string, unknown>,
    }));
  }

  async getMeta(
    path: string,
  ): Promise<{ title: string; frontmatter: Record<string, unknown> } | null> {
    const r = await this.db.first<NoteRow>(
      'SELECT title, frontmatter FROM notes WHERE user_id = ? AND path = ?',
      this.userId,
      path,
    );
    return r
      ? { title: r.title, frontmatter: JSON.parse(r.frontmatter) as Record<string, unknown> }
      : null;
  }

  /** Frontmatter of every note (for policy checks over many paths at once). */
  async allMeta(): Promise<Map<string, Record<string, unknown>>> {
    const rows = await this.db.all<{ path: string; frontmatter: string }>(
      'SELECT path, frontmatter FROM notes WHERE user_id = ?',
      this.userId,
    );
    return new Map(rows.map((r) => [r.path, JSON.parse(r.frontmatter) as Record<string, unknown>]));
  }

  async allPaths(): Promise<string[]> {
    return (
      await this.db.all<{ path: string }>('SELECT path FROM notes WHERE user_id = ?', this.userId)
    ).map((r) => r.path);
  }

  async backlinks(path: string): Promise<{ path: string; title: string; context: string }[]> {
    const rows = await this.db.all<{ path: string; title: string; body: string; target: string }>(
      `SELECT DISTINCT l.src AS path, n.title AS title, n.body AS body, l.target AS target
       FROM links l JOIN notes n ON n.user_id = l.user_id AND n.path = l.src
       WHERE l.user_id = ? AND l.target_path = ? AND l.src != ?`,
      this.userId,
      path,
      path,
    );
    return rows.map((r) => {
      const i = r.body.indexOf(`[[${r.target}`);
      const context =
        i >= 0 ? markdownToPlain(r.body.slice(Math.max(0, i - 60), i + r.target.length + 80)) : '';
      return { path: r.path, title: r.title, context };
    });
  }

  async outgoingLinks(path: string): Promise<{ target: string; path: string | null }[]> {
    return (
      await this.db.all<{ target: string; target_path: string | null }>(
        'SELECT target, target_path FROM links WHERE user_id = ? AND src = ?',
        this.userId,
        path,
      )
    ).map((r) => ({ target: r.target, path: r.target_path }));
  }

  async graph(): Promise<{
    nodes: { id: string; title: string; createdBy: string | null; tags: string[] }[];
    edges: { source: string; target: string }[];
  }> {
    const tags = await this.tagsByPath();
    const nodes = (
      await this.db.all<NoteRow>(
        'SELECT path, title, created_by FROM notes WHERE user_id = ?',
        this.userId,
      )
    ).map((r) => ({
      id: r.path,
      title: r.title,
      createdBy: r.created_by,
      tags: tags.get(r.path) ?? [],
    }));
    const edges = (
      await this.db.all<{ src: string; target_path: string }>(
        'SELECT DISTINCT src, target_path FROM links WHERE user_id = ? AND target_path IS NOT NULL AND src != target_path',
        this.userId,
      )
    ).map((r) => ({ source: r.src, target: r.target_path }));
    return { nodes, edges };
  }

  async tags(): Promise<{ tag: string; count: number }[]> {
    return this.db.all<{ tag: string; count: number }>(
      'SELECT tag, COUNT(*) AS count FROM tags WHERE user_id = ? GROUP BY tag ORDER BY count DESC',
      this.userId,
    );
  }

  async textSearch(query: string, limit = 20): Promise<SearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    let rows: { path: string; title: string; snippet: string }[];
    const terms = q.split(/\s+/).filter((t) => [...t].length >= 3);
    if (this.opts.fts && terms.length) {
      const fts = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
      rows = await this.db.all(
        `SELECT path, title, snippet(notes_fts, 3, '«', '»', '…', 16) AS snippet
         FROM notes_fts WHERE notes_fts MATCH ? AND user_id = ? ORDER BY bm25(notes_fts, 0, 0, 5, 1) LIMIT ?`,
        fts,
        this.userId,
        limit,
      );
    } else {
      // Trigram FTS needs ≥3 characters (and may be unavailable); LIKE covers the rest.
      const words = q.split(/\s+/).filter(Boolean).slice(0, 5);
      const whereSql = words
        .map(() => `(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')`)
        .join(' AND ');
      const params = words.flatMap((w) => [likeContains(w), likeContains(w)]);
      const found = await this.db.all<{ path: string; title: string; body: string }>(
        `SELECT path, title, body FROM notes WHERE user_id = ? AND ${whereSql} ORDER BY updated_at DESC LIMIT ?`,
        this.userId,
        ...params,
        limit,
      );
      const first = words[0]!;
      rows = found.map((r) => {
        const idx = r.body.indexOf(first);
        const snippet =
          idx >= 0
            ? '…' +
              r.body.slice(Math.max(0, idx - 30), idx) +
              '«' +
              first +
              '»' +
              r.body.slice(idx + first.length, idx + first.length + 30) +
              '…'
            : r.body.slice(0, 60);
        return { path: r.path, title: r.title, snippet };
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
    const rows = await this.db.all<{ path: string; text: string; vector: unknown; title: string }>(
      `SELECT c.path, c.text, c.vector, n.title FROM chunks c
       JOIN notes n ON n.user_id = c.user_id AND n.path = c.path
       WHERE c.user_id = ? AND c.model = ?`,
      this.userId,
      this.embedder.id,
    );
    const scored = rows.map((r) => {
      const b = toBytes(r.vector);
      const v = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
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
    const text = await this.textSearch(query, limit * 2);
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
    const text = await this.textSearch(question, limit);
    const out: { path: string; title: string; text: string; access: AiAccess }[] = [];
    const seen = new Set<string>();
    const policy = this.policy();
    for (const h of [...vec, ...text]) {
      if (seen.has(h.path) || out.length >= limit) continue;
      seen.add(h.path);
      const row = await this.db.first<{ body: string; frontmatter: string }>(
        'SELECT body, frontmatter FROM notes WHERE user_id = ? AND path = ?',
        this.userId,
        h.path,
      );
      if (!row) continue;
      out.push({
        path: h.path,
        title: h.title,
        text: 'chunk' in h ? (h as { chunk: string }).chunk : row.body.slice(0, 1800),
        access: effectiveAccess(
          policy,
          h.path,
          JSON.parse(row.frontmatter) as Record<string, unknown>,
        ),
      });
    }
    return out;
  }
}
