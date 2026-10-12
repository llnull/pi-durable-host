# Pi Durable Host

`@earendil-works/pi-durable`（实验性，API 随版本变动）的本地 host：

- 持久化会话跑在 SQLite（WAL）上，进程崩溃可恢复
- 模型后端多主机自适应：本机 pi 配置（openai-completions）或 Ark relay（anthropic-messages），同一份代码无需修改
- 工具为 CodingTools（read / write / edit / bash），外加 host 自建扩展：项目上下文 / 危险命令守卫（审批流）/ 子代理
- 常驻 daemon：Web UI（会话/模型切换、实时视图、审批、任务图、文件浏览）+ REST API + 热重启

clone 到任意目录即可使用；运行时数据都在 `data/`（已 gitignore，不入库）。

> 提示：仓库放在 Windows 盘再挂进 WSL（drvfs）时，SQLite WAL 可用但性能低于 ext4；
> 重负载场景建议用 `PI_DURABLE_DATA_DIR` 把数据目录指到 ext4 文件系统。

## 目录结构

| 路径 | 说明 |
|---|---|
| `host.js` | host CLI（ask / history / wait / status / tasks / sessions / approve / backup / timing / restart / serve / config） |
| `lib/lock.js` | 单写者锁（PID 存活检查，崩溃遗留的锁自动接管；`--takeover` 可等待前任退出） |
| `lib/extensions.js` | 自建扩展：host-project-context / host-guard（拦截入待批清单）/ host-team（subagent） |
| `lib/server.js` | 常驻 daemon：HTTP + SSE 实时视图 + REST API（含会话/审批/备份/热重启/工作区文件） |
| `lib/ui.html` | Web UI（会话/模型切换、审批面板、实时视图、任务图、文件面板、专注模式、composer 快捷操作） |
| `lib/models.js` | 多主机模型层（完全复用 `~/.pi/agent` 的 models.json / auth.json / models-store.json / settings.json） |
| `lib/sessions.js` | 命名会话 ↔ conversation 映射（`data/sessions.json`） |
| `lib/approvals.js` | 批准清单 + 待批清单（guard / CLI / daemon / UI 共用） |
| `lib/backup.js` | `VACUUM INTO` 一致性快照（daemon 内多连接安全，无需暂停 run） |
| `lib/daemon.js` | serve.json 发现 + CLI→daemon HTTP 转发 |
| `lib/format.js` | CLI 输出格式化（本地直连与 daemon 转发共用，两种路径输出一致） |
| `data/session.sqlite` | 持久化存储（WAL，进程崩溃可恢复；运行时生成） |
| `data/host.lock` | 单写者锁文件（存活期间持有，退出自动释放） |
| `data/serve.json` | daemon 运行信息（pid/port/host；CLI 据此转发） |
| `data/approvals*.json` | 批准清单 / 待批清单（`approve` 命令或 UI 维护，guard 每次调用实时读取） |
| `data/tool-timing.log` | 工具调用耗时日志（host-guard 的计时 wrap 追加；`timing` 命令汇总） |
| `data/backups/` | `backup` 快照（默认保留最新 20 份） |
| `workspace/` | agent 工具的默认 cwd（bash/write/edit 在此工作；不入库） |

## 依赖

- Node >= 22.19（node:sqlite 有 ExperimentalWarning，可忽略）
- `npm install` 安装 `@earendil-works/pi-durable` + `@earendil-works/pi-ai` + `@earendil-works/chord`
- 可选 `PI_DURABLE_TOKEN` —— daemon API 鉴权令牌（绑定非回环地址时强烈建议设置；Web UI / `/api/*` / `/files/*` 全部受保护）
- 可选 `PI_DURABLE_HOST` —— serve 默认监听地址（默认 `127.0.0.1`）
- 可选 `PI_DURABLE_DATA_DIR` —— 覆盖数据目录（默认 `<repo>/data`；测试/多实例用）

## 模型后端（完全复用 pi 配置）

host 不维护自己的模型配置——直接复用 pi CLI 的 `~/.pi/agent/`，各机器自行配置，同一份代码无需修改：

| 文件 | 作用 |
|---|---|
| `models.json` | 自定义 provider（中继/自建端点）：`baseUrl` + `api`（如 `anthropic-messages`）+ 模型目录；`apiKey` 支持 `$VAR`/`${VAR}` 环境变量引用（密钥不落盘） |
| `auth.json` | pi `/login` 存储的 api-key 凭证 |
| `models-store.json` | pi 维护的模型目录缓存（`pi update --models`） |
| `settings.json` | `defaultProvider` / `defaultModel` |

