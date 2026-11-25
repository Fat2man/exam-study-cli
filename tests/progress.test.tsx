import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { render } from 'ink-testing-library';
import { App } from '../src/app/App.js';
import { ProgressSession, progressAt, resolveProgress } from '../src/app/progress.js';
import { readerText, viewport } from '../src/app/viewport.js';
import { libraryKey, PROGRESS_V1_SQL, SqliteProgressStore } from '../src/infrastructure/progress-db.js';
import type { BookPackage } from '../src/domain/schema.js';
import type { IProgressStore } from '../src/domain/progress.js';

const dirs: string[] = []; const stores: SqliteProgressStore[] = []; const sessions: ProgressSession[] = [];
const apps: ReturnType<typeof render>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) { app.unmount(); app.cleanup(); }
  for (const session of sessions.splice(0)) session.dispose();
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
function book(id = 'math'): BookPackage {
  const timestamp = '2026-11-11T00:00:00.000Z';
  const blocks = ['## 实数', `${Array.from({ length: 50 }, (_, i) => `段落${String(i).padStart(2, '0')}：数学学习内容。`).join('\n')}\n长块末尾`, '下一块正文'].map((content, order) => ({
    id: `${id}:legacy:${order}`, type: order === 0 ? 'heading' as const : 'paragraph' as const,
    sectionId: `${id}:section`, content, source: { mapping: 'unmapped' as const, bookId: id, pageNo: null, rawFile: 'raw/legacy.md' },
    order, verification: 'unverified' as const, warnings: [], original: { rawFile: 'raw/legacy.md', start: order * 100, end: order * 100 + content.length }, contentVersion: 1
  }));
  return { manifest: { schemaVersion: 1, id, title: id === 'math' ? '数学' : '逻辑', subject: id === 'math' ? 'math' : 'logic', mode: 'legacy-preview',
    source: null, contentVersion: 1, createdAt: timestamp, updatedAt: timestamp }, pages: [], blocks,
    sections: [{ id: `${id}:section`, bookId: id, title: '实数', kind: 'section', level: 1, order: 0, blockIds: blocks.map(b => b.id), children: [] }], diagnostics: [] };
}
async function fixture() {
  await mkdir('data/test-temp', { recursive: true });
  const dir = await mkdtemp(path.resolve('data/test-temp/进度-')); dirs.push(dir);
  const root = path.join(dir, '教材'); await mkdir(root);
  const state = path.join(dir, '学习状态'); await mkdir(state);
  const file = path.join(state, 'progress.db');
  const open = (library = root) => { const store = new SqliteProgressStore(file, library); stores.push(store); return store; };
  return { dir, root, state, file, open };
}
async function writeBook(root: string, data: BookPackage) {
  const dir = path.join(root, 'books', data.manifest.id); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'book.json'), JSON.stringify(data));
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(data.manifest));
}
const pause = () => new Promise(resolve => setTimeout(resolve, 120));
function mapped(data: BookPackage, index: number, pageNo: number) {
  data.blocks[index]!.editorial = { corrections: [], source: { eventId: 'test', reviewer: '测试', reason: '测试来源',
    spans: [{ start: 0, end: data.blocks[index]!.content.length, pageNo, image: 'test.png', imageSha256: 'a'.repeat(64) }] } };
}
test('真实 SQLite 跨连接保存块与滚动位置，数学/逻辑进度独立，最近教材可恢复', async () => {
  const f = await fixture(); const store = f.open();
  const math = progressAt(book(), 1, 7, 79, 18); store.save(math);
  const logic = progressAt(book('logic'), 2, 0, 79, 18); store.save(logic);
  store.close(); const reopened = f.open();
  expect(reopened.get('math')).toEqual(math); expect(reopened.get('logic')).toEqual(logic);
  expect(reopened.getLastRead()?.bookId).toBe('logic'); expect(reopened.get('missing')).toBeNull();
  expect(resolveProgress(book(), reopened.get('math')!, 79, 18)).toMatchObject({ index: 1, offset: 7, kind: 'exact' });
});
test('共享数据库中的不同教材目录，即使教材 ID 相同也不互相覆盖', async () => {
  const f = await fixture(); const first = f.open(); const other = f.open(path.join(f.dir, '另一教材目录'));
  first.save(progressAt(book(), 1, 3, 79, 18)); other.save(progressAt(book(), 2, 0, 79, 18));
  expect(first.getLastRead()?.blockId).toBe('math:legacy:1'); expect(other.getLastRead()?.blockId).toBe('math:legacy:2');
});
test('v1 SQLite 数据保留并迁移至 v2；首次新格式保存前归档旧位置', async () => {
  const f = await fixture(); const db = new Database(f.file);
  db.exec(PROGRESS_V1_SQL); db.pragma('user_version = 1');
  db.prepare('INSERT INTO reading_progress VALUES (?, ?, ?, ?, ?, ?, ?)').run(libraryKey(f.root), 'math', 'math:section', 'math:legacy:1', null, 5, '2026-11-11T00:00:00.000Z');
  db.prepare('INSERT INTO recent_reading VALUES (?, ?)').run(libraryKey(f.root), 'math'); db.close();
  const store = f.open(); expect(store.get('math')?.scrollOffset).toBe(5); expect(store.getLastRead()?.bookId).toBe('math');
  store.save(progressAt(book(), 1, 6, 79, 18));
  expect(store.history('math')[0]?.scrollOffset).toBe(5);
  const inspect = new Database(f.file); expect(inspect.pragma('user_version', { simple: true })).toBe(2); inspect.close();
});
test('迁移中途失败时事务回滚，不删除旧表、旧记录或版本号', async () => {
  const f = await fixture(); const db = new Database(f.file);
  db.exec(`${PROGRESS_V1_SQL} CREATE TABLE progress_recovery_history(dummy TEXT);`); db.pragma('user_version = 1');
  db.prepare('INSERT INTO reading_progress VALUES (?, ?, ?, ?, ?, ?, ?)').run(libraryKey(f.root), 'math', null, null, 27, 2, '2026-11-11T00:00:00.000Z'); db.close();
  expect(() => f.open()).toThrow();
  const inspect = new Database(f.file);
  expect(inspect.pragma('user_version', { simple: true })).toBe(1);
  expect(inspect.prepare('SELECT scroll_offset FROM reading_progress').get()).toEqual({ scroll_offset: 2 });
  expect(inspect.prepare('PRAGMA table_info(reading_progress)').all().some(row => (row as { name: string }).name === 'anchor_json')).toBe(false); inspect.close();
});
test('损坏库或高版本库明确拒绝，不自动重建/覆盖', async () => {
  const f = await fixture(); const bytes = Buffer.from('not a sqlite database'); await writeFile(f.file, bytes);
  expect(() => f.open()).toThrow(); expect(await readFile(f.file)).toEqual(bytes);
  const future = path.join(f.state, 'future.db'); const db = new Database(future); db.exec('CREATE TABLE keep(value TEXT)'); db.pragma('user_version = 99'); db.close();
  expect(() => new SqliteProgressStore(future, f.root)).toThrow('高于');
  const inspect = new Database(future); expect(inspect.pragma('user_version', { simple: true })).toBe(99); inspect.close();
});
test('数据库写锁导致失败时旧位置仍在，释放后可重试保存', async () => {
  const f = await fixture(); const store = f.open(); store.save(progressAt(book(), 1, 3, 79, 18));
  const locker = new Database(f.file); locker.exec('BEGIN IMMEDIATE');
  try { expect(() => store.save(progressAt(book(), 2, 0, 79, 18))).toThrow(); expect(store.get('math')?.scrollOffset).toBe(3); }
  finally { locker.exec('ROLLBACK'); locker.close(); }
  store.save(progressAt(book(), 2, 0, 79, 18)); expect(store.get('math')?.blockId).toBe('math:legacy:2');
});
test('重新分块、ID 被复用时通过可靠物理页兜底，旧位置保留到历史', async () => {
  const f = await fixture(); const old = book(); mapped(old, 1, 29); const store = f.open();
  const saved = progressAt(old, 1, 8, 79, 18); store.save(saved);
  const next = book(); next.manifest.contentVersion = 2;
  next.blocks[1]!.content = '另一页的无关新内容'; mapped(next, 1, 60);
  next.blocks[2]!.content = old.blocks[1]!.content; mapped(next, 2, 29);
  const target = resolveProgress(next, saved, 79, 18);
  expect(target).toMatchObject({ kind: 'page', index: 2, offset: 0 });
  store.save(progressAt(next, target.index, target.offset, 79, 18));
  expect(store.history('math')[0]).toEqual(saved);
});
test('缺页码时章节路径兜底；同名路径歧义或原 PDF 换书时回目录而不猜测', () => {
  const old = book(); const saved = progressAt(old, 1, 4, 79, 18);
  const next = book(); next.blocks[1]!.id = 'changed'; next.blocks[1]!.content = '变更后的原文';
  expect(resolveProgress(next, saved, 79, 18)).toMatchObject({ kind: 'section', index: 0 });
  next.sections.push({ ...next.sections[0]!, id: 'duplicate' });
  expect(resolveProgress(next, saved, 79, 18).kind).toBe('directory');
  saved.anchor!.pdfSha256 = 'a'.repeat(64);
  next.manifest.source = { format: 'scanned-pdf', pdfPath: 'test.pdf', sha256: 'b'.repeat(64), totalPages: 100 };
  expect(resolveProgress(next, saved, 79, 18).kind).toBe('directory');
});
test('窄宽终端之间根据字符锚点恢复，不沿用错误的折行数；极端偏移夹取', () => {
  const data = book(); data.blocks[1]!.content = `中文😀${Array.from({ length: 100 }, (_, i) => `[知识点${String(i).padStart(3, '0')}]循环小数 `).join('')}`;
  const saved = progressAt(data, 1, 7, 24, 6);
  const target = resolveProgress(data, saved, 60, 8);
  expect(target.offset).toBeLessThan(saved.scrollOffset);
  const before = viewport(readerText(data.blocks[1]!), 24, 6, 7).lines.join('');
  const after = viewport(readerText(data.blocks[1]!), 60, 8, target.offset).lines.join('');
  const marker = before.match(/\[知识点\d{3}\]/)?.[0];
  expect(marker).toBeDefined(); expect(after).toContain(marker);
  saved.scrollOffset = 999999; expect(resolveProgress(data, saved, 24, 6).offset).toBeLessThan(999999);
});
test('校订导致显示内容改变时从原块开头恢复，归档此前滚动位置', async () => {
  const f = await fixture(); const old = book(); const saved = progressAt(old, 1, 7, 79, 18); const store = f.open(); store.save(saved);
  const next = book(); next.blocks[1]!.editorial = { corrections: [], content: '校订后的正文' };
  const target = resolveProgress(next, saved, 79, 18); expect(target).toMatchObject({ kind: 'exact', index: 1, offset: 0 });
  store.save(progressAt(next, 1, 0, 79, 18)); expect(store.history('math')[0]?.scrollOffset).toBe(7);
});
test('滚动防抖但退出冲刷最新位置，换教材后没有旧计时器覆盖最近记录', () => {
  vi.useFakeTimers(); const saved: string[] = [];
  const save = vi.fn((p: { bookId: string; scrollOffset: number }) => { saved.push(`${p.bookId}:${p.scrollOffset}`); });
  const store: IProgressStore = { save, get: () => null, getLastRead: () => null };
  const session = new ProgressSession(store, () => {}); sessions.push(session);
  session.schedule(progressAt(book(), 1, 0, 79, 18));
  session.schedule(progressAt(book(), 1, 3, 79, 18));
  session.schedule(progressAt(book(), 1, 5, 79, 18)); expect(save).toHaveBeenCalledTimes(1);
  session.flush(); expect(saved.at(-1)).toBe('math:5');
  session.schedule(progressAt(book('logic'), 1, 2, 79, 18)); vi.advanceTimersByTime(1000);
  expect(saved.at(-1)).toBe('logic:2');
});
test('写入失败期间切换教材，重试时仍保存两本的待落盘位置', () => {
  vi.useFakeTimers(); let locked = false; const saved: string[] = [];
  const store: IProgressStore = { save: p => { if (locked) throw new Error('locked'); saved.push(`${p.bookId}:${p.scrollOffset}`); }, get: () => null, getLastRead: () => null };
  const session = new ProgressSession(store, () => {}); sessions.push(session);
  session.schedule(progressAt(book(), 1, 0, 79, 18)); locked = true;
  session.schedule(progressAt(book(), 1, 7, 79, 18)); session.schedule(progressAt(book('logic'), 1, 3, 79, 18));
  locked = false; expect(session.flush()).toBe(true);
  expect(saved).toEqual(['math:0', 'math:7', 'logic:3']);
});
test('阅读滚动自动保存，来源/原文滚动不污染位置，退出再启动恢复', async () => {
  const f = await fixture(); const data = book(); await writeBook(f.root, data); const store = f.open();
  const session = new ProgressSession(store, () => {}); sessions.push(session);
  const app = render(<App root={f.root} books={[data.manifest]} initialBook={data} initialIndex={1} progress={session} />); apps.push(app);
  await pause(); app.stdin.write('\u001b[B'); await pause(); app.stdin.write('\u001b[B');
  await expect.poll(() => store.get('math')?.scrollOffset, { timeout: 2000 }).toBe(2);
  app.stdin.write('p'); await pause(); app.stdin.write('\u001b[B'); await pause(); expect(store.get('math')?.scrollOffset).toBe(2);
  app.stdin.write('\u001b'); await pause(); expect(app.lastFrame()).toContain('正文行 3');
  app.stdin.write('r'); await pause(); app.stdin.write('\u001b[6~'); await pause();
  expect(store.get('math')?.scrollOffset).toBe(2); app.stdin.write('\u001b'); await pause();
  app.stdin.write('\u001b[B'); await pause(); app.stdin.write('q'); await pause(); expect(store.get('math')?.scrollOffset).toBe(3);
  const saved = store.getLastRead()!; const target = resolveProgress(data, saved, 99, 18);
  const reopened = render(<App root={f.root} books={[data.manifest]} initialBook={data} initialIndex={target.index} initialOffset={target.offset} progress={session} />); apps.push(reopened);
  await pause(); expect(reopened.lastFrame()).toContain('正文行 4');
});
test('主页 L 恢复最近位置；切换教材各自保存，返回主页不会覆盖原滚动', async () => {
  const f = await fixture(); const math = book(); const logic = book('logic'); await writeBook(f.root, math); await writeBook(f.root, logic);
  const store = f.open(); store.save(progressAt(math, 1, 5, 99, 18));
  const session = new ProgressSession(store, () => {}); sessions.push(session);
  const app = render(<App root={f.root} books={[math.manifest, logic.manifest]} progress={session} />); apps.push(app);
  await pause(); app.stdin.write('l'); await expect.poll(() => app.lastFrame(), { timeout: 3000 }).toContain('正文行 6');
  for (const key of ['\u001b', '\u001b', '\u001b[B', '\r']) { app.stdin.write(key); await pause(); }
  await expect.poll(() => app.lastFrame(), { timeout: 3000 }).toContain('Enter 阅读');
  app.stdin.write('\r'); await expect.poll(() => store.get('logic')?.blockId).toBe('logic:legacy:0');
  expect(store.get('math')?.scrollOffset).toBe(5); expect(store.getLastRead()?.bookId).toBe('logic');
});
test('保存失败时界面继续翻读、明确提示，T 重试成功后清除告警', async () => {
  let fails = true;
  const save = vi.fn(() => { if (fails) throw new Error('database is locked'); });
  const session = new ProgressSession({ save, get: () => null, getLastRead: () => null }, () => {}); sessions.push(session);
  const data = book(); const app = render(<App root="data" books={[data.manifest]} initialBook={data} progress={session} />); apps.push(app);
  await pause(); expect(app.lastFrame()).toContain('进度保存失败');
  app.stdin.write('n'); await pause(); expect(app.lastFrame()).toContain(data.blocks[1]!.id);
  fails = false; app.stdin.write('t'); await expect.poll(() => app.lastFrame()).not.toContain('进度保存失败');
});
test('无法可靠恢复时停在目录，不把旧进度覆盖成第一块', async () => {
  const f = await fixture(); const old = book(); const saved = progressAt(old, 1, 7, 99, 18); const store = f.open(); store.save(saved);
  const next = book(); next.blocks[1]!.id = 'changed'; next.blocks[1]!.content = '不同内容'; next.sections[0]!.title = '不同章节';
  const target = resolveProgress(next, saved, 99, 18); expect(target.screen).toBe('chapters');
  const session = new ProgressSession(store, () => {}); sessions.push(session);
  const app = render(<App root={f.root} books={[next.manifest]} initialBook={next} initialIndex={target.index}
    initialScreen={target.screen} initialNotice={target.notice} progress={session} />); apps.push(app);
  await pause(); expect(store.get('math')).toEqual(saved); expect(app.lastFrame()).toContain('旧进度保留');
  app.stdin.write('q'); await pause(); expect(store.get('math')).toEqual(saved);
});
test('CLI resume 恢复滚动预览但不修改进度，丢失教材报错且保留旧记录', async () => {
  const f = await fixture(); const data = book(); await writeBook(f.root, data); const store = f.open();
  const saved = progressAt(data, 1, 4, 79, 18); store.save(saved);
  const args = ['--import', 'tsx', 'src/cli/index.tsx', '--data-dir', f.root, '--state-dir', f.state];
  const output = execFileSync(process.execPath, [...args, 'resume', 'math'], { encoding: 'utf8', timeout: 12000 });
  expect(output).toContain('已恢复上次阅读位置'); expect(output).toContain('段落04'); expect(output).not.toContain('段落00');
  expect(store.get('math')).toEqual(saved);
  await rm(path.join(f.root, 'books/math'), { recursive: true, force: true });
  expect(() => execFileSync(process.execPath, [...args, 'resume'], { stdio: 'pipe', timeout: 12000 })).toThrow();
  expect(store.get('math')).toEqual(saved);
}, 30000);
