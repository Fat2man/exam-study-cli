import Database from 'better-sqlite3';
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { readingProgressSchema, type IProgressStore, type ReadingProgress } from '../domain/progress.js';

export const PROGRESS_SCHEMA_VERSION = 2;
export const PROGRESS_V1_SQL = `
CREATE TABLE reading_progress (
  library_key TEXT NOT NULL, book_id TEXT NOT NULL, section_id TEXT, block_id TEXT,
  page_no INTEGER, scroll_offset INTEGER NOT NULL DEFAULT 0 CHECK(scroll_offset >= 0),
  updated_at TEXT NOT NULL, PRIMARY KEY(library_key, book_id)
);
CREATE TABLE recent_reading (
  library_key TEXT PRIMARY KEY, book_id TEXT NOT NULL,
  FOREIGN KEY(library_key, book_id) REFERENCES reading_progress(library_key, book_id)
);`;
export function migrateProgressDatabase(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > PROGRESS_SCHEMA_VERSION) throw new Error(`进度库版本 ${version} 高于程序支持的 ${PROGRESS_SCHEMA_VERSION}，未修改数据库`);
  db.transaction(() => {
    if (version < 1) { db.exec(PROGRESS_V1_SQL); db.pragma('user_version = 1'); }
    if (version < 2) {
      db.exec(`ALTER TABLE reading_progress ADD COLUMN anchor_json TEXT;
        CREATE TABLE progress_recovery_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT, library_key TEXT NOT NULL, book_id TEXT NOT NULL,
          saved_json TEXT NOT NULL, archived_at TEXT NOT NULL
        );`);
      db.pragma('user_version = 2');
    }
  })();
}
export function libraryKey(root: string): string {
  let resolved = path.resolve(root);
  try { resolved = realpathSync.native(resolved); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
type ProgressRow = {
  book_id: string; section_id: string | null; block_id: string | null; page_no: number | null;
  scroll_offset: number; updated_at: string; anchor_json: string | null;
};
export class SqliteProgressStore implements IProgressStore {
  private readonly db: Database.Database;
  readonly library: string;
  constructor(readonly file: string, root: string) {
    this.library = libraryKey(root);
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file, { timeout: 250 });
    try {
      migrateProgressDatabase(this.db);
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      if (this.db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('进度库完整性检查失败');
    } catch (error) { this.db.close(); throw error; }
  }
  private parse(row: ProgressRow | undefined): ReadingProgress | null {
    if (!row) return null;
    return readingProgressSchema.parse({ bookId: row.book_id, sectionId: row.section_id ?? undefined,
      blockId: row.block_id ?? undefined, pageNo: row.page_no ?? undefined, scrollOffset: row.scroll_offset,
      updatedAt: row.updated_at, anchor: row.anchor_json ? JSON.parse(row.anchor_json) : undefined });
  }
  get(bookId: string): ReadingProgress | null {
    return this.parse(this.db.prepare('SELECT * FROM reading_progress WHERE library_key = ? AND book_id = ?').get(this.library, bookId) as ProgressRow | undefined);
  }
  getLastRead(): ReadingProgress | null {
    return this.parse(this.db.prepare(`SELECT p.* FROM recent_reading r JOIN reading_progress p
      ON p.library_key = r.library_key AND p.book_id = r.book_id WHERE r.library_key = ?`).get(this.library) as ProgressRow | undefined);
  }
  save(input: ReadingProgress): void {
    const progress = readingProgressSchema.parse(input);
    this.db.transaction(() => {
      const old = this.get(progress.bookId);
      if (old && (old.anchor?.revision !== progress.anchor?.revision
        || (old.blockId === progress.blockId && old.anchor?.viewHash !== progress.anchor?.viewHash))) {
        this.db.prepare(`INSERT INTO progress_recovery_history(library_key, book_id, saved_json, archived_at) VALUES (?, ?, ?, ?)`)
          .run(this.library, old.bookId, JSON.stringify(old), new Date().toISOString());
      }
      this.db.prepare(`INSERT INTO reading_progress(library_key, book_id, section_id, block_id, page_no, scroll_offset, updated_at, anchor_json)
        VALUES (@library, @book, @section, @block, @page, @offset, @time, @anchor)
        ON CONFLICT(library_key, book_id) DO UPDATE SET section_id=excluded.section_id, block_id=excluded.block_id,
        page_no=excluded.page_no, scroll_offset=excluded.scroll_offset, updated_at=excluded.updated_at, anchor_json=excluded.anchor_json`)
        .run({ library: this.library, book: progress.bookId, section: progress.sectionId ?? null, block: progress.blockId ?? null,
          page: progress.pageNo ?? null, offset: progress.scrollOffset, time: progress.updatedAt, anchor: progress.anchor ? JSON.stringify(progress.anchor) : null });
      this.db.prepare(`INSERT INTO recent_reading(library_key, book_id) VALUES (?, ?)
        ON CONFLICT(library_key) DO UPDATE SET book_id=excluded.book_id`).run(this.library, progress.bookId);
    })();
  }
  history(bookId: string): ReadingProgress[] {
    return (this.db.prepare('SELECT saved_json FROM progress_recovery_history WHERE library_key = ? AND book_id = ? ORDER BY id').all(this.library, bookId) as { saved_json: string }[])
      .map(row => readingProgressSchema.parse(JSON.parse(row.saved_json)));
  }
  close(): void { if (this.db.open) this.db.close(); }
}
