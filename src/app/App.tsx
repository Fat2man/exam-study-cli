import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { BookManifest, BookPackage } from '../domain/schema.js';
import { describeSource, flattenSections, loadBook, openImage, openPageImage, openPdf, searchBook, type SearchHit } from './library.js';
import { originalText, readerText, singleLine, viewport } from './viewport.js';
import { sourceLabel, sourcePageNumbers } from '../domain/editorial.js';
import { progressAt, resolveProgress, type ProgressSession } from './progress.js';

type Screen = 'home' | 'books' | 'chapters' | 'reader' | 'search' | 'results' | 'source' | 'original' | 'error';
export interface AppProps {
  root: string; books: BookManifest[]; errors?: string[];
  initialBook?: BookPackage; initialIndex?: number; initialError?: string;
  initialHits?: SearchHit[];
  initialOffset?: number; initialScreen?: 'reader' | 'chapters'; initialNotice?: string;
  progress?: ProgressSession; initialProgressWarning?: string;
}
export function App({ root, books, errors = [], initialBook, initialIndex = 0, initialError, initialHits,
  initialOffset = 0, initialScreen = 'reader', initialNotice = '', progress, initialProgressWarning = '' }: AppProps) {
  const { exit } = useApp(); const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  const [screen, setScreen] = useState<Screen>(initialError ? 'error' : initialHits ? 'results' : initialBook ? initialScreen : 'home');
  const [book, setBook] = useState(initialBook);
  const [index, setIndex] = useState(initialIndex);
  const [selected, setSelected] = useState(0);
  const [offset, setOffset] = useState(initialOffset);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>(initialHits ?? []);
  const [message, setMessage] = useState(initialError ?? '');
  const [busy, setBusy] = useState(false);
  const [readerBack, setReaderBack] = useState<'chapters' | 'results'>('chapters');
  const [sourcePageIndex, setSourcePageIndex] = useState(0);
  const [progressWarning, setProgressWarning] = useState(initialProgressWarning);
  const [progressNotice, setProgressNotice] = useState(initialNotice);
  const readerOffset = useRef(initialOffset);
  const columns = Math.max(4, size.columns - 1);
  const height = Math.max(1, size.rows - 6);
  const block = book?.blocks[index];
  const readerView = screen === 'reader' && block ? viewport(readerText(block), columns, height, offset) : undefined;
  const sections = book ? flattenSections(book.sections) : [];
  useEffect(() => {
    const resize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on('resize', resize); return () => { stdout.off('resize', resize); };
  }, [stdout]);
  useEffect(() => progress?.subscribe(setProgressWarning), [progress]);
  useEffect(() => {
    if (screen !== 'reader' || !book || !block) return;
    const actual = viewport(readerText(block), columns, height, offset).offset;
    readerOffset.current = actual;
    progress?.schedule(progressAt(book, index, actual, columns, height));
  }, [screen, book, block, index, offset, columns, height, progress]);
  useEffect(() => () => { progress?.flush(); }, [progress]);
  const move = (next: Screen) => {
    if (screen === 'reader') { readerOffset.current = readerView?.offset ?? offset; progress?.flush(); }
    setScreen(next); setSelected(0); setOffset(next === 'reader' && (screen === 'source' || screen === 'original' || screen === 'search') ? readerOffset.current : 0); setMessage('');
  };
  const fail = (error: unknown) => { setMessage(error instanceof Error ? error.message : String(error)); setScreen('error'); setBusy(false); };
  const run = (work: () => Promise<void>) => { setBusy(true); void work().catch(fail).finally(() => setBusy(false)); };
  const sourcePages = block ? sourcePageNumbers(block) : [];
  const source = book && block ? `${block.editorial?.source ? `原页图选择：${sourcePages[sourcePageIndex] ?? sourcePages[0]}（1–${Math.min(9, sourcePages.length)} 选择，G 打开）\n` : ''}${describeSource(book, block)}` : '';
  let body = '';
  let footer = 'Enter 教材 · L 继续上次 · S 搜索 · Q 退出';
  let items: string[] = [];
  if (screen === 'home') body = `Exam Study CLI\n\n${books.length} 本本地教材\n${books.length ? 'Enter 选择教材 · L 继续上次阅读' : '暂无教材。先运行 import --help 查看导入方式。'}\n\n阅读 / 搜索 / 来源 / 进度恢复\nOCR 未核验，不提供自动判分。\n${errors.join('\n')}`;
  if (screen === 'books') { items = books.map(b => `${b.id} · ${b.title} · ${b.mode === 'formal' ? '逐页映射' : 'Legacy Preview / 来源未映射'}`); footer = '↑↓ 选择 · Enter 章节 · Esc 主页 · Q 退出'; }
  if (screen === 'chapters') { items = sections.map(s => `${'  '.repeat(Math.min(4, s.level - 1))}${s.title}`); footer = '↑↓ 章节 · Enter 阅读 · S 搜索 · Esc 教材'; }
  if (screen === 'results') { items = hits.map(h => `${h.bookId} · ${h.source} · ${h.text}`); footer = '↑↓ 结果 · Enter 跳转 · Esc 返回 · Q 退出'; }
  if (items.length) {
    const first = Math.max(0, Math.min(selected - Math.floor(height / 2), items.length - height));
    body = items.slice(first, first + height).map((item, i) => `${first + i === selected ? '›' : ' '} ${singleLine(item, columns - 2)}`).join('\n');
  } else if (screen === 'books' || screen === 'chapters' || screen === 'results') body = '没有可用内容。Esc 返回';
  if (readerView) {
    body = readerView.lines.join('\n');
    footer = '↑↓/PgUp/Dn 翻读 · N/B 块 · C 目录 · P 来源 · R 原文 · S 搜索 · Esc 返回';
  }
  if (screen === 'search') { body = `搜索本地教材（子串匹配）\n> ${query}\n\nEnter 搜索 · Esc 返回`; footer = '输入关键词，中文可直接粘贴'; }
  if (screen === 'source') { body = viewport(`${source}\n\n${message}`, columns, height, offset).lines.join('\n'); footer = '↑↓ 滚动 · G 原页图 · 1–9 选页 · O PDF · I 插图 · Esc 阅读'; }
  if (screen === 'original' && block) { body = viewport(originalText(block), columns, height, offset).lines.join('\n'); footer = '↑↓/PgUp/Dn 滚动原文与校订记录 · Esc 阅读'; }
  if (screen === 'error') { body = viewport(`无法完成操作\n${message}`, columns, height, offset).lines.join('\n'); footer = '↑↓ 滚动 · Esc 主页 · Q 退出'; }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { progress?.flush(); exit(); return; }
    if (input.toLowerCase() === 'q' && screen !== 'search') { progress?.flush(); exit(); return; }
    if (busy) return;
    if (key.escape) {
      if (screen === 'source' || screen === 'original') move('reader');
      else if (screen === 'reader') move(readerBack);
      else if (screen === 'chapters') move('books');
      else if (screen === 'search') move(book ? 'reader' : 'home');
      else move('home');
      return;
    }
    if (screen === 'search') {
      if (key.return) {
        if (!query.trim()) return;
        run(async () => {
          const results: SearchHit[] = [];
          for (const manifest of books) results.push(...searchBook(await loadBook(root, manifest.id), query));
          setHits(results); move('results');
        });
      } else if (key.backspace || key.delete) setQuery(q => Array.from(q).slice(0, -1).join(''));
      else if (!key.ctrl && !key.meta && input && !/[\x00-\x1f\x7f]/.test(input)) setQuery(q => q + input);
      return;
    }
    if (input.toLowerCase() === 't' && progress) { progress.flush(); return; }
    if (screen === 'home' && input.toLowerCase() === 'l') {
      if (!progress) { setProgressWarning(initialProgressWarning || '进度服务不可用，请先手动选择教材。'); return; }
      run(async () => {
        const saved = progress.store.getLastRead();
        if (!saved) { setProgressNotice('暂无已保存进度，请先选择教材开始阅读。'); return; }
        const nextBook = await loadBook(root, saved.bookId);
        const target = resolveProgress(nextBook, saved, columns, height);
        setBook(nextBook); setIndex(target.index); setOffset(target.offset); readerOffset.current = target.offset;
        setScreen(target.screen); setSelected(0); setReaderBack('chapters'); setProgressNotice(target.notice);
      });
      return;
    }
    if (input.toLowerCase() === 's' && screen !== 'source' && screen !== 'original' && screen !== 'error') { setQuery(''); move('search'); return; }
    if (screen === 'home' && key.return) { move('books'); return; }
    if (screen === 'reader') {
      if (input.toLowerCase() === 'n' || input.toLowerCase() === 'b') {
        setProgressNotice('');
        setIndex(i => Math.max(0, Math.min((book?.blocks.length ?? 1) - 1, i + (input.toLowerCase() === 'n' ? 1 : -1)))); setOffset(0);
      }
      if (input.toLowerCase() === 'p') { setSourcePageIndex(0); move('source'); }
      if (input.toLowerCase() === 'r') move('original');
      if (input.toLowerCase() === 'c') move('chapters');
    }
    if (screen === 'source' && book && block) {
      if (/^[1-9]$/.test(input) && Number(input) <= sourcePages.length) { setSourcePageIndex(Number(input) - 1); setOffset(0); }
      if (input.toLowerCase() === 'g') run(async () => { const page = sourcePages[sourcePageIndex] ?? sourcePages[0]; await openPageImage(root, book, block, page); setMessage(`已请求系统打开 PDF 物理页 ${page} 的原页图像`); });
      if (input.toLowerCase() === 'o') run(async () => setMessage(await openPdf(book)));
      if (input.toLowerCase() === 'i') run(async () => { await openImage(root, book, block); setMessage('已请求系统打开本地图片'); });
    }
    if (['reader', 'source', 'original', 'error'].includes(screen)) {
      const text = screen === 'reader' && block ? readerText(block) : screen === 'original' && block ? originalText(block) : screen === 'source' ? `${source}\n\n${message}` : `无法完成操作\n${message}`;
      const view = viewport(text, columns, height, offset);
      const delta = key.pageDown ? height : key.pageUp ? -height : key.downArrow ? 1 : key.upArrow ? -1 : 0;
      if (delta) {
        if (screen === 'reader') setProgressNotice('');
        if (screen === 'reader' && book && delta > 0 && view.offset === view.maxOffset && index < book.blocks.length - 1) {
          setIndex(index + 1); setOffset(0);
        } else if (screen === 'reader' && book && delta < 0 && view.offset === 0 && index > 0) {
          // 从块顶向前阅读时落到上一块末屏，不跳过长题干的尾部。
          const previous = viewport(readerText(book.blocks[index - 1]!), columns, height, 0);
          setIndex(index - 1); setOffset(previous.maxOffset);
        } else setOffset(Math.max(0, Math.min(view.maxOffset, view.offset + delta)));
      }
      return;
    }
    if (key.upArrow) setSelected(i => Math.max(0, i - 1));
    if (key.downArrow) setSelected(i => Math.min(Math.max(0, items.length - 1), i + 1));
    if (key.return && screen === 'books' && books[selected]) run(async () => { setBook(await loadBook(root, books[selected]!.id)); setIndex(0); move('chapters'); });
    if (key.return && screen === 'chapters' && sections[selected] && book) {
      setIndex(Math.max(0, book.blocks.findIndex(b => b.id === sections[selected]!.blockIds[0])));
      setReaderBack('chapters'); move('reader');
    }
    if (key.return && screen === 'results' && hits[selected]) run(async () => {
      const hit = hits[selected]!; const nextBook = await loadBook(root, hit.bookId);
      setBook(nextBook); setIndex(nextBook.blocks.findIndex(b => b.id === hit.blockId)); setReaderBack('results'); move('reader');
    });
  });
  const label = block && (screen === 'reader' || screen === 'source' || screen === 'original')
    ? `${index + 1}/${book!.blocks.length} · ${sourceLabel(block)} · ${block.verification}${block.editorial?.corrections.length ? ' · 已校订' : ''}`
    : screen;
  if (size.rows < 6 || size.columns < 12) return <Text>{singleLine('终端太小，请扩大；Q 退出', columns)}</Text>;
  return <Box flexDirection="column" width={columns}>
    <Text color="cyan">{singleLine(`${book?.manifest.title ?? 'Exam Study CLI'} · ${label}`, columns)}</Text>
    <Text color="yellow">{singleLine(book?.editorialWarnings?.length ? `来源/校订记录告警 ${book.editorialWarnings.length} 项，按 P 查看；未通过检查的记录不应用` : 'OCR 未核验；公式保留 LaTeX 原文；不提供自动判分', columns)}</Text>
    <Box height={height} flexDirection="column"><Text wrap="wrap">{body}</Text></Box>
    <Text color={progressWarning ? 'red' : undefined} dimColor={!progressWarning}>{singleLine(progressWarning || progressNotice || (progress ? '进度自动保存 · T 重试保存' : '本地阅读'), columns)}</Text>
    <Text dimColor>{singleLine(busy ? '正在读取本地文件…' : footer, columns)}</Text>
    <Text dimColor>{singleLine(readerView && block ? `${block.id} · 正文行 ${readerView.offset + 1}–${Math.min(readerView.total, readerView.offset + height)}/${readerView.total}${readerView.offset === readerView.maxOffset ? index < book!.blocks.length - 1 ? ' · ↓/PgDn 下一块' : ' · 已到全书末尾' : ''}${index === 0 && readerView.offset === 0 ? ' · 全书开头' : ''}` : `${items.length ? `${selected + 1}/${items.length}` : ''} · 本地离线`, columns)}</Text>
  </Box>;
}