选型顺序：`PI_DURABLE_PROVIDER=<id>` 显式指定 → `settings.json` 的 `defaultProvider` → `models.json` 自定义 provider → `auth.json` 凭证 provider。
`PI_DURABLE_MODEL` 覆盖默认模型；`PI_DURABLE_KEY_<PROVIDER_ID>` 覆盖凭证（优先于 auth.json）；`PI_DURABLE_PI_DIR` 覆盖 pi agent 目录（默认 `~/.pi/agent`）。

Web UI 的模型下拉会列出全部可用 provider（`models.json` 自定义 + `auth.json` 凭证，按 provider 分组、附模型说明），跨 provider 切换即时生效、无需重启；凭证或 api 实现不可用的 provider 自动隐藏。

输入框支持快捷操作（类似 pi CLI）：

- `/`：命令面板（↑↓/Enter/Esc 导航）——host 命令（`/model` `/cwd` `/instructions` `/session` `/approve` `/restart` `/help`）+ **pi 自定义命令**（`~/.pi/agent/prompts/*.md` 与 `<cwd>/.pi/prompts/*.md`，frontmatter 的 `description`/`argument-hint` 用于展示）；自定义命令由 UI 端按 pi 的参数语义（`$ARGUMENTS`/`$1`/`${n:-默认}`/`${@:start:len}`）展开后发送，模板本身与 pi CLI 同源共享
- `@`：模糊补全会话工作区文件（`@相对路径` 以文本插入，模型用 read 工具自取内容）

自定义中继示例（`~/.pi/agent/models.json`）：

```json
{
  "providers": {
    "my-relay": {
      "baseUrl": "http://your-relay-host:3000/api",
      "apiKey": "$MY_RELAY_TOKEN",
      "api": "anthropic-messages",
      "models": [
        { "id": "your-model", "name": "Your Model", "reasoning": true,
          "input": ["text"], "contextWindow": 200000, "maxTokens": 65536 }
      ]
    }
  }
}
```

- host-guard 的磁盘类拦截同时覆盖 Linux（/dev/sd*、nvme、vd）与 macOS（/dev/disk*、/dev/rdisk*、diskutil 抹除/卸载/缩容）

## 单写者模型（重要）

pi-durable 存储无跨进程锁：**一个存储同一时刻只能被一个进程打开**。
host.js 的每个存储命令都会持有 `data/host.lock`（记录 PID）直到退出；锁的持有者还活着时其他进程
拒绝启动，持有者已死时自动接管。**推荐姿势：跑一个 `serve` 常驻进程作为唯一持有者**，
其余一切（人、脚本、UI、host.js 自身）通过它的 HTTP 接口使用：serve 运行期间，
CLI 命令（ask / history / status / tasks / sessions / approve / config / backup / restart / wait）
检测到 daemon 后**自动转发**，不再被锁拒绝。

## 命名会话

每个会话名对应一个独立持久 conversation（`data/sessions.json`）；`default` 即 root conversation（id 1），
历史数据无缝兼容。daemon 的 UI/API/SSE 全部跟随"当前会话"，切换即时生效；
`ask --session <name>` 可以直接对非当前会话提问。`sessions new|switch|delete` 管理映射
（delete 只解除映射，conversation 数据保留在存储中）。

## 危险命令审批（host-guard）

guard 拦截危险 bash 命令时，命令进入 `data/approvals-pending.json` 待批清单：

- **Web UI**：侧栏「审批」面板一键「批准 / 忽略」，已批准项可「撤销」（5s 轮询刷新）
- **CLI**：`node host.js approve -- <命令>`（批准并清待批）/ `--list` / `--revoke n`
- 批准/撤销对运行中的 daemon 实时生效（guard 每次调用重读文件）；批准后让 agent 重试原命令即可
- 允许前缀通配：批准 `git push origin*` 会放行所有以它开头的命令

## 备份与热重启

- `node host.js backup` / `POST /api/backup`：daemon 在自己进程内开第二个 SQLite 连接执行
  `VACUUM INTO`，拿到与 WAL 一致的快照，不暂停任何 run；默认存 `data/backups/`，保留最新 20 份
- `node host.js restart` / `POST /api/restart`：**热重启**。daemon 先派生 detached 后继进程
  （`serve --takeover`，最长等锁 60s），再优雅关闭存储退出；后继接管锁后 `resume()` 接续所有
  未完成的 run（包括正在生成的回答）。Web UI 的 SSE 会自动重连。典型用途：改完 host 代码后零数据损失升级
- 踩坑记录：daemon 停止时，运行中的工具调用会被执行环境 `killProcessTree` 按**进程组** SIGKILL——
  从工具里 nohup 出来的后台脚本会一起被杀（nohup 只免 SIGHUP，不换进程组；且 macOS 无 setsid）。
  需要跨 daemon 存活的工作必须独立会话（如 `node -e spawn(...,{detached:true})`），
  或干脆走 `/api/restart`（后继由 daemon 自身派生，天然不在工具进程树里）
