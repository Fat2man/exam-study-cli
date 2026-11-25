import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { editorialEventSchema, mappingRequestSchema, pageEvidenceSchema, type EditorialEvent } from '../domain/editorial.js';
import { packageSchema, type BookPackage, type ContentBlock, type ReviewedPageSpan } from '../domain/schema.js';
import { inside, publishRename, sha256 } from '../infrastructure/files.js';

export const textHash = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
function directory(root: string, id: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('教材 ID 无效');
  return path.resolve(root, 'books', id);
}
async function localFile(root: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative)) throw new Error('记录中的资源必须使用相对路径');
  const resolved = await realpath(path.resolve(root, relative));
  if (!inside(await realpath(root), resolved)) throw new Error('记录资源越出教材目录');
  return resolved;
}
export async function readEditorialEvents(root: string, id: string): Promise<{ events: EditorialEvent[]; warnings: string[] }> {
  const dir = path.join(directory(root, id), 'editorial/events');
  const events: EditorialEvent[] = []; const warnings: string[] = [];
  let files: string[];
  try { files = await readdir(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events, warnings }; throw error; }
  for (const file of files.filter(f => f.endsWith('.json')).sort()) {
    try {
      const event = editorialEventSchema.parse(JSON.parse(await readFile(path.join(dir, file), 'utf8')));
      if (file !== `${event.id}.json` || event.bookId !== id) throw new Error('记录身份无效');
      events.push(event);
    } catch { warnings.push(`校订记录 ${file} 损坏，未应用`); }
  }
  return { events: events.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)), warnings };
}
async function baseContext(root: string, id: string) {
  const dir = directory(root, id);
  const bytes = await readFile(path.join(dir, 'book.json'));
  const book: BookPackage = packageSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (book.manifest.id !== id) throw new Error('教材 ID 不一致');
  return { dir, book, packageSha256: textHash(bytes) };
}
function activeEvents(events: EditorialEvent[], packageHash: string, pdfHash: string, warnings: string[]) {
  const matching = events.filter(e => {
    const match = e.packageSha256 === packageHash && e.pdfSha256 === pdfHash;
    if (!match) warnings.push(`记录 ${e.id} 的教材/PDF 指纹已变化，未应用`);
    return match;
  });
  const revoked = new Set(matching.filter(e => e.type === 'revoke').map(e => e.targetId));
  return matching.filter(e => e.type !== 'revoke' && !revoked.has(e.id));
}
function validateSpans(block: ContentBlock, spans: ReviewedPageSpan[], totalPages: number) {
  let end = 0;
  for (const span of spans) {
    if (span.start !== end || span.end <= span.start || span.end > block.content.length || span.pageNo > totalPages) throw new Error('来源区间必须完整覆盖块原文、无重叠/缺口，且物理页不越界');
    end = span.end;
  }
  if (end !== block.content.length) throw new Error('来源区间没有覆盖完整内容块');
}
export async function applyEditorial(root: string, original: BookPackage): Promise<BookPackage> {
  const { events, warnings } = await readEditorialEvents(root, original.manifest.id);
  if (!events.length && !warnings.length) return original;
  const data = structuredClone(original);
  data.editorialWarnings = warnings;
  if (!data.manifest.source) { warnings.push('教材没有 PDF，未应用来源与校订记录'); return data; }
  const { dir, packageSha256 } = await baseContext(root, data.manifest.id);
  const pdf = data.manifest.source;
  try {
    if (await sha256(pdf.pdfPath) !== pdf.sha256) throw new Error('PDF 指纹改变');
  } catch { warnings.push('原始 PDF 缺失或指纹变化，未应用来源与校订记录'); return data; }
  const active = activeEvents(events, packageSha256, pdf.sha256, warnings);
  const byId = new Map(data.blocks.map(b => [b.id, b]));
  const hashes = new Map<string, Promise<string>>();
  const checkedHash = (file: string) => {
    if (!hashes.has(file)) hashes.set(file, sha256(file));
    return hashes.get(file)!;
  };
  for (const event of active) {
    if (event.type !== 'mapping') continue;
    try {
      for (const binding of event.bindings) {
        const block = byId.get(binding.blockId);
        if (!block || textHash(block.content) !== binding.contentSha256 || block.original.rawFile !== binding.rawFile) throw new Error('内容块原文变化');
        if (block.editorial?.source) throw new Error('重复有效来源记录');
        validateSpans(block, binding.spans, pdf.totalPages);
        if (await checkedHash(await localFile(dir, binding.rawFile)) !== binding.rawSha256) throw new Error('原始 OCR 快照变化');
        for (const span of binding.spans) if (await checkedHash(await localFile(dir, span.image)) !== span.imageSha256) throw new Error('页面图像证据变化');
      }
      for (const binding of event.bindings) byId.get(binding.blockId)!.editorial = {
        corrections: [], source: { eventId: event.id, reviewer: event.reviewer, reason: event.reason, spans: binding.spans }
      };
    } catch (error) { warnings.push(`来源记录 ${event.id} 失效：${error instanceof Error ? error.message : String(error)}`); }
  }
  const proposals = new Map(active.filter(e => e.type === 'proposal').map(e => [e.id, e]));
  for (const event of active) {
    if (event.type !== 'acceptance') continue;
    const proposal = proposals.get(event.proposalId);
    const block = proposal ? byId.get(proposal.blockId) : undefined;
    if (!proposal || !block || !block.editorial?.source || block.editorial.source.eventId !== event.mappingId || textHash(block.content) !== proposal.contentSha256
      || block.content.slice(proposal.start, proposal.end) !== proposal.before || proposal.end <= proposal.start) {
      warnings.push(`校订确认 ${event.id} 的原文或来源失效，未应用`); continue;
    }
    if (block.editorial.corrections.some(c => c.start < proposal.end && proposal.start < c.end)) {
      warnings.push(`校订确认 ${event.id} 与已有校订重叠，未应用`); continue;
    }
    block.editorial.corrections.push({ id: proposal.id, start: proposal.start, end: proposal.end, before: proposal.before,
      after: proposal.after, reviewer: event.reviewer, reason: event.reason });
  }
  for (const block of data.blocks) {
    if (!block.editorial?.corrections.length) continue;
    let content = block.content;
    for (const correction of [...block.editorial.corrections].sort((a, b) => b.start - a.start)) content = content.slice(0, correction.start) + correction.after + content.slice(correction.end);
    block.editorial.content = content;
    // 单处校订不能沿用整块的已核验状态。
    if (block.verification === 'verified') block.verification = 'unverified';
    const touchedPages = new Set(block.editorial.source?.spans.map(s => s.pageNo));
    for (const page of data.pages) if (touchedPages.has(page.pageNo) && page.status === 'verified') page.status = 'needs_review';
  }
  const updateTitles = (nodes: BookPackage['sections']) => {
    for (const node of nodes) {
      const heading = byId.get(node.blockIds[0] ?? '');
      if (heading?.type === 'heading' && heading.editorial?.content !== undefined) node.title = heading.editorial.content.replace(/^#+\s*/, '');
      updateTitles(node.children);
    }
  };
  updateTitles(data.sections);
  return data;
}
async function mutate<T>(root: string, id: string, work: () => Promise<T>): Promise<T> {
  const dir = path.join(directory(root, id), 'editorial'); await mkdir(dir, { recursive: true });
  let lock;
  try { lock = await open(path.join(dir, '.lock'), 'wx'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('另一项校订写入正在进行；如上次异常退出，请先检查 editorial/.lock'); throw error; }
  try { return await work(); }
  finally { await lock.close(); await rm(path.join(dir, '.lock')); }
}
async function appendEvent(root: string, event: EditorialEvent) {
  editorialEventSchema.parse(event);
  const dir = path.join(directory(root, event.bookId), 'editorial/events'); await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `${event.id}.tmp`);
  const handle = await open(temp, 'wx');
  try { await handle.writeFile(JSON.stringify(event, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  try { await publishRename(temp, path.join(dir, `${event.id}.json`)); }
  finally { await rm(temp, { force: true }); }
  return event.id;
}
async function writeContext(root: string, id: string) {
  const context = await baseContext(root, id);
  const source = context.book.manifest.source;
  if (!source || await sha256(source.pdfPath) !== source.sha256) throw new Error('必须关联存在且指纹匹配的原始 PDF');
  const provenance = z.array(z.object({ snapshot: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }))
    .parse(JSON.parse(await readFile(path.join(context.dir, 'provenance.json'), 'utf8')));
  for (const rawFile of new Set(context.book.blocks.map(b => b.original.rawFile))) {
    const records = provenance.filter(p => p.snapshot === rawFile);
    if (records.length !== 1 || await sha256(await localFile(context.dir, rawFile)) !== records[0]!.sha256) throw new Error('原始 OCR 快照与导入指纹不符，不能登记新来源/校订');
  }
  const journal = await readEditorialEvents(root, id);
  if (journal.warnings.length) throw new Error(journal.warnings.join('\n'));
  return { ...context, journal: journal.events, base: { id: randomUUID(), createdAt: new Date().toISOString(), bookId: id,
    packageSha256: context.packageSha256, pdfSha256: source.sha256 } };
}
export async function registerSourceMap(root: string, id: string, requestFile: string): Promise<string> {
  return mutate(root, id, async () => {
    const ctx = await writeContext(root, id);
    const request = mappingRequestSchema.parse(JSON.parse(await readFile(requestFile, 'utf8')));
    if (request.bookId !== id || request.pdfSha256 !== ctx.base.pdfSha256) throw new Error('来源清单不属于当前教材/PDF');
    const evidenceFile = await realpath(path.resolve(path.dirname(requestFile), request.pageEvidence));
    const evidence = pageEvidenceSchema.parse(JSON.parse(await readFile(evidenceFile, 'utf8')));
    if (evidence.pdfSha256 !== ctx.base.pdfSha256 || evidence.totalPages !== ctx.book.manifest.source!.totalPages) throw new Error('图像证据不属于当前 PDF');
    if (new Set(evidence.pages.map(p => p.pageNo)).size !== evidence.pages.length) throw new Error('图像证据物理页重复');
    const reading = await applyEditorial(root, ctx.book);
    const grouped = new Map<string, ReviewedPageSpan[]>();
    for (const entry of request.mappings) {
      const start = ctx.book.blocks.findIndex(b => b.id === entry.fromBlock);
      const end = ctx.book.blocks.findIndex(b => b.id === (entry.toBlock ?? entry.fromBlock));
      if (start < 0 || end < start) throw new Error('来源内容块范围无效');
      if (entry.toBlock && (entry.start !== undefined || entry.end !== undefined)) throw new Error('跨块范围不能指定块内区间');
      const page = evidence.pages.find(p => p.pageNo === entry.pageNo);
      if (!page || entry.pageNo > evidence.totalPages) throw new Error('缺少物理页图像证据或页码越界');
      const imageFile = await localFile(path.dirname(evidenceFile), page.image);
      if (await sha256(imageFile) !== page.sha256) throw new Error('页面图像指纹不匹配');
      const imageBytes = await readFile(imageFile);
      if (!imageBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('原页证据必须为 PNG 图像');
      const imageName = `editorial/assets/${page.sha256}.png`;
      await mkdir(path.join(ctx.dir, 'editorial/assets'), { recursive: true });
      // 文件内容寻址；重复引用也核对现有证据，不覆盖。
      const destination = path.join(ctx.dir, imageName);
      try { await writeFile(destination, imageBytes, { flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await sha256(destination) !== page.sha256) throw error; }
      for (const block of ctx.book.blocks.slice(start, end + 1)) {
        if (reading.blocks.find(b => b.id === block.id)?.editorial?.source) throw new Error(`内容块 ${block.id} 已有有效来源，请先撤销旧记录`);
        const spans = grouped.get(block.id) ?? [];
        spans.push({ start: entry.start ?? 0, end: entry.end ?? block.content.length, pageNo: entry.pageNo,
          printedPage: entry.printedPage, image: imageName, imageSha256: page.sha256 });
        grouped.set(block.id, spans);
      }
    }
    const bindings = [];
    for (const [blockId, spans] of grouped) {
      const block = ctx.book.blocks.find(b => b.id === blockId)!;
      spans.sort((a, b) => a.start - b.start); validateSpans(block, spans, evidence.totalPages);
      bindings.push({ blockId, contentSha256: textHash(block.content), rawFile: block.original.rawFile,
        rawSha256: await sha256(await localFile(ctx.dir, block.original.rawFile)), spans });
    }
    return appendEvent(root, { ...ctx.base, type: 'mapping', reviewer: request.reviewer, reason: request.reason, bindings });
  });
}
export async function proposeCorrection(root: string, id: string, options: { blockId: string; before: string; after: string; reason: string; start?: number }): Promise<string> {
  return mutate(root, id, async () => {
    const ctx = await writeContext(root, id);
    const block = ctx.book.blocks.find(b => b.id === options.blockId);
    if (!block || !options.before || options.before === options.after) throw new Error('内容块、原文或改文无效');
    const start = options.start ?? block.content.indexOf(options.before);
    if (!Number.isInteger(start) || start < 0 || block.content.slice(start, start + options.before.length) !== options.before) throw new Error('原文区间不匹配');
    if (options.start === undefined && block.content.indexOf(options.before, start + 1) >= 0) throw new Error('原文出现多次，请用 --start 指定 UTF-16 位置');
    return appendEvent(root, { ...ctx.base, type: 'proposal', ...options, start, end: start + options.before.length, contentSha256: textHash(block.content) });
  });
}
export async function acceptCorrection(root: string, id: string, proposalId: string, reviewer: string, reason: string): Promise<string> {
  return mutate(root, id, async () => {
    const ctx = await writeContext(root, id);
    const active = activeEvents(ctx.journal, ctx.packageSha256, ctx.base.pdfSha256, []);
    const proposal = active.find(e => e.id === proposalId && e.type === 'proposal');
    if (!proposal || proposal.type !== 'proposal') throw new Error('校订候选不存在、已撤销或指纹过期');
    const book = await applyEditorial(root, ctx.book);
    const block = book.blocks.find(b => b.id === proposal.blockId);
    if (!block?.editorial?.source) throw new Error('确认校订前必须有经图像核对的逐页来源');
    if (block.verification === 'rejected') throw new Error('不可靠内容不能以局部校订绕过核验，请先处理原始识别质量');
    if (textHash(block.content) !== proposal.contentSha256 || block.content.slice(proposal.start, proposal.end) !== proposal.before) throw new Error('校订候选原文已变化');
    if (block.editorial.corrections.some(c => c.start < proposal.end && proposal.start < c.end)) throw new Error('校订范围重叠或已确认，请先撤销旧确认');
    return appendEvent(root, { ...ctx.base, type: 'acceptance', proposalId, mappingId: block.editorial.source.eventId, reviewer, reason });
  });
}
export async function revokeEditorial(root: string, id: string, targetId: string, reviewer: string, reason: string): Promise<string> {
  return mutate(root, id, async () => {
    const ctx = await writeContext(root, id);
    const target = ctx.journal.find(e => e.id === targetId);
    if (!target || target.type === 'revoke') throw new Error('只能撤销已有来源、候选或确认记录');
    if (ctx.journal.some(e => e.type === 'revoke' && e.targetId === targetId)) throw new Error('此记录已撤销');
    return appendEvent(root, { ...ctx.base, type: 'revoke', targetId, reviewer, reason });
  });
}
