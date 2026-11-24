# pi-durable 1.3.0 → 1.6.0 与 pi CLI 1.6.0 同步升级评估

> **状态（2026-11-24）**：**已合并、已迁移**（分支 `feat/pi-durable-1.6`）。适配补丁先在数据快照的隔离副本上全量验证
> （单测 79/79、迁移、CLI、daemon、SSE、模型往返、压缩/重置、并发切会话、热重启、盘满自灭），随后按第五节 runbook 上线：
> 升级前备份 `data/backups/pre-pi-durable-1.6-2026-11-24T03-04-24Z.sqlite`（schema v1，文件名不参与轮转，请长期保留）；
> 真实库迁移后 `durable_schema` = 2，21,164 条 entry / 13 个会话完好，四个会话活跃段条数与升级前逐条一致，
> 默认模型回到与 pi CLI 一致的 `glm-5.4`。补丁文件已随合并删除（提交即补丁）。
> **新能力落地（同日）**：迁移后按第四节的清单逐项实现了审批闸门、系统事件、会话运行策略、图片整理、归档回看等，
> 各自独立提交于同一分支；默认行为的变化见第六节末尾「上线后的默认行为变化」。

上游 `@earendil-works/*` 自 1.3.0（2026-10-15，本仓库当前锁定）之后发布了 1.4.0（10-21）、1.5.0（11-02）、
1.5.1 / 1.5.2（11-09 / 11-10）、1.6.0（11-20）；本机 pi CLI 已是 1.6.0。四个包版本号同步（pi-durable 精确依赖
同版本的 chord / pi-ai / pi-codemode，1.6.0 起新增 `pi-schema` / `pi-telemetry` 两个精确依赖），host 的 range
必须一起抬，避免双版本共存。

## 结论

1. **建议升级，且应尽快**——不只是为了新功能：host 与 pi 的配置已经出现**当下就生效的漂移**
   （见 P0-7：本机 host 仍在用 `glm-5.3`，pi CLI 已是 `glm-5.4`）。
2. **不能"只升依赖不改代码"**：1.5.0 是个大版本，host 有 8 处调用了已删除的 API、2 处 watch 回调签名变了。
   其中 3 类是**静默失效**（不报错、测试也抓不到），比崩溃更危险——见第二节。
3. **数据库迁移是单向的**（schema 1 → 2，`pi.tool` v4 / `pi.generation` v3 / `pi.live` v3）：升级前必须备份，
   回滚只能靠备份。已在 64MB 真实数据快照上实测迁移无错、条目数不变。
4. 静态对照 changelog 会漏（这次演练抓到 2 处静态检索漏掉的调用点）。**在快照副本上演练应作为升级流程的固定步骤**。

## 一、上游新功能 review

### pi-durable

| 版本 | 对本 host 有意义的变更 |
|---|---|
| **1.4.0** | 任务可休眠（`sleeping` 状态，不占调用、跨重启）；crash-loop 保护（`restartLimit`，1.5.0 起改为直接结束而非 park）；`onReport`（存储失败 / 任务故障 / 迁移失败等上报）；`settings.afterFailedRun`；`settings.compaction.modelOverrides`（同一 harness 混用小/大窗口模型）；`HarnessOptions.identity`（User-Agent 归因）；`telemetry`；`wake()/onWake`。**SQLite schema 迁移到 v2（单向）** |
| **1.5.0** | **大量 breaking**（见第二节）。新增：group commit（Session 不再在提交期间独占线；128 会话 / 4ms 存储延迟下 5 → 440 run/s）、调度器每提交成本不再随会话数增长（2048 会话 100 → 805 run/s）、`ConversationTranscript`、`pi.live.runFailure`、continue 提交、`maxTurns`、`whenIdle: "reject"`、`submit(tx, draft)` 原子准入、`beforeProviderRequest` 钩子、`HarnessOptions.readOnly`（只读查看器）；**工具 schema 改为纯 JSON Schema（pi-schema），TypeBox 不再是依赖** |
| **1.5.1** | 每会话压缩配置 `configure({ compaction })`；`Tx.submission(id)`；SQLite `commit()` 由每批约 8 条语句降为每次调用数条 |
| **1.5.2** | 调度器"等待中的任务永不结束"修复（#11892）；codemode 对畸形 `$ref` 不再全军覆没（#11803） |
| **1.6.0** | **信号与 park**：工具可 `execute()` 返回 `{ sleep / wait }` 挂起而不占调用，`SubmissionDraft.notify` 让子代理工具等子会话回答；`afterTools` / `onYield` 钩子可起任务；`images/fit`（入会话的图片按模型限制缩放：`fitImages()` + `createFitImagesExtension()`）；codemode namespace 改由扩展声明；`onAbort: "keep"`。**`pi.tool` v4 / `pi.generation` v3（再一次单向）** |

