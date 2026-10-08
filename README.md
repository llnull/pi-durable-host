# Pi Durable 本机部署

`@earendil-works/pi-durable`（实验性，API 随版本变动）的本地 host：持久化会话跑在 SQLite 上，
模型走 Ark relay（anthropic-messages 协议），工具为 CodingTools（read / write / edit / bash），
外加 host 自建扩展（项目上下文 / 危险命令守卫 / 子代理）。

位置：`/mnt/d/ws/project/wsl-ws/ai/vibe-ws/pi-durable/`（Windows 盘 drvfs，SQLite WAL 已实测可用；
性能比 ext4 慢，重负载可考虑把 `data/` 挪回 ext4）

分析报告见 `pi-durable-report.html`（能力、目的与本地实现的完整分析）。

## 目录结构

| 路径 | 说明 |
|---|---|
| `host.js` | host CLI（ask / history / wait / status / tasks / approve / serve / config） |
| `lib/lock.js` | 单写者锁（PID 存活检查，崩溃遗留的锁自动接管） |
| `lib/extensions.js` | 自建扩展：host-project-context / host-guard / host-team（subagent） |
| `lib/server.js` | 常驻 daemon：HTTP + SSE 实时视图 + REST API |
| `lib/ui.html` | Web UI（会话实时视图、发送/转向/中止/压缩/重置/任务图） |
| `data/session.sqlite` | 持久化存储（WAL，进程崩溃可恢复） |
| `data/host.lock` | 单写者锁文件（存活期间持有，退出自动释放） |
| `data/approvals.json` | 危险命令批准清单（`approve` 命令维护，hook 每次调用实时读取） |
| `data/tool-timing.log` | 工具调用耗时日志（host-guard 的计时 wrap 追加） |
| `workspace/` | agent 工具的默认 cwd（bash/write/edit 在此工作） |

## 依赖

- Node >= 22.19（本机 v24.13.0；node:sqlite 有 ExperimentalWarning，可忽略）
- `@earendil-works/pi-durable` + `@earendil-works/pi-ai` + `@earendil-works/chord`（npm 已装）
- 环境变量 `ANTHROPIC_AUTH_TOKEN`（或 `ANTHROPIC_API_KEY`）——relay 令牌
- 可选 `ARK_BASE_URL` 覆盖 relay 地址（默认 `http://192.168.210.107:3000/api`）
- 可选 `PI_DURABLE_TOKEN` —— daemon API 鉴权令牌（绑定非回环地址时强烈建议设置）
- 可选 `PI_DURABLE_HOST` —— serve 默认监听地址（默认 `127.0.0.1`）

## 单写者模型（重要）

pi-durable 存储无跨进程锁：**一个存储同一时刻只能被一个进程打开**。
host.js 的每个命令都会持有 `data/host.lock`（记录 PID）直到退出；锁的持有者还活着时其他进程
拒绝启动，持有者已死时自动接管。**推荐姿势：跑一个 `serve` 常驻进程作为唯一持有者**，
其余一切（人、脚本、UI）通过它的 HTTP 接口使用；此时所有 CLI 命令都会被拒绝。

## 用法

```bash
cd /mnt/d/ws/project/wsl-ws/ai/vibe-ws/pi-durable

# 常驻 daemon（推荐）：Web UI + SSE 实时视图 + REST API
node host.js serve [端口=7600] [--host 127.0.0.1]
#   UI:        http://localhost:7600/
#   POST /api/ask      { content, whenBusy?: "followUp"|"steer"|"reject", wait?: bool, requestId? }
#   POST /api/steer → 用 /api/ask 的 whenBusy:"steer"
#   POST /api/abort    中止当前运行（后台任务不受影响）
#   POST /api/compact  { instructions? }
#   POST /api/reset    { note? }
#   POST /api/config   { cwd? / instructions? / model? }
#   GET  /api/state | /api/events(SSE) | /api/tasks | /api/usage

# 一次性 CLI（serve 运行时会被锁拒绝）
node host.js ask "..." [--fresh]  # 提交 prompt，等 run 结束，打印回答
                                  # 同内容重复 ask 幂等复用（requestId=内容哈希）；--fresh 强制新提交
node host.js history [n]          # 打印最近 n 条 transcript（默认 50）
node host.js wait [秒]            # 有未完成的 run（如上个进程被杀）时等它走完；开机/部署后先跑一次
node host.js status               # 会话状态：busy / 生成重试 / 工具 / 压缩 / inbox / agent / 用量 / 活任务
node host.js tasks                # 实时任务图（所有权、等待关系、后台标记）
node host.js approve -- <命令>    # 批准一条危险命令（--list 查看 / --revoke n 撤销）；daemon 运行中实时生效
node host.js config               # 把存储的 agent cwd/model 重置为本目录当前值（换目录后跑一次）
```

