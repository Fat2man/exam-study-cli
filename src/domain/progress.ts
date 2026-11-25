import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const progressAnchorSchema = z.object({
  revision: hash, pdfSha256: hash.optional(), contentVersion: z.number().int().positive(),
  blockHash: hash, viewHash: hash, blockOrder: z.number().int().nonnegative(),
  sectionPath: z.array(z.string()), sourcePages: z.array(z.number().int().positive()),
  columns: z.number().int().min(4), charOffset: z.number().int().nonnegative()
});
export const readingProgressSchema = z.object({
  bookId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), sectionId: z.string().optional(),
  blockId: z.string().optional(), pageNo: z.number().int().positive().optional(),
  scrollOffset: z.number().int().nonnegative(), updatedAt: z.string().datetime(),
  anchor: progressAnchorSchema.optional()
});
export type ReadingProgress = z.infer<typeof readingProgressSchema>;
export interface IProgressStore {
  save(progress: ReadingProgress): void;
  get(bookId: string): ReadingProgress | null;
  getLastRead(): ReadingProgress | null;
}