与本 host 既有痛点直接相关的修复：

- **内存**：会话 watcher 不再为每个 partial commit 持有流式文本/工具调用参数的副本（140KB 回答 + 140KB 工具调用
  曾占用 >100MB，#9265）；500KB 工具调用的 partial commit 从约 20s CPU / 100MB 堆峰值降为增量追加。
  长驻 daemon 的内存占用会明显下降。
- **关停**：`Submission.wait()` 在 Harness 关闭时不再留下 unhandled rejection（#11963）——正是 host 优雅停止 / 热重启走的路径。
- **中文**：`tool_search` / codemode `searchTools()` 此前对中文等非 ASCII 查询返回空（#10816）。
- **图片**：`read` 不再把"当前模型不支持图片"的提示写进工具结果（切到视觉模型后会被重放为过期文本，#12131）。
- **压缩**：模型请求在途时崩溃不再无限重发（此前每次重发都多一条 aborted entry）。

### pi CLI 1.6.0（host 只复用其配置，不加载其扩展）

| 方面 | 1.6.0 现状 | 对 host 的影响 |
|---|---|---|
| `models.json` | **宽松 JSON**（允许 `//` 注释、尾逗号、BOM）；与内置 provider **同 id = 修改该 provider**（模型按 id 原位合并，provider 级 `baseUrl`/`compat` 也作用于内置模型，`modelOverrides` 逐字段打补丁）；模型新增 `thinkingLevelMap` / `inputLimits` / `promptCache` / `samplingParams*` / `headers` / `compat` / `cost.tiers` | **host 用严格 `JSON.parse` 读 → 整个文件被静默丢弃**；且把 models.json 的 provider 一律当成"独立自定义 provider"，没有合并语义 → P0-7 |
| 凭证优先级 | 显式选中的凭证 > `models.json` 的 `apiKey` > provider 自身解析（`auth.json`） | host 原先是 env > `auth.json` > `models.json` → 补丁对齐为 pi 同序 |
| `settings.json` | `defaultProvider` / `defaultModel` 不变；新增 `defaultThinkingLevel`、`defaultTools`（如 `+codemode`）、`cacheWarming`、资源路径 `prompts` / `skills` / `packages` / `extensions` | 默认模型读取不受影响；`defaultTools` / 资源路径尚未跟随 → 机会项 |
| `prompts/` | 仍是 `~/.pi/agent/prompts/*.md`（直接子级），frontmatter `description` / `argument-hint`，`$1` `$@` `${1:-def}` `${@:N:L}` | host 的 `/api/commands` 与之同源，无需改 |
| `models-store.json` / `auth.json` | 结构不变 | 无影响 |
| 扩展包（如本机的 `npm:pi-web-access`） | pi CLI 有 web 访问能力 | host 有自己的扩展注册表，不加载 pi 扩展包；**已决定不做**（见第四节） |

## 二、影响面评估

### P0 必改（补丁已全部覆盖）