## 自建扩展（lib/extensions.js）

| 扩展 | 机制 | 说明 |
|---|---|---|
| `host-project-context` | section | 把 `workspace/AGENTS.md`（存在时）注入 system prompt；内容稳定，prompt cache 不受影响 |
| `host-guard` | hook + wraps | 危险 bash（sudo / 递归删除 / 磁盘写入 / 强推 / 管道执行远程脚本等 12 类）先拦截：未批准的命令向模型返回 block + 批准指引；`approve` 后放行。四个工具全部计时并追加到 `data/tool-timing.log` |
| `host-team` | 工具 | `subagent` 工具：创建被当前调用拥有的子会话（replay-safe + requestId，崩溃重跑恰好一次），等待并返回其回答；UI 可通过 details 把子会话挂到调用下 |

## 持久化与恢复语义（已实测）

- 每次打开存储都调用 `harness.resume()`——任何进程中断的 run 由下一个进程自动接续
  （daemon 启动时若发现未完成 run 会在日志中提示）。
- 被中断的非 replay-safe 工具按文档给模型 `interrupted` 错误结果，模型自行决定补救方式
  （实测：sleep 25 被 kill -9 打断 → 模型改用后台执行完成任务）。
- 自动压缩已启用（reserve 16384 / background 32768 / keepRecent 20000 tokens）：
  上下文接近 200k 窗口时后台生成摘要，仅在放不下时阻塞下一请求；transcript 小于阈值时
  压缩任务按规范结算为 stale、不落条目（已实测）。
- steer / follow-up / inbox、fork、defineDoc、后台任务等库能力尚未全部使用，见报告第 8 章能力地图。

## 快速验证记录（2026-10-08）

1. 单写者锁：活持有者拒绝 + 死锁接管，均符合预期
2. daemon：`/api/state`、`/api/events`（SSE 快照+增量）、`/api/tasks`、UI 均正常
3. 真实模型往返：CLI ask 与 `POST /api/ask wait:true` 均成功（relay, thinking high）
4. requestId 幂等：同 requestId 两次提交 → 同一 submission，模型只执行一次
5. host-guard：`rm -rf ./guard-test` 被拦截 → 模型转述拦截信息 → 前缀批准 `rm -rf ./guard-test*` → 放行执行成功
6. subagent：子会话 conv 107（owner_task=pi.tool #106）独立完成任务并回报；任务链在 taskGraph 可见
7. steer：sleep 15 运行中插入转向指令 → 当前工具轮结束后并入同一 run 执行
8. 崩溃恢复：daemon 被 SIGTERM 时 run 未完成 → 新进程 `wait` 接管 → 回答落库

## 已知限制

- relay 只回传 cacheRead，cacheWrite 恒为 0（费用统计偏低，model cost 全填 0）
- daemon 与 CLI 二选一（单写者锁）；daemon 未做持久化队列之外的多副本/HA
- Web UI 为单会话（根会话）视图；多会话/子会话面板待建（taskGraph 与 details 已可支撑）
- 环境隔离（per-conversation 容器 ExecutionEnv）未实现，工具直接跑在本机 workspace/
- Codemode 无关；这是独立于 pi 交互式 CLI 的第二套运行时（库形态 + 本 host 的 daemon 形态）
- Windows 部署可用 `createPowerShellTool()`（pi-durable 1.0.4+）替换/追加 bash 工具，未配置
