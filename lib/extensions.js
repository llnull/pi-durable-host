// Host extensions for the pi-durable local host.
//
// Three extensions, all plain data + code, installed into the registry by host.js:
//
//   host-project-context — system prompt section that injects AGENTS.md from the
//     conversation's working directory. Content is stable between edits, so the
//     provider prompt cache stays warm (the section is only re-sent when it changes).
//
//   host-guard — beforeTool gate for dangerous bash commands, plus wrapTool timers
//     that append every tool call's duration to data/tool-timing.log. An exact
//     match in data/approvals.json passes. Otherwise (mode "block") the call PARKS
//     until a person decides (pi-durable 1.6 signals): it holds no invocation,
//     survives restarts, and runs by itself once approved — the model no longer
//     has to "retry the original command". Mode "flag" only audits; "off" disables.
//
//   host-screen — wrapTool 后置护栏：工具结果进 agent context 前过 System One 判别
//     （prompt-injection / 表里不一），flag（默认：审计+UI）或 block（替换为拦截说明）。
//     仅 system-one provider 有语义判断能力，heuristic 下为 null（不安装）。
//
//   host-team — a replay-safe `subagent` tool: creates a child conversation owned
//     by the tool call task, waits for its answer, and returns the text. A crash
//     rerun finds the same child via the ownership index and the same submission
//     via requestId, so delegation is exactly-once.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import path from "node:path";
// pi-durable 1.5：工具参数 schema 改为纯 JSON Schema（pi-schema 构建），pi-ai 不再导出 TypeBox 的 Type。
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { AssistantEntry, configure, defineEntry, defineExtension, defineSignal, defineTool, hook, section, wrapTool, ToolTask } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { addPending, clearPending, isApproved, pendingFileOf } from "./approvals.js";
import { textOf } from "./format.js";
import { SCREEN_QUESTIONS } from "./judge.js";

// ---------------------------------------------------------------------------
// host.config 审计条目
// ---------------------------------------------------------------------------

/**
 * 配置变更的 transcript 审计（模型/cwd/instructions 切换）。自定义 kind 无 `model`
 * 字段 —— contribute() 对它贡献零消息，天然不进模型 context；纯账本记录，
 * 回放可见、随 fork 复制、随 reset 剪裁。
 */
export const HostConfigEntry = defineEntry("host.config");

// ---------------------------------------------------------------------------
// host-project-context
// ---------------------------------------------------------------------------

/**
 * A section that renders `<agents-md>` from AGENTS.md (or a custom list of files)
 * at the conversation's cwd, read through the call's execution environment.
 * Returns undefined when no file exists, which omits the section entirely.
 */
export function buildProjectContext({ files = ["AGENTS.md", "agents.md"] } = {}) {
	return defineExtension({
		name: "host-project-context",
		sections: [
			section("agents-md", async (input, context) => {
				const env = input.env;
				if (!env) return undefined;
				for (const name of files) {
					try {
						const abs = await env.absolutePath(name, context);
						if (!abs.ok) continue;
						const res = await env.readTextFile(abs.value, context);
						if (!res.ok) continue;
						const trimmed = res.value.trim();
						if (trimmed) return trimmed.slice(0, 8000); // bounded; keeps context predictable
					} catch {
						// fall through to the next candidate file
					}
				}
				return undefined;
			}),
		],
	});
}

// ---------------------------------------------------------------------------
// host-guard
// ---------------------------------------------------------------------------

