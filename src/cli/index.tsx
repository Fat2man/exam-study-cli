#!/usr/bin/env node
import React from 'react';
import path from 'node:path';
import os from 'node:os';
import { Command } from 'commander';
import { render } from 'ink';
import { App } from '../app/App.js';
import { describeSource, listBooks, loadBook, openPageImage, openPdf, searchBook, sectionIndex, type SearchHit } from '../app/library.js';
import { originalText, readerText, safeText, viewport } from '../app/viewport.js';
import { importBook, importReport } from '../preprocess/importer.js';
import { acceptCorrection, proposeCorrection, readEditorialEvents, registerSourceMap, revokeEditorial } from '../app/editorial.js';
import { readingContent, sourcePageNumbers } from '../domain/editorial.js';
import { SqliteProgressStore } from '../infrastructure/progress-db.js';
import { ProgressSession, resolveProgress } from '../app/progress.js';
import type { ReadingProgress } from '../domain/progress.js';

const defaultState = process.env.EXAM_STUDY_STATE_HOME ?? (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local'), 'ExamStudy')
  : path.join(os.homedir(), '.local/share/exam-study'));
const program = new Command().name('study').description('本地离线教材阅读器 · Phase 0–3').version('0.1.0')
  .option('--data-dir <directory>', '教材数据根目录', process.env.EXAM_STUDY_HOME ?? path.resolve('data'))
  .option('--state-dir <directory>', '独立学习状态目录', defaultState);
const root = () => path.resolve(program.opts<{ dataDir: string }>().dataDir);
const progressStore = () => new SqliteProgressStore(path.resolve(program.opts<{ stateDir: string }>().stateDir, 'progress.db'), root());
const print = (text: string) => console.log(safeText(text));
async function launch(bookId?: string, section?: string, initialHits?: SearchHit[], saved?: ReadingProgress) {
  const catalog = await listBooks(root());
  const book = bookId ? await loadBook(root(), bookId) : undefined;
  const target = book && saved ? resolveProgress(book, saved, Math.max(4, (process.stdout.columns || 80) - 1), Math.max(1, (process.stdout.rows || 24) - 6)) : undefined;
  const index = target?.index ?? (book ? sectionIndex(book, section) : 0);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (book) {
      if (target?.screen === 'chapters') { print(`${target.notice}\n${book.sections.map(s => s.title).join('\n')}\n请使用 study read ${bookId} <章节> 手动选择。`); return; }
      const block = book.blocks[index]!;
      print(`${target?.notice ?? ''}\n${book.manifest.title}\n${describeSource(book, block)}\n\n${viewport(readerText(block), 79, 18, target?.offset ?? 0).lines.join('\n')}\n\n非交互输出仅预览当前块，不更新学习进度；完整阅读请在交互终端运行 study read ${bookId}。`);
    } else print(`Exam Study CLI\n${catalog.books.map(b => `${b.id} · ${b.title} · ${b.mode}`).join('\n') || '暂无教材，请使用 study import。'}\n${catalog.errors.join('\n')}\n交互阅读需要 TTY 终端。`);
    return;
  }
  let store: SqliteProgressStore | undefined; let session: ProgressSession | undefined; let saveError = '';
  try {
    store = progressStore();
    session = new ProgressSession(store, message => { saveError = message; }, () => { saveError = ''; });
  } catch (error) { saveError = `进度服务不可用：${error instanceof Error ? error.message : String(error)}；当前阅读不会保存，原数据库保留。`; }
  const instance = render(<App root={root()} books={catalog.books} errors={catalog.errors} initialBook={book} initialIndex={index}
    initialHits={initialHits} initialOffset={target?.offset} initialScreen={target?.screen} initialNotice={target?.notice}
    progress={session} initialProgressWarning={saveError} />);
  const stop = () => { session?.flush(); instance.unmount(); };
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.once(signal, stop);
  try { await instance.waitUntilExit(); }
  finally {
    for (const signal of signals) process.off(signal, stop);
    session?.flush(); session?.dispose(); store?.close();
    if (saveError) { console.error(safeText(saveError)); process.exitCode = 1; }
  }
}
program.action(() => launch());
program.command('books').description('列出已导入教材').action(async () => {
  const { books, errors } = await listBooks(root());
  print(books.map(b => `${b.id}\t${b.title}\t${b.mode}\tPDF ${b.source?.totalPages ?? '未知'} 页`).join('\n') || '暂无教材，请使用 study import。');
  for (const error of errors) print(error);
});
program.command('import').description('导入逐页映射包，或显式导入 Legacy Preview')
  .option('--legacy <markdown>', '旧合并 Markdown，来源未映射')
  .option('--map <json>', '含实际物理页码和来源依据的逐页导入清单')
  .option('--id <id>', '预览教材 ID', 'math-preview').option('--title <title>', '预览标题')
  .option('--subject <subject>', 'math 或 logic', 'math').option('--pdf <pdf>', '为预览关联 PDF（不会建立块页码映射）')
  .action(async options => {
    if (!['math', 'logic'].includes(options.subject as string)) throw new Error('--subject 必须为 math 或 logic');
    const data = await importBook({ ...options, root: root() });
    print(`Import completed.\n${JSON.stringify(importReport(data), null, 2)}`);
  });
