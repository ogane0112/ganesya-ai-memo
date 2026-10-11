import type { Db, SqlValue, Stmt } from './db.js';

/** Minimal structural types for Cloudflare D1 (avoids a hard dependency on workers-types). */
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
}
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

/** Workers adapter: D1 behind the async Db interface. */
export class D1Db implements Db {
  constructor(private readonly d1: D1DatabaseLike) {}

  private prep(sql: string, params: SqlValue[]): D1PreparedStatementLike {
    const s = this.d1.prepare(sql);
    return params.length ? s.bind(...params) : s;
  }

  async first<T>(sql: string, ...params: SqlValue[]): Promise<T | null> {
    return (await this.prep(sql, params).first<T>()) ?? null;
  }

  async all<T>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    return (await this.prep(sql, params).all<T>()).results;
  }

  async run(sql: string, ...params: SqlValue[]): Promise<{ changes: number }> {
    const r = await this.prep(sql, params).run();
    return { changes: r.meta.changes ?? 0 };
  }

  async batch(stmts: Stmt[]): Promise<{ changes: number }[]> {
    const out: { changes: number }[] = [];
    // D1 limits statements per batch; chunk while keeping order. Each chunk is atomic.
    for (let i = 0; i < stmts.length; i += 90) {
      const res = (await this.d1.batch(
        stmts.slice(i, i + 90).map((s) => this.prep(s.sql, s.params)),
      )) as { meta?: { changes?: number } }[];
      for (const r of res) out.push({ changes: r?.meta?.changes ?? 0 });
    }
    return out;
  }
}
