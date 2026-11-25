import { createHash } from 'node:crypto';
import type { IProgressStore, ReadingProgress } from '../domain/progress.js';
import type { BookPackage, SectionNode } from '../domain/schema.js';
import { sourcePageNumbers } from '../domain/editorial.js';
import { displayLines, readerText, safeText, viewport } from './viewport.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const revisionCache = new WeakMap<BookPackage, string>();
function revision(book: BookPackage) {
  if (!revisionCache.has(book)) revisionCache.set(book, digest(JSON.stringify({ version: book.manifest.contentVersion,
    pdf: book.manifest.source?.sha256, blocks: book.blocks.map(b => [b.id, b.content, sourcePageNumbers(b), b.sectionId]) })));
  return revisionCache.get(book)!;
}
function sectionsWithPath(nodes: SectionNode[], ancestors: string[] = []): { node: SectionNode; path: string[] }[] {
  return nodes.flatMap(node => { const names = [...ancestors, node.title]; return [{ node, path: names }, ...sectionsWithPath(node.children, names)]; });
}
function lineStarts(text: string, columns: number): number[] {
  const original = safeText(text); let cursor = 0;
  return displayLines(text, columns).map(line => {
    const start = cursor; cursor += line.length;
    if (original[cursor] === '\n') cursor++;
    return start;
  });
}
export function progressAt(book: BookPackage, index: number, offset: number, columns: number, rows: number): ReadingProgress {
  const block = book.blocks[index]; if (!block) throw new Error('当前阅读位置不存在');
  const text = readerText(block); const view = viewport(text, columns, rows, offset);
  const pages = sourcePageNumbers(block);
  return { bookId: book.manifest.id, sectionId: block.sectionId, blockId: block.id, pageNo: pages[0],
    scrollOffset: view.offset, updatedAt: new Date().toISOString(), anchor: {
      revision: revision(book), pdfSha256: book.manifest.source?.sha256, contentVersion: book.manifest.contentVersion,
      blockHash: digest(block.content), viewHash: digest(text), blockOrder: block.order,
      sectionPath: sectionsWithPath(book.sections).find(s => s.node.id === block.sectionId)?.path ?? [], sourcePages: pages,
      columns, charOffset: lineStarts(text, columns)[view.offset] ?? 0
    } };
}
export interface ResumePosition { index: number; offset: number; screen: 'reader' | 'chapters'; notice: string; kind: 'exact' | 'page' | 'section' | 'directory' }
export function resolveProgress(book: BookPackage, saved: ReadingProgress, columns: number, rows: number): ResumePosition {
  const directory = (notice: string): ResumePosition => ({ index: 0, offset: 0, screen: 'chapters', kind: 'directory', notice });
  if (book.manifest.id !== saved.bookId) return directory('进度属于其他教材，旧记录保留，请手动选择章节。');
  const anchor = saved.anchor;
  if (anchor?.pdfSha256 && anchor.pdfSha256 !== book.manifest.source?.sha256) return directory('原 PDF 身份已改变，未套用旧位置；旧进度保留，请手动选择章节。');
  const direct = book.blocks.findIndex(b => b.id === saved.blockId);
  if (direct >= 0 && (!anchor || anchor.revision === revision(book) || anchor.blockHash === digest(book.blocks[direct]!.content))) {
    const text = readerText(book.blocks[direct]!);
    if (anchor && anchor.viewHash !== digest(text)) return { index: direct, offset: 0, screen: 'reader', kind: 'exact', notice: '已定位原内容块；展示内容有校订或提示变化，从块首恢复，旧进度保留在历史中。' };
    let offset = saved.scrollOffset;
    if (anchor && anchor.columns !== columns) {
      offset = 0;
      for (const [line, start] of lineStarts(text, columns).entries()) if (start <= anchor.charOffset) offset = line;
    }
    return { index: direct, offset: viewport(text, columns, rows, offset).offset, screen: 'reader', kind: 'exact', notice: anchor ? '已恢复上次阅读位置。' : '已恢复旧版进度；旧记录缺少内容指纹，请核对位置。' };
  }
  const pages = anchor?.sourcePages.length ? anchor.sourcePages : saved.pageNo ? [saved.pageNo] : [];
  // 只使用当前仍有可靠映射的页面，不根据原始块序号推测 PDF 页码。
  const pageCandidates = book.blocks.map((block, index) => ({ block, index })).filter(item => sourcePageNumbers(item.block).some(p => pages.includes(p)));
  if (pageCandidates.length) {
    const byContent = anchor ? pageCandidates.find(c => digest(c.block.content) === anchor.blockHash) : undefined;
    const chosen = byContent ?? pageCandidates[0]!;
    return { index: chosen.index, offset: 0, screen: 'reader', kind: 'page', notice: '原内容块已变化，已按可靠 PDF 物理页恢复；请核对位置，旧进度保留。' };
  }
  const sections = sectionsWithPath(book.sections);
  let candidates = anchor?.sectionPath.length ? sections.filter(s => JSON.stringify(s.path) === JSON.stringify(anchor.sectionPath)) : [];
  if (!anchor && saved.sectionId) candidates = sections.filter(s => s.node.id === saved.sectionId);
  if (candidates.length === 1) {
    const section = candidates[0]!.node;
    const index = book.blocks.findIndex(b => b.id === section.blockIds[0]);
    if (index >= 0) return { index, offset: 0, screen: 'reader', kind: 'section', notice: '原块与页码无法定位，已恢复到原章节开头；请核对位置，旧进度保留。' };
  }
  return directory('无法可靠定位原内容，已返回教材目录；旧进度保留，请手动选择章节。');
}

// 同步小事务保存；滚动防抖，换块/离开阅读/退出时立即冲刷。
export class ProgressSession {
  private readonly pending = new Map<string, ReadingProgress>();
  private lastIdentity = '';
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private error = '';
  private readonly listeners = new Set<(message: string) => void>();
  constructor(readonly store: IProgressStore, private readonly onError: (message: string) => void, private readonly onSaved: () => void = () => {}, readonly delay = 250) {}
  schedule(progress: ReadingProgress): void {
    if (this.disposed) return;
    const identity = `${progress.bookId}:${progress.blockId}`;
    const changed = this.lastIdentity !== identity;
    if (changed) this.flush();
    this.lastIdentity = identity;
    // 失败时按教材保留未落盘位置，切书不能把另一本的待保存位置丢掉。
    this.pending.delete(progress.bookId); this.pending.set(progress.bookId, progress);
    if (this.timer) clearTimeout(this.timer);
    if (changed) this.flush();
    else this.timer = setTimeout(() => this.flush(), this.delay);
  }
  flush(): boolean {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    if (this.disposed || !this.pending.size) return true;
    try {
      for (const [id, progress] of this.pending) { this.store.save(progress); this.pending.delete(id); }
      this.error = ''; this.onSaved(); for (const listener of this.listeners) listener(''); return true;
    }
    catch (error) {
      this.error = `进度保存失败：${error instanceof Error ? error.message : String(error)}；仍可阅读，T 重试。`;
      this.onError(this.error); for (const listener of this.listeners) listener(this.error); return false;
    }
  }
  subscribe(listener: (message: string) => void): () => void {
    this.listeners.add(listener); listener(this.error); return () => { this.listeners.delete(listener); };
  }
  dispose(): void { this.disposed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.listeners.clear(); }
}
