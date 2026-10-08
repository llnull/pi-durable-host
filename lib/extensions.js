// Host extensions for the pi-durable local host.
//
// Three extensions, all plain data + code, installed into the registry by host.js:
//
//   host-project-context — system prompt section that injects AGENTS.md from the
//     conversation's working directory. Content is stable between edits, so the
//     provider prompt cache stays warm (the section is only re-sent when it changes).
//
//   host-guard — beforeTool hook that blocks dangerous bash commands unless the
//     exact command has been approved (data/approvals.json), plus wrapTool timers
//     that append every tool call's duration to data/tool-timing.log.
//
//   host-team — a replay-safe `subagent` tool: creates a child conversation owned
//     by the tool call task, waits for its answer, and returns the text. A crash
//     rerun finds the same child via the ownership index and the same submission
//     via requestId, so delegation is exactly-once.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, configure, defineExtension, defineTool, hook, section, wrapTool, ToolTask } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { addPending, isApproved, pendingFileOf } from "./approvals.js";
import { textOf } from "./format.js";

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

const DANGEROUS_PATTERNS = [
	{ re: /(?:^|\s)(?:sudo|doas)\s/, why: "提权命令" },
	{ re: /(?:^|\s)rm\s+(?:-{1,2}[\w-]+\s+)*-\w*[rR]/, why: "递归删除（rm -r）" },
	{ re: /(?:^|\s)rm\s+(?:-{1,2}[\w-]+\s+)*-\w*f/, why: "强制删除（rm -f）" },
	{ re: /mkfs/, why: "格式化文件系统" },
	{ re: /(?:^|\s)dd\s+[^|]*of=\/dev\//, why: "直写块设备" },
	{ re: /:\(\)\s*\{.*\}\s*;\s*;/, why: "fork 炸弹" },
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
 * Approval hook + timing wraps.
 *
 * Approval model: a blocked command is never rerun silently. The block message
 * tells the model (and the user) the exact escape hatches: one-click approval in
 * the web UI (blocked commands land in data/approvals-pending.json), or
 * `node host.js approve -- <command>`. Reading the allowlist file on every call
 * is pure, so a rerun after a crash is safe.
 */
export function buildGuard({ approvalsFile, timingLog } = {}) {
	const pendingFile = approvalsFile ? pendingFileOf(approvalsFile) : undefined;
	const timers = [createBashTool(), createReadTool(), createWriteTool(), createEditTool()];
	return defineExtension({
		name: "host-guard",
		hooks: [
			hook(ToolTask, {
				beforeTool: (call) => {
					if (call.name !== "bash") return undefined;
					const command = String(call.arguments?.command ?? "");
					if (!command.trim()) return undefined;
					const hit = DANGEROUS_PATTERNS.find((p) => p.re.test(command));
					if (!hit) return undefined;
					if (approvalsFile && isApproved(approvalsFile, command)) return undefined;
					if (pendingFile) addPending(pendingFile, { command, why: hit.why });
					return {
						block:
							`host-guard: 命令被判定为危险（${hit.why}），已阻止。\n` +
							`命令原文：${command}\n` +
							`如确需执行，用户可在 Web UI 的「审批」面板一键批准，或运行：node host.js approve -- ${command}\n` +
							`该命令已加入待批清单；批准后重试原命令即可。`,
					};
				},
			}),
		],
		wraps: timers.map((tool) =>
			wrapTool(tool, (winner) => ({
				...winner,
				execute: async (args, api, context) => {
					const start = performance.now();
					try {
						return await winner.execute(args, api, context);
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
			parameters: Type.Object({
				task: Type.String({ description: "自包含的子任务描述" }),
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
					return { content: [{ type: "text", text: `子代理会话 ${child} 不存在` }], isError: true };
				}
				const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` };
				const settled = await (await handle.submit(request, context)).wait(context);
				if (settled.status !== "done" || settled.type !== "input") {
					const reason = settled.status === "unanswered" ? settled.reason : settled.status;
					return { content: [{ type: "text", text: `子代理未能回答：${reason}` }], isError: true };
				}
				// The answer entry already exists in the child's transcript; read it typed.
				const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
				const answer = textOf(entry?.model?.[0]) || "(子代理没有文本回答)";
				return { content: [{ type: "text", text: answer }] };
			},
		}),
	],
});
