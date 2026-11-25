import { mkdir, readFile, realpath, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bookManifestSchema, importMapSchema, packageSchema, type BookPackage, type ContentBlock, type SectionNode } from '../domain/schema.js';
import { classifyHeading } from '../domain/headings.js';
import { inside, pdfMetadata, publishRename, readMarkdown, sha256 } from '../infrastructure/files.js';
import { parseMarkdown } from '../infrastructure/markdown.js';

export function buildSections(blocks: ContentBlock[], bookId: string): SectionNode[] {
  const roots: SectionNode[] = [];
  const stack: SectionNode[] = [];
  // 无标题开头也进入可导航的“前置内容”，不丢失跨页上下文。
  for (const block of blocks) {
    if (block.type === 'heading' || stack.length === 0) {
      const title = block.type === 'heading' ? block.content.replace(/^#+\s*/, '') : '前置内容';
      const classified = block.type === 'heading' ? classifyHeading(title) : { kind: 'unknown' as const, level: 1 };
      while (stack.length && stack[stack.length - 1]!.level >= classified.level) stack.pop();
      const parent = stack[stack.length - 1];
      const node: SectionNode = { id: `${bookId}:section:${block.id}`, bookId, title,
        ...classified, parentId: parent?.id, order: block.order, blockIds: [], children: [] };
      if (parent) parent.children.push(node); else roots.push(node);
      stack.push(node);
    }
    block.sectionId = stack[stack.length - 1]!.id;
    for (const ancestor of stack) ancestor.blockIds.push(block.id);
  }
  return roots;
}
export interface ImportOptions {
  root: string; id?: string; title?: string; subject?: 'math' | 'logic';
  legacy?: string; map?: string; pdf?: string; tier?: 'basic' | 'standard' | 'unknown';
}
export async function importBook(options: ImportOptions): Promise<BookPackage> {
  if (Boolean(options.legacy) === Boolean(options.map)) throw new Error('必须且只能指定 --legacy 或 --map');
  const mapFile = options.map ? await realpath(options.map) : undefined;
  const map = mapFile ? importMapSchema.parse(JSON.parse(await readFile(mapFile, 'utf8'))) : undefined;
  const id = map?.bookId ?? options.id ?? 'math-preview';
  const now = new Date().toISOString();
  const pdf = map ? path.resolve(path.dirname(mapFile!), map.pdf) : options.pdf;
  const manifest = bookManifestSchema.parse({ schemaVersion: 1, id, title: map?.title ?? options.title ?? id,
    subject: map?.subject ?? options.subject ?? 'math', mode: map ? 'formal' : 'legacy-preview',
    source: pdf ? await pdfMetadata(pdf) : null, contentVersion: 1, createdAt: now, updatedAt: now });
  const entries = map ? map.pages.map(p => ({ ...p, file: path.resolve(path.dirname(mapFile!), p.markdown) }))
    : [{ pageNo: null, printedPage: undefined, evidence: '', file: path.resolve(options.legacy!) }];
  const pageNos = new Set<number>();
  for (const entry of entries) {
    if (entry.pageNo !== null) {
      if (pageNos.has(entry.pageNo) || entry.pageNo > manifest.source!.totalPages) throw new Error('物理页码重复或超出实际 PDF 页数');
      pageNos.add(entry.pageNo);
    }
  }
  await mkdir(path.join(options.root, 'books'), { recursive: true });
  const booksRoot = await realpath(path.join(options.root, 'books'));
  const destination = path.join(booksRoot, id);
  try { await access(destination); throw new Error(`教材 ${id} 已存在；请使用新的 ID，旧数据不会被覆盖`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const entry of entries) if (inside(destination, await realpath(entry.file))) throw new Error('原始 OCR 不能放在输出教材目录内');
  const staging = path.join(booksRoot, `.import-${randomUUID()}`);
  await mkdir(staging);
  try {
    await mkdir(path.join(staging, 'raw'));
    await mkdir(path.join(staging, 'clean'));
    const data: BookPackage = { manifest, pages: [], blocks: [], sections: [], diagnostics: [] };
    if (mapFile) await writeFile(path.join(staging, 'mapping.json'), await readFile(mapFile));
    const provenance: { originalPath: string; snapshot: string; sha256: string }[] = [];
    for (const entry of entries) {
      const file = await realpath(entry.file);
      const raw = await readMarkdown(file);
      const rawName = `raw/${entry.pageNo === null ? 'legacy' : `page-${String(entry.pageNo).padStart(6, '0')}`}.md`;
      await writeFile(path.join(staging, rawName), raw);
      provenance.push({ originalPath: file, snapshot: rawName, sha256: await sha256(file) });
      const source = entry.pageNo === null ? { mapping: 'unmapped' as const, bookId: id, pageNo: null, rawFile: rawName }
        : { mapping: 'mapped' as const, bookId: id, pageNo: entry.pageNo, printedPage: entry.printedPage, evidence: entry.evidence };
      const parsed = await parseMarkdown(raw, source, file, staging, data.blocks.length);
      for (const block of parsed.blocks) block.original.rawFile = rawName;
      await writeFile(path.join(staging, 'clean', path.basename(rawName)), parsed.clean);
      data.blocks.push(...parsed.blocks);
      if (entry.pageNo !== null) data.pages.push({ id: `${id}:page:${entry.pageNo}`, bookId: id, pageNo: entry.pageNo,
        printedPage: entry.printedPage, ocrVariants: [{ tier: map!.tier, textPath: rawName, createdAt: now }],
        selectedOcrTier: map!.tier, blocks: parsed.blocks.map(b => b.id), status: 'needs_review' });
    }
    if (!data.blocks.length) throw new Error('没有可阅读内容，未发布教材包');
    data.sections = buildSections(data.blocks, id);
    data.diagnostics = data.blocks.flatMap(block => block.warnings.map(message => ({ blockId: block.id, code: 'needs-review', severity: 'warning' as const, message })));
    const validated = packageSchema.parse(data);
    await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(validated.manifest, null, 2));
    await writeFile(path.join(staging, 'provenance.json'), JSON.stringify(provenance, null, 2));
    await writeFile(path.join(staging, 'book.json'), JSON.stringify(validated, null, 2));
    await writeFile(path.join(staging, 'report.json'), JSON.stringify(importReport(validated), null, 2));
    // 同一卷内重命名发布。失败时只删除本次随机 staging，不触及原文件或已有教材。
    await publishRename(staging, destination);
    return validated;
  } catch (error) {
    if (inside(booksRoot, staging) && path.basename(staging).startsWith('.import-')) await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
export function importReport(data: BookPackage) {
  return { book: data.manifest.id, mode: data.manifest.mode, pages: data.pages.length, blocks: data.blocks.length,
    warnings: data.diagnostics.length, sourceMapping: data.manifest.mode === 'formal' ? 'valid (declared per-page evidence)' : 'unmapped',
    verification: 'unverified', automaticGrading: false };
}
