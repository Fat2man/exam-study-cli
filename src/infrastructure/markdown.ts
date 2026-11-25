import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import type { ContentBlock, SourceLocation } from '../domain/schema.js';
import { inside } from './files.js';

type AstNode = { type: string; url?: string; identifier?: string; alt?: string; children?: AstNode[]; position?: { start: { offset?: number }; end: { offset?: number } } };
const parser = unified().use(remarkParse).use(remarkMath).use(remarkGfm);
const MAX_IMAGE = 10 * 1024 * 1024;
function imageExtension(bytes: Buffer): string {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'jpg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return 'gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw new Error('图片文件签名不属于 JPEG/PNG/GIF/WebP');
}
export async function extractImage(url: string, rawFile: string, output: string): Promise<string> {
  let bytes: Buffer;
  if (url.startsWith('data:')) {
    const match = /^data:image\/(jpeg|png|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
    if (!match || !match[2] || match[2].length % 4 !== 0) throw new Error('Base64 图片无效或格式不在白名单中');
    if (match[2].length > Math.ceil(MAX_IMAGE / 3) * 4) throw new Error('图片超过 10 MiB');
    bytes = Buffer.from(match[2], 'base64');
    if (bytes.toString('base64') !== match[2]) throw new Error('Base64 图片编码无效');
    const ext = imageExtension(bytes);
    if (ext !== (match[1] === 'jpeg' ? 'jpg' : match[1])) throw new Error('图片 MIME 与签名不符');
  } else {
    if (/^[a-z]+:/i.test(url) || url.startsWith('//')) throw new Error('不读取远程或绝对路径图片');
    const root = await realpath(path.dirname(rawFile));
    const candidate = await realpath(path.resolve(root, decodeURIComponent(url)));
    if (!inside(root, candidate)) throw new Error('图片路径超出 OCR 目录');
    const { stat } = await import('node:fs/promises');
    if ((await stat(candidate)).size > MAX_IMAGE) throw new Error('图片超过 10 MiB');
    bytes = await readFile(candidate);
  }
  if (bytes.length > MAX_IMAGE) throw new Error('图片超过 10 MiB');
  const ext = imageExtension(bytes);
  const asset = `assets/${createHash('sha256').update(bytes).digest('hex')}.${ext}`;
  await mkdir(path.join(output, 'assets'), { recursive: true });
  await writeFile(path.join(output, asset), bytes);
  return asset;
}

export async function parseMarkdown(raw: string, source: SourceLocation, rawFile: string, output: string,
  startOrder = 0): Promise<{ blocks: ContentBlock[]; clean: string }> {
  const tree = parser.parse(raw) as unknown as AstNode;
  const definitions = new Map<string, string>();
  const collect = (node: AstNode) => {
    if (node.type === 'definition' && node.identifier && node.url) definitions.set(node.identifier, node.url);
    node.children?.forEach(collect);
  };
  collect(tree);
  const blocks: ContentBlock[] = [];
  // AST 的 offset 指向原始 UTF-16 文本，保留 CRLF 和所有数学字符。
  for (const node of tree.children ?? []) {
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? start;
    let content = raw.slice(start, end);
    const warnings: string[] = [];
    const walk = async (child: AstNode): Promise<void> => {
      const url = child.type === 'imageReference' && child.identifier ? definitions.get(child.identifier) : child.url;
      if (child.type === 'image' || child.type === 'imageReference') {
        let asset = 'asset-unavailable';
        try {
          if (!url) throw new Error('图片引用缺少定义');
          asset = await extractImage(url, rawFile, output);
        }
        catch (error) {
          warnings.push(`图片未导入：${error instanceof Error ? error.message : String(error)}`);
        }
        if (child.type === 'imageReference') {
          const imageText = raw.slice(child.position?.start.offset ?? start, child.position?.end.offset ?? end);
          content = content.replace(imageText, `![${child.alt ?? 'image'}](${asset})`);
        } else if (url) content = content.replaceAll(url, asset);
      }
      for (const next of child.children ?? []) await walk(next);
    };
    await walk(node);
    // 引用式图片定义也不能把 Base64 或任意链接传到 UI。
    if (node.type === 'definition') continue;
    content = content.replace(/data:image\/[^\s)]+/g, '[图片数据已隔离]');
    if (/\\dot\{|\\overline\{|\\sqrt\{[^}]*\d\s+\d|带宗喙法/.test(content)) warnings.push('疑似 OCR 公式或文字问题，需与 PDF 核对；未自动修正');
    if (source.mapping === 'unmapped') warnings.push('来源未映射，无法定位 PDF 物理页');
    if (node.type === 'math' || /\\(frac|sqrt|begin|dot)\b/.test(content)) warnings.push('公式显示为 LaTeX 原文；复杂排版请回源核对');
    const onlyImage = node.type === 'paragraph' && node.children?.every(c => c.type === 'image' || c.type === 'imageReference');
    const type: ContentBlock['type'] = node.type === 'heading' ? 'heading' : node.type === 'math' ? 'formula'
      : node.type === 'table' ? 'table' : onlyImage ? 'image' : node.type === 'paragraph' || node.type === 'list' || node.type === 'blockquote' ? 'paragraph' : 'unknown';
    blocks.push({ id: `${source.bookId}:${source.pageNo ?? 'legacy'}:${String(blocks.length + 1).padStart(4, '0')}`,
      type, content, source, order: startOrder + blocks.length, verification: 'unverified', warnings,
      original: { rawFile, start, end }, contentVersion: 1 });
  }
  return { blocks, clean: blocks.map(b => b.content).join('\n\n') };
}
