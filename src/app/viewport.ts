import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import type { ContentBlock } from '../domain/schema.js';
import { readingContent } from '../domain/editorial.js';

export function readerText(block: ContentBlock): string {
  const rejected = block.verification === 'rejected' ? '此内容已标记为不可靠。请按 P 查看来源并优先核对原始 PDF 或图片。\n\n' : '';
  const warnings = block.editorial?.source ? block.warnings.filter(w => !w.startsWith('来源未映射')) : block.warnings;
  const corrected = block.editorial?.corrections.length ? `\n\n本块已校订 ${block.editorial.corrections.length} 处；R 查看原文与记录，整块仍需核验。` : '';
  return `${rejected}${readingContent(block)}${corrected}\n\n${warnings.length ? `提示：${warnings.join('；')}` : ''}`;
}

export function originalText(block: ContentBlock): string {
  return `原始 OCR（未覆盖）\n${block.content}\n\n校订记录\n${block.editorial?.corrections.map(c => `${c.id}\n[${c.start}, ${c.end}) ${c.before} → ${c.after}\n核对人：${c.reviewer}\n依据：${c.reason}`).join('\n\n') || '暂无已确认校订'}\n\n区间针对原始块的 UTF-16 字符位置，不因校订改变。`;
}

export function safeText(input: string): string {
  // 屏蔽 ANSI/OSC、C0/C1 控制符和双向覆盖符。保留换行与数学字符。
  return input.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\t/g, '  ').replace(/\r\n/g, '\n');
}
export function displayLines(text: string, columns: number): string[] {
  const width = Math.max(4, Math.floor(columns));
  // 不对公式做代数修复或有歧义的 Unicode 替换。换行仅影响显示。
  return wrapAnsi(safeText(text), width, { hard: true, trim: false, wordWrap: false }).split('\n');
}
export function viewport(text: string, columns: number, rows: number, offset: number) {
  const lines = displayLines(text, columns);
  const height = Math.max(1, Math.floor(rows));
  const maxOffset = Math.max(0, lines.length - height);
  const current = Math.max(0, Math.min(offset, maxOffset));
  return { lines: lines.slice(current, current + height), offset: current, maxOffset, total: lines.length };
}
export function singleLine(text: string, columns: number): string {
  const safe = safeText(text).replace(/\n/g, ' ');
  if (stringWidth(safe) <= columns) return safe;
  return `${displayLines(safe, Math.max(4, columns - 1))[0] ?? ''}…`;
}
