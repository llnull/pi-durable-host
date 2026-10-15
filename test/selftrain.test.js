// 自训编排纯函数单测（issue #130）：切分/合并/提案校验/留档封口。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { splitReal, mergeWithWeight, validateProposal, pruneRuns, pruneFailed, shouldRun, promotedName } from "../lib/selftrain.js";

const rows = (n, label) => Array.from({ length: n }, (_, i) => ({ context: `command: cmd-${label}-${i}\nq: x`, options: ["safe", "destructive"], label }));

test("splitReal：确定性 + 分层 + 约等于 80/20", () => {
	const samples = [...rows(40, "a"), ...rows(10, "b")]; // 50 条
	const s1 = splitReal(samples);
	const s2 = splitReal(samples); // 同输入同切分
	assert.deepEqual(s1, s2);
	// 分层：两类都出现在两侧
	assert.ok(s1.train.length > 0 && s1.holdout.length > 0);
	// 总数守恒
	assert.equal(s1.train.length + s1.holdout.length, samples.length);
	// 80/20 附近（50 条 ± 容差）
	assert.ok(s1.holdout.length >= 4 && s1.holdout.length <= 16, `holdout=${s1.holdout.length}`);
});

test("mergeWithWeight：real ×weight 拼接", () => {
	const syn = ["s1", "s2", "s3"];
	const real = ["r1", "r2"];
	assert.deepEqual(mergeWithWeight(syn, real, 2), ["s1", "s2", "s3", "r1", "r2", "r1", "r2"]);
	assert.deepEqual(mergeWithWeight(syn, real, 1), ["s1", "s2", "s3", "r1", "r2"]);
	assert.deepEqual(mergeWithWeight(syn, [], 2), syn);
});

const passReport = {
	champion: { accuracy: 0.72, domains: { guard: 0.6 } },
	challenger: { accuracy: 0.83, domains: { guard: 0.75 } },
	probes: [{ name: "p", ok: true }],
};

test("validateProposal：过门+存在+路径合法 → ok", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "selftrain-test-"));
	try {
		const jevDir = path.join(dir, "jevlike");
		mkdirSync(jevDir, { recursive: true });
		const candidate = path.join(jevDir, "candidate.pt");
		writeFileSync(candidate, "ckpt");
		const p = { candidate, report: passReport, applied: false };
		const ok = (r) => validateProposal(r, { decide: () => ({ pass: true, reasons: [] }), jevDir });
		assert.equal(ok(p).ok, true);
		// 已应用 → 拒
		assert.equal(ok({ ...p, applied: true }).ok, false);
		// 路径逃逸 → 拒
		assert.equal(ok({ ...p, candidate: "/etc/passwd" }).ok, false);
		assert.ok(ok({ ...p, candidate: "/etc/passwd" }).error.includes("jevlike 目录内"));
		// 缺文件 → 拒
		assert.equal(ok({ ...p, candidate: path.join(jevDir, "ghost.pt") }).ok, false);
		// 门未过 → 拒（重算，不信任提案里的 decision 字段）
		const bad = validateProposal({ ...p, report: { ...passReport, challenger: { ...passReport.challenger, domains: { guard: 0.1 } } } },
			{ decide: (r) => ({ pass: r.challenger.domains.guard >= 0.6, reasons: r.challenger.domains.guard < 0.6 ? ["回归"] : [] }), jevDir });
		assert.equal(bad.ok, false);
		assert.ok(bad.error.includes("门判定未通过"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pruneRuns：只清 run-* 前缀、keep 最新 N 代、顶层不动", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "selftrain-test-"));
	try {
		for (const n of ["run-a", "run-b", "run-c", "run-d"]) {
			mkdirSync(path.join(dir, n));
			writeFileSync(path.join(dir, n, "candidate.pt"), "x");
		}
		writeFileSync(path.join(dir, "host-v8.pt"), "champion"); // 顶层不可触碰
		writeFileSync(path.join(dir, "promotion.json"), "{}");
		const removed = pruneRuns(dir, 3);
		assert.deepEqual(removed, ["run-a"]); // 字母序最老的一代
		assert.ok(existsSync(path.join(dir, "run-b")));
		assert.ok(existsSync(path.join(dir, "run-d")));
		assert.ok(existsSync(path.join(dir, "host-v8.pt")), "champion 永不触碰");
		assert.ok(existsSync(path.join(dir, "promotion.json")));
		// 目录不存在 → 空数组不炸
		assert.deepEqual(pruneRuns(path.join(dir, "nope"), 3), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("promotedName：不可变晋升名格式", () => {
	const n = promotedName(new Date("2026-10-15T05:31:10Z"));
	assert.match(n, /^host-promoted-\d{14}\.pt$/);
	assert.equal(n, "host-promoted-20261015053110.pt");
});

test("pruneFailed：failed-*.json 封口 keep 份，run-* 不动", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "selftrain-test-"));
	try {
		for (const n of ["failed-a.json", "failed-b.json", "failed-c.json"]) writeFileSync(path.join(dir, n), "{}");
		mkdirSync(path.join(dir, "run-x"));
		assert.deepEqual(pruneFailed(dir, 2), ["failed-a.json"]);
		assert.ok(existsSync(path.join(dir, "failed-b.json")));
		assert.ok(existsSync(path.join(dir, "failed-c.json")));
		assert.ok(existsSync(path.join(dir, "run-x")));
		assert.deepEqual(pruneFailed(path.join(dir, "nope"), 2), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("shouldRun：interval 内跳过、interval 外/无 run 目录则跑", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "selftrain-test-"));
	try {
		assert.equal(shouldRun(dir, 3600_000), true, "无 run 目录 → 跑");
		// 造一个 2026-10-15T05-51-39 的 run 目录
		mkdirSync(path.join(dir, "run-2026-10-15T05-51-39"));
		const at = Date.UTC(2026, 9, 15, 6, 21, 39); // 30min 后
		assert.equal(shouldRun(dir, 3600_000, at), false, "interval(1h) 内 → 跳过");
		assert.equal(shouldRun(dir, 1800_000, at), true, "interval(30m) 到点 → 跑");
		assert.equal(shouldRun(dir, 3600_000, at + 1800_001), true, "超过 1h → 跑");
		// 无法解析的目录名 → 保守起见跑
		mkdirSync(path.join(dir, "run-garbage"));
		assert.equal(shouldRun(dir, 3600_000, at), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
