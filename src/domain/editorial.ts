import { z } from 'zod';
import type { ContentBlock } from './schema.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const note = z.string().trim().min(1);
const page = z.number().int().positive();
const span = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(),
  pageNo: page, printedPage: z.number().int().optional(), image: note, imageSha256: hash });
const base = { id: z.string().uuid(), createdAt: z.string().datetime(), bookId: note, packageSha256: hash, pdfSha256: hash };
export const editorialEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('mapping'), reviewer: note, reason: note,
    bindings: z.array(z.object({ blockId: note, contentSha256: hash, rawFile: note, rawSha256: hash, spans: z.array(span).min(1) })).min(1) }),
  z.object({ ...base, type: z.literal('proposal'), blockId: note, contentSha256: hash,
    start: z.number().int().nonnegative(), end: z.number().int().positive(), before: z.string().min(1), after: z.string(), reason: note }),
  z.object({ ...base, type: z.literal('acceptance'), proposalId: z.string().uuid(), mappingId: z.string().uuid(), reviewer: note, reason: note }),
  z.object({ ...base, type: z.literal('revoke'), targetId: z.string().uuid(), reviewer: note, reason: note })
]);
export type EditorialEvent = z.infer<typeof editorialEventSchema>;
export const pageEvidenceSchema = z.object({ schemaVersion: z.literal(1), pdfPath: note, pdfSha256: hash, totalPages: page,
  pages: z.array(z.object({ pageNo: page, image: note, sha256: hash })).min(1) });
const mappingEntry = z.object({ fromBlock: note, toBlock: note.optional(), pageNo: page, printedPage: z.number().int().optional(),
  start: z.number().int().nonnegative().optional(), end: z.number().int().positive().optional() });
export const mappingRequestSchema = z.object({ schemaVersion: z.literal(1), bookId: note, pdfSha256: hash,
  pageEvidence: note, reviewer: note, reason: note, mappings: z.array(mappingEntry).min(1) });

export function readingContent(block: ContentBlock): string { return block.editorial?.content ?? block.content; }
export function sourcePageNumbers(block: ContentBlock): number[] {
  return block.editorial?.source ? [...new Set(block.editorial.source.spans.map(s => s.pageNo))]
    : block.source.mapping === 'mapped' ? [block.source.pageNo] : [];
}
export function sourceLabel(block: ContentBlock): string {
  const pages = sourcePageNumbers(block);
  return pages.length ? `PDF ${pages.join('、')}${pages.length > 1 ? '（跨页）' : ''}` : '来源未映射';
}
