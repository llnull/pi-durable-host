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
//   GET  /api/commands         pi 自定义命令模板（~/.pi/agent/prompts 与 <cwd>/.pi/prompts 的 *.md）
//   POST /api/fork             { entryId, name? }  从历史条目分叉新会话（Conversation.fork）并切换
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
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createReadStream, existsSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AssistantEntry, ToolResultEntry } from "@earendil-works/pi-durable";
import { backupStorageFile } from "./backup.js";
import { textOf, collectStatus } from "./format.js";
import { SETTLEMENT_QUESTIONS, GATE_QUESTIONS } from "./judge.js";
import { HostConfigEntry } from "./extensions.js";
import {
	approveCommand,
	pendingFileOf,
	readApprovals,
	readPending,
	clearApprovals,
	revokeApprovalAt,
	clearPending,
} from "./approvals.js";
import { DEFAULT_SESSION, assertSessionName, readSessions, sessionsFile, sessionConversationId, writeSessions } from "./sessions.js";
import { clearServeInfo, writeServeInfo } from "./daemon.js";

const UI_PATH = fileURLToPath(new URL("./ui.html", import.meta.url));
/** SSE/UI 协议版本：session 事件携带，页面不一致时自动重载（issue #33）。 */
const SERVER_PROTO = 2;

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

