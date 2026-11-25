import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, rename, stat } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';

export async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function pdfMetadata(file: string) {
  const pdfPath = await realpath(file);
  const pdf = await PDFDocument.load(await readFile(pdfPath), { updateMetadata: false });
  return { format: 'scanned-pdf' as const, pdfPath, totalPages: pdf.getPageCount(), sha256: await sha256(pdfPath) };
}
export async function readMarkdown(file: string): Promise<string> {
  if ((await stat(file)).size > 32 * 1024 * 1024) throw new Error('单份 Markdown 超过 32 MiB，请按物理页拆分');
  const buffer = await readFile(file);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
}
export function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export async function publishRename(from: string, to: string): Promise<void> {
  // Windows 文件扫描器可能暂时占用刚写完的目录/记录；只对占用类错误短暂重试。
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await setTimeout(25 * 2 ** attempt);
    }
  }
}
