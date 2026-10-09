// Long-lived host daemon: one process owns the storage, and every client —
// human, script, or the host.js CLI itself — attaches to it over HTTP.
//
//   GET  /                     web UI (lib/ui.html)
//   GET  /api/events           SSE: session + view snapshot, then every commit
//   GET  /api/state            current view + conversation id
//   GET  /api/history?limit=   transcript items (chronological)
//   GET  /api/status           aggregated status (what `host.js status` prints)
//   GET  /api/tasks            live task graph
//   GET  /api/usage            session usage totals
//   GET  /api/models           model catalog + source
//   GET  /api/sessions         named sessions
//   GET  /api/approvals        approved allowlist + pending blocked commands
//   GET  /api/submission?id=   one submission's durable status
//   GET  /api/entry?id=        one transcript entry (answer text)
//   GET  /files/<path>         工作区静态文件（浏览器新窗口打开 agent 生成的产物）
//   GET  /api/files            列出 agent 工作区（当前会话 agent.cwd）下的文件
//   POST /api/ask              { content, whenBusy?, wait?, requestId?, session? }
//   POST /api/abort            abort the current conversation
//   POST /api/compact          { instructions? }
//   POST /api/reset            { note? }
//   POST /api/config           { cwd? / instructions? / model? }
//   POST /api/approve          { command }        approve + clear pending
//   POST /api/approve/revoke   { index }
//   POST /api/approvals/dismiss { command }       drop a pending entry
//   POST /api/sessions         { action: new|switch|delete, name, note? }
//   POST /api/backup           { file? } → VACUUM INTO data/backups/
//   POST /api/restart          spawn a successor daemon, then stop gracefully
//
// The daemon answers without waiting by default; UIs follow progress on SSE.
// Answers are read back from the transcript (the generation task commits the
// pi.assistant entry itself), so there is nothing for the daemon to double-write.
import http from "node:http";
import { gzipSync } from "node:zlib";
import { createReadStream, existsSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AssistantEntry, ToolResultEntry } from "@earendil-works/pi-durable";
import { backupStorageFile } from "./backup.js";
import { textOf, collectStatus } from "./format.js";
import {
	approveCommand,
	pendingFileOf,
	readApprovals,
	readPending,
	revokeApprovalAt,
	clearPending,
} from "./approvals.js";
import { DEFAULT_SESSION, assertSessionName, readSessions, sessionsFile, sessionConversationId, writeSessions } from "./sessions.js";
import { clearServeInfo, writeServeInfo } from "./daemon.js";

const UI_PATH = fileURLToPath(new URL("./ui.html", import.meta.url));

const MIME = {
	".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
	".log": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
	".xml": "application/xml", ".svg": "image/svg+xml",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
	".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm",
	".mp3": "audio/mpeg", ".wav": "audio/wav", ".wasm": "application/wasm",
};

function json(req, res, status, value) {
	const body = Buffer.from(JSON.stringify(value));
	// Large payloads gzip on the fly (#27 P2): /api/state snapshots are ~1MB raw.
	if (body.length > 4096 && String(req.headers["accept-encoding"] ?? "").includes("gzip")) {
		const gz = gzipSync(body);
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"content-encoding": "gzip",
			"content-length": gz.length,
		});
		res.end(gz);
		return;
	}
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("请求体过大"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (chunks.length === 0) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(new Error("请求体不是合法 JSON"));
			}
		});
		req.on("error", reject);
	});
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