- 三保险（issue #25 / #28）：① 工具子进程携带 `PI_DURABLE_HOSTED_BY` + `PI_DURABLE_CONV` 环境标记，
  CLI `restart` 在 hosted 环境内一律拒绝（重放循环）；CLI `ask` 在 hosted 环境内默认拒绝
  （followUp 等待被自己占用的会话 → 环等死锁），仅显式 `--session` 指向旁路会话时放行；
  （工具调用被打断后会被 pi-durable 重放，重放的 restart 会再杀一次后继 daemon，形成循环）；
  ② `/api/restart` 15s 防抖窗口（`data/restart.marker`，跨世代生效、过期自愈）
- `node host.js timing [n]`：tool-timing.log 汇总（每工具 n / avg / p50 / p95 / max）+ 最近 n 条

## 用法

```bash
# 常驻 daemon（推荐）：Web UI + SSE 实时视图 + REST API
node host.js serve [端口=7600] [--host 127.0.0.1] [--takeover]
#   UI:        http://localhost:7600/
#   POST /api/ask      { content, whenBusy?: "followUp"|"steer"|"reject", wait?: bool, requestId?, session? }
#                      （忙时排队/转向都走 ask 的 whenBusy，无独立 /api/steer）
#   POST /api/abort    中止当前运行（后台任务不受影响）
#   POST /api/compact  { instructions? }
#   POST /api/reset    { note? }
#   POST /api/config   { cwd? / instructions? / model? }   ← UI 模型切换器也走这里
#   POST /api/sessions { action: new|switch|delete, name }
#   POST /api/approve  { command } | /api/approve/revoke { index } | /api/approvals/dismiss { command }
#   POST /api/backup   { file? }
#   POST /api/restart  热重启（见上）
#   GET  /api/state | /api/events(SSE) | /api/history | /api/status | /api/tasks | /api/usage
#   GET  /api/models | /api/sessions | /api/approvals | /api/files | /api/commands | /api/submission?id= | /api/entry?id=
#   GET  /files/<path>  工作区静态文件（MIME 自适应、路径穿越防护；设置 PI_DURABLE_TOKEN 时同样受鉴权保护）

# CLI（daemon 运行时自动转发到 daemon；未运行时本地直连存储）
node host.js ask "..." [--fresh] [--session s]  # 提交 prompt，等 run 结束，打印回答
                                  # 同内容重复 ask 幂等复用（requestId=内容哈希）；--fresh 强制新提交
node host.js history [n] [--session s]          # 打印最近 n 条 transcript（默认 50）
node host.js wait [秒]            # 有未完成的 run（如上个进程被杀）时等它走完；开机/部署后先跑一次
node host.js status               # 会话状态：busy / 生成重试 / 工具 / 压缩 / inbox / agent / 用量 / 活任务
node host.js tasks                # 实时任务图（所有权、等待关系、后台标记）
node host.js sessions [new|switch|delete <name>]  # 命名会话管理（default=root conversation）
node host.js approve -- <命令>    # 批准危险命令（--list 查看 / --revoke n 撤销）；实时生效
node host.js backup [文件]        # VACUUM INTO 一致性快照
node host.js timing [n]           # 工具耗时汇总
node host.js restart              # 热重启 daemon（后继进程 resume 所有 run）
node host.js config               # 把存储的 agent cwd/model 重置为本目录当前值
```

## Web UI（http://localhost:7600/）

- 顶栏：会话下拉（切换/新建/删除）、模型下拉（即改即生效，来自本机模型目录）、备份、热重启
- 工具栏：对话搜索/过滤（全部 / 含工具调用 / 转向）、全部展开/收起、跳到最新、**专注模式**（收起侧栏、收窄为阅读列宽）
- 主区：按 run 分组的对话流（内容壳宽屏分档自适应 1200/1440/1600），工具调用卡片配对渲染，markdown/表格/代码块渲染，流式生成实时显示
- 输入区：卡片式 composer（聚焦高亮、运行状态胶囊、字数统计、草稿自动保存、Ctrl/⌘+Enter 发送、↑ 召回上一条、忙时「排队/转向」）
- 侧栏：实时运行、排队 inbox、**审批面板（待批一键批准/撤销）**、用量、任务图、文件面板
- 文件：回答中的工作区文件路径自动链接，`GET /files/<path>` 直接打开
- SSE 断线自动重连（daemon 重启后视图无缝恢复）

## 部署节奏（改代码后）

```bash
node host.js restart      # 热重启：后继进程接管，未完成 run 自动 resume
node host.js status       # 确认新 daemon 状态
```
