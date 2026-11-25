import React from 'react';
import { afterEach, expect, test } from 'vitest';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { App } from '../src/app/App.js';
import { describeSource, flattenSections, loadBook, searchBook, sectionIndex } from '../src/app/library.js';
import { displayLines, readerText, safeText, viewport } from '../src/app/viewport.js';
import { parseMarkdown } from '../src/infrastructure/markdown.js';
import { bookManifestSchema, type BookPackage } from '../src/domain/schema.js';
import { buildSections } from '../src/preprocess/importer.js';

const rendered: ReturnType<typeof render>[] = [];
afterEach(() => { for (const app of rendered.splice(0)) { app.unmount(); app.cleanup(); } });
const tick = () => new Promise(resolve => setTimeout(resolve, 100));
async function starterSample(): Promise<BookPackage> {
  const markdownPath = 'examples/starter.md';
  const parsed = await parseMarkdown(await readFile(markdownPath, 'utf8'), { mapping: 'unmapped', bookId: 'math', pageNo: null, rawFile: markdownPath }, markdownPath, 'data/test-assets');
  const now = new Date().toISOString();
  return { manifest: bookManifestSchema.parse({ schemaVersion: 1, id: 'math', title: '原创数学演示', subject: 'math', mode: 'legacy-preview', source: null,
    contentVersion: 1, createdAt: now, updatedAt: now }), pages: [], blocks: parsed.blocks,
    sections: buildSections(parsed.blocks, 'math'), diagnostics: [] };
}
test('原创演示保留小数、字母、模拟 OCR 字符、根号空格及答案标签', async () => {
  const book = await starterSample(); const text = book.blocks.map(b => b.content).join('\n');
  expect(text).toContain('0.37'); expect(text).toContain('10b');
  expect(text).toContain('0.\\dot{54}'); expect(text).toContain('3 2 4'); expect(text).toContain('【答案】');
  expect(text).not.toContain('data:image');
  expect(book.blocks.every(b => b.verification === 'unverified')).toBe(true);
  expect(describeSource(book, book.blocks[0]!)).toContain('来源未映射');
  expect(searchBook(book, '循环小数').length).toBeGreaterThan(0);
  expect(sectionIndex(book, '1.3')).toBeGreaterThan(0);
});
test('中文、emoji、长 LaTeX 窄屏换行不丢内容，滚动可达末行', () => {
  const text = `数学😀 ${'\\sqrt{3 2 4} + '.repeat(25)}\n末行`;
  const lines = displayLines(text, 20);
  expect(lines.every(l => stringWidth(l) <= 20)).toBe(true);
  expect(lines.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  const view = viewport(text, 20, 4, 9999);
  expect(view.lines.at(-1)).toBe('末行'); expect(view.offset).toBe(view.maxOffset);
  expect(viewport(text, 60, 20, view.offset).offset).toBeLessThanOrEqual(view.offset);
});
test('终端控制序列、清屏、链接和双向控制不能执行', () => {
  expect(safeText('\u001b[2J数学\u001b]8;;https://evil.test\u0007内容\u202e')).toBe('数学内容');
});
test('TUI 逐块阅读、查看来源、滚动、目录和返回主页', async () => {
  const book = await starterSample();
  const app = render(<App root="data" books={[book.manifest]} initialBook={book} />); rendered.push(app);
  await tick(); expect(app.lastFrame()).toContain('来源未映射');
  const first = book.blocks[0]!.id; expect(app.lastFrame()).toContain(first);
  app.stdin.write('n'); await tick(); expect(app.lastFrame()).toContain(book.blocks[1]!.id);
  app.stdin.write('b'); await tick(); expect(app.lastFrame()).toContain(first);
  app.stdin.write('p'); await tick(); expect(app.lastFrame()).toContain('无法定位 PDF 物理页');
  app.stdin.write('\u001b'); await tick(); expect(app.lastFrame()).toContain(first);
  app.stdin.write('c'); await tick(); expect(app.lastFrame()).toContain('数学阅读演示');
  app.stdin.write('\u001b'); await tick(); expect(app.lastFrame()).toContain('Legacy Preview');
  app.stdin.write('\u001b'); await tick(); expect(app.lastFrame()).toContain('Enter 选择教材');
});
test('找不到教材时返回明确错误而非空白界面', async () => {
  await expect(loadBook('data/no-such-root', 'math')).rejects.toThrow('无法读取教材');
  const app = render(<App root="data" books={[]} initialError="找不到教材" />); rendered.push(app);
  expect(app.lastFrame()).toContain('找不到教材');
});
test('同名章节别名必须消歧，不能静默选择第一个', async () => {
  const book = await starterSample();
  const s = book.sections[0]!;
  book.sections.push({ ...s, id: 'different', title: '1.3 重名知识点' });
  expect(() => sectionIndex(book, '1.3')).toThrow('不唯一');
});
test('搜索、选择结果和跳转能读取完整块；长内容可滚动到末尾', async () => {
  const book = await starterSample();
  await mkdir('data/test-temp', { recursive: true });
  const root = await mkdtemp(path.resolve('data/test-temp/reader-'));
  try {
    const dir = path.join(root, 'books/math'); await mkdir(dir, { recursive: true });
    const long = book.blocks.find(b => b.content.includes('10b'))!;
    long.content += `\n${'滚动验证\n'.repeat(40)}唯一末行`;
    await writeFile(path.join(dir, 'book.json'), JSON.stringify(book));
    const app = render(<App root={root} books={[book.manifest]} />); rendered.push(app);
    await tick(); app.stdin.write('s'); await tick(); app.stdin.write('10b'); await tick();
    app.stdin.write('\r');
    await expect.poll(() => app.lastFrame(), { timeout: 3000 }).toContain('Enter 跳转');
    expect(app.lastFrame()).toContain('10b');
    app.stdin.write('\r');
    await expect.poll(() => app.lastFrame(), { timeout: 3000 }).toContain(long.id);
    for (let i = 0; i < 10 && !app.lastFrame()?.includes('唯一末行'); i++) { app.stdin.write('\u001b[6~'); await tick(); }
    expect(app.lastFrame()).toContain('唯一末行');
    app.stdin.write('\u001b'); await tick(); expect(app.lastFrame()).toContain('Enter 跳转');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('rejected 内容明确提示回源，不能作为已核验内容展示', async () => {
  const book = await starterSample(); const block = book.blocks[0]!; block.verification = 'rejected';
  expect(readerText(block)).toContain('不可靠');
  const app = render(<App root="data" books={[book.manifest]} initialBook={book} />); rendered.push(app);
  expect(app.lastFrame()).toContain('rejected'); expect(app.lastFrame()).toContain('优先核对');
});
test('终端动态缩窄及高度不足时保持边界，扩大后继续阅读', async () => {
  const book = await starterSample();
  const app = render(<App root="data" books={[book.manifest]} initialBook={book} />); rendered.push(app);
  await tick();
  Object.defineProperty(app.stdout, 'columns', { configurable: true, value: 24 });
  Object.defineProperty(app.stdout, 'rows', { configurable: true, value: 10 });
  app.stdout.emit('resize'); await tick();
  expect(app.lastFrame()!.split('\n').every(l => stringWidth(l) <= 23)).toBe(true);
  expect(app.lastFrame()!.split('\n').length).toBeLessThanOrEqual(10);
  Object.defineProperty(app.stdout, 'rows', { configurable: true, value: 4 });
  app.stdout.emit('resize'); await tick(); expect(app.lastFrame()).toContain('终端太小');
  Object.defineProperty(app.stdout, 'columns', { configurable: true, value: 100 });
  Object.defineProperty(app.stdout, 'rows', { configurable: true, value: 24 });
  app.stdout.emit('resize'); await tick(); expect(app.lastFrame()).toContain(book.blocks[0]!.id);
});
test('可靠映射来源显示物理页、印刷页和依据，状态仍未核验', async () => {
  const book = await starterSample();
  book.blocks[0]!.source = { mapping: 'mapped', bookId: 'math', pageNo: 29, printedPage: 17, evidence: '逐页 OCR 导出记录' };
  const app = render(<App root="data" books={[book.manifest]} initialBook={book} />); rendered.push(app);
  await tick(); app.stdin.write('p'); await tick();
  expect(app.lastFrame()).toContain('PDF 物理页 29');
  expect(app.lastFrame()).toContain('印刷页 17');
  expect(app.lastFrame()).toContain('逐页 OCR 导出记录');
  expect(app.lastFrame()).toContain('unverified');
});
test('从目录 Enter 进入 2.1 标题后，方向键及翻页键能跨短块继续阅读和返回', async () => {
  const book = await starterSample();
  await mkdir('data/test-temp', { recursive: true });
  const root = await mkdtemp(path.resolve('data/test-temp/chapter-scroll-'));
  try {
    const dir = path.join(root, 'books/math'); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'book.json'), JSON.stringify(book));
    const app = render(<App root={root} books={[book.manifest]} />); rendered.push(app);
    const press = async (key: string) => { app.stdin.write(key); await tick(); };
    await tick(); await press('\r'); await press('\r');
    await expect.poll(() => app.lastFrame(), { timeout: 3000 }).toContain('↑↓ 章节');
    const chapter = flattenSections(book.sections).findIndex(s => s.title.startsWith('2.1 '));
    expect(chapter).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < chapter; i++) await press('\u001b[B');
    await press('\r');
    const start = sectionIndex(book, '2.1');
    expect(app.lastFrame()).toContain(book.blocks[start]!.id);
    await press('\u001b[B');
    expect(app.lastFrame()).toContain(book.blocks[start + 1]!.id);
    expect(app.lastFrame()).toContain('若整数');
    await press('\u001b[6~');
    expect(app.lastFrame()).toContain(book.blocks[start + 2]!.id);
    await press('\u001b[A');
    expect(app.lastFrame()).toContain(book.blocks[start + 1]!.id);
    await press('\u001b[5~');
    expect(app.lastFrame()).toContain(book.blocks[start]!.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('长块先滚动，到底再跨块；返回长块末屏，书首书尾不越界', async () => {
  const book = await starterSample();
  book.blocks = book.blocks.slice(0, 2);
  book.blocks[0]!.content = `${'长段落内容\n'.repeat(40)}前块末行`;
  book.blocks[1]!.content = '下一块正文';
  const app = render(<App root="data" books={[book.manifest]} initialBook={book} />); rendered.push(app);
  const press = async (key: string) => { app.stdin.write(key); await tick(); };
  await tick(); await press('\u001b[A');
  expect(app.lastFrame()).toContain(book.blocks[0]!.id);
  await press('\u001b[B');
  expect(app.lastFrame()).toContain(book.blocks[0]!.id);
  expect(app.lastFrame()).toContain('正文行 2');
  await press('\u001b[6~'); await press('\u001b[6~');
  expect(app.lastFrame()).toContain('前块末行');
  expect(app.lastFrame()).toContain(book.blocks[0]!.id);
  await press('\u001b[B');
  expect(app.lastFrame()).toContain(book.blocks[1]!.id);
  await press('\u001b[6~');
  expect(app.lastFrame()).toContain(book.blocks[1]!.id);
  await press('\u001b[5~');
  expect(app.lastFrame()).toContain(book.blocks[0]!.id);
  expect(app.lastFrame()).toContain('前块末行');
});
