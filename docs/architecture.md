# Phase 0–2 架构

- `src/cli/index.tsx`：Commander 路由、参数、TTY / 非 TTY 分流、退出码。
- `src/app/App.tsx`：Ink 状态机（主页、教材、章节、阅读、搜索、结果、来源、错误），键盘、窗口 resize。只渲染当前块的可见行，不输出整章。
- `src/app/library.ts`：教材目录、包加载、章节别名消歧、中文子串搜索、来源追溯。
- `src/app/viewport.ts`：终端控制符清理、按显示宽度折行、滚动夹取；不修改保存的内容。
- `src/domain`：Zod 契约、章节语义分类。不依赖 Ink。
- `src/infrastructure`：Markdown AST、数学/GFM 语法、图片提取、PDF 元数据与 SHA-256。
- `src/preprocess`：显式运行的导入流水线；阅读不执行 OCR 或导入。

教材内容和用户学习状态分离。Phase 3 已引入 SQLite，数据库位于独立状态目录，教材包、来源与校订日志不承担进度存储。

目录列表只读取各包的 `manifest.json`。选书时加载并校验该书 `book.json`，视窗仅渲染当前内容块。当前仍是每书 JSON 索引，不是全书逐块磁盘分页；需要用完整教材再衡量内存、启动和搜索性能，未声称达成性能目标。

默认数据位于 `data/books/<bookId>`。导入使用同卷 `.import-<uuid>` 暂存目录，验证后重命名发布。读端忽略暂存目录；失败清理本次暂存。已有 ID 拒绝覆盖，故没有静默内容版本替换或进度丢失。当前内容版本为 1，解析结构变化后的跨版本匹配不在前三阶段交付范围。

Markdown 作为内容数据处理，终端只输出经过控制符清理的文本；不执行 HTML、代码块、命令或远程资源。图片只导入本地受限目录资源和白名单 Base64 图片，内容寻址去重。PDF 打开前重新校验源文件指纹；系统查看器仅接受独立传递的本地路径。

2026-11-09 增加 `src/app/editorial.ts`：不可变来源/校订事件、指纹校验、候选确认与撤销；`src/domain/editorial.ts` 定义事件协议与统一展示访问器。`loadBook` 在基础包验证后组合有效记录，目录和搜索复用同一阅读版本；R 提供原文及已应用校订，P/G 提供区间来源和原页图像。Python 渲染脚本仅作为独立、显式预处理命令，不参与 Node 日常阅读。未增加 SQLite 进度或题目系统。

2026-11-11 的 Phase 3 增加 `src/domain/progress.ts`、`src/infrastructure/progress-db.ts` 和 `src/app/progress.ts`：SQLite 迁移/事务仓储、内容身份与字符锚点恢复、按教材暂存的防抖保存会话。CLI 仅在交互阅读/resume/progress 时按需打开数据库，Ink 卸载与退出前同步冲刷并关闭。阅读器单独保留正文偏移，查看来源/原文不污染学习位置；无可靠恢复目标时停在目录，保留旧进度。仍不包含答案折叠或题目系统。
