# 安装与使用指南

## 1. 安装与构建

在仓库根目录执行。运行需要 Node.js 22.16.0 或以上版本，锁文件使用 pnpm 10.20.0。如果没有 pnpm，可先运行 `npm install --global pnpm@10.20.0`。如果系统已有 Corepack，也可用 `corepack pnpm` 替代命令中的 `pnpm`；首次下载依赖需要网络。

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
node dist/cli/index.js --help
```

下文均使用构建产物。开发时可将命令前缀 `node dist/cli/index.js` 换成 `pnpm dev`。

## 2. 体验完整阅读流程

```sh
node dist/cli/index.js import --legacy examples/starter.md --id starter --title "数学阅读演示"
node dist/cli/index.js books
node dist/cli/index.js read starter 1.1
node dist/cli/index.js search "循环小数" --book starter
node dist/cli/index.js resume starter
node dist/cli/index.js progress starter
```

执行 `read` 或 `search` 进入交互界面后，先按 `Q` 退出，再执行下一条命令。在搜索输入框内，`Q` 是普通输入；先按 `Esc` 离开输入框。`read` 的第二参数可以是章节别名、完整章节 ID 或内容块 ID，不是 PDF 页码。`read` 显式选择起点，`resume` 才会读取保存的进度。

| 界面 | 操作 |
| --- | --- |
| 首页 / 列表 | `Enter` 打开，`↑` / `↓` 选择，`Esc` 返回，首页 `L` 续读。 |
| 阅读 | `↑` / `↓` 滚动，`Page Up` / `Page Down` 翻屏；滚完一块再向下会跨块。`N` / `B` 直接切块。 |
| 导航与核对 | `C` 目录，`S` 搜索，`P` 来源，`R` 查看原文和校订。 |
| 来源 | 有对应证据时，`G` 打开原页图像，`1`–`9` 选择跨页图像；`O` 打开关联 PDF，`I` 查看块内插图。 |
| 退出 | `Q` 或 `Ctrl+C`。如果进度保存失败，阅读界面可按 `T` 重试。 |

## 3. 导入自己的资料

**只有 Markdown，或 OCR 没有可靠页界？** 用 Legacy Preview；即使加上 `--pdf`，也只是关联 PDF，不会自动补页码。请使用有权使用的资料。

```sh
node dist/cli/index.js import --legacy my-notes.md --id my-notes --title "我的笔记"
node dist/cli/index.js import --legacy my-ocr.md --id my-preview --pdf my-material.pdf
```

**已有可靠的逐页 OCR？** 在 CLI 外生成逐页文件，再创建导入清单。以下路径以清单所在目录为准；`pageNo` 是从 1 开始的 PDF 物理页，不是印在书上的页号。

```json
{
  "schemaVersion": 1,
  "bookId": "my-pages",
  "title": "我的逐页教材",
  "subject": "math",
  "pdf": "my-material.pdf",
  "pages": [
    { "pageNo": 1, "markdown": "pages/page-000001.md", "evidence": "与 PDF 第 1 个物理页对照得到的 OCR 输出" }
  ]
}
```

```sh
node dist/cli/index.js import --map mapping.json
node dist/cli/index.js source my-pages 1 --open
node dist/cli/index.js review --help
```

相同教材 ID 不会被覆盖。`source` 可查看物理页或按块 ID 检查来源；系统 PDF 查看器不保证自动跳转。`review map` 登记图像证据，`propose` 提交候选，`accept` 核对后应用，`revoke` 撤销，`history` / `show` 查看记录。映射页码和校订个别文字都不代表整页或数学结论已核验。详见 [教材包协议](data-schema.md)。

## 4. 数据位置与故障排查

| 数据 | 默认位置 | 如何指定 |
| --- | --- | --- |
| 教材包 | 工作目录下的 `data/books/` | `--data-dir <路径>` 或 `EXAM_STUDY_HOME`。 |
| 学习状态 | Windows：`%LOCALAPPDATA%\ExamStudy\progress.db` | `--state-dir <路径>` 或 `EXAM_STUDY_STATE_HOME`，详见 [进度文档](progress.md)。 |

- **`pnpm` 找不到**：先安装固定版本，重新打开终端后检查 `pnpm --version`。
- **`better-sqlite3` 原生模块加载失败**：确认 Node.js 版本与架构，使用同一 Node 版本重新安装依赖；若没有对应的预编译二进制，再检查本机编译工具链。
- **教材列表为空**：确认已成功导入，并在读写时使用同一教材数据目录；也可用 `--data-dir` 固定路径。
- **只有文本预览、不记录进度**：避免把 `read` / `resume` 输出重定向或通过管道运行，改用支持 TTY 的终端。
- **位置未恢复或来源不可用**：先看 `progress <教材ID> --history` 或 `source <教材ID> <块ID>`；不要把推测页码录作证据。
