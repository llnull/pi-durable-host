# 架构（ARCHITECTURE）

面向贡献者/维护者的实现说明。使用方法见 [README](../README.md)。

## 设计原则

- **复用而非重造**：模型配置完全复用 pi CLI；fork/压缩/steer 语义全部走 pi-durable 库 API，host 只做注册与展示
- **不编造数据**：费率未知就不显示金额；重试/压缩状态如实呈现
- **账本与 context 分离**：审计用自定义 entry（`host.config`），只进 transcript 不进模型 context
- **可恢复优先**：一切状态入 SQLite，重启靠 resume 而非约定 UI 状态

## 目录结构与各文件职责

源码：

| 路径 | 职责 |
|---|---|
| `host.js` | CLI 入口（ask/history/context/wait/status/tasks/sessions/approve/backup/timing/restart/serve/config） |
| `lib/server.js` | 常驻 daemon：HTTP + SSE 增量推送 + REST API |
| `lib/ui.html` | Web UI（单文件，无构建步骤；单 script 块） |
| `lib/models.js` | 模型层（复用 `~/.pi/agent` 配置；PI_DURABLE_PROVIDER → settings → models.json → auth.json 选型） |
| `lib/extensions.js` | 自建扩展：host-project-context（AGENTS.md 注入）/ host-guard（审批流）/ host-team（subagent 工具） |
| `lib/sessions.js` | 命名会话 ↔ conversation 映射 |
| `lib/approvals.js` | 批准/待批清单（guard / CLI / daemon / UI 共用；tmp-file + rename 原子写） |
| `lib/judge.js` | judge 子系统（issue #70）：三原语 noul/choice/score + provider 抽象（heuristic 内置 / system-one HTTP）+ 降级 + 审计 |
| `lib/backup.js` | VACUUM INTO 快照 |
| `lib/lock.js` | 单写者锁（PID 存活检查，崩溃遗留锁自动接管） |
| `lib/daemon.js` | serve.json 发现 + CLI→daemon HTTP 转发 |
| `lib/format.js` | CLI 输出格式化（本地直连与 daemon 转发输出一致） |
| `test/` | node:test 单测（guard 纯函数等；零新依赖） |

运行时数据（`data/`，不入库）：

| 路径 | 说明 |
|---|---|
| `session.sqlite` | pi-durable 持久化存储（WAL） |
| `host.lock` | 单写者锁（记录 PID） |
| `serve.json` | daemon 运行信息（pid/port/host），CLI 据此转发 |
| `sessions.json` | 会话名 ↔ conversation 映射 |
| `approvals*.json` | 批准清单 / 待批清单（`-pending` 为 guard 拦截记录） |
| `tool-timing.log` / `serve.log` | 日志（1MB 轮转保 `.1`） |
| `backups/` | 备份快照（默认保留 20 份） |
| `restart.marker` | /api/restart 15s 防抖窗口标记 |
| `workspace/` | agent 工具的默认 cwd |

## 关键机制

### 单写者与转发

pi-durable 存储无跨进程锁。`lib/lock.js` 用 `data/host.lock`（记录 PID）实现互斥：持有者存活时其他进程拒绝启动，
已死时自动接管。serve 是推荐的长持有者；`lib/daemon.js` 读 `data/serve.json` 发现 daemon，
CLI 命令（ask/history/context/wait/status/tasks/sessions/approve/backup/config/restart）检测到 daemon 即转发 HTTP，
避免第二个存储连接。

### SSE 增量协议（issue #27，PR #30）

`diffFrames(oldView, newView)` 把一次 view 变化拆成多帧：`live`（仅 pi.live doc，流式主体，可丢弃）、
`entries`（仅新增 entry）、`docs`（其余 doc 变化）、结构变化（reset/compaction/head）回退全量 `view`。
慢消费者背压：live 帧单 client 缓冲 >256KB 丢弃，其余帧必达。`GET /api/state?light=1` 只回元数据（1.2KB 级）。
>4KB 的响应按 `Accept-Encoding: gzip` 即时压缩。

### UI 增量渲染（PR #31）

`runEls` 按 run 首条 entry id 缓存 DOM，`sig`（轮次号/条目数/展开态等指纹）变化才重建该 run；
`expanded`（localStorage）记录展开的 run；流式期间 rAF 合帧。历史 run 不重解析 markdown。

### 重启与三保险（issue #25 / #28）