export const DANGEROUS_PATTERNS = [
	{ re: /(?:^|\s)(?:sudo|doas)\s/, why: "提权命令" },
	{ re: /(?:^|\s)rm\s+(?:-{1,2}[\w-]+\s+)*(?:-\w*[rR]|--recursive\b)/, why: "递归删除（rm -r）" },
	{ re: /(?:^|\s)rm\s+(?:-{1,2}[\w-]+\s+)*(?:-\w*f|--force\b)/, why: "强制删除（rm -f）" },
	{ re: /mkfs/, why: "格式化文件系统" },
	{ re: /(?:^|\s)dd\s+[^|]*of=\/dev\//, why: "直写块设备" },
	{ re: /:\s*\(\)\s*\{.*\}\s*;\s*:/, why: "fork 炸弹" },
	{ re: /(?:^|\s)(?:shutdown|reboot|halt|poweroff|init\s+[06])\b/, why: "关机/重启" },
	{ re: /git\s+push\s+(?:\S+\s+)*(?:--force\b|--force-with-lease\b|-f\b)/, why: "强制推送分支" },
	{ re: /chmod\s+(?:-[A-Za-z]+\s+)*777/, why: "全员可写权限" },
	{ re: /(?:curl|wget)\b[^|]*\|\s*(?:ba|z|da|fi)?sh\b/, why: "管道执行远程脚本" },
	{ re: />\s*\/dev\/(?:sd[a-z]|nvme|vd|disk|rdisk)/, why: "覆盖磁盘设备" },
	{ re: /(?:^|\s)diskutil\s+[\w\s]*(?:eraseDisk|eraseVolume|eraseOptical|zeroDisk|splitDisk|splitPartition|unmountDisk|unmount\w+|apfs\s+(?:delete\w*|resize\w*))\b/, why: "抹除/卸载磁盘（macOS diskutil）" },
	{ re: /(?:^|\s)kill\s+-\w*9\s+(?:-1|1)\b/, why: "杀死系统级进程" },
	{ re: /(?:^|\s)\w+-grab\s|nvidia-smi\s+--gpu-reset/, why: "GPU 设备重置" },
];

/**
 * 灰色地带（issue #70 落点 2 置信路由）：非硬破坏但有外部副作用/系统变更的命令。
 * 硬拦表管「不可逆破坏」（block 模式下永远人工，不受置信路由影响）；
 * 灰表管「值得一问」：block 模式 + judge 在位时语义判别——高置信无副作用直接放行（留审计），
 * 低置信/判不出/无 judge 走保守待批；flag/off 模式仅审计不改变行为。
 */
export const GRAY_PATTERNS = [
	{ re: /(?:^|\s)git\s+push\b(?![^|]*--dry-run)/, why: "推送到远端（外部副作用）" },
	{ re: /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:i|install|add)\s+(?:-{1,2}[\w-]+\s+)*(?:-g\b|--global\b)/, why: "全局安装包" },
	{ re: /(?:^|\s)pip3?\s+install\b|(?:^|\s)uv\s+pip\s+install\b/, why: "安装 Python 包" },
	{ re: /(?:^|\s)brew\s+(?:install|uninstall|upgrade)\b/, why: "Homebrew 变更" },
	{ re: /(?:^|\s)cargo\s+install\b/, why: "Cargo 安装" },
	{ re: /(?:^|\s)crontab\b|(?:^|\s)launchctl\b|(?:^|\s)defaults\s+write\b/, why: "系统配置变更" },
	{ re: /(?:^|\s)(?:chmod|chown)\s+(?:-{1,2}[\w-]+\s+)*-[A-Za-z]*R\b/, why: "递归改权限/属主" },
	{ re: /(?:^|\s)(?:kill|pkill|killall)\b/, why: "进程终止" },
];

/**
 * 纯判定：命令是否危险且未被批准。返回 { why, severity } 或 undefined（放行）。
 * severity: "block" = 硬破坏表命中；"gray" = 灰表命中（置信路由候选）。
 * 副作用（记 pending、读文件）留在 buildGuard 里，这里只做可测的规则匹配。
 */
export function judgeCommand(command, approved = false) {
	const cmd = String(command ?? "");
	if (!cmd.trim()) return undefined;
	const hit = DANGEROUS_PATTERNS.find((p) => p.re.test(cmd));
	if (hit && !approved) return { why: hit.why, severity: "block" };
	const gray = GRAY_PATTERNS.find((p) => p.re.test(cmd));
	if (gray && !approved) return { why: gray.why, severity: "gray" };
	return undefined;
}

