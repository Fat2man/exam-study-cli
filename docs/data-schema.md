# 数据协议 v1

运行时定义位于 `src/domain/schema.ts`。

| 结构 | 保证 |
| --- | --- |
| BookManifest | schemaVersion、id、subject、formal/legacy-preview、contentVersion、时间戳；正式包必须有实际 PDF 路径、SHA-256 和读取的总页数 |
| PageRecord | 正式包每个导入物理页独立记录；1-based pageNo，不连续页允许；printedPage 独立可空；OCR 版本及选定 tier；导入初始 needs_review |
| SourceLocation | 映射来源为 `mapping: mapped` + 物理页 + evidence；预览为 `mapping: unmapped` + `pageNo: null` + 原 OCR 快照；明确的判别联合 |
| ContentBlock | 原文、类型、顺序、章节、来源、核验状态、告警、内容版本，以及原始 OCR 的 UTF-16 `[start,end)` offset |
| SectionNode | 知识结构与 PDF 页面分离；按讲/节/考点/知识点/母题语义建树；父节点包含后代块引用，跨页延续章节 |
| StudyQuestion | 仅预留题型/条件充分性/选项/答案/解析/来源/核验类型契约，没有提取、折叠或判分服务 |

`unverified`：未人工核对，可阅读，不可自动判分。`verified`：须人工与原 PDF 核对，导入器不会生成。`rejected`：已判定不可靠，阅读时突出回源提示，不得用于正式刷题。看到 `【答案】`、OCR 完成、来源页码存在或无诊断告警，都不构成核验。

`formal` 表示导入的是有逐页证据的来源映射，**不表示 OCR 正确或已转换全书**。报告中的 pages 是实际成功导入的页数，总页数来自 PDF 元数据。

包级校验拒绝重复物理页/块 ID、越界页、错误教材 ID、未映射正式内容、伪造预览页码、错误页面块引用、章节不存在的块引用及倒置原文区间。

内容 ID 为 `bookId:pageNo:sequence`；预览显式使用 `bookId:legacy:sequence`。不以全文 hash 作为身份。原文 offset、source、order、contentVersion 和快照用于将来位置迁移；块数改变时不能保证序列 ID 跨版本稳定。当前拒绝覆盖旧 ID，不自动清空数据。

教材目录包含 `manifest.json`、`book.json`、`raw/`、`clean/`、`assets/`、`provenance.json`、`report.json`；正式导入另存原始 `mapping.json`。原始 OCR 快照保留输入文本换行和数学表达式，图片替换仅发生在 clean/块内容中。

## 独立来源与校订层（2026-11-09）

`src/domain/editorial.ts` 定义 mapping/proposal/acceptance/revoke 事件，单独保存于 `editorial/events/<uuid>.json`，图像证据位于 `editorial/assets/`。事件绑定基础教材包/PDF 指纹；来源事件还绑定块内容和原始 OCR 快照指纹、每个来源区间与物理页/印刷页及图像指纹。

基础 `SourceLocation`、PageRecord 和 Legacy Preview 校验保持不变。读端先校验基础包，再添加只存在于内存中的 `ContentBlock.editorial`，不写回 `book.json`。已核对的跨页来源通过 spans 保留多个 `[start,end)`；未应用记录会出现在 `editorialWarnings`。Legacy Preview 的来源补齐不自动把它变成正式逐页 OCR 包。

`readingContent` 是正文/目录标题/搜索共用的展示入口，`sourcePageNumbers`/`sourceLabel` 是来源展示入口。原始 `block.content` 始终保留。确认校订只作用于精确区间，不把整块标为 verified；重叠校订拒绝，失效或撤销时回退原文。详见 source-review.md。

## Phase 3 进度（2026-11-11）

`src/domain/progress.ts` 定义 ReadingProgress 和恢复锚点，SQLite schema v2 使用 `(library_key, book_id)` 联合主键；当前记录、最近阅读引用和变更前历史均属于用户状态，不写进上述教材协议。章节/物理页仅用于位置恢复，不代表核验完成；跨页来源保存真实页数组，没有来源时 pageNo 为空，不伪造 0 或段落页码。详见 progress.md。
