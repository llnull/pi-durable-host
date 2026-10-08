#!/usr/bin/env node
// Pi Durable host — durable conversations on SQLite, served by one daemon.
//
// Commands (all transparently forward to a running daemon over HTTP —
// see lib/daemon.js — so the CLI works while `serve` owns the lock):
//
//   node host.js ask <prompt> [--fresh] [--session s]  Submit a prompt, wait, print the answer.
//   node host.js history [n] [--session s]             Print the last n transcript entries.
//   node host.js wait [seconds]                        Wait for runs a previous process left unfinished.
//   node host.js status                                Conversation state: busy, inbox, agent, usage, tasks.
//   node host.js tasks                                 Print the live task graph.
//   node host.js sessions                              List named sessions (one durable conversation each).
//   node host.js approve -- <command> | --list | --revoke <n>
//                                                      Manage the bash-command approval allowlist (host-guard).
//   node host.js backup [file]                         VACUUM INTO a consistent snapshot (data/backups/).
//   node host.js timing [n]                            tool-timing.log summary (per tool count/avg/p95).
//   node host.js restart                               Hot-restart the daemon: successor takes over, runs resume.
//   node host.js serve [port] [--host h] [--takeover]  Long-lived daemon: web UI + SSE + HTTP API.
//   node host.js config                                Reset the stored agent cwd/model to this directory's values.
//
// Every command that touches the storage holds a single-writer lock
// (data/host.lock): pi-durable storage has no cross-process locking. Run
// `serve` to keep one long-lived owner and attach everything else to it over
// HTTP. --takeover (used by POST /api/restart) waits for the old holder to exit.
// PI_DURABLE_DATA_DIR overrides the data directory (default <repo>/data).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, ToolResultEntry, createRegistry, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, releaseLock } from "./lib/lock.js";
import { buildGuard, buildProjectContext, SubagentExtension } from "./lib/extensions.js";
import { openModelLayer } from "./lib/models.js";
import { startServer } from "./lib/server.js";
import { detectDaemon, daemonApi } from "./lib/daemon.js";
import { collectStatus, printHistory, printStatus, textOf } from "./lib/format.js";
import { approveCommand, pendingFileOf, readApprovals, readPending, revokeApprovalAt } from "./lib/approvals.js";
import { backupStorageFile } from "./lib/backup.js";
import { DEFAULT_SESSION, assertSessionName, readSessions, sessionsFile, sessionConversationId, writeSessions } from "./lib/sessions.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_PATH = fileURLToPath(import.meta.url);
const DATA_DIR = process.env.PI_DURABLE_DATA_DIR ? path.resolve(process.env.PI_DURABLE_DATA_DIR) : path.join(HERE, "data");
const DATA_FILE = path.join(DATA_DIR, "session.sqlite");
const LOCK_FILE = path.join(DATA_DIR, "host.lock");
const APPROVALS_FILE = path.join(DATA_DIR, "approvals.json");
const TIMING_LOG = path.join(DATA_DIR, "tool-timing.log");
const SERVE_LOG = path.join(DATA_DIR, "serve.log");
const WORKSPACE = path.join(HERE, "workspace");

const MODEL_LAYER = openModelLayer();
const MODEL = MODEL_LAYER.model;

const DEFAULT_AGENT = {
	model: MODEL,
	thinkingLevel: "high",
	cwd: WORKSPACE,
	instructions:
		"You are the Pi Durable host agent on this machine. Be concise. Work only inside the current working directory.",
};

function buildRegistry() {
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(buildProjectContext()); // injects workspace AGENTS.md when present
	registry.install(buildGuard({ approvalsFile: APPROVALS_FILE, timingLog: TIMING_LOG }));
	registry.install(SubagentExtension); // provides the `subagent` tool
	return registry;
}