export async function startServer({ harness, root, port, host, token, modelLayer, hostPath, dataDir, serveLogFile, defaultAgent, judge, screen, routingAuto }) {
	const ui = readFileSync(UI_PATH, "utf8");
	// UI 内容版本（issue #91）：serve 启动时算一次哈希，注入页面 + 随 session 事件广播；
	// 页面比对 window.UI_VER 不一致即 reload——UI 变更但协议不变也能自愈（proto 握手的盲区）。
	const UI_VER = createHash("sha256").update(ui).digest("hex").slice(0, 12);
	const approvalsFile = path.join(dataDir, "approvals.json");
	const pendingFile = pendingFileOf(approvalsFile);
	const sessFile = sessionsFile(dataDir);
	const backupsDir = path.join(dataDir, "backups");
	const dataFile = path.join(dataDir, "session.sqlite");
	const judgeLogFile = path.join(dataDir, "judge-log.jsonl");
	// 忙时自动路由开关：host.js 传入（host.json 可配，env PI_DURABLE_JUDGE_ROUTING=auto 优先）。
	const judgeRoutingAuto = routingAuto ?? process.env.PI_DURABLE_JUDGE_ROUTING === "auto";

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
			proto: SERVER_PROTO, // SSE/UI 协议版本：页面不一致时自动重载（issue #33）
			ui: UI_VER, // UI 内容哈希：UI 变更但协议不变时旧页面也重载（issue #91）
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
	let lastLiveRun = null; // run 完成检测：上一次 watch 到的 pi.live.run（issue #70 体检）
	const recentCheckups = []; // 内存最近 50 条，用于连败检测

	/**
	 * Run 体检（issue #70）：run 完成时对最后一轮做统计判断。
	 * 结果落 data/judge-log.jsonl（type:"checkup"）+ SSE 广播 + /api/judge/checkups。
	 * judge.score 给健康分（heuristic：工具错误率；Jev：语义检查），统计 flags 永远本地算。
	 */
	async function checkupRun(value) {
		try {
			console.error(`[judge] checkup 触发 session=${currentName}`);
			const entries = value?.entries ?? [];
			const lastUserIdx = entries.map((e) => e.kind).lastIndexOf("pi.user");
			if (lastUserIdx < 0) return; // 无用户输入（如纯压缩任务）不体检
			const runEntries = entries.slice(lastUserIdx + 1);
			const toolResults = runEntries.filter((e) => e.kind === "pi.tool-result");
			const errors = toolResults.filter((e) => e.model?.[0]?.isError);
			const assistants = runEntries.filter((e) => e.kind === "pi.assistant");
			const finalAnswer = [...assistants].reverse().find((e) => {
				const blocks = Array.isArray(e.model?.[0]?.content) ? e.model[0].content : [];
				return !blocks.some((b) => b.type === "toolCall"); // 块级检查：JSON 子串会把回答文字里的 toolCall 一词误判
			});
			const answerText = finalAnswer ? textOf(finalAnswer.model?.[0]) : "";
			const flags = [];
			if (!answerText.trim()) flags.push("empty-answer");
			if (errors.length) flags.push(`tool-errors:${errors.length}`);
			const toolStats = { calls: toolResults.length, errors: errors.length };
			const lastUserText = textOf(entries[lastUserIdx].model?.[0]); // pi.user 条目与 assistant 同形：model[0].content
			let health = null;
			let settlement = null;
			if (judge?.provider === "system-one") {
				// 结算单（issue #78）：一次调用 fan-out 多个原子问题（speculative fan-out 模式）
				const state = [
					`用户请求：${lastUserText.slice(0, 1500)}`,
					answerText ? `最终回答：${answerText.slice(0, 2500)}` : "最终回答：（无）",
					toolResults.slice(-12).map((e, i) => {
						const err = e.model?.[0]?.isError ? "[isError]" : "";
						return `工具${i + 1}${err}：${textOf(e.model?.[0]).slice(0, 400)}`;
					}).join("\n"),
				].filter(Boolean).join("\n\n");
				const s = await judge.batch(SETTLEMENT_QUESTIONS, state);
				settlement = { answers: s, provider: judge.provider };
				// flags 增强（阈值是 host 代码的权重，判断是模型）
				if (s.answered?.p != null && s.answered.p <= 0.4) flags.push("off-target");
				if (s.silentFail?.p != null && s.silentFail.p >= 0.6) flags.push("silent-fail");
				if (s.confusion?.p != null && s.confusion.p >= 0.6) flags.push("confusion");
				if (s.drift?.p != null && s.drift.p >= 0.6) flags.push("drift");
				if (s.needsHuman?.choice && s.needsHuman.choice !== "no") flags.push(`needs-human:${s.needsHuman.choice}`);
				if (s.forkWorthy?.choice === "yes") flags.push("fork-worthy");
				if (s.health?.score != null) health = s.health;
				// 智能分叉建议（issue #79）：值得重试时，对最近 20 个用户条目边界做一次 choice
				// （官方 line-by-line search 模式：state=transcript 摘录，criteria=候选位置，一次调用）
				if (s.forkWorthy?.choice === "yes") {
					const cands = [];
					for (let i = 0; i < entries.length && cands.length < 20; i++) {
						if (entries[i].kind === "pi.user" && i !== lastUserIdx) cands.push(entries[i]); // 排除本轮首条（重试同点无意义）
					}
					if (cands.length >= 2) {
						const excerpt = (e) => textOf(e.model?.[0]).slice(0, 120) || "(无文本)";
						const criteria = Object.fromEntries(cands.map((e) => [String(e.id), excerpt(e)]));
						const cState = [
							`当前失败轮的用户请求：${lastUserText.slice(0, 800)}`,
							`最终回答：${(answerText || "（无）").slice(0, 1200)}`,
							`工具错误 ${toolStats.errors}/${toolStats.calls}`,
							`历史用户条目（候选分叉点）：\n` + cands.map((e) => `#${e.id} ${excerpt(e)}`).join("\n"),
						].join("\n\n");
						const c = await judge.batch({ pick: { type: "choice", instructions: "从哪个历史位置分叉重试最可能解决当前问题？criteria 是候选条目（id: 内容摘录）。", criteria } }, cState);
						if (c.pick?.choice != null) settlement.forkSuggestion = { entryId: Number(c.pick.choice), confidence: c.pick.confidence ?? null, probabilities: c.pick.probabilities ?? null, candidates: cands.length };
					}
				}
			} else if (judge) {
				health = await judge.score("run 体检：这次 run 的工具执行健康吗？", ["不健康", "健康"], { toolStats });
			}
			if (health && health.score < 0.5) flags.push(`health:${health.score.toFixed(2)}`);
			const streak = recentCheckups.filter((c) => c.flags.length).length;
			if (flags.length && streak >= 2) flags.push("repeat-failure");
			const record = {
				at: new Date().toISOString(), type: "checkup", session: currentName,
				runFirstId: entries[lastUserIdx].id, entries: runEntries.length,
				tools: toolStats.calls, toolErrors: toolStats.errors,
				health: health?.score ?? null, healthProvider: health?.provider ?? null,
				flags,
				...(settlement ? { settlement } : {}),
			};
			recentCheckups.unshift(record);
			if (recentCheckups.length > 50) recentCheckups.pop();
			try { appendFileSync(judgeLogFile, JSON.stringify(record) + "\n"); } catch {}
			broadcast("judge", record);
		} catch (e) {
			console.error("[judge] checkup 失败:", e?.message ?? e); // 旁路可观测：不让静默吞错误导排查
		}
	}

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

	/**
	 * Resume 一致性检查（issue #70 落点 5，补完）：启动时扫描最后 epoch 之后的尾部，
	 * 找未配对的 toolCall（assistant 块 id 无对应 pi.tool-result）——中断恢复最常见的静默损伤。
	 * 纯本地扫描零成本；judge 在位时附一次语义完整度 score。记 type:"checkup"（复用体检链路与 UI），
	 * flags: resume-orphan:N / resume-score:x。
	 */
	function scanOrphans(entries) {
		const lastEpoch = entries.map((e) => e.kind).lastIndexOf("pi.compaction");
		const reset = entries.map((e) => e.kind).lastIndexOf("pi.reset");
		const from = Math.max(lastEpoch, reset) + 1; // epoch 前的悬空是压缩正常产物，不扫
		const answered = new Set();
		for (const e of entries.slice(from)) {
			if (e.kind === "pi.tool-result") answered.add(e.model?.[0]?.toolCallId);
		}
		const orphans = [];
		for (const e of entries.slice(from)) {
			if (e.kind !== "pi.assistant") continue;
			const blocks = Array.isArray(e.model?.[0]?.content) ? e.model[0].content : [];
			for (const b of blocks) {
				if (b.type === "toolCall" && b.id && !answered.has(b.id)) orphans.push({ id: b.id, name: b.name, entryId: e.id });
			}
		}
		return orphans;
	}
	async function resumeCheck() {
		try {
			const list = lastView?.entries ?? [];
			const orphans = scanOrphans(list);
			const flags = orphans.length ? [`resume-orphan:${orphans.length}`] : [];
			let health = null;
			if (judge?.provider === "system-one" && list.length) {
				const tail = list.slice(-14).map((e) => `${e.kind}：${textOf(e.model?.[0]).slice(0, 200)}`).join("\n");
				const s = await judge.batch({ integrity: { type: "score", instructions: "崩溃恢复后这段 transcript 尾部完整吗（无静默截断/未完成工具）？", criteria: ["受损", "完整"] } }, tail);
				health = s.integrity?.score ?? null;
				if (health != null && health < 0.5) flags.push(`resume-score:${health.toFixed(2)}`);
			}
			const record = {
				at: new Date().toISOString(), type: "checkup", session: currentName,
					runFirstId: list.length ? list[list.length - 1].id : 0, entries: list.length,
				tools: 0, toolErrors: 0, health, healthProvider: health != null ? judge.provider : null,
				flags, resume: true, ...(orphans.length ? { orphans: orphans.slice(0, 5) } : {}),
			};
			recentCheckups.unshift(record);
			if (recentCheckups.length > 50) recentCheckups.pop();
			try { appendFileSync(judgeLogFile, JSON.stringify(record) + "\n"); } catch {}
			broadcast("judge", record);
			console.error(`[judge] resume 一致性：${orphans.length} 未配对 toolCall${health != null ? `，完整度 ${health}` : ""}${flags.length ? "，" + flags.join(",") : ""}`);
		} catch (e) {
			console.error("[judge] resume 一致性检查失败:", e?.message ?? e);
		}
	}

	/**
	 * Compact 质量闸门（issue #70 落点 4，补完）：压缩开始时快照尾部约束（用户请求原文），
	 * pi.compaction epoch 落账后对账——摘是否保留了关键约束。judge 在位时语义判定
	 * （preserved/silent-drop/distortion），否则 heuristic 弱版（关键词覆盖：≥30% 快照词命中）。
	 * 记 type:"checkup" + flags: compact-loss / compact-distortion，复用体检 UI；未配对信息留在 judge-log。
	 */
	let preCompactSnapshot = null; // { texts: string[] } 压缩开始时末尾用户条目
	function gateCompact(oldEntries, newEntries) {
		const oldEpochs = oldEntries.filter((e) => e.kind === "pi.compaction" || e.kind === "pi.reset").length;
		const newEpochs = newEntries.filter((e) => e.kind === "pi.compaction" || e.kind === "pi.reset").length;
		if (newEpochs > oldEpochs) {
			const epoch = newEntries.find((e) => (e.kind === "pi.compaction" || e.kind === "pi.reset") && !oldEntries.includes(e));
			const summary = textOf(epoch?.model?.[0]).slice(0, 4000);
			const snapshot = preCompactSnapshot; // 异步：快照若被清空则只能 heuristic
			void (async () => {
				try {
					const flags = [];
					let preserved = null;
					if (judge?.provider === "system-one" && snapshot?.texts?.length) {
							const state = [`压缩前尾部用户请求：\n${snapshot.texts.join("\n")}`, `压缩摘要：\n${summary}`].join("\n\n");
							const s = await judge.batch({
								preserved: { type: "noul", instructions: "摘要保留了压缩前用户请求里的关键约束与目标吗？" },
								silentDrop: { type: "noul", instructions: "存在被静默丢弃的重要信息（用户明确要求过的事）？" },
							}, state);
							preserved = s.preserved?.p ?? null;
							if (preserved != null && preserved <= 0.5) flags.push("compact-loss");
							if (s.silentDrop?.p != null && s.silentDrop.p >= 0.6) flags.push("compact-distortion");
						} else if (snapshot?.texts?.length) {
							// heuristic 弱版：关键实词覆盖率（中英 ≥3 字符词）
							const words = new Set(snapshot.texts.join(" ").toLowerCase().match(/[\u4e00-\u9fa5]{2,}|[a-z]{3,}/g) ?? []);
							const hay = summary.toLowerCase();
							const hit = [...words].filter((w) => hay.includes(w)).length;
							preserved = words.size ? hit / words.size : null;
							if (preserved != null && preserved < 0.3) flags.push("compact-loss");
						}
						const record = {
							at: new Date().toISOString(), type: "checkup", session: currentName,
							runFirstId: epoch?.id ?? 0, entries: 0, tools: 0, toolErrors: 0,
							health: preserved, healthProvider: preserved != null ? (judge?.provider === "system-one" && snapshot?.texts?.length ? judge.provider : "heuristic-keywords") : null,
							flags, compactGate: true, ...(snapshot?.texts?.length ? { constraints: snapshot.texts.length } : {}),
						};
						recentCheckups.unshift(record);
						if (recentCheckups.length > 50) recentCheckups.pop();
						try { appendFileSync(judgeLogFile, JSON.stringify(record) + "\n"); } catch {}
						broadcast("judge", record);
						console.error(`[judge] compact 闸门：约束保留${preserved != null ? " " + preserved.toFixed(2) : "（无快照）"}${flags.length ? "，" + flags.join(",") : ""}`);
					} catch (e) {
						console.error("[judge] compact 闸门失败:", e?.message ?? e);
					}
				})();
				preCompactSnapshot = null;
		}
	}

	async function startWatch() {
		const conv = await current();
		watch = await conv.watch(context);
		lastView = watch.value; // diffs start from what connect-time snapshots carry
		watch.start((value) => {
			// 回调链路异常（diff 竞态、未来新增逻辑的 bug 等）绝不能杀死 watch 循环——
			// 否则 SSE 哑火 + run 完成检测失效 + 体检永不触发，且无任何报错（issue #95）。
			try {
				for (const frame of diffFrames(lastView, value)) broadcast(frame.event, frame.data, frame.droppable);
				const newRun = value.docs?.["pi.live"]?.run ?? null;
			const finished = lastLiveRun && !newRun;
				lastLiveRun = newRun;
				// compact 闸门（#70 落点 4）：压缩运行中快照尾部；epoch 落账时对账
				if (value.docs?.["pi.live"]?.compactions?.length && !preCompactSnapshot) {
					preCompactSnapshot = { texts: (lastView?.entries ?? []).filter((e) => e.kind === "pi.user").slice(-8).map((e) => textOf(e.model?.[0]).slice(0, 300)).filter(Boolean) };
				}
				gateCompact(lastView?.entries ?? [], value.entries ?? []);
				if (finished) checkupRun(value); // run 完成 → 体检（显式传新值：async 函数同步段读不到尚未赋值的 lastView）
				lastView = value;
			} catch (e) {
				console.error("[watch] 回调异常（已隔离，watch 继续）:", e?.stack ?? e);
				try { lastView = value; } catch {} // 尽量保住 diff 基线
			}
		});
	}
	if (screen?.sink) screen.sink.broadcast = broadcast; // host 侧 onFlag 回调经此发 SSE（issue #78）

	/**
	 * watch 看门狗（issue #95）：resume 启动后包内 watch 通知链可能哑火（回调不再被调用，
	 * 无异常无报错）。每 10s 与 viewState 对账：entries 数落后即重建 watch + 全量重同步，
	 * 并补触发因哑火而遗漏的 run 完成体检。自愈不依赖包层修复。
	 */
	let watchdogBusy = false;
	setInterval(async () => {
		if (watchdogBusy || !watch) return;
		watchdogBusy = true;
		try {
			const conv = await current();
			const fresh = (await conv.viewState(context)).value ?? {};
			const freshLen = (fresh.entries ?? []).length;
			const staleLen = (lastView?.entries ?? []).length;
			const staleConv = lastView?.conversation?.id ?? null;
			if (freshLen !== staleLen || (fresh.conversation?.id ?? null) !== staleConv) {
				console.error(`[watchdog] watch 疑似哑火（stale ${staleLen}@conv${staleConv} vs fresh ${freshLen}@conv${fresh.conversation?.id}），重建 watch`);
				const missedFinish = lastLiveRun && !fresh.docs?.["pi.live"]?.run;
				await startWatch();
				broadcast("view", watch.value); // 全量重同步（结构帧不可丢）
				if (missedFinish) checkupRun(watch.value); // 补漏：哑火期间完成的 run
			}
		} catch {}
		watchdogBusy = false;
	}, 10_000);

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
	void resumeCheck(); // 启动即扫（issue #70 落点 5）：纯本地扫描零成本，不阻塞启动
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
				// no-cache：daemon 升级后刷新必拿最新 UI（issue #33）；注入 UI_VER 供会话握手（issue #91）
				res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
				res.end(ui.replace("</body>", `<script>window.UI_VER="${UI_VER}"</script></body>`));
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
				case "POST /api/wait-idle": {
					// 一致性等待：resolve 当 ordinary scope 无活跃非后台任务（含传递闭包子任务）。
					// 供外部自动化（备份/脚本）使用；daemon 自身重启靠 resume，不依赖此端点。
					const body = await readBody(req);
					const timeoutMs = Math.min(Math.max(Number(body.timeoutMs ?? 30_000), 0), 300_000);
					const name = body.session ?? currentName;
					const conv = await conversationFor(name);
					let timer;
					const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
					const idle = await Promise.race([conv.waitForIdle(context).then(() => true), timeout]);
					clearTimeout(timer);
					json(req, res, 200, { ok: true, idle, session: name });
					return;
				}
				case "GET /api/context": {
					// 调试视图：at 处的派生上下文（fork(at) 会看到的起点，不建会话）
					const entryId = Number(url.searchParams.get("entryId"));
					if (!Number.isFinite(entryId)) throw new Error("entryId 必须是数值");
					const name = url.searchParams.get("session") ?? currentName;
					const conv = await conversationFor(name);
					const cv = await conv.context(context, { at: entryId });
					json(req, res, 200, {
						entryId,
						conversationId: conv.id,
						entries: cv.entries.map((e) => ({ id: e.id, kind: e.kind })),
						messages: cv.messages.map((m) => ({
							role: m.role,
							// 摘要：文本块拼接，工具调用/结果只报名字与体量，不倾倒全文；
							// content 可能是纯字符串（无块结构的消息）
							preview: (typeof m.content === "string"
								? [{ type: "text", text: m.content }]
								: m.content ?? []
							).map((b) => {
								if (typeof b === "string") return { type: "text", text: b.slice(0, 2000) };
								if (b.type === "text") return { type: "text", text: String(b.text).slice(0, 2000) };
								if (b.type === "thinking") return { type: "thinking", text: String(b.thinking).slice(0, 500) };
								if (b.type === "toolCall") return { type: "toolCall", name: b.name, argsLength: JSON.stringify(b.arguments ?? {}).length };
								if (b.type === "toolResult") return { type: "toolResult", isError: b.isError, length: JSON.stringify(b.output ?? b.content ?? "").length };
								return { type: b.type };
							}),
						})),
					});
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
							return { id: entry.id, kind: entry.kind, toolName: result?.toolName ?? "", text: textOf(result) };
						}
						const message = entry.model?.[0] ?? entry.data;
						return { id: entry.id, kind: entry.kind, text: textOf(message) || JSON.stringify(entry.data ?? "") };
					});
					json(req, res, 200, { session: name, conversationId: conv.id, items });
					return;
				}
				case "GET /api/judge/log": {
					// judge 审计日志尾览（issue #70）：控制面判断可回溯
					const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 500);
					const { readFileSync: rf, existsSync: ex } = await import("node:fs");
					const lines = ex(judgeLogFile) ? rf(judgeLogFile, "utf8").trim().split("\n").filter(Boolean) : [];
					const items = lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return { unparseable: true }; } }).reverse();
					json(req, res, 200, { items, total: lines.length });
					return;
				}
				case "GET /api/judge/checkups": {
					json(req, res, 200, { items: recentCheckups.slice(0, 50) });
					return;
				}
				case "GET /api/judge/screen": {
					json(req, res, 200, { items: (screen?.recent ?? []).slice(0, 50), mode: screen?.mode ?? "off" });
					return;
				}
				case "POST /api/judge/gate": {
					// 自动化闸门（issue #79）：wait-idle 后对 transcript 尾部 fan-out 合格性问题。
					// 供 CI/外部自动化在部署/收尾动作前调用：{ok, idle, ready, confidence, score, flags}
					const body = await readBody(req);
					const timeoutMs = Math.min(Math.max(Number(body.timeoutMs ?? 30_000), 0), 300_000);
					const name = body.session ?? currentName;
					const conv = await conversationFor(name);
					let timer;
					const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
					const idle = await Promise.race([conv.waitForIdle(context).then(() => true), timeout]);
					clearTimeout(timer);
					if (!idle || !judge || judge.provider !== "system-one") {
						// 不空闲或无语义 judge：保守返回未就绪（idle=false 时绝不说 ready）
						json(req, res, 200, { ok: true, idle, ready: false, reason: !idle ? "not-idle" : "no-semantic-judge" });
						return;
					}
						const view = (await conv.viewState(context)).value ?? {}; // 与 collectStatus 同一取视图路径
					const entries = view.entries ?? [];
					const tail = entries.slice(-14);
					const tailText = tail.map((e) => {
						const t = textOf(e.model?.[0]).slice(0, 350);
						const err = e.model?.[0]?.isError ? "[isError]" : "";
						return `${e.kind}${err}：${t}`;
					}).join("\n").slice(0, 8000);
					const s = await judge.batch(GATE_QUESTIONS, `会话：${name}\n最近条目：\n${tailText}`);
					const flags = [];
					if (s.errors?.p != null && s.errors.p >= 0.6) flags.push("unresolved-errors");
					if (s.clean?.p != null && s.clean.p <= 0.4) flags.push("incomplete-work");
					if (s.ready?.score != null && s.ready.score < 0.5) flags.push(`readiness:${s.ready.score.toFixed(2)}`);
					const ready = !flags.length;
					const record = { at: new Date().toISOString(), type: "gate", session: name, ready, flags, answers: s, provider: judge.provider };
					try { appendFileSync(judgeLogFile, JSON.stringify(record) + "\n"); } catch {}
					broadcast("judge", record);
					json(req, res, 200, { ok: true, idle: true, ready, confidence: s.ready?.confidence ?? null, score: s.ready?.score ?? null, flags, answers: s });
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
				case "GET /api/commands": {
					// pi 的自定义命令模板：与 pi CLI 同源（全局 ~/.pi/agent/prompts + 项目 <cwd>/.pi/prompts），
					// 同名去重（先到先得）；展开在 UI 端按 pi 的 substituteArgs 语义进行。
					const piDir = process.env.PI_DURABLE_PI_DIR ?? path.join(homedir(), ".pi", "agent");
					const promptDirs = [
						[path.join(piDir, "prompts"), "user"],
						[path.join(await workspaceRoot(), ".pi", "prompts"), "project"],
					];
					const commands = [];
					const seenCmds = new Set();
					for (const [dir, source] of promptDirs) {
						let names;
						try { names = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
						for (const d of names) {
							if (!d.isFile() || !d.name.endsWith(".md")) continue;
							const name = d.name.replace(/\.md$/, "");
							if (seenCmds.has(name)) continue;
							try {
								const raw = readFileSync(path.join(dir, d.name), "utf-8");
								const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
								const front = fm ? fm[1] : "";
								const body = fm ? raw.slice(fm[0].length) : raw;
								const desc = (front.match(/^description:[ \t]*(.+)$/m)?.[1] ?? body.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 60);
								commands.push({
									name,
									description: desc,
									argumentHint: front.match(/^argument-hint:[ \t]*(.+)$/m)?.[1]?.trim(),
									body,
									source,
								});
								seenCmds.add(name);
							} catch {}
						}
					}
					json(req, res, 200, { commands });
					return;
				}
				case "POST /api/fork": {
					// 分叉交绠 pi-durable：conv.fork 复制 fork 点的上下文与 agent 文档（AgentDoc rewindable），
					// provider 身份全新；host 只负责把新 conversation 注册为具名会话并切换。
					const body = await readBody(req);
					const entryId = Number(body.entryId);
					if (!Number.isFinite(entryId)) throw new Error("entryId 必须是数值（GET /api/history 或 view entries 里的 id）");
					const source = await (await current());
					const forked = await source.fork(entryId, { ownership: { kind: "ownerless" } }, context);
					conversations.set(forked.id, forked);
					let name = String(body.name ?? "").trim();
					if (!name) {
						let n = 1;
						while (store.sessions[`fork-${n}`]) n++;
						name = `fork-${n}`;
					}
					assertSessionName(name);
					if (store.sessions[name]) throw new Error(`会话已存在：${name}`);
					store.sessions[name] = { conversationId: forked.id, createdAt: new Date().toISOString(), note: body.note ? String(body.note) : `fork 自 ${currentName}@${String(entryId)}` };
					writeSessions(sessFile, store);
					await switchSession(name);
					json(req, res, 200, { ok: true, session: name, conversationId: forked.id, ...sessionsPayload() });
					return;
				}
				case "POST /api/ask": {
					const body = await readBody(req);
					const content = String(body.content ?? "").trim();
					if (!content) throw new Error("content 不能为空");
					const whenBusy = ["followUp", "steer", "reject"].includes(body.whenBusy) ? body.whenBusy : undefined;
					// 忙时自动路由（issue #70，opt-in PI_DURABLE_JUDGE_ROUTING=auto）：
					// 未显式指定且会话忙时，让 judge 分类纠偏/排队。永不自动 reject。
					let effBusy = whenBusy;
					if (!whenBusy && judgeRoutingAuto && judge) {
						const convBusy = Boolean(lastView?.docs?.["pi.live"]?.run) && String(body.session ?? currentName) === currentName;
						if (convBusy) {
							const v = await judge.choice("忙时路由：这条消息是纠偏还是新指令？", ["followUp", "steer"], { content });
							if (v?.choice === "steer" && (v.probabilities?.steer ?? 0) >= 0.6) effBusy = "steer";
						}
					}
					const conv = await conversationFor(String(body.session ?? currentName));
					const request = { type: "input", content, ...(effBusy ? { whenBusy: effBusy } : {}) };
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
					const conv = await current();
					const before = await conv.agent(context);
					await conv.configure(change, context);
					// 审计入账：自定义 kind 不进模型 context，只在 transcript 可见（issue #43）
					try {
						await conv.commit(async (tx) => {
							for (const field of ["model", "cwd", "instructions"]) {
								if (change[field] === undefined) continue;
								const from = field === "model" ? (before.model ? `${before.model.provider}/${before.model.modelId}` : undefined) : before[field];
								const to = field === "model" ? `${change[field].provider}/${change[field].modelId}` : change[field];
								await tx.appendEntry(HostConfigEntry, conv.id, { data: { field, from, to } });
							}
						}, context);
					} catch (error) {
						console.error("[audit] 配置变更入账失败：", error instanceof Error ? error.message : error);
					}
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
				case "POST /api/approvals/clear": {
					// 已批准清单清空（issue #106）：不归档——transcript/judge-log 已有完整留痕
					const result = clearApprovals(approvalsFile);
					console.error(`[approvals] 清空已批准清单：${result.archived} 条（transcript/judge-log 已留痕，不归档）`);
					json(req, res, 200, { ok: true, ...result, approved: readApprovals(approvalsFile) });
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
