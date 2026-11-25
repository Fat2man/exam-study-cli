import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { buildSections, importBook } from '../src/preprocess/importer.js';
import { packageSchema } from '../src/domain/schema.js';
import { classifyHeading } from '../src/domain/headings.js';
import { extractImage, parseMarkdown } from '../src/infrastructure/markdown.js';

const temps: string[] = [];
async function setup() {
  await mkdir('data/test-temp', { recursive: true });
  const dir = await mkdtemp(path.resolve('data/test-temp/exam-study-')); temps.push(dir);
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 4; i++) pdf.addPage();
  await writeFile(path.join(dir, '数学.pdf'), await pdf.save());
  const text = '## 第1节 实数\r\n\r\n## 大纲考点1 定义\r\n\r\n## 1.2 循环小数\r\n\r\n$0.\\dot{54}$；$10b > 30$；$\\sqrt{3 2 4}$\r\n\r\n例58 (1) a > 0 (2) b > 0【答案】A\r\n';
  await writeFile(path.join(dir, 'p1.md'), text);
  await writeFile(path.join(dir, 'p3.md'), '跨页续文，不假设选择项存在。\n\n$$\n\\frac{1}{2}\n$$');
  const mapping = { schemaVersion: 1, bookId: 'math', title: '测试教材', subject: 'math', tier: 'standard', pdf: '数学.pdf',
    pages: [{ pageNo: 1, markdown: 'p1.md', evidence: '逐页导出任务记录 page=1' }, { pageNo: 3, markdown: 'p3.md', evidence: '逐页导出任务记录 page=3' }] };
  await writeFile(path.join(dir, 'mapping.json'), JSON.stringify(mapping));
  return { dir, text, mapping, root: path.join(dir, 'output'), map: path.join(dir, 'mapping.json') };
}
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });

test('真实读取 PDF 元数据，非连续页独立映射，保留公式与原始 OCR，答案不提升核验状态', async () => {
  const f = await setup(); const data = await importBook(f);
  expect(data.manifest.source?.totalPages).toBe(4);
  expect(data.manifest.source?.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(data.pages.map(p => p.pageNo)).toEqual([1, 3]);
  expect(data.blocks.at(-1)?.source.pageNo).toBe(3);
  expect(data.blocks.every(b => b.verification === 'unverified')).toBe(true);
  expect(data.pages.every(p => p.status === 'needs_review')).toBe(true);
  expect(data.blocks.find(b => b.content.includes('dot'))?.content).toContain('\\sqrt{3 2 4}');
  expect(await readFile(path.join(f.root, 'books/math/raw/page-000001.md'), 'utf8')).toBe(f.text);
  expect(await readFile(path.join(f.dir, 'p1.md'), 'utf8')).toBe(f.text);
  expect(data.sections[0]?.children[0]?.children[0]?.title).toBe('1.2 循环小数');
  await expect(importBook(f)).rejects.toThrow('已存在');
});
test('无映射旧 Markdown 只能预览，不伪造页码或 PageRecord', async () => {
  const f = await setup(); const data = await importBook({ root: f.root, id: 'preview', legacy: path.join(f.dir, 'p1.md'), pdf: path.join(f.dir, '数学.pdf') });
  expect(data.manifest.mode).toBe('legacy-preview'); expect(data.pages).toEqual([]);
  expect(data.blocks.every(b => b.source.pageNo === null)).toBe(true);
  data.blocks[0]!.source = { mapping: 'mapped', bookId: 'preview', pageNo: 1, evidence: '猜测' };
  expect(packageSchema.safeParse(data).success).toBe(false);
});
test.each([0, 5, 1.5])('拒绝不在实际 PDF 范围内的物理页码 %s', async pageNo => {
  const f = await setup(); f.mapping.pages[0]!.pageNo = pageNo;
  await writeFile(f.map, JSON.stringify(f.mapping)); await expect(importBook(f)).rejects.toThrow();
});
test('重复页码和导入失败都不发布半成品', async () => {
  const f = await setup(); f.mapping.pages[1]!.markdown = 'missing.md';
  await writeFile(f.map, JSON.stringify(f.mapping)); await expect(importBook(f)).rejects.toThrow();
  expect(await readdir(path.join(f.root, 'books'))).toEqual([]);
  f.mapping.pages[1]!.pageNo = 1;
  await writeFile(f.map, JSON.stringify(f.mapping)); await expect(importBook(f)).rejects.toThrow('重复');
});
test('章节不采用 OCR 的统一 ## 深度', () => {
  expect(classifyHeading('母题模型1 整除问题').kind).toBe('model');
  expect(classifyHeading('大纲考点精讲').level).toBeLessThan(classifyHeading('1.2 有理数').level);
  expect(classifyHeading('带宗喙法').kind).toBe('unknown');
});
test('第二讲实际 OCR 的圈号节标题和间隔讲号可导航，原文不被改写', () => {
  const heading = '## 第①节 整式';
  const block = { id: 'math:99:001', type: 'heading' as const, content: heading, source: { mapping: 'mapped' as const, bookId: 'math', pageNo: 99, evidence: '逐页 OCR' },
    order: 0, verification: 'unverified' as const, warnings: [], original: { rawFile: 'raw/page-99.md', start: 0, end: heading.length }, contentVersion: 1 };
  const sections = buildSections([{ ...block, id: 'math:97:001', content: '## 第 2 讲 整式与分式' }, block], 'math');
  expect(classifyHeading('第 2 讲 整式与分式')).toEqual({ kind: 'lecture', level: 1 });
  expect(sections).toHaveLength(1);
  expect(sections[0]?.children[0]).toMatchObject({ title: '第①节 整式', kind: 'section', level: 2 });
  expect(block.content).toBe(heading);
});
test('图片校验、去重、限制与路径穿越防护', async () => {
  const f = await setup();
  const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=';
  const a = await extractImage(url, path.join(f.dir, 'p1.md'), f.root);
  expect(await extractImage(url, path.join(f.dir, 'p1.md'), f.root)).toBe(a);
  expect(await readdir(path.join(f.root, 'assets'))).toHaveLength(1);
  await expect(extractImage('data:image/png;base64,!!!!', f.map, f.root)).rejects.toThrow('Base64');
  await expect(extractImage(url.replace('image/png', 'image/jpeg'), f.map, f.root)).rejects.toThrow('MIME');
  await expect(extractImage('https://example.com/x.png', f.map, f.root)).rejects.toThrow('远程');
  await expect(extractImage('../outside.png', f.map, f.root)).rejects.toThrow();
  await expect(extractImage(`data:image/png;base64,${'AAAA'.repeat(4 * 1024 * 1024)}`, f.map, f.root)).rejects.toThrow('10 MiB');
});
test('引用式 Base64 图片也要提取；非法图片仅警告且不泄漏 Base64', async () => {
  const f = await setup();
  const raw = '![图][diagram]\n\n[diagram]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=\n\n![坏图](data:image/jpeg;base64,AAAA)';
  const parsed = await parseMarkdown(raw, { mapping: 'unmapped', bookId: 'math', pageNo: null, rawFile: f.map }, f.map, f.root);
  expect(parsed.blocks[0]?.type).toBe('image');
  expect(parsed.blocks[0]?.content).toMatch(/assets\/[a-f0-9]{64}\.png/);
  expect(parsed.clean).not.toContain('base64');
  expect(parsed.blocks[1]?.warnings.join(' ')).toContain('图片未导入');
});
