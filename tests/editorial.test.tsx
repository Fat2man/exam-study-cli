import React from 'react';
import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { render } from 'ink-testing-library';
import { importBook } from '../src/preprocess/importer.js';
import { acceptCorrection, proposeCorrection, readEditorialEvents, registerSourceMap, revokeEditorial, textHash } from '../src/app/editorial.js';
import { describeSource, flattenSections, loadBook, searchBook } from '../src/app/library.js';
import { readingContent, sourcePageNumbers } from '../src/domain/editorial.js';
import { readerText } from '../src/app/viewport.js';
import { App } from '../src/app/App.js';

const dirs: string[] = [];
const apps: ReturnType<typeof render>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) { app.unmount(); app.cleanup(); }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  await mkdir('data/test-temp', { recursive: true });
  const dir = await mkdtemp(path.resolve('data/test-temp/editorial-')); dirs.push(dir);
  const pdf = await PDFDocument.create(); for (let i = 0; i < 3; i++) pdf.addPage();
  await writeFile(path.join(dir, '数学.pdf'), await pdf.save());
  const markdown = path.join(dir, 'ocr.md');
  await writeFile(markdown, '## 2.2 带宗喙法\n\n原文甲 $10b > 30$，原文乙【答案】B');
  const root = path.join(dir, 'store');
  const book = await importBook({ root, id: 'math', legacy: markdown, pdf: path.join(dir, '数学.pdf') });
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(dir, 'page.png'), image);
  await writeFile(path.join(dir, 'pages.json'), JSON.stringify({ schemaVersion: 1, pdfPath: path.join(dir, '数学.pdf'),
    pdfSha256: book.manifest.source!.sha256, totalPages: 3,
    pages: [2, 3].map(pageNo => ({ pageNo, image: 'page.png', sha256: textHash(image) })) }));
  const mapping = { schemaVersion: 1, bookId: 'math', pdfSha256: book.manifest.source!.sha256, pageEvidence: 'pages.json', reviewer: '测试核对者', reason: '逐页对照后登记，未核验数学内容',
    mappings: [{ fromBlock: book.blocks[0]!.id, toBlock: book.blocks[1]!.id, pageNo: 2, printedPage: 1 }] };
  const request = path.join(dir, 'mapping.json'); await writeFile(request, JSON.stringify(mapping));
  return { dir, root, book, mapping, request, markdown, bookFile: path.join(root, 'books/math/book.json') };
}
async function corrected() {
  const f = await fixture(); const mappingId = await registerSourceMap(f.root, 'math', f.request);
  const proposalId = await proposeCorrection(f.root, 'math', { blockId: f.book.blocks[0]!.id, before: '带宗喙法', after: '带余除法', reason: '标题错字候选' });
  const acceptanceId = await acceptCorrection(f.root, 'math', proposalId, '测试核对者', '对照物理页 2 的标题与定义，仅确认文字');
  return { ...f, mappingId, proposalId, acceptanceId };
}
test('校订有候选/确认两步，目录/搜索/正文统一使用校订，原始数据和核验状态不变', async () => {
  const f = await fixture(); const original = await readFile(f.bookFile);
  const proposal = await proposeCorrection(f.root, 'math', { blockId: f.book.blocks[0]!.id, before: '带宗喙法', after: '带余除法', reason: '文字候选' });
  expect(readingContent((await loadBook(f.root, 'math')).blocks[0]!)).toContain('带宗喙法');
  await expect(acceptCorrection(f.root, 'math', proposal, '核对者', '已查阅')).rejects.toThrow('逐页来源');
  await registerSourceMap(f.root, 'math', f.request);
  await acceptCorrection(f.root, 'math', proposal, '核对者', '逐字对照物理页 2 定义');
  const book = await loadBook(f.root, 'math'); const block = book.blocks[0]!;
  expect(block.content).toContain('带宗喙法'); expect(readingContent(block)).toContain('带余除法');
  expect(flattenSections(book.sections)[0]?.title).toContain('带余除法');
  expect(searchBook(book, '带余除法')).toHaveLength(1); expect(searchBook(book, '带宗喙法')).toHaveLength(0);
  expect(block.verification).toBe('unverified'); expect(book.pages).toEqual([]); expect(book.manifest.mode).toBe('legacy-preview');
  expect(readerText(block)).not.toContain('来源未映射');
  expect(await readFile(f.bookFile)).toEqual(original);
  expect(await readFile(f.markdown, 'utf8')).toContain('带宗喙法');
  expect((await readEditorialEvents(f.root, 'math')).events.map(e => e.type)).toEqual(expect.arrayContaining(['proposal', 'mapping', 'acceptance']));
});
test('跨页块按 UTF-16 区间分别标注物理页/印刷页，不能只填一个猜测页', async () => {
  const f = await fixture(); const block = f.book.blocks[1]!; const split = block.content.indexOf('，');
  const entries = [
    { fromBlock: block.id, pageNo: 2, printedPage: 1, start: 0, end: split },
    { fromBlock: block.id, pageNo: 3, printedPage: 2, start: split, end: block.content.length }
  ];
  await writeFile(f.request, JSON.stringify({ ...f.mapping, mappings: entries }));
  await registerSourceMap(f.root, 'math', f.request);
  const book = await loadBook(f.root, 'math');
  expect(sourcePageNumbers(book.blocks[1]!)).toEqual([2, 3]);
  expect(describeSource(book, book.blocks[1]!)).toContain('跨页块');
  expect(describeSource(book, book.blocks[1]!)).toContain('印刷页 2');
  expect(sourcePageNumbers(book.blocks[0]!)).toEqual([]);
  const app = render(<App root={f.root} books={[book.manifest]} initialBook={book} initialIndex={1} />); apps.push(app);
  await new Promise(resolve => setTimeout(resolve, 100));
  app.stdin.write('p'); await expect.poll(() => app.lastFrame()).toContain('原页图选择：2');
  app.stdin.write('2'); await expect.poll(() => app.lastFrame()).toContain('原页图选择：3');
  expect(app.lastFrame()).toContain('印刷页 2');
});
test.each(['gap', 'overlap', 'out-of-range'])('拒绝不完整、重叠或越界来源 %s', async kind => {
  const f = await fixture(); const block = f.book.blocks[0]!;
  const mappings = kind === 'out-of-range' ? [{ fromBlock: block.id, pageNo: 4 }]
    : [{ fromBlock: block.id, pageNo: 2, start: kind === 'gap' ? 1 : 0, end: block.content.length },
      ...(kind === 'overlap' ? [{ fromBlock: block.id, pageNo: 2, start: 0, end: 1 }] : [])];
  await writeFile(f.request, JSON.stringify({ ...f.mapping, mappings }));
  await expect(registerSourceMap(f.root, 'math', f.request)).rejects.toThrow();
  expect((await readEditorialEvents(f.root, 'math')).events).toHaveLength(0);
});
test('撤销确认恢复原文并保留审计历史；撤销映射使关联校订停止应用', async () => {
  const f = await corrected();
  await revokeEditorial(f.root, 'math', f.acceptanceId, '核对者', '撤回校订');
  expect(readingContent((await loadBook(f.root, 'math')).blocks[0]!)).toContain('带宗喙法');
  await acceptCorrection(f.root, 'math', f.proposalId, '核对者', '再次对照确认');
  await revokeEditorial(f.root, 'math', f.mappingId, '核对者', '撤回来源');
  const book = await loadBook(f.root, 'math');
  expect(readingContent(book.blocks[0]!)).toContain('带宗喙法'); expect(sourcePageNumbers(book.blocks[0]!)).toEqual([]);
  expect(book.editorialWarnings?.join(' ')).toContain('来源失效');
  expect((await readEditorialEvents(f.root, 'math')).events).toHaveLength(6);
});
test.each(['book', 'raw', 'pdf', 'image'])('原教材/快照/图像任一指纹改变时不误套校订：%s', async target => {
  const f = await corrected();
  const bookDir = path.join(f.root, 'books/math');
  if (target === 'book') await writeFile(f.bookFile, `${await readFile(f.bookFile, 'utf8')}\n`);
  if (target === 'raw') await writeFile(path.join(bookDir, 'raw/legacy.md'), '改变的快照');
  if (target === 'pdf') await writeFile(path.join(f.dir, '数学.pdf'), 'changed');
  if (target === 'image') {
    const asset = (await readdir(path.join(bookDir, 'editorial/assets')))[0]!;
    await writeFile(path.join(bookDir, 'editorial/assets', asset), 'changed');
  }
  const book = await loadBook(f.root, 'math');
  expect(readingContent(book.blocks[0]!)).toContain('带宗喙法');
  expect(sourcePageNumbers(book.blocks[0]!)).toEqual([]);
  expect(book.editorialWarnings!.length).toBeGreaterThan(0);
});
test('校订重叠/重复确认拒绝，错误原文拒绝，数学内容不会因局部校订升级', async () => {
  const f = await corrected();
  await expect(acceptCorrection(f.root, 'math', f.proposalId, '核对者', '重复')).rejects.toThrow('重叠');
  await expect(proposeCorrection(f.root, 'math', { blockId: f.book.blocks[0]!.id, before: '不存在', after: '新词', reason: '错位' })).rejects.toThrow('区间不匹配');
  const block = f.book.blocks[1]!;
  const proposal = await proposeCorrection(f.root, 'math', { blockId: block.id, before: '原文甲', after: '甲', reason: '只改一处文字' });
  await acceptCorrection(f.root, 'math', proposal, '核对者', '对照原图局部确认');
  const read = (await loadBook(f.root, 'math')).blocks[1]!;
  expect(read.verification).toBe('unverified'); expect(readingContent(read)).toContain('$10b > 30$');
  expect(readingContent(read)).toContain('【答案】B');
});
test('TUI 展示校订标题，R 可看原文与确认记录，Esc 回到校订阅读版本', async () => {
  const f = await corrected(); const book = await loadBook(f.root, 'math');
  const app = render(<App root={f.root} books={[book.manifest]} initialBook={book} />); apps.push(app);
  await expect.poll(() => app.lastFrame()).toContain('带余除法');
  await new Promise(resolve => setTimeout(resolve, 100));
  app.stdin.write('r'); await expect.poll(() => app.lastFrame()).toContain('带宗喙法');
  expect(app.lastFrame()).toContain('测试核对者');
  app.stdin.write('\u001b'); await expect.poll(() => app.lastFrame()).toContain('带余除法');
  expect(app.lastFrame()).toContain('unverified');
});
test('在首次来源登记之前篡改 OCR 快照也不能重新背书', async () => {
  const f = await fixture();
  await writeFile(path.join(f.root, 'books/math/raw/legacy.md'), '提前改变的快照');
  await expect(registerSourceMap(f.root, 'math', f.request)).rejects.toThrow('导入指纹不符');
});
test('多处非重叠校订始终使用原始偏移，拒绝重复来源登记', async () => {
  const f = await fixture(); await registerSourceMap(f.root, 'math', f.request);
  await expect(registerSourceMap(f.root, 'math', f.request)).rejects.toThrow('已有有效来源');
  const block = f.book.blocks[1]!;
  for (const [before, after] of [['原文甲', '较长的新文字甲'], ['原文乙', '乙']]) {
    const id = await proposeCorrection(f.root, 'math', { blockId: block.id, before: before!, after: after!, reason: '两处独立校订' });
    await acceptCorrection(f.root, 'math', id, '核对者', '对照页面局部');
  }
  const read = (await loadBook(f.root, 'math')).blocks[1]!;
  expect(readingContent(read)).toBe('较长的新文字甲 $10b > 30$，乙【答案】B');
  expect(read.content).toBe(block.content);
});
