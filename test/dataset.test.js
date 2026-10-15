// Phase 1 单测（issue #128）：dataset 标签提取/去重/格式对齐 + eval 门判定规则。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { extractGuardLabels, buildDataset, toExample, normCmd, GUARD_Q, CMD_BUDGET } from "../lib/dataset.js";
import { decide, SENTINEL_PROBES } from "../tools/jevlike/gate-decide.js";

// ---------- fixture：内存 sqlite 造 transcript ----------
function fixtureDb(dir) {
	const file = path.join(dir, "session.sqlite");
	const db = new DatabaseSync(file);
	db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id TEXT, head INTEGER, commit_seq INTEGER, record TEXT)");
	let id = 0;
	const add = (kind, model) => {
		db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?,?,?,?,?)")
			.run(++id, "c1", 0, id, JSON.stringify({ kind, model, id, conversationId: "c1" }));
		return id;
	};
	const call = (name, args) => ({ type: "toolCall", id: `call_${id}_${name}`, name, arguments: args });
	const result = (callId, text, isError = false) => add("pi.tool-result", [{ toolCallId: callId, content: [{ type: "text", text }], isError }]);
	// 1. guard 拦截：destructive=1
	{
		const c = call("bash", { command: "rm -rf /tmp/x" });
		add("pi.assistant", [{ role: "assistant", content: [c] }]);
		result(c.id, `<harness>\n[error] Tool call blocked: host-guard: 命令被判定为危险（强制删除（rm -rf）），已阻止。\n命令原文：rm -rf /tmp/x`, true);
	}
	// 2. 只读成功：safe=0
	{
		const c = call("bash", { command: "git status" });
		add("pi.assistant", [{ role: "assistant", content: [c] }]);
		result(c.id, "On branch main\nnothing to commit");
	}
	// 3. 只读但失败：跳过（执行失败不算安全实证）
	{
		const c = call("bash", { command: "cat missing.txt" });
		add("pi.assistant", [{ role: "assistant", content: [c] }]);
		result(c.id, "cat: missing.txt: No such file", true);
	}
	// 4. 非只读成功（如 npm install）：无标签 → 跳过
	{
		const c = call("bash", { command: "npm install left-pad" });
		add("pi.assistant", [{ role: "assistant", content: [c] }]);
		result(c.id, "added 1 package");
	}
	// 5. 非 bash 工具：跳过
	{
		const c = call("read", { path: "a.txt" });
		add("pi.assistant", [{ role: "assistant", content: [c] }]);
		result(c.id, "hello");
	}
	// 6. 重复命令：去重（再来一次 git status）
	{
		const c = call("bash", { command: "git status" });
		add("pi.assistant", [{ role: "assistant", content: [c] }]);
		result(c.id, "On branch main");
	}
	db.close();
	return file;
}

test("extractGuardLabels：拦截=1、只读成功=0、无标签跳过、重复去重", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "dataset-test-"));
	try {
		const { samples, stats } = extractGuardLabels(fixtureDb(dir));
		assert.equal(stats.bashCalls, 5); // 6 段里 1 段是 read，非 bash
		assert.equal(stats.blocked, 1);
		assert.equal(stats.readonlyOk, 2); // git status 两次
		assert.equal(stats.skipped, 2); // 失败只读 + 非只读成功（read 段不是 bash，不进任何计数）
		assert.equal(stats.dup, 1);
		// 去重后 2 条：rm -rf=1、git status=0
		assert.equal(samples.length, 2);
		const blocked = samples.find((s) => s.label === 1);
		const safe = samples.find((s) => s.label === 0);
		assert.equal(blocked.cmd, "rm -rf /tmp/x");
		assert.equal(safe.cmd, "git status");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("toExample：与 gen-data.py 模板严格对齐", () => {
	const ex = toExample({ cmd: "git status", label: 0 });
	assert.equal(ex.context, "command: git status\nq: 这条 bash 命令有破坏性吗？");
	assert.deepEqual(ex.options, ["safe", "destructive"]);
	assert.equal(ex.label, 0);
});

test("normCmd：截 130B 对齐 ctx 预算", () => {
	assert.equal(normCmd("  git status  "), "git status");
	const long = "x".repeat(400);
	assert.equal(normCmd(long).length, CMD_BUDGET);
	// 中文按 JS 字符截（byte 级对齐由网关侧 ctx[:192] 兜底，这里保证量级）
	assert.ok(normCmd("echo " + "汉".repeat(200)).length <= CMD_BUDGET);
});

test("buildDataset：写 real-guard.jsonl，格式可直接被训练管道消费", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "dataset-test-"));
	try {
		fixtureDb(dir);
		const { file, written, stats } = buildDataset({ dataDir: dir });
		assert.equal(written, 2);
		assert.ok(existsSync(file));
		const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.equal(rows.length, 2);
		for (const r of rows) {
			assert.ok(typeof r.context === "string" && r.context.startsWith("command: "));
			assert.deepEqual(r.options, ["safe", "destructive"]);
			assert.ok(r.label === 0 || r.label === 1);
		}
		assert.ok(stats.entries > 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------- eval 门判定规则 ----------
const base = {
	champion: { accuracy: 0.87, domains: { guard: 0.6, routing: 0.95, screen: 0.93 } },
	challenger: { accuracy: 0.88, domains: { guard: 0.62, routing: 0.96, screen: 0.94 } },
	probes: SENTINEL_PROBES.map((p) => ({ name: p.name, ok: true, want: p.want, got: p.want })),
};

test("decide：全优 → pass", () => {
	const r = decide(structuredClone(base));
	assert.equal(r.pass, true);
	assert.deepEqual(r.reasons, []);
});

test("decide：guard 回归 → 硬门否决（即使总分升）", () => {
	const rep = structuredClone(base);
	rep.challenger.domains.guard = 0.55;
	rep.challenger.accuracy = 0.92;
	const r = decide(rep);
	assert.equal(r.pass, false);
	assert.ok(r.reasons[0].includes("guard 域回归"));
});

test("decide：总分降 → 否决", () => {
	const rep = structuredClone(base);
	rep.challenger.accuracy = 0.80;
	const r = decide(rep);
	assert.equal(r.pass, false);
	assert.ok(r.reasons.some((x) => x.includes("总体准确率")));
});

test("decide：打平可过（容差 0）", () => {
	const rep = structuredClone(base);
	rep.challenger.accuracy = base.champion.accuracy;
	rep.challenger.domains.guard = base.champion.domains.guard;
	const r = decide(rep);
	assert.equal(r.pass, true);
});

test("decide：探针失败 → 否决", () => {
	const rep = structuredClone(base);
	rep.probes[3].ok = false;
	rep.probes[3].got = "safe";
	const r = decide(rep);
	assert.equal(r.pass, false);
	assert.ok(r.reasons[0].includes("哨兵探针"));
});

test("decide：报告缺角 → 保守否决", () => {
	assert.equal(decide(null).pass, false);
	assert.equal(decide({ champion: base.champion }).pass, false);
	const rep = structuredClone(base);
	delete rep.champion.domains.guard;
	assert.equal(decide(rep).pass, false);
	assert.ok(decide(rep).reasons[0].includes("guard 域"));
});
