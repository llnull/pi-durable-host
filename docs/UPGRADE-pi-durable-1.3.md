# pi-durable 1.1.0 → 1.3.0 同步升级方案

> **执行状态（issue #132）**：P0 全部完成；P1 两项完成（daemon 自灭 + compactionFailure/nestedTools UI 呈现）；
> images 默认开启、codemode opt-in（`PI_DURABLE_CODEMODE=1`）均已接入；单测 74/74 绿；冒烟全过
> （v2 迁移、旧会话读取、ask/bash 工具、subagent、codemode 嵌套调用、热重启、SSE、Session 失败信号、
> timing 记录）。P2 的 sqlite prefix 迁表与后续项保持待办。

上游 `@earendil-works/pi-durable` 已从 1.1.0（本 host 当前锁定）发布到 1.3.0（2026-10-15）。
本文评估影响面并给出升级 runbook。配套依赖同步抬升：`pi-ai` 1.1.0→1.3.0、`chord` 1.1.0→1.3.0
（pi-durable 1.3.0 精确依赖这两个包的 1.3.0，host 自己的 range 必须跟着抬，避免双版本共存）。

## 一、影响面评估

### P0 必改（不改则坏）

| # | 位置 | 变更（1.2.0 breaking） |
|---|---|---|
| 1 | `lib/extensions.js` `screenTool` | `ToolExecutionResult.content` → `output`：读取处 `result.content ?? ""` 改 `result.output ?? ""`；block 模式替换结果时写 `output` 字段（`structuredOutput` 经 `...result` 保留不动） |
| 2 | `lib/extensions.js` subagent 工具 | 3 处 `return { content: [...] }` → `{ output: [...] }` |
| 3 | `test/screen.test.js` | mock execute 返回值与断言的 `content` 同步改 `output` |
| 4 | `package.json` | 三个 `@earendil-works/*` 依赖 ^1.1.0 → ^1.3.0，重锁 package-lock |

已核对：host 用到的其余 API 签名全部兼容——`createRegistry / defineEntry / defineExtension /
defineTool / hook / section / wrapTool / configure / Harness.open / root / conversation / submit /
wait / agent / configure / fork / entries / viewState / watch / commit / scanConversations /
createConversation / appendEntry / entry / details` 均未变。`StorageRejected` host 未引用。
Node engines `>=22.19.0`，本机 v24.5.0 满足。

### P1 建议改（配 daemon 既有健壮性议题）

1. **daemon 感知 Session 失败并自灭**（1.2.0 新语义 + 新 API）
   - 新语义：任何 Storage 错误现在会让 Session 自闭，此后所有调用与 wait 一律 reject `SessionFailed`，不再重试。
   - 现状风险：daemon 的看门狗对比 `viewState` 时 `catch {}` 静默吞错——session 死后 daemon 变"进程活着但永远答错"的僵尸（正是 server.js 注释里担心的形态）。
   - 方案：`Harness extends Session`，直接 `harness.closed.then(end => ...)`：`reason === "failed"` 时记日志（含 `end.error`）、清 `serve.json`、`process.exit(1)`，让 takeover / supervisor 拉起后继。`WatchEnd` 也新增 `session_failed` reason，watch 链路同样可观测。
2. **呈现 `pi.live.compactionFailure`**（1.2.0 新增；此前压缩失败一度不可见）
   - live 帧的 data 就是整个 `pi.live` doc，`diffFrames` 协议免改，字段自动到达 UI；在 ui.html 状态条/结算单补一行渲染即可。符合本 host"如实呈现"原则。

### 行为变化，不改代码，冒烟验证

- **bash 非零退出**：由 throw 改为携带 `exit_code` diagnostic 的 error result。guard 计时 wrap 的 `finally` 仍计时；screen 对 `isError` 结果本来就跳过，语义等价；模型侧反而多拿到结构化退出码。
- **`pi.tool` v2 存储迁移**：`ToolTaskInput/Result` 变 tagged union（`kind: "model" | "nested"`），打开存储时自动迁移活着的 v1 任务。**单向迁移**——升级前必须先备份。
- display-only 提交立即 settle（host 未用，无影响）；`subscribeCommits/subscribeClose` 抛错改走 `onReport`（host 未直接用）。
- 首条 system / 压缩后 baseline 排序两轮修复（1.1.0 #10542、1.3.0 #10904）：Anthropic 类 provider 的 prompt cache 命中与请求形状改善，属正向收益。

