#!/usr/bin/env node
// Pi Durable host — durable conversations on SQLite, model via Ark relay (anthropic-messages).
//
// Commands:
//   node host.js ask <prompt> [--fresh]   Submit a prompt (idempotent by content), wait, print the answer.
//   node host.js history [n]              Print the last n transcript entries (default 50).
//   node host.js wait [seconds]           Wait for a run a previous process left unfinished.
//   node host.js status                   Conversation state: busy, inbox, agent, usage, tasks.
//   node host.js tasks                    Print the live task graph.
//   node host.js approve -- <command> | --list | --revoke <n>
//                                         Manage the bash-command approval allowlist (host-guard).
//   node host.js serve [port] [--host h]  Long-lived daemon: web UI + SSE live view + HTTP API.
//   node host.js config                   Reset the stored agent cwd/model to this directory's values.
//
// Every command holds a single-writer lock on the storage (data/host.lock) for its
// lifetime: pi-durable storage has no cross-process locking. Run `serve` to keep
// one long-lived owner and attach everything else to it over HTTP.
// Model backends are multi-host: lib/models.js reads this machine's pi config
// (~/.pi/agent) when present, or the Ark relay when its token is set. See the
// header of lib/models.js for PI_DURABLE_PROVIDER / PI_DURABLE_MODEL.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, ToolResultEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, releaseLock } from "./lib/lock.js";
import { buildGuard, buildProjectContext, SubagentExtension } from "./lib/extensions.js";
import { openModelLayer } from "./lib/models.js";
import { startServer } from "./lib/server.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, "data");
const DATA_FILE = path.join(DATA_DIR, "session.sqlite");
const LOCK_FILE = path.join(DATA_DIR, "host.lock");
const APPROVALS_FILE = path.join(DATA_DIR, "approvals.json");
const TIMING_LOG = path.join(DATA_DIR, "tool-timing.log");
const WORKSPACE = path.join(HERE, "workspace");

const MODEL_LAYER = openModelLayer();
const MODEL = MODEL_LAYER.model;

function buildModels() {
	return MODEL_LAYER.models;
}

function buildRegistry() {
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(buildProjectContext()); // injects workspace AGENTS.md when present
	registry.install(buildGuard({ approvalsFile: APPROVALS_FILE, timingLog: TIMING_LOG }));
	registry.install(SubagentExtension); // provides the `subagent` tool
	return registry;
}

async function openHarness() {
	mkdirSync(DATA_DIR, { recursive: true });
	mkdirSync(WORKSPACE, { recursive: true });
	acquireLock(LOCK_FILE);
	const storage = await openNodeSqliteStorage(DATA_FILE);
	const harness = await Harness.open(
		storage,
		{
			models: buildModels(),
			registry: buildRegistry(),
			env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? WORKSPACE }),
			settings: {
				stream: { timeoutMs: 120_000 },
				retry: { maxRetries: 3 },
				// Automatic compaction: a background summary starts well before the
				// ceiling; generation only blocks when the next request would not fit.
				compaction: {
					enabled: true,
					reserveTokens: 16384,
					keepRecentTokens: 20000,
					backgroundTokens: 32768,
				},
				progress: { partialIntervalMs: 100, outputIntervalMs: 100 },
				toolExecution: "parallel",
				contextRetentionMs: 600_000,
			},
		},
		BACKGROUND_CONTEXT,
	);
	harness.resume(); // continue runs a previous process left unfinished
	return harness;
}

function getRoot(harness) {
	return harness.root(BACKGROUND_CONTEXT, {
		agent: {
			model: MODEL,
			thinkingLevel: "high",
			cwd: WORKSPACE,
			instructions:
				"You are the Pi Durable host agent on this machine. Be concise. Work only inside the current working directory.",
		},
	});
}

function textOf(message) {
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block) => block && block.type === "text")
			.map((block) => block.text)
			.join("");
	}
	return "";
}

