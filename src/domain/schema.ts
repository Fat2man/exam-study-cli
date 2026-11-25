import { z } from 'zod';

export const verificationSchema = z.enum(['unverified', 'verified', 'rejected']);
export const tierSchema = z.enum(['basic', 'standard', 'unknown']);
const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const pdfSchema = z.object({
  format: z.literal('scanned-pdf'), pdfPath: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), totalPages: z.number().int().positive()
});
export const bookManifestSchema = z.object({
  schemaVersion: z.literal(1), id: idSchema, title: z.string().min(1),
  subject: z.enum(['math', 'logic']), mode: z.enum(['formal', 'legacy-preview']),
  source: pdfSchema.nullable(), contentVersion: z.number().int().positive(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime()
}).superRefine((m, ctx) => {
  if (m.mode === 'formal' && !m.source) ctx.addIssue({ code: 'custom', message: '正式教材必须有实际 PDF 元数据' });
});
export const sourceLocationSchema = z.discriminatedUnion('mapping', [
  z.object({ mapping: z.literal('mapped'), bookId: idSchema, pageNo: z.number().int().positive(),
    evidence: z.string().min(1), printedPage: z.number().int().optional() }),
  z.object({ mapping: z.literal('unmapped'), bookId: idSchema, pageNo: z.null(), rawFile: z.string().min(1) })
]);
export const pageRecordSchema = z.object({
  id: z.string(), bookId: idSchema, pageNo: z.number().int().positive(),
  printedPage: z.number().int().optional(),
  ocrVariants: z.array(z.object({ tier: tierSchema, textPath: z.string(), createdAt: z.string().datetime(), engine: z.string().optional() })).min(1),
  selectedOcrTier: tierSchema, blocks: z.array(z.string()),
  status: z.enum(['imported', 'needs_review', 'verified', 'failed'])
});
export const blockSchema = z.object({
  id: z.string().min(1), type: z.enum(['heading', 'paragraph', 'formula', 'table', 'image', 'question', 'notice', 'unknown']),
  sectionId: z.string().optional(), content: z.string(), source: sourceLocationSchema,
  order: z.number().int().nonnegative(), verification: verificationSchema,
  warnings: z.array(z.string()),
  original: z.object({ rawFile: z.string(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }),
  contentVersion: z.number().int().positive()
});
export type SectionNode = {
  id: string; bookId: string; title: string; parentId?: string; level: number;
  kind: HeadingKind; order: number; blockIds: string[]; children: SectionNode[];
};
export const headingKinds = ['lecture', 'section', 'syllabus-group', 'syllabus-point', 'knowledge-point', 'model-group', 'model', 'exercise', 'unknown'] as const;
export type HeadingKind = typeof headingKinds[number];
export const sectionSchema: z.ZodType<SectionNode> = z.lazy(() => z.object({
  id: z.string(), bookId: idSchema, title: z.string(), parentId: z.string().optional(),
  level: z.number().int().positive(), kind: z.enum(headingKinds), order: z.number().int().nonnegative(),
  blockIds: z.array(z.string()), children: z.array(sectionSchema)
}));
// 只预留契约；Phase 0–2 不提取标准答案、不建立刷题或判分入口。
export const questionSchema = z.object({
  id: z.string(), bookId: idSchema, sectionId: z.string().optional(),
  type: z.enum(['single_choice', 'condition_sufficiency', 'free_response', 'unknown']),
  stem: z.string(), options: z.array(z.object({ key: z.string(), content: z.string() })),
  answer: z.string().optional(), explanation: z.string().optional(),
  source: sourceLocationSchema, verification: verificationSchema, warnings: z.array(z.string())
});
export type BookManifest = z.infer<typeof bookManifestSchema>;
export type SourceLocation = z.infer<typeof sourceLocationSchema>;
export interface ReviewedPageSpan {
  start: number; end: number; pageNo: number; printedPage?: number;
  image: string; imageSha256: string;
}
export interface BlockEditorial {
  source?: { eventId: string; reviewer: string; reason: string; spans: ReviewedPageSpan[] };
  content?: string;
  corrections: { id: string; start: number; end: number; before: string; after: string; reviewer: string; reason: string }[];
}
export type ContentBlock = z.infer<typeof blockSchema> & { editorial?: BlockEditorial };
export type PageRecord = z.infer<typeof pageRecordSchema>;
export type StudyQuestion = z.infer<typeof questionSchema>;
export const importMapSchema = z.object({
  schemaVersion: z.literal(1), bookId: idSchema, title: z.string().min(1), subject: z.enum(['math', 'logic']),
  pdf: z.string().min(1), tier: tierSchema,
  pages: z.array(z.object({ pageNo: z.number().int().positive(), printedPage: z.number().int().optional(),
    markdown: z.string().min(1), evidence: z.string().min(1) })).min(1)
});
export const packageSchema = z.object({
  manifest: bookManifestSchema, pages: z.array(pageRecordSchema), blocks: z.array(blockSchema),
  sections: z.array(sectionSchema), diagnostics: z.array(z.object({
    blockId: z.string().optional(), code: z.string(), message: z.string(), severity: z.enum(['warning', 'error'])
  }))
}).superRefine((data, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const { manifest, pages, blocks } = data;
  const blockIds = new Set(blocks.map(b => b.id));
  const pageNos = new Set(pages.map(p => p.pageNo));
  if (blockIds.size !== blocks.length || pageNos.size !== pages.length) fail('重复内容块或物理页码');
  if (manifest.mode === 'legacy-preview' && pages.length) fail('预览不能伪造 PageRecord');
  if (manifest.mode === 'formal' && !pages.length) fail('正式教材缺少逐页记录');
  for (const page of pages) {
    if (page.bookId !== manifest.id || page.pageNo > (manifest.source?.totalPages ?? 0)) fail('PageRecord 超出原始 PDF 范围');
    for (const id of page.blocks) {
      const block = blocks.find(b => b.id === id);
      if (!block || block.source.pageNo !== page.pageNo) fail('页面内容引用不一致');
    }
  }
  for (const b of blocks) {
    if (b.source.bookId !== manifest.id) fail('教材来源 ID 不一致');
    if (b.original.end < b.original.start) fail('原始内容位置无效');
    if (manifest.mode === 'formal' && (b.source.mapping !== 'mapped' || !pageNos.has(b.source.pageNo))) fail('正式内容缺少可靠页码');
    if (manifest.mode === 'legacy-preview' && b.source.mapping !== 'unmapped') fail('预览禁止推断页码');
    if (b.source.mapping === 'mapped' && !pages.find(p => p.pageNo === b.source.pageNo)?.blocks.includes(b.id)) fail('内容未关联页面');
  }
  const visit = (nodes: SectionNode[], parentId?: string) => {
    for (const node of nodes) {
      if (node.bookId !== manifest.id || node.parentId !== parentId) fail('章节来源或父节点无效');
      if (node.blockIds.some(id => !blockIds.has(id))) fail('章节引用不存在的内容');
      visit(node.children, node.id);
    }
  };
  visit(data.sections);
});
export type BookPackage = Omit<z.infer<typeof packageSchema>, 'blocks'> & { blocks: ContentBlock[]; editorialWarnings?: string[] };