/**
 * Approval hook + timing wraps.
 *
 * Approval model: a blocked command is never rerun silently. The block message
 * tells the model (and the user) the exact escape hatches: one-click approval in
 * the web UI (blocked commands land in data/approvals-pending.json), or
 * `node host.js approve -- <command>`. Reading the allowlist file on every call
 * is pure, so a rerun after a crash is safe.
 */
/**
 * 审批决定信号（pi-durable 1.6 signals）：值随工具任务持久化、经 schema 校验，跨重启不丢。
 * key = 命令摘要（一条命令一个问题）；由 /api/approve 与 /api/approvals/dismiss 经 harness.signal() 投递。
 */
export const ApprovalDecision = defineSignal({
	name: "host-guard.approval",
	version: 1,
	schema: obj({ allow: bool(), by: opt(str()), note: opt(str()) }),
});
/** 超时提示里的时长：秒 / 分钟 / 小时按量级取整（测试里常把上限调到十几秒，不能显示成「0 分钟」）。 */
export function formatWait(ms) {
	if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`;
	return `${Math.round(ms / 3_600_000)} 小时`;
}
/** 一条命令的信号 key：命令原文的摘要（稳定、无 "/"，重试同一命令命中同一问题）。 */
export function approvalKey(command) {
	return createHash("sha256").update(String(command ?? "").trim()).digest("hex").slice(0, 16);
}
/** 等待审批的默认上限：一天。超时即拦截并告知模型，不让 run 无限期挂起（可用 PI_DURABLE_APPROVAL_TIMEOUT / host.json guard.approvalTimeoutSec 调短）。 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export function buildGuard({ approvalsFile, timingLog, judge, mode = "block", bashTimeout = 0, approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS } = {}) {
	const pendingFile = approvalsFile ? pendingFileOf(approvalsFile) : undefined;
	const timers = [createBashTool(), createReadTool(), createWriteTool(), createEditTool()];
	// bash 默认超时（秒）。pi-durable 的 bash schema 是 timeout "no default"——模型不传时 env.exec
	// 无限等待，一条死循环命令就能挂死 run，进而挂死 daemon 的优雅停止与热重启（close 要等在途调用，issue #147）。
	// >0 时：模型未传 → 注入默认；显式传更大值 → 封顶；更小值 → 尊重。0 = 不设防。
	const clampBashArgs = (tool, args) => {
		if (tool !== "bash" || !(bashTimeout > 0)) return args;
		const asked = Number(args?.timeout);
		const has = Number.isFinite(asked) && asked > 0;
		return { ...args, timeout: has ? Math.min(asked, bashTimeout) : bashTimeout };
	};
	// guard 档位（host.json guard.mode，env PI_DURABLE_GUARD 优先）：
	//   block（默认）破坏性命令硬拦进待批；flag 只记待批+审计不阻塞；off 完全关。
	// 用户全程盯场时可切 flag/off 省去审批琐事（issue #100）。
	if (mode === "off") return undefined;
	return defineExtension({
		name: "host-guard",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, context) => {
					if (call.name !== "bash") return undefined;
					const command = String(call.arguments?.command ?? "");
					const hit = judgeCommand(command, approvalsFile && isApproved(approvalsFile, command));
					if (!hit) {
						// 放行也审计（issue #70：现在放行零记录）；有 judge 时再叠加一次独立判断
						if (judge) {
							judge.noul("这条 bash 命令有破坏性吗？", { command })
								.catch(() => {}); // 观感只进 judge-log，不写待批（guard 域 ckpt PoC 已判不可靠，误报海噪真拦截，issue #98）
							}
						return undefined;
					}
					// 置信路由（issue #70 落点 2）：灰表命中——外部副作用/系统变更类，非硬破坏。
					// 原则不变：硬破坏表永远人工；灰表语义判别只在 block 模式生效，flag/off 模式仅审计。
					if (hit.severity === "gray") {
						if (mode === "flag") {
							console.error(`[guard] gray 审计（${hit.why}，flag 模式不路由）：${command.slice(0, 120)}`);
							return undefined; // 盯场模式：用户看得到流水，不动行为
						}
						if (judge) {
							let p = null;
							try {
								p = (await judge.noul("这条命令会对系统或远端造成难以撤销的改动吗？", { command }))?.p ?? null;
							} catch {} // judge 失败 → 保守路径（与无 judge 同）
							if (p != null && p <= 0.25) {
								console.error(`[guard] gray 置信放行（${hit.why}，p=${p.toFixed(2)}）：${command.slice(0, 120)}`);
								return undefined; // 高置信无副作用：放行，judge-log 已留审计
							}
							if (p != null) hit.judgeP = p;
						}
						// 低置信/判不出/无 judge → 落到下方保守路径（与硬拦同路）
					}
					if (mode === "flag") {
						// flag 模式：命令已执行，不写待批（issue #106：写进去只会制造“批准已发生的事”的无意义历史）
						console.error(`[guard] flag 模式放行（${hit.why}）：${command.slice(0, 120)}`);
						return undefined; // 只审计 + 日志，不阻塞：用户自己看得到流水
					}
					// block 模式 = 审批闸门（pi-durable 1.6 gates / signals）。命令不执行，调用挂起等待人工决定：
					// 不占调用、跨重启存活；用户批准后调用自动继续执行，不再需要模型“重试原命令”多跑一轮。
					// 每次唤醒（信号送达 / 重开 Harness / 注册表变化）都从头上重跑本钩子：
					//   已进批准清单 → 上方 judgeCommand 已判放行；否则读信号：同意 → 放行；拒绝 / 超时 → 拦截；
					//   没有决定（重开等外部唤醒）→ 继续挂起（同一 key、memo 过的同一截止时间）。
					const key = approvalKey(command);
					const state = await api.readSignal(ApprovalDecision, key, context);
					if (state !== undefined && "value" in state && state.value.allow) {
						if (pendingFile) clearPending(pendingFile, command);
						return undefined;
					}
					if (state !== undefined) {
						const expired = "expired" in state;
						if (pendingFile) clearPending(pendingFile, command);
						return {
							block: expired
								? `host-guard: 命令等待审批超时（${formatWait(approvalTimeoutMs)}内未获批准），本次不执行。\n命令原文：${command}\n如确需执行，请用户批准后重新发起。`
								: `host-guard: 用户拒绝了该命令（${hit.why}），本次不执行。\n命令原文：${command}\n不要换个写法绕过；如确有必要，向用户说明理由，由其手动执行或在「审批」面板批准后再试。`,
						};
					}
					if (pendingFile) addPending(pendingFile, { command, why: hit.why, judge: hit, taskId: api.taskId, key });
					const until = await api.memo(`host-guard.approval.until.${key}`, api.now() + approvalTimeoutMs, context); // 一个问题一个截止时间：后续唤醒复用
					return { sleep: { signals: [ApprovalDecision.key(key)], until } };
				},
			}),
		],
		wraps: timers.map((tool) =>
			wrapTool(tool, (winner) => ({
				...winner,
				execute: async (args, api, context) => {
					const start = performance.now();
					try {
						return await winner.execute(clampBashArgs(winner.name, args), api, context);
					} finally {
						if (timingLog) {
							const ms = Math.round(performance.now() - start);
							try {
								appendFileSync(timingLog, `${new Date().toISOString()}\t${winner.name}\t${ms}ms\n`);
							} catch {}
						}
					}
				},
			})),
		),
	});
}

// ---------------------------------------------------------------------------
// host-screen（工具结果护栏，issue #78）
// ---------------------------------------------------------------------------

/**
 * 工具结果护栏：bash/read 的输出进 agent context 前过 System One 判别。
 * judge.provider 非 system-one 时返回 null（heuristic 规则域只有 bash 破坏性，无内容语义）。
 *   mode "flag"（默认）—— 判定可疑也原样放行，仅审计 + onFlag 回调（server 转发 SSE/UI）。
 *   mode "block" —— injection 判定 p>=0.5 时把结果替换为拦截说明（isError），原始输出隔离在审计日志。
 * 降级：screening 失败永远放行原结果（可用性优先，可疑内容由结算单/体检兜底观测）。
 */
export function buildScreen({ judge, mode = "flag", onFlag, minChars = 60, budgetChars = 4000 } = {}) {
	if (!judge || judge.provider !== "system-one") return null;

	async function screenTool(toolName, args, result) {
		if (!result || result.isError) return result; // 显性错误走 guard/体检域
		// pi-durable 1.2.0：ToolExecutionResult.content 更名 output（块数组或字符串，textOf 两者都吃）
		const text = textOf({ content: result.output ?? "" });
		if (text.length < minChars) return result; // 确认类短输出无注入面
		try {
			const state = { tool: toolName, args: JSON.stringify(args ?? {}).slice(0, 400), output: text.slice(0, budgetChars) };
			const answers = await judge.batch(SCREEN_QUESTIONS, state);
			const injection = answers.injection?.p ?? null;
			const mislead = answers.mislead?.p ?? null;
			const hit = injection != null && injection >= 0.5;
			const suspect = mislead != null && mislead >= 0.7;
			if (!hit && !suspect) return result;
			onFlag?.({
				at: new Date().toISOString(), type: "screen", tool: toolName, mode,
				flags: [...(hit ? ["injection"] : []), ...(suspect ? ["mislead"] : [])],
				injection, mislead, preview: text.slice(0, 200),
			});
			if (hit && mode === "block") {
				return {
					...result,
					isError: true,
					output: `host-screen: 工具输出被护栏拦截（注入判定 p=${injection.toFixed(2)}）。原始输出已隔离到审计日志（data/judge-log.jsonl）。如确需查看该内容，请用户人工检查此来源后再决定是否放行。`,
				};
			}
		} catch {
			// screening 是旁路：任何失败不阻断工具结果
		}
		return result;
	}

	const wrap = (name) => (winner) => ({
		...winner,
		execute: async (args, api, context) => {
			const result = await winner.execute(args, api, context);
			return await screenTool(name, args, result); // block 模式可能替换为拦截说明
		},
	});

	return defineExtension({
		name: "host-screen",
		wraps: [wrapTool(createBashTool(), wrap("bash")), wrapTool(createReadTool(), wrap("read"))],
	});
}

// ---------------------------------------------------------------------------
// host-team (subagent)
// ---------------------------------------------------------------------------

export const SubagentExtension = defineExtension({
	name: "host-team",
	tools: [
		defineTool({
			name: "subagent",
			description:
				"把一个自包含的子任务委派给子代理（一个独立、持久、可恢复的会话），等待并返回它的文本回答。" +
				"子代理看不到当前对话，任务描述必须自包含。",
			parameters: obj({
				task: str({ description: "自包含的子任务描述" }),
			}),
			// A rerun after a crash finds the same child conversation (ownership index)
			// and the same submission (requestId), so delegation is exactly-once.
			replay: "safe",
			execute: async (args, api, context) => {
				const child = await api.commit(async (tx) => {
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					// Owned by this call: aborting the call aborts the subagent.
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					// Starts as a copy of this conversation's agent. Drop the recursion and focus it.
					await configure(tx, created.id, {
						extensions: { remove: [SubagentExtension] },
						instructions:
							"你是子代理：专注完成交给你的任务，回答简洁（默认 200 字以内），不要反问。" +
							"只在当前工作目录内操作。",
					});
					return created.id;
				}, context);
				// Lets a UI show the subagent under the call.
				await api.details({ conversationId: child }, context);
				const handle = await api.conversation(child, context);
				if (!handle) {
					return { output: [{ type: "text", text: `子代理会话 ${child} 不存在` }], isError: true };
				}
				const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` };
				const settled = await (await handle.submit(request, context)).wait(context);
				if (settled.status !== "done" || settled.type !== "input") {
					const reason = settled.status === "unanswered" ? settled.reason : settled.status;
					return { output: [{ type: "text", text: `子代理未能回答：${reason}` }], isError: true };
				}
				// The answer entry already exists in the child's transcript; read it typed.
				const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
				const answer = textOf(entry?.model?.[0]) || "(子代理没有文本回答)";
				return { output: [{ type: "text", text: answer }] };
			},
		}),
	],
});