| # | 位置 | 上游变更 | 不改的后果 | 类别 |
|---|---|---|---|---|
| 1 | `lib/extensions.js:23` `import { Type } from "@earendil-works/pi-ai"` | 1.5.0：pi-ai 不再导出 TypeBox | **模块链接期 `SyntaxError`**：host.js 完全无法加载，所有 CLI 命令与 daemon 都起不来；3 个测试文件（guard / screen / bash-timeout）无法加载 | 响亮 |
| 2 | `Conversation.viewState()` ×5（`lib/format.js`、`lib/server.js` ×2、`host.js` ×2）、`Harness.taskGraph()` ×3（`lib/format.js`、`lib/server.js`、`host.js`） | 1.5.0：两个状态读取 API 被移除 | `root.viewState is not a function`——**serve 启动失败** | 响亮 |
| 3 | `lib/server.js` 两个 watch 监听器（会话视图、任务图） | 1.5.0：监听器收到 tagged `WatchCall`（`{ kind, value, ops, retired }`），`WatchEnd` 按 `kind` 标记 | 回调把整个 `WatchCall` 当视图用：`docs` 为 undefined → `diffFrames` 判为结构性变化 → 广播损坏的 `view` 帧；任务图缓存写入错误形状 | **静默** |
| 4 | `lib/server.js:1392` `end?.reason !== "failed"` | 1.5.0：`SessionEnd` 改为 `{ kind: "closed" \| "failed" }` | 判断**永远为假** → Session 失败自灭这条保险丝静默失效，daemon 回到"进程活着但永远答错"的僵尸态（正是 1.2.0 升级时专门修的形态） | **静默** |
| 5 | `lib/server.js` `lastView` / SSE / `/api/state`；`lib/format.js` `collectStatus` | 1.5.0：`view.entries` 只是**窗口**（最新 50 条，超 100 裁回 50），不再是整本活跃 transcript | UI 与 `/api/state` 永远只拿到最新 50 条，历史无声丢失；看门狗按条数对账每 10s 误判一次并全量重播（对照组实测：`research` 会话 378 条 → 只剩 50 条，34s 内重播 3 次） | **静默** |
| 6 | `lib/format.js:86`、`lib/ui.html`（压缩状态 / 压缩失败） | 1.5.0：`CompactionStatus.reason` / `CompactionFailure.reason` 更名 `trigger`，失败对象不再带 `attempt` | CLI 与 UI 显示 `undefined` | 响亮（可见） |
| 7 | `lib/models.js`（整层） | pi CLI：`models.json` 为宽松 JSON + provider 合并语义 | **当下已漂移**：本机 `models.json` 带注释 → host 读不到 → 默认模型停在 `glm-5.3`、只列出 4 个模型；pi CLI 已是 `glm-5.4`（且 `glm-5.4` 的 `compat` / `thinkingLevelMap` / `inputLimits` 全部丢失） | **静默** |
| 8 | `package.json` | 依赖抬升 | — | — |

**补丁做法**（细节见补丁内注释）：

- 1 → `obj` / `str`（`@earendil-works/pi-schema`，上游官方迁移路径；新增直接依赖）。
- 2 → `readView` / `readTaskGraph`（挂一个最小窗口的 watch，读首值即停；不占 Session 线、不留常驻观察者）。
- 3 → `call.kind === "value"` 判别后取 `call.value`。
- 4 → `end?.kind !== "failed"`。
- 5 → `ConversationTranscript` 在窗口之上补页，裁出**活跃段**（最新 head marker 的 `head` 起到末尾）。
  **呈现范围与 1.3.0 视图逐条一致**——用旧代码（1.3.0）对同一快照实测 582 / 378 / 852 / 89 条，补丁后完全相同。
  SSE 协议、UI、`/api/state` 形状均未变（旧 UI 与新 daemon 兼容）。transcript 绑定到单个 watch（闭包私有），
  已被替换的 watch 的迟到帧直接丢弃——并发切会话时不会串台。
- 6 → `c.trigger ?? c.reason`（协议兼容兜底）。
- 7 → 移植 pi 的 `stripJsonComments` 与 `provider-composer` 的组合语义（`applyModelsJson` / `modelFromJson` /
  `applyModelOverride` / `mergeCompat` 逐字段对应），全字段透传，`headers` / `authHeader` 随凭证下发。

### 顺带修掉的存量问题（被新语义暴露，或对账时发现）

| 问题 | 证据 | 处理 |
|---|---|---|
| **压缩质量闸门只对每个会话的第一次压缩生效**：按"epoch 计数增加"判断，但旧视图本身包含上一个 marker（旧 = 1，新 = 1） | 代码推断 + 留存 judge 日志里 `compactGate` 记录共 1 条 | 改为按 id 找旧视图里没有的 `pi.compaction` marker；**只看 compaction**——用户主动"重置"没有摘要可对账，不排除会每次重置误报 `compact-loss`。实测同一会话第 2、3 次压缩现在都触发 |
| `/api/tasks` 的限时直读兜底若简单换成"每次请求挂一个 watch"，会在 Session 线被占时叠出观察者 | 设计审查 | 改为复用会话级单一 watch + 在途重建守卫 |
| 看门狗按条数对账在窗口化后天然不成立 | 对照组实测每 10s 误判 | 改为比"最新条目 id"，并延迟 1.5s 复查（存储落账 → watch 发布之间隔着一个 macrotask） |

