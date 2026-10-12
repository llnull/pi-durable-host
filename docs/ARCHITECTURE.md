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

### 审计条目（host.config）

`defineEntry("host.config")` 创建自定义 entry kind：无 `model` 字段 → `contribute()` 零贡献，
天然不进模型 context；只进 transcript 账本（回放可见、随 fork 复制、随 reset 剪裁）。
事务注意：`conv.commit` 回调内必须 `await` 全部 Tx 操作，`void tx.appendEntry(...)` 会报
"settled before its pending Tx operations"。

### 性能实测基线（277 entries 会话）

| 指标 | 优化前 | 优化后 |
|---|---|---|
| 生成期 SSE 帧 | 753KB/帧 | ~40B–1.4KB（-99.8%） |
| /api/state | 745KB | light 1.2KB；gzip 1.05MB→281KB（-26.6%） |
| UI 重渲染 | 每 120ms 全量 markdown 重解析 | run 级增量，历史 run 零解析 |