export async function startServer({ harness, root, port, host, token, modelLayer, hostPath, dataDir, serveLogFile, defaultAgent }) {
	const ui = readFileSync(UI_PATH, "utf8");
	const approvalsFile = path.join(dataDir, "approvals.json");
	const pendingFile = pendingFileOf(approvalsFile);
	const sessFile = sessionsFile(dataDir);
	const backupsDir = path.join(dataDir, "backups");
	const dataFile = path.join(dataDir, "session.sqlite");

	// ---------- 工作区文件服务（/files/<path> 与 /api/files） ----------
	async function workspaceRoot() {
		try {
			const agent = await (await current()).agent(context);
			if (agent?.cwd) return path.resolve(agent.cwd);
		} catch {}
		return path.resolve(path.join(dataDir, "..", "workspace"));
	}

	async function serveWorkspaceFile(url, res) {
		const rel = decodeURIComponent(url.pathname.slice("/files/".length));
		const base = await workspaceRoot();
		const full = path.resolve(base, rel);
		if (full !== base && !full.startsWith(base + path.sep)) {
			json(req, res, 403, { error: "禁止访问工作区之外的路径" });
			return;
		}
		let st;
		try { st = statSync(full); } catch { json(req, res, 404, { error: `文件不存在：${rel}` }); return; }
		if (st.isDirectory()) { json(req, res, 400, { error: "这是目录，请用 /api/files 查看列表" }); return; }
		const type = MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream";
		res.writeHead(200, { "content-type": type, "content-length": st.size, "cache-control": "no-cache" });
		createReadStream(full).pipe(res);
	}

	// ---------- named sessions ----------
	let store = readSessions(sessFile);
	let currentName = store.current;
	const conversations = new Map(); // conversationId → Conversation (cached)

	async function conversationFor(name) {
		if (name === DEFAULT_SESSION) return root;
		const id = sessionConversationId(store, name);
		if (conversations.has(id)) return conversations.get(id);
		const conv = await harness.conversation(id, context);
		if (!conv) throw new Error(`会话 ${name} 指向的 conversation ${id} 不存在（可能已被删除）`);
		conversations.set(id, conv);
		return conv;
	}

	/** The conversation every session-less endpoint (UI, SSE) talks to. */
	async function current() {
		return conversationFor(currentName);
	}

	function sessionsPayload() {
		return {
			current: currentName,
			sessions: Object.entries(store.sessions)
				.sort(([a], [b]) => (a === DEFAULT_SESSION ? -1 : b === DEFAULT_SESSION ? 1 : a.localeCompare(b)))
				.map(([name, entry]) => ({ name, conversationId: entry.conversationId, createdAt: entry.createdAt, note: entry.note ?? "" })),
		};
	}

	// ---------- live view (one watch per current conversation) ----------
	// SSE protocol v2 (#27): a full `view` snapshot goes out on connect and on
	// structural changes only; commits otherwise arrive as small incremental
	// frames — `entries` (appended entries), `live` (pi.live doc, droppable for
	// lagging clients) and `docs` (other doc changes). Re-sending the whole
	// transcript per frame was ~750KB × 10/s during streaming.
	const clients = new Set();
	let watch = null;
	let lastView = null;

	/** Diff two conversation views into incremental frames (or one full view). */
	function diffFrames(oldView, newView) {
		if (!oldView) return [{ event: "view", data: newView }];
		const oldEntries = oldView.entries ?? [];
		const newEntries = newView.entries ?? [];
		let structural = (newView.conversation?.id ?? null) !== (oldView.conversation?.id ?? null);
		if (!structural) {
			if (newEntries.length >= oldEntries.length) {
				for (let i = 0; i < oldEntries.length; i++) {
					if (newEntries[i].id !== oldEntries[i].id) {
						structural = true; // history rewritten (reset/compaction head)
						break;
					}
				}
			} else structural = true;
		}
		if (structural) return [{ event: "view", data: newView }];
		const frames = [];
		if (newEntries.length > oldEntries.length) {
				frames.push({
					event: "entries",
					data: { after: oldEntries[oldEntries.length - 1]?.id ?? null, entries: newEntries.slice(oldEntries.length) },
				});
			}
		const oldDocs = oldView.docs ?? {};
		const newDocs = newView.docs ?? {};
		if (newDocs["pi.live"] !== oldDocs["pi.live"]) {
				frames.push({ event: "live", data: { live: newDocs["pi.live"] ?? null }, droppable: true });
			}
		const docsChanged = {};
		for (const key of Object.keys(newDocs)) {
			if (key !== "pi.live" && newDocs[key] !== oldDocs[key]) docsChanged[key] = newDocs[key];
		}
		if (Object.keys(docsChanged).length > 0) frames.push({ event: "docs", data: { docs: docsChanged } });
		return frames;
	}

	async function startWatch() {
		const conv = await current();
		watch = await conv.watch(context);
		lastView = watch.value; // diffs start from what connect-time snapshots carry
		watch.start((value) => {
			for (const frame of diffFrames(lastView, value)) broadcast(frame.event, frame.data, frame.droppable);
			lastView = value;
		});
	}
	function broadcast(event, data, droppable = false) {
		const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const res of clients) {
			try {
				// Backpressure: a slow consumer skips lossy frames (live partials)
				// instead of buffering unboundedly; entries/docs/view always go through.
				if (droppable && res.writableLength > 262_144) continue;
				res.write(frame);
			} catch {}
		}
	}
	await startWatch();
	const heartbeat = setInterval(() => {
		for (const res of clients) {
			try {
				res.write(": ping\n\n");
			} catch {}
		}
	}, 15_000);

	function authorized(req, url) {
		if (!token) return true;
		return req.headers["x-token"] === token || url.searchParams.get("token") === token;
	}

	async function settledAnswer(conv, submission) {
		const settled = await submission.wait(context);
		if (settled.status !== "done" || settled.type !== "input") {
			return { id: submission.id, status: settled.status, reason: settled.reason };
		}
		// The answer entry is already in the transcript; read it typed.
		const entry = await conv.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		return { id: submission.id, status: "done", answer: textOf(entry?.model?.[0]) };
	}

	/** The same numbers `host.js status` prints, assembled from one view. */
	async function statusPayload() {
		return collectStatus({ harness, conv: await current(), modelSource: modelLayer.source, context });
	}

	async function backupStorage(target) {
		return backupStorageFile(dataFile, target);
	}

	async function switchSession(name) {
		if (!store.sessions[name]) throw new Error(`会话不存在：${name}`);
		const oldWatch = watch;
		currentName = name;
		store.current = name;
		writeSessions(sessFile, store);
		watch = null;
		await startWatch();
		try {
			await oldWatch?.stop();
		} catch {}
		broadcast("session", sessionsPayload());
		broadcast("view", watch.value);
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
		try {
			if (url.pathname === "/" && req.method === "GET") {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(ui);
				return;
			}
			if (url.pathname.startsWith("/files/") && req.method === "GET") {
				if (!authorized(req, url)) {
					json(req, res, 401, { error: "未授权：缺少或错误的 token" });
					return;
				}
				try { await serveWorkspaceFile(url, res); }
				catch (err) { json(req, res, 400, { error: err?.message ?? String(err) }); }
				return;
			}
			if (!url.pathname.startsWith("/api/")) {
				json(req, res, 404, { error: "not found" });
				return;
			}
			if (!authorized(req, url)) {
				json(req, res, 401, { error: "未授权：缺少或错误的 token" });
				return;
			}
			switch (`${req.method} ${url.pathname}`) {
				case "GET /api/events": {
					res.writeHead(200, {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						connection: "keep-alive",
					});
					res.write(`event: session\ndata: ${JSON.stringify(sessionsPayload())}\n\n`);
					res.write(`event: view\ndata: ${JSON.stringify(watch.value)}\n\n`);
					clients.add(res);
					req.on("close", () => clients.delete(res));
					return;
				}
				case "GET /api/state": {
					if (url.searchParams.get("light") === "1") {
						// Docs + counts without the transcript (#27): cheap for scripts/CLI.
						const view = watch.value ?? {};
						json(req, res, 200, {
							conversationId: (await current()).id,
							session: currentName,
							light: true,
							conversation: view.conversation,
							docs: view.docs,
							entryCount: (view.entries ?? []).length,
						});
						return;
					}
					json(req, res, 200, { conversationId: (await current()).id, session: currentName, view: watch.value });
					return;
				}
				case "GET /api/history": {
					const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 500);
					const name = url.searchParams.get("session") ?? currentName;
					const conv = await conversationFor(name);
					const transcript = await conv.entries({}, limit, undefined, context);
					const items = [...transcript.items].reverse().map((entry) => {
						if (ToolResultEntry.is(entry)) {
							const result = entry.model?.[0];
							return { kind: entry.kind, toolName: result?.toolName ?? "", text: textOf(result) };
						}
						const message = entry.model?.[0] ?? entry.data;
						return { kind: entry.kind, text: textOf(message) || JSON.stringify(entry.data ?? "") };
					});
					json(req, res, 200, { session: name, conversationId: conv.id, items });
					return;
				}
				case "GET /api/status": {
					json(req, res, 200, await statusPayload());
					return;
				}
				case "GET /api/submission": {
					const id = url.searchParams.get("id");
					if (!id) throw new Error("缺少 id");
					const sub = await harness.submission(id, context);
					if (!sub) throw new Error(`submission 不存在：${id}`);
					const record = await sub.status(context);
					json(req, res, 200, {
						submission: {
							id,
							conversationId: record.conversationId,
							status: record.status,
							...(record.answer ? { answer: record.answer } : {}),
							...(record.reason ? { reason: record.reason } : {}),
						},
					});
					return;
				}
				case "GET /api/entry": {
					const id = url.searchParams.get("id");
					if (!id) throw new Error("缺少 id");
					const entry = await root.commit((tx) => tx.entry(AssistantEntry, id), context);
					if (!entry) throw new Error(`entry 不存在：${id}`);
					json(req, res, 200, { kind: entry.kind, text: textOf(entry?.model?.[0]) });
					return;
				}
				case "GET /api/tasks": {
					const graph = await harness.taskGraph(context);
					json(req, res, 200, { graph: graph.value ?? graph });
					return;
				}
				case "GET /api/usage": {
					json(req, res, 200, { usage: await harness.usage(context) });
					return;
				}
				case "GET /api/models": {
					json(req, res, 200, {
						source: modelLayer.source,
						default: modelLayer.model,
						models: modelLayer.catalog,
						providers: modelLayer.providers ?? [],
					});
					return;
				}
				case "GET /api/sessions": {
					json(req, res, 200, sessionsPayload());
					return;
				}
				case "GET /api/approvals": {
					json(req, res, 200, { approved: readApprovals(approvalsFile), pending: readPending(pendingFile) });
					return;
				}
				case "GET /api/files": {
					const base = await workspaceRoot();
					const files = [];
					const walk = (dir, depth) => {
						if (depth > 4 || files.length >= 500) return;
						let names;
						try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
						for (const d of names) {
							if (d.name.startsWith(".") || d.name === "node_modules") continue;
							const p = path.join(dir, d.name);
							if (d.isDirectory()) walk(p, depth + 1);
							else {
								try {
									const s = statSync(p);
									files.push({ path: path.relative(base, p), size: s.size, mtime: s.mtimeMs });
								} catch {}
							}
						}
					};
					walk(base, 0);
					files.sort((a, b) => b.mtime - a.mtime);
					json(req, res, 200, { base, files: files.slice(0, 500) });
					return;
				}
				case "POST /api/ask": {
					const body = await readBody(req);
					const content = String(body.content ?? "").trim();
					if (!content) throw new Error("content 不能为空");
					const whenBusy = ["followUp", "steer", "reject"].includes(body.whenBusy) ? body.whenBusy : undefined;
					const conv = await conversationFor(String(body.session ?? currentName));
					const request = { type: "input", content, ...(whenBusy ? { whenBusy } : {}) };
					if (body.requestId) request.requestId = String(body.requestId); // exactly-once for retries
					const submission = await conv.submit(request, context);
					if (body.wait) {
						json(req, res, 200, await settledAnswer(conv, submission));
					} else {
						json(req, res, 200, { id: submission.id, accepted: true });
					}
					return;
				}
				case "POST /api/abort": {
					await readBody(req).catch(() => ({}));
					await (await current()).abort(context);
					json(req, res, 200, { ok: true });
					return;
				}
				case "POST /api/compact": {
					const body = await readBody(req);
					const taskId = await (await current()).compact(body.instructions ? String(body.instructions) : undefined, context);
					json(req, res, 200, { taskId: String(taskId) });
					return;
				}
				case "POST /api/reset": {
					const body = await readBody(req);
					await (await current()).reset(body.note ? String(body.note) : undefined, context);
					json(req, res, 200, { ok: true });
					return;
				}
				case "POST /api/config": {
					const body = await readBody(req);
					const change = {};
					if (body.cwd) change.cwd = String(body.cwd);
					if (body.instructions) change.instructions = String(body.instructions);
					if (body.model) {
						const pid = String(body.model.provider ?? modelLayer.model.provider);
						const provider = (modelLayer.providers ?? []).find((p) => p.id === pid);
						const wanted = provider?.models.find((m) => m.id === String(body.model.modelId ?? body.model.id ?? ""));
						if (!wanted) throw new Error(`未知模型：${JSON.stringify(body.model)}（GET /api/models 查看目录）`);
						change.model = { provider: pid, modelId: wanted.id };
					}
					if (Object.keys(change).length === 0) throw new Error("没有可应用的字段（cwd / instructions / model）");
					await (await current()).configure(change, context);
					json(req, res, 200, { ok: true, agent: await (await current()).agent(context) });
					return;
				}
				case "POST /api/approve": {
					const body = await readBody(req);
					const command = String(body.command ?? "").trim();
					if (!command) throw new Error("command 不能为空");
					const { added } = approveCommand(approvalsFile, command);
					json(req, res, 200, { ok: true, added, approved: readApprovals(approvalsFile) });
					return;
				}
				case "POST /api/approve/revoke": {
					const body = await readBody(req);
					const removed = revokeApprovalAt(approvalsFile, Number.parseInt(body.index, 10));
					if (!removed) throw new Error(`index 越界（1-${readApprovals(approvalsFile).length}）`);
					json(req, res, 200, { ok: true, revoked: removed.command });
					return;
				}
				case "POST /api/approvals/dismiss": {
					const body = await readBody(req);
					const command = String(body.command ?? "");
					clearPending(pendingFile, command);
					json(req, res, 200, { ok: true, pending: readPending(pendingFile) });
					return;
				}
				case "POST /api/sessions": {
					const body = await readBody(req);
					const action = String(body.action ?? "");
					const name = String(body.name ?? "");
					if (action === "new") {
						assertSessionName(name);
						if (store.sessions[name]) throw new Error(`会话已存在：${name}`);
						const created = await harness.createConversation(
							{ ownership: { kind: "ownerless" }, agent: defaultAgent },
							context,
						);
						conversations.set(created.id, created);
						store.sessions[name] = { conversationId: created.id, createdAt: new Date().toISOString(), note: body.note ? String(body.note) : "" };
						writeSessions(sessFile, store);
						if (body.switch !== false) await switchSession(name);
						json(req, res, 200, { ok: true, ...sessionsPayload() });
						return;
					}
					if (action === "switch") {
						await switchSession(name);
						json(req, res, 200, { ok: true, ...sessionsPayload() });
						return;
					}
					if (action === "delete") {
						if (name === DEFAULT_SESSION) throw new Error("default 会话（root conversation）不可删除");
						if (!store.sessions[name]) throw new Error(`会话不存在：${name}`);
						delete store.sessions[name];
						if (currentName === name) {
							currentName = DEFAULT_SESSION;
							store.current = DEFAULT_SESSION;
						}
						writeSessions(sessFile, store);
						await switchSession(currentName); // re-watch + broadcast
						json(req, res, 200, { ok: true, ...sessionsPayload() });
						return;
					}
					throw new Error("action 必须是 new / switch / delete");
				}
				case "POST /api/backup": {
					const body = await readBody(req);
					json(req, res, 200, { ok: true, file: await backupStorage(body.file ? String(body.file) : undefined) });
					return;
				}
				case "POST /api/restart": {
					await readBody(req).catch(() => ({}));
					if (!hostPath) throw new Error("本 daemon 未提供 hostPath，无法重启");
					// Debounce across daemon generations (issue #25): a replayed tool call
					// or a double-click may re-POST within seconds. The marker file survives
					// the restart; the window expires so a stale marker never blocks.
					const marker = path.join(dataDir, "restart.marker");
					if (existsSync(marker)) {
						const age = Date.now() - statSync(marker).mtimeMs;
						if (age < 15_000) {
							throw new Error(`刚刚已触发过重启（${Math.round(age / 1000)}s 前），${Math.ceil((15_000 - age) / 1000)}s 后可再试`);
						}
					}
					writeFileSync(marker, `${new Date().toISOString()} pid=${process.pid}\n`);
					json(req, res, 200, { ok: true, restarting: true });
					res.once("finish", () => {
						setTimeout(() => {
							// Successor starts first and waits up to 60s for the lock
							// (acquireLock waitMs), so there is no takeover gap.
							const logFd = openSync(serveLogFile, "a");
							try {
								const child = spawn(process.execPath, [hostPath, "serve", String(port), "--host", host, "--takeover"], {
									detached: true,
									stdio: ["ignore", logFd, logFd],
									env: process.env,
								});
								child.unref();
							} catch (err) {
								console.error("[serve] 重启失败：无法派生后继进程:", err?.message ?? err);
								return; // stay alive; the old daemon keeps serving
							}
							setTimeout(() => void stop(), 250); // graceful: close storage, release lock, exit
						}, 100);
					});
					return;
				}
				default:
					json(req, res, 404, { error: `未知接口：${req.method} ${url.pathname}` });
			}
		} catch (err) {
			json(req, res, 400, { error: err?.message ?? String(err) });
		}
	});

	await new Promise((resolve) => server.listen(port, host, resolve));
	const infoFile = path.join(dataDir, "serve.json");
	writeServeInfo(infoFile, { pid: process.pid, port, host, hasToken: Boolean(token) });
	const shown = `http://${host === "0.0.0.0" || host === "::" ? "<本机所有地址>" : host === "127.0.0.1" ? "localhost" : host}:${port}`;
	console.error(`[serve] 已监听 ${shown}${token ? "（需要 token）" : "（仅本机访问）"} · 会话：${currentName} · pid ${process.pid}`);
	console.error("[serve] Ctrl+C 停止；存储在进程存活期间由本进程独占。POST /api/restart 可热重启（run 会由后继进程 resume）。");

	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		clearInterval(heartbeat);
		clearServeInfo(infoFile);
		try {
			await watch?.stop();
		} catch {}
		server.close();
		try {
			await harness.close(context);
		} catch {}
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	return { server, stop };
}