### 行为变化（不改代码，已冒烟验证）

- **迁移**：首次打开存储时自动完成（`durable_schema` 1 → 2，任务表重建）。快照实测：无报错，21,164 条 entry 不变，
  20,286 个 task 完成迁移。
- **在途模型请求**：进程死亡时在途的请求不再于重开时重发，计为一次失败尝试并走退避；重试耗尽则 run 以
  `runFailure: interrupted` 结束（UI 现在会显示原因）。
- **流式内容的落盘时机**：partial 改为延迟提交（默认 1s 内），崩溃最多丢约 1 秒流式文本（原 100ms）。
  `settings.progress.persistWithinMs: 0` 可恢复逐次落盘。
- **`pi.live` 空闲时不再保证是 `{}`**：无回答结束的 run 会保留 `runFailure` 到下一次 run。host 一律用 `run === undefined` 判忙，不受影响。
- **工具 `durationMs`**：改为从工具任务首次运行算起（含钩子、排队、重启停机）。UI 工具卡片上的耗时含义略有变化；
  host 自己的计时日志（guard 的 wrapTool）不受影响。
- **head marker 原位追加**：库里不再"裁掉"压缩/重置之前的条目。host 的呈现范围保持原样（见 P0-5），
  完整历史已具备"可选展示"的数据基础（机会项）。
- **`afterTool` 对 Harness 自己写的结果也会触发**（blocked / aborted / restart_limit 等）——host 只用了 `beforeTool`，不受影响。
- 工具槽新增 `sleeping` / `waiting` 状态——UI 已补标签。

### 免费收益（升级即得）

group commit 与调度器扩展性（见第一节）、上述内存修复、关停期 unhandled rejection 修复、中文工具搜索修复、
`read` 图片过期提示修复，以及**模型目录与 pi CLI 完全同源**（本机即见：`glm-5.4` 成为可选与默认，
`compat.thinkingFormat: zai` 等随模型透传）。

## 三、演练验证记录

**隔离方式**：`git archive HEAD` 导出代码到 `/tmp`；用 `node:sqlite` 的在线备份 API 给运行中的库拍快照
（64.8MB，13 个会话 / 21,164 条 entry / 636 个 submission / 20,286 个 task，`durable_schema` 版本 1）；
独立数据目录与端口（7697–7699）；不带 `host.json`（不触发 judge / sidecar）。真实仓库、`node_modules`、`data/`
与 daemon（pid 34443）全程未动。

| 步骤 | 结果 |
|---|---|
| 1.3.0 基线 `node --test` | 79 / 79 |
| 1.6.0 **未打补丁** | `SyntaxError: … does not provide an export named 'Type'`，guard / screen / bash-timeout 三个测试文件无法加载 |
| 1.6.0 **只修崩溃点**（对照组） | daemon 能起、日志干净，但 `research` 的 `/api/state` 只有 **50** 条（应 378）；看门狗每 10s 误判并重播全量 view |
| 1.6.0 **打补丁** `node --test` | **79 / 79** |
| 迁移（首次打开） | `durable_schema` 1 → 2，无报错；entry 21,164 不变；四个会话均可读 |
| 视图呈现范围 | `default` / `research` / `chat` / `env` = **582 / 378 / 852 / 89**，与 1.3.0 旧代码对同一快照的输出逐条一致；`research`（18,294 条的会话）status 0.19s |
| CLI | `status`（各会话）/ `history` / `tasks` / `sessions` / `timing` 全部正常 |
| HTTP | `/api/state`（light 794B / 全量）、`/api/status`、`/api/tasks`、`/api/usage`、`/api/models`、`/api/history`、`/api/entry`、会话切换 |
| SSE | `view` 首帧 → `entries` 按 `after` 正确串接 → `live` / `docs` → 每个 run 结束触发体检；协议未变 |
| 模型往返（glm-5.4） | 纯文本、bash 工具、read 工具各一次；工具错误被体检正确标记（`tool-errors:1`） |
| 压缩 / 重置 | 强制小 `keepRecent` 后连续压缩 3 次：每次都产生摘要、视图按 head 裁剪、闸门 3 次全部触发；重置不触发闸门 |
| 并发切会话 | 4 个切换请求并发：全部返回，SSE 每个 `session` 帧后恰好一个匹配会话的 `view` 帧，四个会话条数与首尾 id 全部正确 |
| 热重启 `/api/restart` | 约 2s 完成交接，后继状态无损 |
| **盘满故障注入**（24MB 磁盘镜像写满） | `SQLite transaction failed and rollback failed` → `[serve] Session 失败，daemon 退出`、清 `serve.json`、进程退出——保险丝在 1.6.0 上有效 |
| 看门狗 | 各轮 daemon 运行期间 0 次误报 |

