// 换代耗时自适应单测（issue #124）：调参建议纯函数 + 计时样本落盘往返。
// 原则回归：只升不降、证据不足不吭声、clamp 上限、证据行非空。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordTiming, readSamples, recommend, TUNING_KEYS } from "../lib/jev-timing.js";

const dirs = [];
const tmpData = () => {
	const d = mkdtempSync(path.join(tmpdir(), "jev-timing-test-"));
	dirs.push(d);
	return d;
};

test("recommend：无样本 → 不吭声", () => {
	const r = recommend([], {});
	assert.equal(r.samples, 0);
	assert.deepEqual(r.recs, []);
});

test("recommend：就绪样本 ≥2 → readyMs 只升不降（max×1.5，取 500ms 整）", () => {
	const samples = [
		{ kind: "ready", ms: 1200 },
		{ kind: "ready", ms: 2400 },
	];
	const r = recommend(samples, { readyMs: 8000 });
	// max 2400 × 1.5 = 3600 < 8000：只升不降 → 不提
	assert.deepEqual(r.recs, []);
	// 慢就绪超过当前值 → 提
	const r2 = recommend([...samples, { kind: "ready", ms: 9000 }], { readyMs: 8000 });
	const rec = r2.recs.find((x) => x.key === "readyMs");
	assert.ok(rec, "应有 readyMs 建议");
	assert.equal(rec.proposed, 13500); // 9000×1.5=13500，已是 500ms 整倍数
	assert.ok(rec.evidence.every((e) => typeof e === "string" && e.length > 0));
});

test("recommend：not-ready 实证 → 即使无成功就绪样本也提", () => {
	const r = recommend([{ kind: "not-ready", ms: 8000 }], { readyMs: 8000 });
	const rec = r.recs.find((x) => x.key === "readyMs");
	assert.ok(rec, "not-ready 应触发建议");
	assert.equal(rec.proposed, 12000); // max(8000×1.5, 12000)
	assert.ok(rec.evidence[0].includes("未就绪"));
});

test("recommend：kill 样本 → killWaitMs（max×2，千位取整）", () => {
	const r = recommend([{ kind: "kill", ms: 3600 }, { kind: "kill", ms: 4200 }], { killWaitMs: 8000 });
	const rec = r.recs.find((x) => x.key === "killWaitMs");
	assert.ok(rec, "4200×2=8400 超过当前 8000，应有建议");
	assert.equal(rec.proposed, 9000);
});

test("recommend：升级杀样本 → escalateWaitMs（单样本即可——出现过升级杀本身就是证据）", () => {
	const r = recommend([{ kind: "escalate", ms: 1800 }], { escalateWaitMs: 2000 });
	const rec = r.recs.find((x) => x.key === "escalateWaitMs");
	assert.ok(rec, "升级杀出现过即应有建议");
	assert.equal(rec.proposed, 4000);
});

test("recommend：probe-slow 慢尾 → probeTimeoutMs（≥2 样本，clamp 上限 3000）", () => {
	const r = recommend([{ kind: "probe-slow", ms: 600 }, { kind: "probe-slow", ms: 1200 }], { probeTimeoutMs: 700 });
	const rec = r.recs.find((x) => x.key === "probeTimeoutMs");
	assert.ok(rec);
	assert.equal(rec.proposed, 2500); // 1200×2=2400 → ceil 250（步长）= 2500
	const r2 = recommend([{ kind: "probe-slow", ms: 2500 }, { kind: "probe-slow", ms: 2800 }], { probeTimeoutMs: 700 });
	assert.equal(r2.recs.find((x) => x.key === "probeTimeoutMs").proposed, 3000, "clamp 上限 3000");
});

test("recommend：clamp 下限与未知 kind 忽略", () => {
	const r = recommend([
		{ kind: "ready", ms: 29_000 }, { kind: "ready", ms: 31_000 },
		{ kind: "noise", ms: 1 },
		{ kind: "ready", ms: "bogus" },
	], { readyMs: 8000 });
	const rec = r.recs.find((x) => x.key === "readyMs");
	assert.ok(rec);
	assert.equal(rec.proposed, 30_000, "clamp 上限 30000");
	assert.equal(r.recs.length, 1);
});

test("recommend：TUNING_KEYS 覆盖全部可调参数", () => {
	assert.deepEqual(TUNING_KEYS.sort(), ["escalateWaitMs", "killWaitMs", "probeTimeoutMs", "readyMs"]);
});

test("recordTiming/readSamples：落盘往返，坏行跳过，目录自动创建", () => {
	const d = tmpData();
	recordTiming(d, { kind: "ready", ms: 1234 });
	recordTiming(d, { kind: "kill", ms: 888 });
	const file = path.join(d, "jevlike", "timing.jsonl");
	assert.ok(existsSync(file));
	// 坏行不打扰读取
	const raw = readFileSync(file, "utf8");
	recordTiming(d, { kind: "escalate", ms: 77 });
	const samples = readSamples(d);
	assert.equal(samples.length, 3);
	assert.equal(samples[0].kind, "ready");
	assert.ok(samples[0].at, "自动盖时间戳");
	assert.equal(samples[1].ms, 888);
});
