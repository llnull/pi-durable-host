// Long-lived host daemon: one process owns the storage, and every client —
// human or script — attaches to it over HTTP.
//
//   GET  /              web UI (lib/ui.html)
//   GET  /api/events    SSE: snapshot, then the committed view after every commit
//   GET  /api/state     current view + conversation id
//   GET  /api/tasks     live task graph
//   GET  /api/usage     session usage totals
//   POST /api/ask       { content, whenBusy?: "followUp"|"steer"|"reject", wait?: bool }
//   POST /api/abort     abort the conversation (background work survives)
//   POST /api/compact   { instructions? }
//   POST /api/reset     { note? }
//   POST /api/config    { cwd?, instructions?, model? }
//
// The daemon answers without waiting by default; UIs follow progress on SSE.
// Answers are read back from the transcript (the generation task commits the
// pi.assistant entry itself), so there is nothing for the daemon to double-write.
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { textOf } from "./extensions.js";

const UI_PATH = fileURLToPath(new URL("./ui.html", import.meta.url));

function json(res, status, value) {
	const body = JSON.stringify(value);
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

export async function startServer({ harness, root, port, host, token }) {
	const ui = readFileSync(UI_PATH, "utf8");

	// Live view: one watch feeds every connected SSE client.
	const watch = await root.watch(context);
	const clients = new Set();
	watch.start(async (value) => {
		const frame = `event: view\ndata: ${JSON.stringify(value)}\n\n`;
		for (const res of clients) {
			try {
				res.write(frame);
			} catch {}
		}
	});
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

	async function settledAnswer(submission) {
		const settled = await submission.wait(context);
		if (settled.status !== "done" || settled.type !== "input") {
			return { id: submission.id, status: settled.status, reason: settled.reason };
		}
		// The answer entry is already in the transcript; read it typed.
		const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		return { id: submission.id, status: "done", answer: textOf(entry?.model?.[0]) };
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
		try {
			if (url.pathname === "/" && req.method === "GET") {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(ui);
				return;
			}
			if (!url.pathname.startsWith("/api/")) {
				json(res, 404, { error: "not found" });
				return;
			}
			if (!authorized(req, url)) {
				json(res, 401, { error: "未授权：缺少或错误的 token" });
				return;
			}
			switch (`${req.method} ${url.pathname}`) {
				case "GET /api/events": {
					res.writeHead(200, {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						connection: "keep-alive",
					});
					res.write(`event: view\ndata: ${JSON.stringify(watch.value)}\n\n`);
					clients.add(res);
					req.on("close", () => clients.delete(res));
					return;
				}
				case "GET /api/state": {
					json(res, 200, { conversationId: root.id, view: watch.value });
					return;
				}
				case "GET /api/tasks": {
					const graph = await harness.taskGraph(context);
					json(res, 200, { graph: graph.value ?? graph });
					return;
				}
				case "GET /api/usage": {
					json(res, 200, { usage: await harness.usage(context) });
					return;
				}
				case "POST /api/ask": {
					const body = await readBody(req);
					const content = String(body.content ?? "").trim();
					if (!content) throw new Error("content 不能为空");
					const whenBusy = ["followUp", "steer", "reject"].includes(body.whenBusy) ? body.whenBusy : undefined;
					const request = { type: "input", content, ...(whenBusy ? { whenBusy } : {}) };
					if (body.requestId) request.requestId = String(body.requestId); // exactly-once for retries
					const submission = await root.submit(request, context);
					if (body.wait) {
						json(res, 200, await settledAnswer(submission));
					} else {
						json(res, 200, { id: submission.id, accepted: true });
					}
					return;
				}
				case "POST /api/abort": {
					await readBody(req).catch(() => ({}));
					await root.abort(context);
					json(res, 200, { ok: true });
					return;
				}
				case "POST /api/compact": {
					const body = await readBody(req);
					const taskId = await root.compact(body.instructions ? String(body.instructions) : undefined, context);
					json(res, 200, { taskId: String(taskId) });
					return;
				}
				case "POST /api/reset": {
					const body = await readBody(req);
					await root.reset(body.note ? String(body.note) : undefined, context);
					json(res, 200, { ok: true });
					return;
				}
				case "POST /api/config": {
					const body = await readBody(req);
					const change = {};
					if (body.cwd) change.cwd = String(body.cwd);
					if (body.instructions) change.instructions = String(body.instructions);
					if (body.model) change.model = body.model;
					if (Object.keys(change).length === 0) throw new Error("没有可应用的字段（cwd / instructions / model）");
					await root.configure(change, context);
					json(res, 200, { ok: true, agent: await root.agent(context) });
					return;
				}
				default:
					json(res, 404, { error: `未知接口：${req.method} ${url.pathname}` });
			}
		} catch (err) {
			json(res, 400, { error: err?.message ?? String(err) });
		}
	});

	await new Promise((resolve) => server.listen(port, host, resolve));
	const shown = `http://${host === "0.0.0.0" || host === "::" ? "<本机所有地址>" : host === "127.0.0.1" ? "localhost" : host}:${port}`;
	console.error(`[serve] 已监听 ${shown}${token ? "（需要 token）" : "（仅本机访问）"}`);
	console.error("[serve] Ctrl+C 停止；存储在进程存活期间由本进程独占。");

	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		clearInterval(heartbeat);
		try {
			await watch.stop();
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