演练期间对模型端点发起了约 16 次很小的请求（GLM Coding Plan；其中约 6 次是为验证压缩闸门而生成的摘要）。

## 四、机会项与落地情况

迁移（`cb37655`）之后按价值逐项落地，每项独立提交、单测 + dev daemon（迁移后库的快照、独立端口）端到端 + 真实浏览器验证：

| 状态 | 项 | 说明 |
|---|---|---|
| ✅ 已落地 | **审批闸门「批准即续跑」**（`f542666`） | 1.6 信号/闸门：危险命令挂起等人工决定（不占进程、跨重启存活），Web UI / CLI 批准后调用自动继续，不再需要模型重试一轮；拒绝 / 超时 / 中止各有明确结果；优雅停止只在真有调用在执行时才中止 run |
| ✅ 已落地 | **系统事件可观测**（`aba10ff`） | `onReport` → 内存环 + judge-log 留痕 + SSE + UI「系统事件」面板；`runFailure` 并入 run 体检；`PI_DURABLE_FAULT=hook` 演练开关 |
| ✅ 已落地 | **会话运行策略**（`7c0c649`） | 思考档位（按模型 thinkingLevelMap 校验）/ 单次 run 轮数上限 / 压缩策略，UI ⚙ 弹层；新会话档位与 codemode 开关跟随 pi 的 `defaultThinkingLevel` / `defaultTools` |
| ✅ 已落地 | **图片入库前按模型限制整理**（`98d6396`） | 1.6 `images/fit`：缩放 / 转码 / 坏图剔除并说明；`fit-images` 扩展兜住工具产出的图片 |
| ✅ 已落地 | **压缩 / 重置前的对话可回看**（`d54abe3`） | 分隔线入口 + 置顶只读归档区（分页、保持阅读位置） |
| ✅ 已落地 | 子代理的 codemode 命名空间（`host-team` → `team`） | 1.6 起命名空间由扩展声明 |
| ✅ 已落地 | UI 冒烟脚本 `scripts/ui-smoke.mjs` | 零依赖 CDP：页面异常 / 控制台错误 / 关键控件断言，可截图与执行 JS |
| ⏸ 未做 | `prompts` / `skills` 资源路径（pi settings）与 `enableSkillCommands` | `/api/commands` 仍只读两个约定目录 |
| ⏸ 未做 | 子代理工具改为 park（`SubmissionDraft.notify`） | 单会话场景收益有限 |
| ⏸ 未做 | `HarnessOptions.readOnly`、`telemetry`、更多 pi-ai API、sqlite prefix 表迁入 | 见第三节 |
| ⏸ 未做（有意） | `identity`（User-Agent / 归因） | 上游默认已归因到 pi；自定义 UA 对中继端点的兼容性是未知风险、无明确收益 |
| 🚫 不做（已决定） | pi 扩展包兼容 | 明确不在范围内：host 不加载 pi 扩展包（如本机 pi CLI 的 `npm:pi-web-access`）。host 的 agent 需要联网时另议（走 host 自己的扩展注册表） |

## 五、升级 Runbook

1. **预检**：`node host.js status` 确认 `busy: no`；`git status` 干净；`node host.js backup`——**升级前这份备份不要被轮转掉**。
2. **停 daemon**（冷停，不要热重启）：`kill -TERM <pid>`。
   依赖升级会在运行中的进程脚下替换 `node_modules`——photon / codemode 是懒加载的，热重启路径上可能加载到不匹配的版本。