function oneLine(text, max = 160) {
	const flat = String(text).replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

async function cmdAsk(args) {
	const fresh = args.includes("--fresh");
	const rest = args.filter((a) => a !== "--fresh");
	const prompt = rest.join(" ");
	if (!prompt) {
		console.error("usage: node host.js ask <prompt> [--fresh]");
		process.exitCode = 2;
		return;
	}
	// Idempotent by content: a retried ask (same prompt, no --fresh) rejoins the
	// original submission instead of asking the model twice. --fresh forces a new one.
	const requestId = fresh ? undefined : `ask:${createHash("sha256").update(prompt).digest("hex").slice(0, 24)}`;
	const context = BACKGROUND_CONTEXT;
	const harness = await openHarness();
	try {
		const root = await getRoot(harness);
		const submission = await root.submit(
			requestId ? { type: "input", content: prompt, requestId } : { type: "input", content: prompt },
			context,
		);
		const prior = await submission.status(context);
		const reused = Boolean(requestId) && prior.status !== "queued";
		console.error(
			`[submitted ${submission.id}${reused ? " · 已存在的提交，直接复用（--fresh 可强制新提交）" : " · waiting for the run to settle"}]`,
		);
		const settled = await submission.wait(context);
		if (settled.status === "done" && settled.type === "input") {
			const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
			const message = entry?.model?.[0];
			console.log(textOf(message));
		} else {
			console.error(`unanswered: ${settled.status === "unanswered" ? settled.reason : settled.status}`);
			process.exitCode = 1;
		}
	} finally {
		await harness.close(context);
	}
}

async function cmdHistory(limit) {
	const context = BACKGROUND_CONTEXT;
	const harness = await openHarness();
	try {
		const root = await getRoot(harness);
		const transcript = await root.entries({}, limit, undefined, context);
		const items = [...transcript.items].reverse(); // newest-first → chronological
		if (items.length === 0) {
			console.log("(empty transcript)");
			return;
		}
		for (const entry of items) {
			if (ToolResultEntry.is(entry)) {
				const result = entry.model?.[0];
				console.log(`${entry.kind} ${result?.toolName ?? ""}: ${oneLine(textOf(result))}`);
			} else {
				const message = entry.model?.[0] ?? entry.data;
				console.log(`${entry.kind}: ${oneLine(textOf(message) || JSON.stringify(entry.data ?? ""))}`);
			}
		}
	} finally {
		await harness.close(context);
	}
}

async function cmdWait(timeoutMs = 600000) {
	const context = BACKGROUND_CONTEXT;
	const harness = await openHarness();
	try {
		const root = await getRoot(harness);
		const view = await root.viewState(context);
		const v = view.value ?? view;
		const inputs = (v.docs?.["pi.live"]?.run?.inputs ?? []).map(String);
		if (inputs.length === 0) {
			console.log("(no run in progress)");
			return;
		}
		console.error(`[run in progress; input(s): ${inputs.join(", ")}; waiting up to ${Math.round(timeoutMs / 1000)}s]`);
		const results = await Promise.all(
			inputs.map(async (id) => {
				const sub = await harness.submission(id, context);
				if (!sub) return `submission ${id}: not found`;
				const settled = await sub.wait(context);
				return `submission ${id}: ${settled.status}${settled.status === "unanswered" && settled.reason ? ` (${settled.reason})` : ""}`;
			}),
		);
		for (const line of results) console.log(line);
	} finally {
		await harness.close(context);
	}
}

async function cmdConfig() {
	const context = BACKGROUND_CONTEXT;
	const harness = await openHarness();
	try {
		const root = await getRoot(harness);
		await root.configure({ cwd: WORKSPACE, model: MODEL }, context);
		const agent = await root.agent(context);
		console.log("cwd:", agent.cwd);
		console.log("model:", agent.model?.provider + "/" + (agent.model?.modelId ?? agent.model?.id ?? "?"));
		console.log("model source:", MODEL_LAYER.source);
		console.log("extensions:", (agent.extensions ?? []).map((e) => e.name).join(", "));
	} finally {
		await harness.close(context);
	}
}

function sumUsage(usage) {
	let input = 0, output = 0, cacheRead = 0;
	for (const u of Object.values(usage?.models ?? {})) {
		input += u.input ?? 0;
		output += u.output ?? 0;
		cacheRead += u.cacheRead ?? 0;
	}
	return { input, output, cacheRead };
}

async function cmdStatus() {
	const context = BACKGROUND_CONTEXT;
	const harness = await openHarness();
	try {
		const root = await getRoot(harness);
		const view = await root.viewState(context);
		const v = view.value ?? view;
		const live = v.docs?.["pi.live"] ?? {};
		const busy = Boolean(live.run);
		const inbox = v.docs?.["pi.inbox"]?.items ?? [];
		const agent = await root.agent(context);
		console.log("conversation:", String(root.id));
		console.log("model source:", MODEL_LAYER.source);
		console.log("busy:", busy ? `yes (run task ${live.run.taskId}, inputs: ${live.run.inputs.join(", ")})` : "no");
		if (busy && live.generation) {
			console.log("generation:", `attempt ${live.generation.attempt}${live.generation.retry ? ` · retrying: ${live.generation.retry.error}` : ""}`);
		}
		for (const tool of live.tools ?? []) console.log(`tool: ${tool.name} ${tool.status}`);
		for (const c of live.compactions ?? []) console.log(`compaction: ${c.reason}${c.blocking ? " (blocking)" : ""} attempt ${c.attempt}`);
		console.log("inbox:", inbox.length === 0 ? "(empty)" : "");
		for (const item of inbox) {
			const content = item.content?.content ?? JSON.stringify(item.entry ?? "");
			console.log(`  [${item.mode}] ${oneLine(String(content), 100)}`);
		}
		console.log("entries:", (v.entries ?? []).length);
		console.log("agent:", `${agent.model?.provider}/${agent.model?.modelId} · cwd=${agent.cwd} · extensions=${(agent.extensions ?? []).map((e) => e.name).join(",")}`);
		const { input, output, cacheRead } = sumUsage(await harness.usage(context));
		console.log(`usage: input=${input} output=${output} cacheRead=${cacheRead} (tokens)`);
		const graph = await harness.taskGraph(context);
		const nodes = Object.values((graph.value ?? graph).tasks ?? {});
		console.log("live tasks:", nodes.length === 0 ? "(none)" : "");
		for (const node of nodes) {
			console.log(`  #${node.id} ${node.kind} ${node.state.status}${node.background ? " (background)" : ""}${node.owner ? ` (owner #${node.owner})` : ""}`);
		}
	} finally {
		await harness.close(context);
	}
}

async function cmdTasks() {
	const context = BACKGROUND_CONTEXT;
	const harness = await openHarness();
	try {
		const graph = await harness.taskGraph(context);
		const nodes = Object.values((graph.value ?? graph).tasks ?? {});
		if (nodes.length === 0) {
			console.log("(no live tasks)");
			return;
		}
		for (const node of nodes) {
			const state = node.state.status === "waiting" ? `waiting on ${node.state.on.join(", ")} (${node.state.policy})` : `${node.state.status}${node.state.phase ? ` · ${node.state.phase}` : ""}`;
			console.log(`#${node.id} ${node.kind} ${state}${node.background ? " [background]" : ""}${node.abortRequested ? " [abort requested]" : ""}`);
			console.log(`   owner: ${node.owner ? `task #${node.owner}` : `conversation ${node.conversationId}`}${node.conversations.length ? ` · owns conversations: ${node.conversations.join(", ")}` : ""}`);
		}
	} finally {
		await harness.close(context);
	}
}

function readApprovals() {
	try {
		const parsed = JSON.parse(readFileSync(APPROVALS_FILE, "utf8"));
		return Array.isArray(parsed?.items) ? parsed.items : [];
	} catch {
		return [];
	}
}

function writeApprovals(items) {
	writeFileSync(APPROVALS_FILE, `${JSON.stringify({ items }, null, "\t")}\n`);
}

async function cmdApprove(args) {
	if (args[0] === "--list") {
		const items = readApprovals();
		if (items.length === 0) {
			console.log("(approval allowlist is empty)");
			return;
		}
		for (const [index, item] of items.entries()) console.log(`${index + 1}. ${item.command}${item.addedAt ? `  (added ${item.addedAt})` : ""}`);
		return;
	}
	if (args[0] === "--revoke") {
		const index = Number.parseInt(args[1], 10);
		const items = readApprovals();
		if (!Number.isInteger(index) || index < 1 || index > items.length) {
			console.error(`usage: node host.js approve --revoke <1-${Math.max(items.length, 1)}>`);
			process.exitCode = 2;
			return;
		}
		const [removed] = items.splice(index - 1, 1);
		writeApprovals(items);
		console.log("revoked:", removed.command);
		return;
	}
	const command = args.join(" ").trim();
	if (!command) {
		console.error("usage: node host.js approve -- <command> | node host.js approve --list | node host.js approve --revoke <n>");
		process.exitCode = 2;
		return;
	}
	const items = readApprovals();
	if (items.some((item) => item.command === command)) {
		console.log("already approved:", command);
		return;
	}
	items.push({ command, addedAt: new Date().toISOString() });
	writeApprovals(items);
	console.log("approved:", command);
}

async function cmdServe(args) {
	let port = 7600;
	let host = process.env.PI_DURABLE_HOST ?? "127.0.0.1";
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (/^\d+$/.test(arg)) port = Number.parseInt(arg, 10);
		else if (arg === "--host") host = args[++i] ?? host;
		else if (arg === "--port") port = Number.parseInt(args[++i], 10) || port;
	}
	const token = process.env.PI_DURABLE_TOKEN;
	if ((host === "0.0.0.0" || host === "::") && !token) {
		console.error("[serve] 警告：绑定到所有地址且未设置 PI_DURABLE_TOKEN，任何能访问该端口的人都可以驱动本机 agent。");
	}
	const context = BACKGROUND_CONTEXT;
	const harness = await openHarness();
	try {
		const root = await getRoot(harness);
		const view = await root.viewState(context);
		const v = view.value ?? view;
		const inputs = (v.docs?.["pi.live"]?.run?.inputs ?? []).map(String);
		if (inputs.length > 0) console.error(`[serve] 检测到未完成的 run（inputs: ${inputs.join(", ")}），resume() 已接管。`);
		await startServer({ harness, root, port, host, token });
	} catch (err) {
		console.error("[serve] 启动失败:", err.message);
		process.exitCode = 1;
		try {
			await harness.close(context);
		} catch {}
	}
}

const [command, ...rest] = process.argv.slice(2);
const commands = {
	ask: () => cmdAsk(rest),
	history: () => cmdHistory(Number(rest[0] ?? 50)),
	wait: () => cmdWait(Number(rest[0] ?? 600) * 1000),
	config: () => cmdConfig(),
	status: () => cmdStatus(),
	tasks: () => cmdTasks(),
	approve: () => cmdApprove(rest[0] === "--" ? rest.slice(1) : rest),
	serve: () => cmdServe(rest),
};
if (!command || !commands[command]) {
	console.error(
		"usage: node host.js ask <prompt> [--fresh] | history [n] | wait [s] | status | tasks |\n" +
			"       approve -- <cmd> | approve --list | approve --revoke <n> | serve [port] [--host h] | config",
	);
	process.exitCode = 2;
} else {
	// serve keeps the process (and the lock) alive until a signal; everything else
	// releases the lock when its command finishes. The exit handler is the safety net.
	process.on("exit", () => releaseLock(LOCK_FILE));
	try {
		await commands[command]();
		if (command !== "serve") releaseLock(LOCK_FILE);
	} catch (err) {
		console.error(`[host] ${command} 失败:`, err.message ?? err);
		process.exitCode = 1;
	}
}
