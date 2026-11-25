import type { HeadingKind } from './schema.js';
export function classifyHeading(title: string): { kind: HeadingKind; level: number } {
  if (/^第\s*[一二三四五六七八九十\d①-⑳]+\s*讲/.test(title)) return { kind: 'lecture', level: 1 };
  if (/^第\s*[一二三四五六七八九十\d①-⑳]+\s*节/.test(title)) return { kind: 'section', level: 2 };
  if (/^大纲考点精讲/.test(title)) return { kind: 'syllabus-group', level: 3 };
  if (/^大纲考点\s*\d+/.test(title)) return { kind: 'syllabus-point', level: 4 };
  if (/^\d+\.\d+/.test(title)) return { kind: 'knowledge-point', level: 5 };
  if (/^\d*个母题模型/.test(title)) return { kind: 'model-group', level: 3 };
  if (/^母题模型\s*\d+/.test(title)) return { kind: 'model', level: 4 };
  if (/习题|练习/.test(title)) return { kind: 'exercise', level: 3 };
  return { kind: 'unknown', level: 3 };
}
