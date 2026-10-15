// 磁盘水位守卫单测（issue #127）：封口轮转、水位分级、不存在文件不惊。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { diskGuard, rotateCap } from "../lib/diskguard.js";

test("rotateCap：超限换 .1 代，未超限不动，.1 已存在先清再换（幂等）", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "diskguard-test-"));
	try {
		const f = path.join(dir, "a.log");
		assert.equal(rotateCap(f), false, "不存在 → false");
		writeFileSync(f, "x".repeat(2048));
		assert.equal(rotateCap(f, 1024), true);
		assert.ok(!existsSync(f), "当前文件应已换走");
		assert.equal(statSync(`${f}.1`).size, 2048);
		// 幂等：再来一轮，旧 .1 被覆盖
		writeFileSync(f, "y".repeat(1500));
		assert.equal(rotateCap(f, 1024), true);
		assert.equal(statSync(`${f}.1`).size, 1500, "旧 .1 应被新 .1 覆盖");
		// 未超限不动
		writeFileSync(f, "small");
		assert.equal(rotateCap(f, 1024), false);
		assert.ok(existsSync(f));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("diskGuard：封口已知日志 + 水位分级", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "diskguard-test-"));
	try {
		// jevlike 子目录的日志也要被扫到
		mkdirSync(path.join(dir, "jevlike"), { recursive: true });
		writeFileSync(path.join(dir, "serve.log"), "x".repeat(2048));
		writeFileSync(path.join(dir, "jevlike", "gateway.log"), "x".repeat(2048));
		const g = diskGuard(dir, { maxBytes: 1024, warnFreeBytes: 1, alarmFreeBytes: 0 });
		assert.deepEqual(g.rotated.sort(), ["jevlike/gateway.log", "serve.log"]);
		assert.equal(g.level, "ok", "warnFreeBytes=1 时正常盘 → ok");
		assert.ok(g.freeBytes > 0, "statfs 可得");
		// 极端阈值 → alarm
		const g2 = diskGuard(dir, { maxBytes: 1024, warnFreeBytes: Number.MAX_SAFE_INTEGER, alarmFreeBytes: Number.MAX_SAFE_INTEGER });
		assert.equal(g2.level, "alarm");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("diskGuard：空目录不惊", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "diskguard-test-"));
	try {
		const g = diskGuard(dir, { maxBytes: 1024 });
		assert.deepEqual(g.rotated, []);
		assert.ok(["ok", "warn", "alarm"].includes(g.level));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