3. **应用**：`git apply docs/upgrade-pi-durable-1.6.patch` → `npm install` → 连同 `package-lock.json` 一起提交。
4. **单测**：`node --test` → 79 / 79。
5. **首次打开即迁移**（此后无法用 1.3.0 打开）：`node host.js status` 逐会话看一眼，条数应与升级前一致
   （演练时为 582 / 378 / 852 / 89，以升级当时实际值为准）。
6. **起 daemon**：`node host.js serve 7600 --host 127.0.0.1`。UI 检查：模型下拉出现 `glm-5.4` 且为默认；
   历史完整；侧栏实时区在 run 结束后正常收起。
7. **冒烟**：一次纯文本往返、一次带工具的往返、切换会话、一次手动压缩、`node host.js restart`。
8. **收尾**：
   - README：模型后端一节补"`models.json` 为宽松 JSON、与内置 provider 同 id 即合并"；依赖一节补 `pi-schema`。
   - ARCHITECTURE："Session 失败自灭"段的 `{ reason: "failed" }` 改为 `{ kind: "failed" }`；
     SSE 一节补一句"1.5 起视图是窗口，daemon 用 `ConversationTranscript` 补齐活跃段"。
   - 删除 `docs/upgrade-pi-durable-1.6.patch`；按需 bump `package.json` 的 version。
9. **回滚**：`git revert` + `npm install`（回到 1.3.0）+ 用第 1 步的备份恢复 `session.sqlite`（迁移单向，没有第二条路）。

## 六、风险清单

| 风险 | 缓解 |
|---|---|
| 单向迁移（schema v2 + 三个文档版本） | 强制备份并保留；迁移只在首个打开存储的进程发生（单写者锁保证只有一个）；已在真实数据快照上实测 |
| 静默失效类问题修漏 | 补丁已逐项在副本上验证（第三节）；合并后头几天留意 serve.log 的 `[watchdog]` / `补页失败` 与 UI 的 runFailure 提示 |
| 凭证优先级变化：`models.json` 的 `apiKey` 现在优先于 `auth.json`（pi 同序；此前相反） | 本机 `models.json` 没有 `apiKey`，无实际影响；README 里写明 |
| 自定义模型缺省值对齐 pi：`contextWindow` 128000 / `maxTokens` 16384（原 200000 / 65536） | 只影响 `models.json` 里省略这两个字段的模型；README 示例是显式写出的 |
| 压缩闸门修复后 `compactGate` 记录会明显变多（原先漏掉第 2 次起的所有压缩） | 属预期；heuristic 模式下阈值不变 |
| 内存：daemon 持有"活跃段 + 一页"的 transcript | 与旧 `viewState` 持有整段活跃 transcript 相当；上游同期的 watcher 内存修复是净收益 |
| 流式内容最多丢约 1 秒 | 可接受；介意则 `persistWithinMs: 0` |

### 上线后的默认行为变化（新能力带来的）

| 变化 | 说明 | 怎么调 |
|---|---|---|
| codemode 默认开启 | 跟随 pi `settings.json` 的 `defaultTools`（本机为 `["+codemode"]`）。此前 host 里默认关 | `PI_DURABLE_CODEMODE=0` 或 `data/host.json` 的 `features.codemode: false` |
| 危险命令：挂起等审批（仅 `guard.mode = block`） | 不再直接拦截，批准后自动继续。**本机 `host.json` 目前是 `flag`（只审计），上线后行为不变** | 想用闸门：把 `guard.mode` 改回 `block`（或删掉该键）后重启；现在审批只需点一下，不再需要让 agent 重试 |
| 用户图片入库前缩放 / 转码 | 超过模型限制的图被缩到限制内，坏图剔除并说明 | `PI_DURABLE_IMAGES=0` 关闭（原样透传） |
| 优雅停止不再一律中止当前 run | 只有真有调用在执行时才中止；挂起等审批的命令在热重启后继续等 | 无需调整 |
| 用户主动中止的 run 不再生成体检记录 | 中止不是需要诊断的失败，此前每条都挂 empty-answer 噪音 | 无需调整 |
| 新会话的思考档位跟随 pi 的 `defaultThinkingLevel` | 本机 pi 未配置 → 仍为 high | 顶栏 ⚙ 按会话调整 |
| 顶栏多一个「⚙ 思考 · 档位」入口；侧栏多「系统事件」面板；分隔线上多「查看此前的对话」 | 纯增量 | — |