async function openHarness({ takeover = false } = {}) {
	mkdirSync(DATA_DIR, { recursive: true });
	mkdirSync(WORKSPACE, { recursive: true });
	await acquireLock(LOCK_FILE, { waitMs: takeover ? 60_000 : 0 });
	const storage = await openNodeSqliteStorage(DATA_FILE);
	const harness = await Harness.open(
		storage,
		{
			models: MODEL_LAYER.models,
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
	return harness.root(BACKGROUND_CONTEXT, { agent: DEFAULT_AGENT });
}

/** Resolve a session name (default = root conversation) to a Conversation. */
async function conversationFor(harness, root, name) {
	if (name === DEFAULT_SESSION) return root;
	const id = sessionConversationId(readSessions(sessionsFile(DATA_DIR)), name);
	const conv = await harness.conversation(id, BACKGROUND_CONTEXT);
	if (!conv) throw new Error(`会话 ${name} 指向的 conversation ${id} 不存在`);
	return conv;
}

function sessionFlag(args) {
	const index = args.indexOf("--session");
	if (index === -1) return { session: undefined, rest: args };
	const value = args[index + 1];
	if (!value) throw new Error("--session 需要一个会话名（node host.js sessions 查看）");
	assertSessionName(value);
	return { session: value, rest: args.filter((_, i) => i !== index && i !== index + 1) };
}

/** Split args of the shape `ask <prompt> [--fresh] [--session s]`. */
function askArgs(args) {
	const { session, rest } = sessionFlag(args);
	const fresh = rest.includes("--fresh");
	const prompt = rest.filter((a) => a !== "--fresh").join(" ");
	return { session, fresh, prompt };
}

// ---------------------------------------------------------------------------
// daemon forwarding
// ---------------------------------------------------------------------------

/** The running daemon to forward to, or undefined. Exits with a hint on serve. */
function requireDaemonOrThrow(command) {
	const daemon = detectDaemon(DATA_DIR);
	if (daemon) console.error(`[forward] daemon pid ${daemon.pid} 正在运行，${command} 转发到 ${daemon.baseUrl}`);
	return daemon;
}

async function forwardAsk(args) {
	const { session, fresh, prompt } = askArgs(args);
	if (!prompt) {
		console.error("usage: node host.js ask <prompt> [--fresh] [--session s]");
		process.exitCode = 2;
		return;
	}
	const daemon = requireDaemonOrThrow("ask");
	// Idempotent by content: a retried ask (same prompt, no --fresh) rejoins the
	// original submission instead of asking the model twice.
	const requestId = fresh ? undefined : `ask:${createHash("sha256").update(prompt).digest("hex").slice(0, 24)}`;
	const { id } = await daemonApi(daemon, "POST", "/api/ask", { content: prompt, ...(session ? { session } : {}), ...(requestId ? { requestId } : {}) });
	console.error(`[submitted ${id} · waiting]`);
	for (;;) {
		await new Promise((r) => setTimeout(r, 1000));
		const { submission } = await daemonApi(daemon, "GET", `/api/submission?id=${encodeURIComponent(id)}`);
		if (submission.status === "queued" || submission.status === "placed") continue;
		if (submission.status === "done" && submission.answer) {
			const entry = await daemonApi(daemon, "GET", `/api/entry?id=${encodeURIComponent(submission.answer)}`);
			console.log(entry.text || "(no text)");
		} else {
			console.error(`unanswered: ${submission.reason ?? submission.status}`);
			process.exitCode = 1;
		}
		return;
	}
}

// ---------------------------------------------------------------------------
// local commands (no daemon running)
// ---------------------------------------------------------------------------

async function cmdAsk(args) {
	const { session, fresh, prompt } = askArgs(args);
	if (!prompt) {
		console.error("usage: node host.js ask <prompt> [--fresh] [--session s]");
		process.exitCode = 2;
		return;
	}
	const requestId = fresh ? undefined : `ask:${createHash("sha256").update(prompt).digest("hex").slice(0, 24)}`;
	const context = BACKGROUND_CONTEXT;
	const harness = await openHarness();
	try {
		const root = await getRoot(harness);
		const conv = await conversationFor(harness, root, session ?? DEFAULT_SESSION);
		const submission = await conv.submit(
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
			const entry = await conv.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
			console.log(textOf(entry?.model?.[0]));
		} else {
			console.error(`unanswered: ${settled.status === "unanswered" ? settled.reason : settled.status}`);
			process.exitCode = 1;
		}
	} finally {
		await harness.close(context);
	}
}

async function cmdHistory(args) {
	const { session, rest } = sessionFlag(args);
	const limit = Number.parseInt(rest[0] ?? "50", 10) || 50;
	const daemon = requireDaemonOrThrow("history");
	if (daemon) {
		const data = await daemonApi(daemon, "GET", `/api/history?limit=${limit}${session ? `&session=${encodeURIComponent(session)}` : ""}`);
		printHistory(data.items);
		return;
	}
	const context = BACKGROUND_CONTEXT;
	const harness = await openHarness();
	try {
		const root = await getRoot(harness);
		const conv = await conversationFor(harness, root, session ?? DEFAULT_SESSION);
		const transcript = await conv.entries({}, limit, undefined, context);
		const items = [...transcript.items].reverse().map((entry) => {
			if (ToolResultEntry.is(entry)) {
				const result = entry.model?.[0];
				return { kind: entry.kind, toolName: result?.toolName ?? "", text: textOf(result) };
			}
			const message = entry.model?.[0] ?? entry.data;
			return { kind: entry.kind, text: textOf(message) || JSON.stringify(entry.data ?? "") };
		});
		printHistory(items);
	} finally {
		await harness.close(context);
	}
}

async function cmdStatus(args) {
	const { session } = sessionFlag(args);
	const daemon = requireDaemonOrThrow("status");
	if (daemon) {
		printStatus(await daemonApi(daemon, "GET", "/api/status"));
		return;
	}
	const context = BACKGROUND_CONTEXT;
	const harness = await openHarness();
	try {
		const root = await getRoot(harness);
		const conv = await conversationFor(harness, root, session ?? DEFAULT_SESSION);
		printStatus(await collectStatus({ harness, conv, modelSource: MODEL_LAYER.source, context }));
	} finally {
		await harness.close(context);
	}
}

async function cmdTasks() {
	const daemon = requireDaemonOrThrow("tasks");
	if (daemon) {
		const { graph } = await daemonApi(daemon, "GET", "/api/tasks");
		printTaskGraph(graph);
		return;
	}
	const context = BACKGROUND_CONTEXT;
	const harness = await openHarness();
	try {
		const graph = await harness.taskGraph(context);
		printTaskGraph(graph.value ?? graph);
	} finally {
		await harness.close(context);
	}
}

function printTaskGraph(graph) {
	const nodes = Object.values(graph?.tasks ?? {});
	if (nodes.length === 0) {
		console.log("(no live tasks)");
		return;
	}
	for (const node of nodes) {
		const state = node.state.status === "waiting" ? `waiting on ${node.state.on.join(", ")} (${node.state.policy})` : `${node.state.status}${node.state.phase ? ` · ${node.state.phase}` : ""}`;
		console.log(`#${node.id} ${node.kind} ${state}${node.background ? " [background]" : ""}${node.abortRequested ? " [abort requested]" : ""}`);
		console.log(`   owner: ${node.owner ? `task #${node.owner}` : `conversation ${node.conversationId}`}${node.conversations.length ? ` · owns conversations: ${node.conversations.join(", ")}` : ""}`);
	}
}

async function cmdWait(timeoutMs = 600000) {
	const daemon = requireDaemonOrThrow("wait");
	if (daemon) {
		// The daemon already resumed every unfinished run when it opened the storage.
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const status = await daemonApi(daemon, "GET", "/api/status");
			if (!status.busy) {
				console.log("(no run in progress)");
				return;
			}
			if (Date.now() > deadline) {
				console.error(`[仍在运行（run task ${status.run?.taskId}），超时退出]`);
				process.exitCode = 1;
				return;
			}
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
	const context = BACKGROUND_CONTEXT;
	const harness = await openHarness();
	try {
		const root = await getRoot(harness);
		const store = readSessions(sessionsFile(DATA_DIR));
		const inputs = [];
		for (const [name, entry] of Object.entries(store.sessions)) {
			const conv = name === DEFAULT_SESSION ? root : await harness.conversation(entry.conversationId, context);
			if (!conv) continue;
			const view = (await conv.viewState(context)).value ?? {};
			for (const id of view.docs?.["pi.live"]?.run?.inputs ?? []) inputs.push({ name, id: String(id) });
		}
		if (inputs.length === 0) {
			console.log("(no run in progress)");
			return;
		}
		console.error(`[run in progress; input(s): ${inputs.map((i) => `${i.name}:${i.id}`).join(", ")}; waiting up to ${Math.round(timeoutMs / 1000)}s]`);
		const results = await Promise.all(
			inputs.map(async ({ name, id }) => {
				const sub = await harness.submission(id, context);
				if (!sub) return `submission ${name}:${id}: not found`;
				const settled = await sub.wait(context);
				return `submission ${name}:${id}: ${settled.status}${settled.status === "unanswered" && settled.reason ? ` (${settled.reason})` : ""}`;
			}),
		);
		for (const line of results) console.log(line);
	} finally {
		await harness.close(context);
	}
}

async function cmdConfig() {
	const daemon = requireDaemonOrThrow("config");
	if (daemon) {
		await daemonApi(daemon, "POST", "/api/config", { cwd: WORKSPACE, model: MODEL });
	}
	const context = BACKGROUND_CONTEXT;
	const harness = daemon ? undefined : await openHarness();
	if (harness) {
		try {
			const root = await getRoot(harness);
			await root.configure({ cwd: WORKSPACE, model: MODEL }, context);
		} finally {
			await harness.close(context);
		}
	}
	console.log("cwd:", WORKSPACE);
	console.log("model:", `${MODEL.provider}/${MODEL.modelId}`);
	console.log("model source:", MODEL_LAYER.source);
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

async function cmdSessions(args) {
	const sub = args[0];
	const name = args[1];
	const daemon = requireDaemonOrThrow("sessions");
	const context = BACKGROUND_CONTEXT;
	try {
		if (!sub) {
			const payload = daemon
				? await daemonApi(daemon, "GET", "/api/sessions")
				: (() => {
					const store = readSessions(sessionsFile(DATA_DIR));
					return {
						current: store.current,
						sessions: Object.entries(store.sessions).map(([n, e]) => ({ name: n, conversationId: e.conversationId, createdAt: e.createdAt, note: e.note ?? "" })),
					};
				})();
			for (const s of payload.sessions) {
				console.log(`${s.name === payload.current ? "*" : " "} ${s.name.padEnd(20)} conv ${s.conversationId}${s.note ? ` · ${s.note}` : ""}`);
			}
			console.log(`(当前: ${payload.current}；node host.js sessions new|switch|delete <name> 管理)`);
			return;
		}
		if (daemon) {
			await daemonApi(daemon, "POST", "/api/sessions", { action: sub, name });
			console.log("ok");
			return;
		}
		assertSessionName(name);
		const file = sessionsFile(DATA_DIR);
		const store = readSessions(file);
		if (sub === "new") {
			if (store.sessions[name]) throw new Error(`会话已存在：${name}`);
			const harness = await openHarness();
			try {
				const created = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: DEFAULT_AGENT }, context);
				store.sessions[name] = { conversationId: created.id, createdAt: new Date().toISOString() };
				store.current = name;
				writeSessions(file, store);
				console.log(`created ${name} → conversation ${created.id}（已设为当前）`);
			} finally {
				await harness.close(context);
			}
			return;
		}
		if (sub === "switch") {
			if (!store.sessions[name]) throw new Error(`会话不存在：${name}`);
			store.current = name;
			writeSessions(file, store);
			console.log(`current → ${name}`);
			return;
		}
		if (sub === "delete") {
			if (name === DEFAULT_SESSION) throw new Error("default 会话不可删除");
			if (!store.sessions[name]) throw new Error(`会话不存在：${name}`);
			delete store.sessions[name];
			if (store.current === name) store.current = DEFAULT_SESSION;
			writeSessions(file, store);
			console.log(`deleted ${name}（conversation 数据保留在存储中）`);
			return;
		}
		throw new Error("用法：node host.js sessions [new|switch|delete] <name>");
	} catch (err) {
		console.error(err.message);
		process.exitCode = 1;
	}
}

// ---------------------------------------------------------------------------
// approvals / backup / timing / restart
// ---------------------------------------------------------------------------

async function cmdApprove(args) {
	const daemon = requireDaemonOrThrow("approve");
	if (daemon) {
		if (args[0] === "--list") {
			const { approved, pending } = await daemonApi(daemon, "GET", "/api/approvals");
			printApprovals(approved, pending);
			return;
		}
		if (args[0] === "--revoke") {
			const index = Number.parseInt(args[1], 10);
			const { revoked } = await daemonApi(daemon, "POST", "/api/approve/revoke", { index });
			console.log("revoked:", revoked);
			return;
		}
		const command = args.join(" ").trim();
		if (!command) throw new Error("usage: node host.js approve -- <command>");
		await daemonApi(daemon, "POST", "/api/approve", { command });
		console.log("approved:", command);
		return;
	}
	if (args[0] === "--list") {
		printApprovals(readApprovals(APPROVALS_FILE), readPending(pendingFileOf(APPROVALS_FILE)));
		return;
	}
	if (args[0] === "--revoke") {
		const index = Number.parseInt(args[1], 10);
		const removed = revokeApprovalAt(APPROVALS_FILE, index);
		if (!removed) {
			console.error(`usage: node host.js approve --revoke <1-${Math.max(readApprovals(APPROVALS_FILE).length, 1)}>`);
			process.exitCode = 2;
			return;
		}
		console.log("revoked:", removed.command);
		return;
	}
	const command = args.join(" ").trim();
	if (!command) {
		console.error("usage: node host.js approve -- <command> | node host.js approve --list | node host.js approve --revoke <n>");
		process.exitCode = 2;
		return;
	}
	approveCommand(APPROVALS_FILE, command);
	console.log("approved:", command);
}

function printApprovals(approved, pending) {
	if (approved.length === 0 && pending.length === 0) {
		console.log("(approval allowlist is empty)");
		return;
	}
	if (approved.length) {
		console.log("已批准（guard 放行）：");
		for (const [index, item] of approved.entries()) console.log(`${index + 1}. ${item.command}${item.addedAt ? `  (added ${item.addedAt})` : ""}`);
	}
	if (pending.length) {
		console.log("待批（guard 已拦截，等待用户决定）：");
		pending.forEach((item) => console.log(`  ! ${item.command}  (${item.why ?? "?"} · ${item.blockedAt ?? ""})`));
	}
}

async function cmdBackup(file) {
	const daemon = requireDaemonOrThrow("backup");
	if (daemon) {
		const { file: out } = await daemonApi(daemon, "POST", "/api/backup", file ? { file } : {});
		console.log("backup:", out);
		return;
	}
	// No daemon → no other process touches the file; VACUUM INTO takes a
	// consistent snapshot on its own connection.
	console.log("backup:", await backupStorageFile(DATA_FILE, file));
}

async function cmdTiming(limit = 10) {
	if (!existsSync(TIMING_LOG)) {
		console.log(`(no ${TIMING_LOG} — tool timing appears after serve runs tools)`);
		return;
	}
	const lines = readFileSync(TIMING_LOG, "utf8").trim().split("\n").filter(Boolean);
	const byTool = new Map();
	for (const line of lines) {
		const [date, tool, ms] = line.split("\t");
		const value = Number.parseInt(ms, 10);
		if (!tool || !Number.isInteger(value)) continue;
		if (!byTool.has(tool)) byTool.set(tool, []);
		byTool.get(tool).push(value);
	}
	if (byTool.size === 0) {
		console.log("(timing log is empty)");
		return;
	}
	console.log(`工具耗时汇总（${lines.length} 次调用，取自 ${TIMING_LOG}）：`);
	const p = (arr, q) => arr[Math.min(arr.length - 1, Math.floor((arr.length - 1) * q))];
	for (const [tool, times] of [...byTool.entries()].sort((a, b) => b[1].length - a[1].length)) {
		const sorted = [...times].sort((a, b) => a - b);
		const total = sorted.reduce((a, b) => a + b, 0);
		console.log(
			`  ${tool.padEnd(8)} n=${String(sorted.length).padStart(4)}  avg=${Math.round(total / sorted.length)}ms  p50=${p(sorted, 0.5)}ms  p95=${p(sorted, 0.95)}ms  max=${sorted[sorted.length - 1]}ms`,
		);
	}
	console.log(`最近 ${Math.min(limit, lines.length)} 条：`);
	for (const line of lines.slice(-limit)) console.log(`  ${line}`);
}

async function cmdRestart() {
	const daemon = requireDaemonOrThrow("restart");
	if (!daemon) {
		console.error("restart 需要 daemon 正在运行（node host.js serve）");
		process.exitCode = 1;
		return;
	}
	await daemonApi(daemon, "POST", "/api/restart");
	console.error("[restart] 已请求热重启；等待新 daemon 接管…");
	const deadline = Date.now() + 60_000;
	let lastErr = "";
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 1000));
		try {
			const probe = detectDaemon(DATA_DIR);
			if (probe) {
				const state = await daemonApi(probe, "GET", "/api/state");
				console.error(`[restart] 新 daemon 已就绪（pid ${probe.pid}，会话 ${state.session}，条目 ${(state.view?.entries ?? []).length}）`);
				console.log("ok");
				return;
			}
		} catch (err) {
			lastErr = err?.message ?? String(err);
		}
	}
	console.error(`[restart] 等待超时${lastErr ? `（${lastErr}）` : ""}；检查 ${SERVE_LOG}`);
	process.exitCode = 1;
}

