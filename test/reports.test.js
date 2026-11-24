// 系统事件（pi-durable onReport）单测：记录格式、环/日志/广播，以及一条真实 Harness 的集成用例——
// 用内存存储打开 Harness、挂一个会抛错的 watch 监听器并提交一次，确认 onReport 真的收到 listener_error 并落账。
// 不依赖模型、网络与磁盘上的真实数据。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, createRegistry, defineEntry } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { REPORT_KINDS, createReportLog, formatReport } from "../lib/reports.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 8000 } = {}) {
	const t0 = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - t0 > timeout) throw new Error("timeout");
		await sleep(50);
	}
}

test("formatReport：每个 kind 有严重度与中文标签；错误信息与堆栈分开且截断", () => {
	for (const kind of Object.keys(REPORT_KINDS)) {
		const rec = formatReport({ kind, error: new Error("x") }, "2026-01-01T00:00:00.000Z");
		assert.equal(rec.kind, kind);
		assert.equal(rec.severity, REPORT_KINDS[kind].severity);
		assert.equal(rec.label, REPORT_KINDS[kind].label);
		assert.equal(rec.type, "report");
		assert.equal(rec.at, "2026-01-01T00:00:00.000Z");
	}
	const err = new Error("E".repeat(900));
	const rec = formatReport({ kind: "task_interrupted", error: err, task: { id: 7, kind: "pi.generation", conversationId: 3 }, reason: "restart_limit", restarts: 5 }, "t");
	assert.equal(rec.message.length, 500, "message 截到 500");
	assert.equal(rec.task.id, 7);
	assert.equal(rec.reason, "restart_limit");
	assert.equal(rec.restarts, 5);
	assert.ok(rec.stack.length <= 2000);
	assert.equal(formatReport({ kind: "host_error", error: "plain", callback: "env" }).callback, "env");
	assert.equal(formatReport({ kind: "whatever-new", error: null }).severity, "warn", "未知 kind 不崩，按 warn");
});

test("createReportLog：环有上限、新纪录在前、落审计日志、经 sink 广播；日志写不进去也不抛", async (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "reports-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const logFile = path.join(dir, "judge-log.jsonl");
	const log = createReportLog({ logFile, cap: 3 });
	const seen = [];
	log.sink.broadcast = (event, rec) => seen.push([event, rec.kind]);
	for (let i = 0; i < 5; i++) log.onReport({ kind: "extension_error", error: new Error(`e${i}`), extension: "x" });
	assert.deepEqual(log.items.map((r) => r.message), ["e4", "e3", "e2"], "只留最新 3 条，新的在前");
	assert.equal(log.snapshot().length, 3);
	assert.equal(seen.length, 5, "每次都广播");
	assert.equal(seen[0][0], "report");
	assert.equal(readFileSync(logFile, "utf8").trim().split("\n").length, 5, "审计日志全量落盘（不受环上限影响）");
	// 坏路径：onReport 不能向 Harness 抛
	const errors = [];
	const bad = createReportLog({ logFile: path.join(dir, "no-such-dir", "x.log"), onError: (e) => errors.push(e) });
	bad.onReport({ kind: "storage_failed", error: new Error("disk") });
	assert.equal(errors.length, 1);
	assert.equal(bad.items.length, 1, "落账失败仍进环：可见性优先（审计缺了这一条，但 UI 不能跟着一起瞎）");
});

test("真实 Harness：抛错的 watch 监听器 → onReport 收到 listener_error", async (t) => {
	const log = createReportLog({ cap: 10 });
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry(), onReport: log.onReport }, BACKGROUND_CONTEXT);
	t.after(() => harness.close(BACKGROUND_CONTEXT));
	const root = await harness.root(BACKGROUND_CONTEXT);
	const w = await root.watch(BACKGROUND_CONTEXT);
	w.start(() => { throw new Error("boom-listener"); });
	const Note = defineEntry("test.note");
	await root.commit((tx) => tx.appendEntry(Note, root.id, { data: { hello: "world" } }), BACKGROUND_CONTEXT);
	const rec = await waitFor(() => log.items[0]);
	assert.equal(rec.kind, "listener_error");
	assert.match(rec.message, /boom-listener/);
	assert.equal(rec.severity, "warn");
});
