import { expect, test } from 'vitest';
import { bookManifestSchema } from '../src/domain/schema.js';
test('正式教材拒绝缺失 PDF 元数据', () => {
  expect(bookManifestSchema.safeParse({ schemaVersion: 1, id: 'math', title: '数学', subject: 'math', mode: 'formal', source: null,
    contentVersion: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).success).toBe(false);
});