async function cmdServe(args) {
	let port = 7600;
	let host = process.env.PI_DURABLE_HOST ?? "127.0.0.1";
	let takeover = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (/^\d+$/.test(arg)) port = Number.parseInt(arg, 10);
		else if (arg === "--host") host = args[++i] ?? host;
		else if (arg === "--port") port = Number.parseInt(args[++i], 10) || port;
		else if (arg === "--takeover") takeover = true;
	}
	const token = process.env.PI_DURABLE_TOKEN;
	if ((host === "0.0.0.0" || host === "::") && !token) {
		console.error("[serve] 警告：绑定到所有地址且未设置 PI_DURABLE_TOKEN，任何能访问该端口的人都可以驱动本机 agent。");
	}
	const context = BACKGROUND_CONTEXT;
	const harness = await openHarness({ takeover });
	try {
		const root = await getRoot(harness);
		const view = (await root.viewState(context)).value ?? {};
		const inputs = (view.docs?.["pi.live"]?.run?.inputs ?? []).map(String);
		if (inputs.length > 0) console.error(`[serve] 检测到未完成的 run（inputs: ${inputs.join(", ")}），resume() 已接管。`);
		await startServer({
			harness,
			root,
			port,
			host,
			token,
			modelLayer: MODEL_LAYER,
			hostPath: HOST_PATH,
			dataDir: DATA_DIR,
			serveLogFile: SERVE_LOG,
			defaultAgent: DEFAULT_AGENT,
		});
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
	history: () => cmdHistory(rest),
	wait: () => cmdWait(Number(rest[0] ?? 600) * 1000),
	config: () => cmdConfig(),
	status: () => cmdStatus(rest),
	tasks: () => cmdTasks(),
	sessions: () => cmdSessions(rest),
	approve: () => cmdApprove(rest[0] === "--" ? rest.slice(1) : rest),
	backup: () => cmdBackup(rest.find((a) => !a.startsWith("-"))),
	timing: () => cmdTiming(Number(rest[0] ?? 10) || 10),
	restart: () => cmdRestart(),
	serve: () => cmdServe(rest),
};
if (!command || !commands[command]) {
	console.error(
		"usage: node host.js ask <prompt> [--fresh] [--session s] | history [n] | wait [s] | status | tasks |\n" +
			"       sessions [new|switch|delete <name>] | approve -- <cmd> | approve --list | approve --revoke <n> |\n" +
			"       backup [file] | timing [n] | restart | serve [port] [--host h] [--takeover] | config",
	);
	process.exitCode = 2;
} else {
	// serve keeps the process (and the lock) alive until a signal; everything else
	// releases the lock when its command finishes. The exit handler is the safety net.
	process.on("exit", () => releaseLock(LOCK_FILE));
	try {
		const daemon = command === "serve" || command === "timing" ? undefined : detectDaemon(DATA_DIR);
		if (daemon && command === "serve") {
			throw new Error(`daemon 已在运行（pid ${daemon.pid}，${daemon.baseUrl}）。要用新代码先 node host.js restart。`);
		}
		if (daemon && command === "ask") await forwardAsk(rest);
		else await commands[command]();
		if (command !== "serve") releaseLock(LOCK_FILE);
	} catch (err) {
		console.error(`[host] ${command} 失败:`, err.message ?? err);
		process.exitCode = 1;
	}
}
