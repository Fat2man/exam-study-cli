# Phase 3：进度保存与恢复

## 使用

在交互终端阅读时自动保存。退出后可恢复最近阅读的教材或指定教材：

```powershell
node dist/cli/index.js
node dist/cli/index.js read math
node dist/cli/index.js resume
node dist/cli/index.js resume math
```

主页 L 也能继续最近阅读。`read math` 明确从教材开头阅读，`read math 2.2` 明确从该章节开始；它们会成为新的学习位置。如果要继续上次位置，请使用 resume 或主页 L。

## 保存时机

- 进入阅读、切换内容块、切换教材时同步保存小事务。
- 块内滚动防抖 250 ms；离开阅读、Q、Ctrl+C、应用正常卸载时冲刷当前待保存位置。
- CLI 收到 SIGTERM/SIGHUP 时尝试冲刷并卸载界面。强制终止进程、断电等无法保证最后 250 ms 内尚未落盘的滚动；已提交事务由 SQLite 保证原子性。
- 来源、原文、目录、搜索结果的滚动不计为正文进度。查看来源/原文再返回，会回到原正文滚动位置。
- 非交互 read/resume 只输出预览，不改变最近阅读或保存位置。books/search/source/review 不启动进度保存。

遇到暂时写入失败，界面显示“进度保存失败”，仍可翻读。T 重试。失败期间切换教材时，分别保留各书的待保存位置，重试按实际阅读顺序落盘。退出前仍失败会输出错误并返回非零退出码；原数据库和以前已保存的记录保留。

## 数据位置与隔离

Windows 默认：`%LOCALAPPDATA%\ExamStudy\progress.db`。非 Windows 默认：`~/.local/share/exam-study/progress.db`。

```powershell
node dist/cli/index.js --state-dir 'D:\我的学习状态' resume math
$env:EXAM_STUDY_STATE_HOME = 'D:\我的学习状态'
```

优先级为 `--state-dir`、`EXAM_STUDY_STATE_HOME`、平台默认位置。教材数据仍由 `--data-dir` / `EXAM_STUDY_HOME` 指定，未改变已有含义。

数据库按规范化教材根目录（realpath，Windows 不区分大小写）和教材 ID 联合隔离。同一个数据库可以同时存数学、逻辑及不同教材目录的同名 ID，互不覆盖。移动整个教材根目录会被视为新库，当前不做自动跨目录迁移。

## 恢复规则

保存块 ID、章节 ID/路径、可靠 PDF 物理页、正文滚动行、字符锚点、窗口宽度、原始块/展示内容指纹、教材版本及 PDF 身份。

1. PDF 身份变为另一本时不套用旧位置，回目录。
2. 优先原块 ID；同时检查教材版本指纹或原始块内容，避免重新分块后复用序号而跳到另一题。
3. 同一块展示因校订或提示而改变时从块首恢复，明确提示。窗口宽度变化时按原可见字符重新折行定位，再夹取到可用范围。
4. 原块失效后，寻找当前仍可靠映射到原 PDF 物理页的块；同页有完全相同原文时优先它，否则回到该页首块，并提示核对位置。
5. 没有可靠页码时尝试唯一、完整的章节标题路径；重名或失效则回目录，不按相近段落序号猜测。
6. 回目录期间不自动写成第一块。旧进度留在原记录，等手动选择新位置。

内容版本/展示内容改变后的首次新位置保存，会在同一事务中归档旧进度。恢复不是 OCR 核验，不会修改页码来源、原始文件、校订记录或内容 verified 状态。

检查当前位置和更新前的恢复历史：

```powershell
node dist/cli/index.js progress math
node dist/cli/index.js progress math --history
```

v1 数据缺少内容指纹时保留兼容恢复并提示核对位置；不声称旧记录具备新锚点的可靠性。教材文件丢失时报告错误，保留数据库记录，不偷偷换成其他教材。

## SQLite 实现与迁移

- 驱动为 better-sqlite3 12.4.1；当前 Windows / Node.js 22.16.0 已通过原生模块构建和实际读写验证。未改用 JSON 等替代存储。
- v1 建立 `reading_progress`（各教材当前位置）与 `recent_reading`（每教材目录一个最近阅读引用）。
- v2 增加恢复锚点 JSON 和 `progress_recovery_history`。`PRAGMA user_version` 标识版本，迁移在事务内完成，失败回滚。高于程序支持的版本明确拒绝。
- 启用 WAL、FULL 同步及 250 ms 锁等待；每次保存当前位置与最近阅读引用在同一事务内更新。恢复历史也与新位置一起提交。
- 数据库损坏、锁定、权限不足或迁移失败时不会删除或自动重建旧库。普通交互阅读可以降级运行，并明确说明无法保存。
- 备份时退出全部阅读实例后复制整个状态目录。数据库打开期间的已提交数据可能还在 `progress.db-wal` 中，不能只拷主文件当作完整备份。

当前不提供多实例间的位置合并；同时阅读同一本书时以最后成功保存的操作为准。不包含答题、书签、错题或复习队列数据。
