import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { render } from 'ink-testing-library';
import { PDFDocument, rgb } from 'pdf-lib';
import React from 'react';
import { App } from '../dist/app/App.js';
import { registerSourceMap } from '../dist/app/editorial.js';
import { loadBook } from '../dist/app/library.js';
import { ProgressSession } from '../dist/app/progress.js';
import { SqliteProgressStore } from '../dist/infrastructure/progress-db.js';
import { importBook } from '../dist/preprocess/importer.js';

const scratch = path.resolve('data');
await mkdir(scratch, { recursive: true });
const temp = await mkdtemp(path.join(scratch, 'readme-demo-'));
const root = path.join(temp, 'library');
const stateFile = path.join(temp, 'state', 'progress.db');
const output = new URL('../docs/assets/', import.meta.url);

const escapeXml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const frame = app => stripVTControlCharacters(app.lastFrame() ?? '')
  .replace(/^PDF：[^\n]*\n[\s\S]*?(?=^原始 OCR：)/m, 'PDF：source-demo.pdf（省略本地路径）\n')
  .replace(/^(来源记录：[a-f0-9]{8})-[a-f0-9-]+$/m, '来源记录：本次演示生成（省略 ID）')
  .replace(/((?:editorial\/)?assets\/[a-f0-9]{12})[a-f0-9]{52}(?=\.png)/g, '$1…');

async function waitFor(app, expected) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (frame(app).includes(expected)) return frame(app);
    await delay(50);
  }
  throw new Error(`未截取到 ${expected}：\n${frame(app)}`);
}

function panel({ title, action, screen }) {
  const lines = screen.split('\n').map(line => line.trimEnd());
  const [heading, notice] = lines.splice(0, 2);
  const footer = lines.splice(-3);
  while (lines.at(-1) === '') lines.pop();
  const body = lines.map((line, index) => {
    const fill = /^(›|- 【答案】|原始 OCR|校订记录)/.test(line) ? '#91e9d7'
      : line.startsWith('提示：') ? '#f3ca80' : '#eef3fb';
    return `<text x="49" y="${153 + index * 26}" fill="${fill}">${escapeXml(line)}</text>`;
  }).join('\n');
  const boundary = 166 + lines.length * 26;
  return { height: boundary + 84, markup: `
    <text x="32" y="37" fill="#dce8f7" font-weight="700">${escapeXml(title)}</text>
    <text x="1008" y="37" fill="#91e9d7" text-anchor="end" font-size="14">${escapeXml(action)}</text>
    <path d="M1 53h1038 M32 ${boundary}h976" stroke="#324960"/>
    <text x="32" y="84" fill="#91e9d7" font-size="19" font-weight="700">${escapeXml(heading)}</text>
    <text x="32" y="109" fill="#aabbd1" font-size="14">${escapeXml(notice)}</text>
    <rect x="32" y="127" width="976" height="${boundary - 141}" rx="9" fill="#172840"/>
    ${body}
    ${footer.map((line, index) => `<text x="32" y="${boundary + 22 + index * 21}" fill="${index === 0 ? '#91e9d7' : '#b6c8dd'}" font-size="14">${escapeXml(line)}</text>`).join('\n')}` };
}

async function save(name, panels) {
  let y = 1;
  const markup = panels.map(data => {
    const item = panel(data);
    const result = `<g transform="translate(0 ${y})"><rect x="1" y="1" width="1038" height="${item.height - 2}" rx="16" fill="#0f1b2c" stroke="#324960" stroke-width="2"/>${item.markup}</g>`;
    y += item.height + 14;
    return result;
  }).join('\n');
  const height = y - 13;
  await writeFile(new URL(`demo-${name}.svg`, output), `<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="${height}" viewBox="0 0 1040 ${height}" role="img" aria-label="${escapeXml(panels.map(item => item.title).join(' / '))}">
<g font-family="Consolas, 'Microsoft YaHei', 'PingFang SC', 'Noto Sans Mono CJK SC', monospace" font-size="16" xml:space="preserve">
${markup}
</g>
</svg>
`);
}

