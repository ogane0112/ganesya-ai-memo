import Database from 'better-sqlite3';
import type { Db, SqlValue, Stmt } from './db.js';

/** Node adapter: better-sqlite3 behind the async Db interface. */
export class SqliteDb implements Db {
  readonly raw: Database.Database;

  constructor(file: string) {
    this.raw = new Database(file);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
    this.raw.pragma('busy_timeout = 5000');
  }

  private conv(params: SqlValue[]): unknown[] {
    return params.map((p) =>
      p instanceof ArrayBuffer
        ? Buffer.from(p)
        : p instanceof Uint8Array && !Buffer.isBuffer(p)
          ? Buffer.from(p.buffer, p.byteOffset, p.byteLength)
          : p,
    );
  }

  async first<T>(sql: string, ...params: SqlValue[]): Promise<T | null> {
    return (this.raw.prepare(sql).get(...this.conv(params)) as T | undefined) ?? null;
  }

  async all<T>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    return this.raw.prepare(sql).all(...this.conv(params)) as T[];
  }

  async run(sql: string, ...params: SqlValue[]): Promise<{ changes: number }> {
    const r = this.raw.prepare(sql).run(...this.conv(params));
    return { changes: r.changes };
  }

  async batch(stmts: Stmt[]): Promise<{ changes: number }[]> {
    return this.raw.transaction(() =>
      stmts.map((s) => ({
        changes: this.raw.prepare(s.sql).run(...this.conv(s.params)).changes,
      })),
    )();
  }

  close(): void {
    this.raw.close();
  }
}
