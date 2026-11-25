import { access, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { bookManifestSchema, packageSchema, type BookManifest, type BookPackage, type ContentBlock, type SectionNode } from '../domain/schema.js';
import { inside, sha256 } from '../infrastructure/files.js';
import { spawn } from 'node:child_process';
import { applyEditorial } from './editorial.js';
import { readingContent, sourceLabel, sourcePageNumbers } from '../domain/editorial.js';

export function bookDirectory(root: string, id: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('教材 ID 无效');
  return path.resolve(root, 'books', id);
}
export async function listBooks(root: string): Promise<{ books: BookManifest[]; errors: string[] }> {
  const books: BookManifest[] = []; const errors: string[] = [];
  let entries;
  try { entries = await readdir(path.join(root, 'books'), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { books, errors }; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      const manifest = bookManifestSchema.parse(JSON.parse(await readFile(path.join(bookDirectory(root, entry.name), 'manifest.json'), 'utf8')));
      if (manifest.id !== entry.name) throw new Error('目录和教材 ID 不一致');
      books.push(manifest);
    } catch { errors.push(`教材 ${entry.name} 损坏或未完成导入`); }
  }
  return { books: books.sort((a, b) => a.id.localeCompare(b.id)), errors };
}
export async function loadBook(root: string, id: string): Promise<BookPackage> {
  const file = path.join(bookDirectory(root, id), 'book.json');
  let data: BookPackage;
  try { data = packageSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) { throw new Error(`无法读取教材 ${id}：${error instanceof Error ? error.message : String(error)}`); }
  if (data.manifest.id !== id) throw new Error('教材 ID 与目录不一致');
  if (!data.blocks.length) throw new Error('教材没有可阅读内容');
  return applyEditorial(root, data);
}
export function flattenSections(nodes: SectionNode[]): SectionNode[] {
  return nodes.flatMap(n => [n, ...flattenSections(n.children)]);
}
export function sectionIndex(book: BookPackage, query?: string): number {
  if (!query) return 0;
  const byBlock = book.blocks.findIndex(b => b.id === query);
  if (byBlock >= 0) return byBlock;
  const matches = flattenSections(book.sections).filter(s => s.id === query || s.title === query || s.title.startsWith(`${query} `) || s.title.startsWith(`${query}\u3000`));
  if (matches.length > 1) throw new Error(`章节别名 ${query} 不唯一，请使用章节 ID：\n${matches.map(s => `${s.title} · ${s.id}`).join('\n')}`);
  const section = matches[0];
  if (!section) throw new Error(`找不到章节或内容块：${query}`);
  return Math.max(0, book.blocks.findIndex(b => b.id === section.blockIds[0]));
}
export interface SearchHit { bookId: string; blockId: string; text: string; source: string }
export function searchBook(book: BookPackage, query: string): SearchHit[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return book.blocks.flatMap(b => {
    const content = readingContent(b);
    const index = content.toLocaleLowerCase().indexOf(needle);
    if (index < 0) return [];
    return [{ bookId: book.manifest.id, blockId: b.id,
      text: content.slice(Math.max(0, index - 20), index + needle.length + 60).replace(/\s+/g, ' '),
      source: sourceLabel(b) }];
  });
}
export function describeSource(book: BookPackage, block: ContentBlock): string {
  const reviewed = block.editorial?.source;
  const location = reviewed ? `PDF 物理页 ${sourcePageNumbers(block).join('、')}${reviewed.spans.length > 1 ? '（跨页块，分别保留原文区间）' : ''}\n${reviewed.spans.map(s => `[${s.start}, ${s.end}) → 物理页 ${s.pageNo}${s.printedPage === undefined ? '' : ` / 印刷页 ${s.printedPage}`}\n原页图：${s.image}`).join('\n')}\n来源记录：${reviewed.eventId}\n核对人：${reviewed.reviewer}\n映射依据：${reviewed.reason}` : block.source.mapping === 'mapped'
    ? `PDF 物理页 ${block.source.pageNo}${block.source.printedPage === undefined ? '' : ` · 印刷页 ${block.source.printedPage}`}\n映射依据：${block.source.evidence}`
    : '来源未映射：无法定位 PDF 物理页；请人工查阅，不根据段落或样本页序推断。';
  return `${location}\n核验状态：${block.verification}（来源核对/局部校订不代表整块正确；不提供自动判分）\n已确认校订：${block.editorial?.corrections.length ?? 0} 处\nPDF：${book.manifest.source?.pdfPath ?? '未关联'}\n原始 OCR：${block.original.rawFile} [${block.original.start}, ${block.original.end})${book.editorialWarnings?.length ? `\n记录告警：${book.editorialWarnings.join('；')}` : ''}`;
}
export async function openPageImage(root: string, book: BookPackage, block: ContentBlock, pageNo?: number): Promise<void> {
  const spans = block.editorial?.source?.spans;
  const span = pageNo === undefined ? spans?.[0] : spans?.find(s => s.pageNo === pageNo);
  if (!span) throw new Error('此块/物理页没有经过核对的原页图像，请先登记来源映射');
  if (!book.manifest.source || await sha256(book.manifest.source.pdfPath) !== book.manifest.source.sha256) throw new Error('PDF 指纹变化，停止回源');
  const dir = await realpath(bookDirectory(root, book.manifest.id));
  const file = await realpath(path.resolve(dir, span.image));
  if (!inside(dir, file) || await sha256(file) !== span.imageSha256) throw new Error('页面图像路径或指纹无效');
  await openLocalFile(file);
}
export async function openPdf(book: BookPackage): Promise<string> {
  const source = book.manifest.source;
  if (!source) throw new Error('未关联 PDF，请根据原始 OCR 来源核对');
  await access(source.pdfPath);
  if (await sha256(source.pdfPath) !== source.sha256) throw new Error('PDF 指纹已改变，停止回源，请重新确认教材来源');
  await openLocalFile(source.pdfPath);
  return '已请求系统打开 PDF；系统阅读器不保证自动跳页，请按显示的物理页码手动定位。';
}
export async function openImage(root: string, book: BookPackage, block: ContentBlock): Promise<void> {
  const asset = /assets\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)/.exec(block.content)?.[0];
  if (!asset) throw new Error('当前内容块没有可用的本地图片');
  const dir = bookDirectory(root, book.manifest.id);
  const file = path.resolve(dir, asset);
  if (!inside(dir, file)) throw new Error('图片路径无效');
  await access(file); await openLocalFile(file);
}
export function openLocalFile(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // 路径通过环境传入 PowerShell，不作为脚本拼接；不执行 Markdown 命令或链接。
    const child = process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:EXAM_STUDY_SOURCE -ErrorAction Stop'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, EXAM_STUDY_SOURCE: file } })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`系统查看器启动失败（${code}）`)));
  });
}