try {
  await importBook({ root, id: 'starter', title: '数学阅读演示', legacy: 'examples/starter.md' });
  const book = await loadBook(root, 'starter');
  const indexOf = sample => {
    const index = book.blocks.findIndex(block => block.content.includes(sample));
    assert.ok(index >= 0, sample);
    return index;
  };
  const proseIndex = indexOf('把 26 张卡片');
  const exerciseIndex = indexOf('【例题】34 张卡片');
  const start = props => render(React.createElement(App, { root, books: [book.manifest], ...props }));
  const close = app => { app.unmount(); app.cleanup(); };

  const reader = start({ initialBook: book, initialIndex: proseIndex });
  try {
    await save('reading', [{ title: '01 / 纯文字阅读', action: '↑ ↓  翻读', screen: await waitFor(reader, '完整分组之后') }]);
    reader.stdin.write('r');
    await save('original', [{ title: '03 / 查看原文', action: 'R  原文与校订', screen: await waitFor(reader, '暂无已确认校订') }]);
    reader.stdin.write('\u001b');
    await waitFor(reader, 'N/B 块');
    reader.stdin.write('c');
    const chapters = await waitFor(reader, '↑↓ 章节');
    assert.match(chapters, /2\.2 整数分组练习/);
    await save('contents', [{ title: '05 / 章节目录', action: 'C  目录', screen: chapters }]);
    reader.stdin.write('s');
    await waitFor(reader, '搜索本地教材');
    reader.stdin.write('整数分组练习');
    await waitFor(reader, '> 整数分组练习');
    reader.stdin.write('\r');
    const results = await waitFor(reader, 'Enter 跳转');
    assert.match(results, /2\.2 整数分组练习/);
    await save('search', [{ title: '04 / 中文搜索结果', action: 'S  搜索「整数分组练习」', screen: results }]);
  } finally { close(reader); }

  const store = new SqliteProgressStore(stateFile, root);
  const session = new ProgressSession(store, err => { throw new Error(err); });
  const practice = start({ initialBook: book, initialIndex: exerciseIndex, progress: session });
  let savedScreen;
  try {
    savedScreen = await waitFor(practice, '【解析】');
    assert.match(savedScreen, /【答案】装满 5 盒/);
    await save('exercise', [{ title: '02 / 习题阅读', action: '题干 / 答案 / 解析', screen: savedScreen }]);
    practice.stdin.write('q');
  } finally { close(practice); session.dispose(); store.close(); }

  const reopened = new SqliteProgressStore(stateFile, root);
  const resumeSession = new ProgressSession(reopened, err => { throw new Error(err); });
  const home = start({ progress: resumeSession });
  try {
    const { blockId } = reopened.get('starter');
    assert.equal(blockId, book.blocks[exerciseIndex].id);
    await waitFor(home, 'L 继续上次阅读');
    home.stdin.write('l');
    const resumed = await waitFor(home, '已恢复上次阅读位置');
    assert.ok(resumed.includes(blockId));
    await save('resume', [
      { title: '06A / 阅读时自动存档', action: 'Q  退出', screen: savedScreen },
      { title: '06B / 重启后回到同一块', action: 'L  继续上次阅读', screen: resumed },
    ]);
  } finally { close(home); resumeSession.dispose(); reopened.close(); }

  const pdf = await PDFDocument.create();
  const passage = '26 cards, grouped into sets of 4.';
  const conclusion = 'Six full sets, with 2 cards remaining.';
  const ink = rgb(0.09, 0.19, 0.31);
  const pages = ['Reading with provenance', '01 / Group the cards', '02 / Count the remainder'].map((title, index) => {
    const page = pdf.addPage([600, 338]);
    page.drawRectangle({ x: 0, y: 0, width: 600, height: 338, color: rgb(0.96, 0.97, 0.99) });
    page.drawText('EXAM STUDY CLI  /  SOURCE DEMO', { x: 32, y: 301, size: 13, color: ink });
    page.drawText(title, { x: 32, y: 233, size: 32, color: ink });
    page.drawText(['An original three-page sample', passage, conclusion][index], { x: 32, y: 194, size: 17, color: ink });
    page.drawText(index ? `PRINTED PAGE ${index}  /  PDF PAGE ${index + 1}` : 'COVER  /  PDF PAGE 1', { x: 32, y: 28, size: 11, color: ink });
    return page;
  });
  pages[1].drawText('Continued on the next page', { x: 32, y: 132, size: 14, color: ink });
  pages[2].drawRectangle({ x: 32, y: 82, width: 536, height: 96, color: rgb(0.87, 0.92, 0.98) });
  for (const [index, label] of ['4', '4', '4', '4', '4', '4', '2 left'].entries()) {
    const x = 50 + index * 73;
    pages[2].drawRectangle({ x, y: 108, width: 56, height: 48, color: index === 6 ? rgb(0.55, 0.88, 0.78) : rgb(0.19, 0.34, 0.57) });
    pages[2].drawText(label, { x: x + 13, y: 125, size: 14, color: index === 6 ? ink : rgb(1, 1, 1) });
  }
  const pdfPath = path.join(temp, 'source-demo.pdf');
  const evidenceDir = path.join(temp, 'evidence');
  const python = process.env.DEMO_PYTHON || 'python';
  await writeFile(pdfPath, await pdf.save());
  execFileSync(python, ['scripts/render-source-pages.py', '--pdf', pdfPath, '--pages', '1-3', '--output', evidenceDir], { stdio: 'inherit' });
  execFileSync(python, ['-c', 'from PIL import Image; import sys; Image.open(sys.argv[1]).crop((64, 320, 1136, 512)).save(sys.argv[2])',
    path.join(evidenceDir, 'page-000003.png'), path.join(temp, 'cards.png')]);
  const markdown = path.join(temp, 'source-page.md');
  await writeFile(markdown, `${passage}\n${conclusion}\n![Card groups](cards.png)`);
  const sourceBook = await importBook({ root, id: 'source-demo', title: '教材来源演示', legacy: markdown, pdf: pdfPath });
  const block = sourceBook.blocks[0];
  const map = path.join(temp, 'source-map.json');
  await writeFile(map, JSON.stringify({
    schemaVersion: 1, bookId: 'source-demo', pdfSha256: sourceBook.manifest.source.sha256,
    pageEvidence: 'evidence/pages.json', reviewer: '演示样例', reason: '对照原创 PDF 两页，逐段登记来源。',
    mappings: [
      { fromBlock: block.id, pageNo: 2, printedPage: 1, start: 0, end: passage.length + 1 },
      { fromBlock: block.id, pageNo: 3, printedPage: 2, start: passage.length + 1, end: block.content.length },
    ],
  }));
  await registerSourceMap(root, 'source-demo', map);
  const mappedBook = await loadBook(root, 'source-demo');
  const source = start({ books: [mappedBook.manifest], initialBook: mappedBook });
  try {
    const reading = await waitFor(source, passage);
    source.stdin.write('p');
    const screen = await waitFor(source, '原始 OCR：raw/legacy.md');
    assert.match(screen, /物理页 2 \/ 印刷页 1/);
    assert.match(screen, /物理页 3 \/ 印刷页 2/);
    assert.match(screen, /核验状态：unverified/);
    await save('source', [{ title: '07 / 查看来源', action: 'P  来源 · O  打开 PDF', screen }]);
    source.stdin.write('2');
    const selected = await waitFor(source, '原页图选择：3');
    await save('source-selection', [
      { title: '按键前 / 第一个来源页', action: '物理页 2', screen },
      { title: '按 2 / 选中第二个来源页', action: '物理页 3', screen: selected },
    ]);
    source.stdin.write('\u001b');
    const returned = await waitFor(source, 'N/B 块');
    assert.equal(returned, reading);
    await save('source-return', [{ title: '返回原阅读位置', action: 'Esc  阅读', screen: returned }]);
    const [pageTwo] = mappedBook.blocks[0].editorial.source.spans;
    const bookDir = path.join(root, 'books', 'source-demo');
    const inlineAsset = mappedBook.blocks[0].content.match(/assets\/[a-f0-9]{64}\.png/)[0];
    await copyFile(path.join(bookDir, pageTwo.image), new URL('demo-source-page.png', output));
    await copyFile(path.join(evidenceDir, 'page-000001.png'), new URL('demo-source-pdf.png', output));
    await copyFile(path.join(bookDir, inlineAsset), new URL('demo-source-illustration.png', output));
  } finally { close(source); }
} finally {
  await rm(temp, { recursive: true, force: true });
}