program.command('read <book> [section]').description('阅读教材；可指定章节别名或内容块 ID').action((book: string, section?: string) => launch(book, section));
program.command('resume [book]').description('恢复该教材或本教材目录最近一次阅读位置').action(async (id?: string) => {
  const store = progressStore(); let saved: ReadingProgress | null;
  try { saved = id ? store.get(id) : store.getLastRead(); }
  finally { store.close(); }
  if (!saved) { print(id ? `教材 ${id} 暂无学习进度，请先使用 study read ${id}。` : '暂无学习进度，请先在交互终端选择教材阅读。'); return; }
  await launch(saved.bookId, undefined, undefined, saved);
});
program.command('progress [book]').description('检查已保存位置；可查看内容更新前保留的进度历史')
  .option('--history', '查看指定教材的恢复历史').action((id: string | undefined, options: { history?: boolean }) => {
    const store = progressStore();
    try {
      if (options.history && !id) throw new Error('查看历史需要指定教材 ID');
      print(JSON.stringify(options.history ? store.history(id!) : id ? store.get(id) : store.getLastRead(), null, 2));
    } finally { store.close(); }
  });
program.command('search <keyword>').description('本地中文子串搜索，交互终端可选择结果跳转')
  .option('--book <id>', '限定教材').action(async (keyword: string, options: { book?: string }) => {
    if (!keyword.trim()) throw new Error('搜索词不能为空');
    const catalog = await listBooks(root()); const hits: SearchHit[] = [];
    const ids = options.book ? [options.book] : catalog.books.map(b => b.id);
    for (const id of ids) hits.push(...searchBook(await loadBook(root(), id), keyword));
    if (process.stdin.isTTY && process.stdout.isTTY) await launch(undefined, undefined, hits);
    else print(hits.map(h => `${h.bookId}\t${h.blockId}\t${h.source}\t${h.text}\n  study read ${h.bookId} ${h.blockId}`).join('\n') || '未找到结果');
  });
program.command('source <book> [pageOrBlock]').description('查看来源；数字参数为明确指定的 PDF 物理页码')
  .option('--open', '调用系统 PDF 查看器，必要时手动跳页').option('--image', '打开已核对的原页图像')
  .option('--page <number>', '跨页块选择哪张原页图像', Number)
  .action(async (id: string, query: string | undefined, options: { open?: boolean; image?: boolean; page?: number }) => {
    const book = await loadBook(root(), id);
    let imageBlock;
    if (options.page !== undefined && (!Number.isInteger(options.page) || options.page < 1)) throw new Error('--page 必须为正整数物理页码');
    if (query && /^\d+$/.test(query)) {
      const page = Number(query);
      if (!book.manifest.source || page < 1 || page > book.manifest.source.totalPages) throw new Error('页码超出实际 PDF 范围或没有关联 PDF');
      print(`请求查看 PDF 物理页 ${page} / ${book.manifest.source.totalPages}\nPDF：${book.manifest.source.pdfPath}\n这是显式指定的原始物理页，块级映射以核对后的来源记录为准。`);
      imageBlock = book.blocks.find(b => sourcePageNumbers(b).includes(page));
      if (options.image) options.page ??= page;
    } else {
      const block = query ? book.blocks.find(b => b.id === query) : book.blocks[0];
      if (!block) throw new Error('找不到内容块');
      print(describeSource(book, block));
      imageBlock = block;
    }
    if (options.open) print(await openPdf(book));
    if (options.image) {
      if (!imageBlock) throw new Error('没有已核对的原页图像');
      await openPageImage(root(), book, imageBlock, options.page);
      print('已请求系统打开原页图像');
    }
  });