### 免费收益（升级即得）

- 调度器性能：abort 级联 / 所有权索引 / 文档缓存按需保留（`documentRetentionMs` 默认 10min）——长驻 daemon 内存占用下降。
- 数组 append 提交成本：11.3s → 1.4s（32k 次追加基准）。
- 压缩不再把 thinking 计入摘要请求（此前可致 "prompt is too long" 连环失败）；阻塞阈值压缩失败现在让 run 以 `model_error` 显式失败而非裸发请求。
- `toBase64` 内存修复（3MiB 图片不再吃 140MB 堆）。
- 等待环检测、`onReport`/watch listener 异常隔离等多项正确性修复。

## 二、机会项（升级后按需立项，不阻塞本次）

| 优先级 | 项 | 说明 |
|---|---|---|
| P2 | `SqliteStorage.open(db, { prefix })`（1.3.0） | 把 `sessions.json` / `approvals*.json` 迁进 session.sqlite 的 `host_` 前缀表：单次备份覆盖全部状态、免 tmp-file+rename 原子写故事。`serve.json`/`host.lock` 保持文件（daemon 发现必须先于开库）。改动面：sessions.js / approvals.js / backup.js / diskguard.js |
| P2 | `createCodingTools({ images })` + `@earendil-works/pi-durable/images`（node worker 线程，30s 自退） | `read` 现可将 PNG/JPEG/GIF/WebP 作为图片块返回（不配 processor 也按模型限制原样返回）→ 多模态。先零配置验证再决定是否启用 Photon 预处理 |
| P3 | codemode 扩展（`createCodemodeExtension`） | 给 agent 加 JS 编排工具（nested calls + 重启回放）。host.json 开关 opt-in，注意 prompt 占用 |
| P3 | `structuredOutput` / deferred tools + tool-search / `InputEntry` 自定义入账 kind | 工具面小、暂无强需求；InputEntry 可作为未来 UI 消息审计的备选 |

## 三、升级 Runbook

1. **前置**：工作区干净提交；确认 daemon 已停（`node host.js status`，在跑先优雅停）；执行 `node host.js backup`（VACUUM INTO 快照，data/backups 保 20 份）。
2. **依赖**：`npm install @earendil-works/pi-durable@^1.3.0 @earendil-works/pi-ai@^1.3.0 @earendil-works/chord@^1.3.0`。新传递依赖 `pi-codemode` / `photon` / `diff` 均为懒加载，不启用对应特性则零成本。
3. **代码适配**：上表 P0 四项 + P1 两项（P1 可拆独立 PR，先合 P0）。
4. **单测**：`node --test test/` 全绿（screen/guard/dataset/sidecar/judge/diskguard/jev-timing/selftrain）。
5. **冒烟**（按序，每步看日志）：
   - 本地 `node host.js ask` 一次往返 —— 触发 `pi.tool` v2 迁移，确认无迁移报错；
   - `history` / `context` 读旧会话，dataset/selftrain 数据链路复算无异常（entries 层未变）；
   - `serve` 起 daemon：SSE 增量、审批流（block→approve→重试）、fork/reset、`/api/restart` 热重启；
   - subagent 委派一次（新 `output` 返回形状 + exactly-once 复用）；
   - 人为制造 storage 错误（如临时挪走 sqlite-wal）验证 daemon 按 P1-1 自灭退出。
6. **收尾**：README / ARCHITECTURE 更新涉及行为的段落（bash 退出码语义、压缩失败可见性、session 失败自愈）。
7. **回滚预案**：git revert 代码 + 从 data/backups 恢复 sqlite（v2 迁移单向，回退只能靠备份）。观察期建议至少保留升级前那份备份不轮转掉。

## 四、风险清单

| 风险 | 缓解 |
|---|---|
| `pi.tool` v2 迁移单向、迁移 bug 损数据 | 升级前强制 backup；迁移只在首个打开存储的进程发生，确保单进程执行 |
| `output` 改名漏改点 | 全仓 grep `\.content` 复核 + 单测覆盖（screen 三态 + subagent 路径） |
| session 失败新语义改变 daemon 故障形态 | P1-1 显式自灭 + 冒烟第 5 步人为触发验证 |
| pi-ai 1.3.0 与模型层（Ark relay / lazy api 模块）兼容性 | diff 极小（仅移除 `assistant-message-frame` 再导出，host 未用）；冒烟覆盖真实模型往返 |