热重启 = 派生 detached 后继（`serve --takeover`，最长等锁 60s）→ 优雅关闭 → 后继 `resume()`。
已知坑：daemon 停止时运行中的工具调用被 `killProcessTree` 按进程组 SIGKILL（nohup 只免 SIGHUP 不换进程组；
macOS 无 setsid），从工具里 nohup 的后台脚本会被一起杀——跨 daemon 存活的工作需独立会话 detached spawn，
或走 `/api/restart`（后继由 daemon 自身派生，不在工具进程树里）。
三保险：① 工具子进程携带 `PI_DURABLE_HOSTED_BY`/`PI_DURABLE_CONV` 标记，hosted 环境内 CLI `restart` 一律拒绝
（重放会再杀后继 daemon 形成循环）、`ask` 默认拒绝（followUp 环等死锁），仅 `--session` 旁路会话放行；
② `/api/restart` 15s 防抖窗口（`restart.marker`，跨世代生效、过期自愈）。

### Session 失败自灭与 pi.live 新信号（pi-durable 1.2.0）

任何 Storage 错误永久关闭 Session（此后一切调用/等待 reject `SessionFailed`，不重试；`StorageRejected` 已移除）。
daemon 在 SIGINT/SIGTERM 处理器旁注册 `harness.closed` 观察（Harness extends Session）：`reason === "failed"` 即
记日志、清 `serve.json`、非零码退出。不能走 stop()：它会 exit(0)，且 zombie 态下看门狗的 `catch {}`
会把 viewState 的持续 reject 吞掉，SSE 哑火但进程活着。优雅停止路径 resolve `{ reason: "closed" }` 不进此分支。
同批接入的 live 信号：`pi.live.compactionFailure`（压缩失败保留到下次成功出摘要，UI 实时区渲染，
此前这个失败无声）、`pi.live.nestedTools`（codemode 嵌套调用的运行态与 summary）。SSE 的 live 帧本就
携带整个 pi.live doc，新字段零协议改动自动到达。bash 非零退出从 throw 改为携带 exit_code 的错误结果
（guard 计时 wrap 的 finally 不受影响，screen 对 isError 结果本就跳过）。

### 特性开关（featureOn，issue #132）

`features.images`（默认开）/ `features.codemode`（默认关）：env（`PI_DURABLE_IMAGES` / `PI_DURABLE_CODEMODE`）
优先于 host.json features 段。两者都动态 import：Photon wasm 与 quickjs wasm 只在启用时加载。
images 初始化失败降级为原样透传（图片仍按模型限制返回），codemode 启用失败仅告警不阻塞启动——
与 judge 降级同一条原则：新特性永远不成为可用性单点。

### 审计条目（host.config）

`defineEntry("host.config")` 创建自定义 entry kind：无 `model` 字段 → `contribute()` 零贡献，
天然不进模型 context；只进 transcript 账本（回放可见、随 fork 复制、随 reset 剪裁）。
事务注意：`conv.commit` 回调内必须 `await` 全部 Tx 操作，`void tx.appendEntry(...)` 会报
"settled before its pending Tx operations"。

### judge 子系统（issue #70）

Jev-like（System One）类型化判断接入控制面：state 进、类型化决策出。与主对话模型的分工：
agent run 是数据面（autoregressive 生成、工具循环），judge 是控制面（高频、廉价、类型化判断），
两者完全解耦——判断不进 conversation context，fork/CTX 语义不受污染。

- **provider 双层**：`system-one` HTTP 端点（PI_DURABLE_JUDGE_URL，Jev/jevlike 兼容形状）失败
  自动降级 `heuristic`（内置规则），再不行返回 null——调用方走保守路径，安全功能永不禁用；
- **heuristic 如实定位**：规则判断、无概率语义；规则外返回 null 不装懂（对照：LLM 判断的
  概率输出天然可信度未知，规则判断的边界是显式的）；
- **挂载点**：guard（放行也审计 + 异步旁路独立判断）、忙时自动路由（opt-in）、run 体检
  （watch diff 检测 pi.live.run 消失；注意 async 函数同步段读不到当帧 lastView，需显式传值，
  这是 PR #75 修过的竞态）；
- **审计**：data/judge-log.jsonl 全量（含降级事件），GET /api/judge/log 尾览；
- **置信路由原则**：高置信自动 / 低置信转人工 / 破坏性操作永远人工——阈值缩放随风险，
  不随 judge 自信程度（校准未验证前尤其如此）。

### 性能实测基线（277 entries 会话）

| 指标 | 优化前 | 优化后 |
|---|---|---|
| 生成期 SSE 帧 | 753KB/帧 | ~40B–1.4KB（-99.8%） |
| /api/state | 745KB | light 1.2KB；gzip 1.05MB→281KB（-26.6%） |
| UI 重渲染 | 每 120ms 全量 markdown 重解析 | run 级增量，历史 run 零解析 |