const review = program.command('review').description('独立来源记录及校订候选/确认/撤销；不覆盖 OCR，不升级整块核验状态');
review.command('map <book>').requiredOption('--file <json>', '已对照 PDF 图像填写的来源清单').action(async (id: string, options: { file: string }) => {
  print(`来源记录已保存：${await registerSourceMap(root(), id, path.resolve(options.file))}\n来源核对不代表数学内容已核验。`);
});
review.command('propose <book> <block>').requiredOption('--before <text>', '精确原文').requiredOption('--after <text>', '替换文本')
  .requiredOption('--reason <text>', '校订原因').option('--start <offset>', '原始块内 UTF-16 起始位置', Number)
  .action(async (id: string, blockId: string, options: { before: string; after: string; reason: string; start?: number }) => {
    print(`校订候选：${await proposeCorrection(root(), id, { ...options, blockId })}\n尚未应用。核对原页后使用 review accept。`);
  });
review.command('accept <book> <proposal>').requiredOption('--reviewer <name>', '实际核对人/工具名称')
  .requiredOption('--reason <text>', '对照原页的确认依据').action(async (id: string, proposal: string, options: { reviewer: string; reason: string }) => {
    print(`校订确认：${await acceptCorrection(root(), id, proposal, options.reviewer, options.reason)}\n将在重新打开教材后生效；整块/整页仍未核验。`);
  });
review.command('revoke <book> <record>').requiredOption('--reviewer <name>', '撤销人').requiredOption('--reason <text>', '撤销原因')
  .action(async (id: string, record: string, options: { reviewer: string; reason: string }) => {
    print(`撤销记录：${await revokeEditorial(root(), id, record, options.reviewer, options.reason)}\n原始记录保留，重新打开教材后生效。`);
  });
review.command('history <book>').option('--json', '输出完整审计记录').action(async (id: string, options: { json?: boolean }) => {
  const { events, warnings } = await readEditorialEvents(root(), id);
  const book = await loadBook(root(), id);
  if (options.json) print(JSON.stringify({ events, warnings: [...warnings, ...book.editorialWarnings ?? []] }, null, 2));
  else print(`${events.map(e => `${e.id} · ${e.type} · ${e.createdAt} · ${e.type === 'mapping' ? `${e.bindings.length} 个块` : e.type === 'proposal' ? e.blockId : e.type === 'acceptance' ? e.proposalId : e.targetId}`).join('\n') || '暂无记录'}\n有效来源块：${book.blocks.filter(b => b.editorial?.source).length}\n已应用校订：${book.blocks.reduce((n, b) => n + (b.editorial?.corrections.length ?? 0), 0)}\n${book.editorialWarnings?.join('\n') ?? ''}`);
});
review.command('show <book> <block>').action(async (id: string, blockId: string) => {
  const book = await loadBook(root(), id); const block = book.blocks.find(b => b.id === blockId);
  if (!block) throw new Error('找不到内容块');
  print(`${describeSource(book, block)}\n\n阅读版本\n${readingContent(block)}\n\n${originalText(block)}`);
});
try { await program.parseAsync(); }
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const catalog = await listBooks(root()).catch(() => ({ books: [], errors: [] }));
    await render(<App root={root()} books={catalog.books} errors={catalog.errors} initialError={message}
      initialProgressWarning="当前为手动阅读，进度服务未启用；退出后可修复问题并重新启动。" />).waitUntilExit();
  }
  else console.error(safeText(`错误：${message}`));
  process.exitCode = 1;
}
finally {
  // Windows ConPTY 下 Ink 卸载后仍可能保留 stdin 的读取引用。
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdin.unref();
    // 阅读会话已冲刷进度并关闭数据库，Ink 已卸载；释放 ConPTY 残留句柄。
    process.exit(process.exitCode ?? 0);
  }
}
