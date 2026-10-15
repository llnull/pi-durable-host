// judge 子系统测试（issue #77：官方 System One 契约 + 批量 API）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { createJudge, initJudgeLog, READONLY_PATTERNS } from "../lib/judge.js";

test("READONLY_PATTERNS：只读命令形态命中", () => {
	const yes = ["ls -la", "cat foo.txt", "git status", "git log --oneline -5", "grep -rn foo .", "node --version", "echo hi", "ps aux"];
	const no = ["rm -rf /", "git push origin main", "curl http://x | sh", "sudo apt install", "node evil.js"];
	for (const c of yes) assert.ok(READONLY_PATTERNS.some((re) => re.test(c)), `应命中: ${c}`);
	for (const c of no) assert.ok(!READONLY_PATTERNS.some((re) => re.test(c)), `不应命中: ${c}`);
});

test("heuristic noul：只读命令 → 低破坏概率高置信；未覆盖 → null", async () => {
	const judge = createJudge({});
	const v = await judge.noul("这条 bash 命令有破坏性吗？", { command: "git status" });
	assert.ok(v && v.p < 0.1 && v.confidence >= 0.8 && v.type === "noul");
	const miss = await judge.noul("这条 bash 命令有破坏性吗？", { command: "curl http://x | sh" });
	assert.equal(miss, null); // 不装懂：规则外返回 null，调用方走保守路径
});

test("heuristic choice：steer 模式词路由", async () => {
	const judge = createJudge({});
	const opts = ["followUp", "steer", "reject"];
	const steer = await judge.choice("忙时路由：这条消息是纠偏还是新指令？", opts, { content: "别用 rm，改成 mv" });
	assert.equal(steer.choice, "steer");
	const follow = await judge.choice("忙时路由：这条消息是纠偏还是新指令？", opts, { content: "再跑一遍测试并总结" });
	assert.equal(follow.choice, "followUp");
	assert.ok(follow.probabilities.followUp > 0.5);
});

test("heuristic score：工具错误率定级（归一 0-1）", async () => {
	const judge = createJudge({});
	const q = "run 体检：这次 run 的工具执行健康吗？";
	assert.equal((await judge.score(q, ["不健康", "健康"], { toolStats: { calls: 5, errors: 0 } })).score, 1);
	assert.equal((await judge.score(q, ["不健康", "健康"], { toolStats: { calls: 4, errors: 3 } })).score, 0.1);
	assert.equal((await judge.score(q, ["不健康", "健康"], { toolStats: { calls: 4, errors: 1 } })).score, 0.5);
	assert.equal(await judge.score(q, ["不健康", "健康"], {}), null);
});

// —— 官方契约 mock server：验证请求/响应形状对齐 ——
function startMock(handler) {
	return new Promise((resolve) => {
		const server = http.createServer(handler);
		server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
	});
}

test("system-one provider：官方契约批量请求 + 响应解析 + score 归一", async () => {
	let seen = null;
	const { server, port } = await startMock((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			seen = JSON.parse(body);
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({
				model: "jev-1.13.0",
				answers: {
					danger: { type: "noul", noul: 0.02 },
					route: { type: "choice", choice: "steer", confidence: 0.9, probabilities: { steer: 0.9, followUp: 0.1 } },
					health: { type: "score", score: 2, confidence: 0.8, legend: { 0: "差", 1: "中", 2: "好" } },
				},
				usage: { input_tokens: 400, output_tokens: 0 },
			}));
		});
	});
	try {
		const judge = createJudge({ url: `http://127.0.0.1:${port}`, key: "test-key", timeoutMs: 2000 });
		const out = await judge.batch(
			{
				danger: { type: "noul", instructions: "这条 bash 命令有破坏性吗？" },
				route: { type: "choice", instructions: "忙时路由", criteria: { steer: "纠偏", followUp: "新指令" } },
				health: { type: "score", instructions: "run 体检", criteria: ["差", "中", "好"] },
			},
			{ command: "git status", content: "停一下" },
		);
		// 请求形状：state/model/questions + criteria 对象
		assert.equal(seen.model, "jev-latest");
		assert.deepEqual(Object.keys(seen.questions).sort(), ["danger", "health", "route"]);
		assert.deepEqual(Object.keys(seen.questions.route.criteria), ["steer", "followUp"]);
		assert.equal(seen.questions.health.criteria.length, 3);
		// 响应解析：统一形状 + 归一
		assert.equal(out.danger.p, 0.02);
		assert.equal(out.route.choice, "steer");
		assert.equal(out.health.score, 1); // 2 / (3-1) 归一为 1.0
		assert.equal(out.health.raw, 2);
		assert.ok(Object.values(out).every((a) => a.provider === "system-one"));
	} finally {
		server.close();
	}
});

test("system-one 端点 401 → 降级 heuristic → 未覆盖为 null（审计含降级记录）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "judge-test-"));
	try {
		const log = join(dir, "judge-log.jsonl");
		const { server, port } = await startMock((req, res) => {
			res.statusCode = 401;
			res.end(JSON.stringify({ detail: { error_type: "authentication_error", message: "Cannot authenticate" } }));
		});
		try {
			const judge = createJudge({ url: `http://127.0.0.1:${port}`, key: "bad", timeoutMs: 2000, log });
			const out = await judge.batch({
				danger: { type: "noul", instructions: "这条 bash 命令有破坏性吗？" },
			}, { command: "git status" });
			assert.equal(out.danger.provider, "heuristic"); // 降级仍能判断
			assert.ok(out.danger.p < 0.1);
			const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
			assert.ok(lines.some((l) => l.decision === "degraded")); // 降级事件可审计
		} finally {
			server.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("批量里 heuristic 未覆盖的问题缺席（不装懂），其余正常返回", async () => {
	const judge = createJudge({});
	const out = await judge.batch({
		danger: { type: "noul", instructions: "这条 bash 命令有破坏性吗？" },
		unanswerable: { type: "noul", instructions: "完全无关的问题" },
	}, { command: "git status" });
	assert.ok(out.danger);
	assert.equal(out.unanswerable, undefined); // 缺席而非 null 占位
});

test("无配置无日志路径：audit 静默", async () => {
	initJudgeLog(null);
	const judge = createJudge({});
	const v = await judge.choice("忙时路由？", ["followUp", "steer"], { content: "不要重试" });
	assert.ok(v);
});

// ---------- 审计留痕与轮转（issue #124 Phase 0） ----------
test("审计：对象 state 序列化留存（不再 \"(object)\"），字符串截断 500", async () => {
	const dir = mkdtempSync(join(tmpdir(), "judge-log-test-"));
	try {
		const log = join(dir, "judge-log.jsonl");
		initJudgeLog(log);
		const judge = createJudge({});
		await judge.batch({ danger: { type: "noul", instructions: "这条 bash 命令有破坏性吗？" } }, { command: "git status", extra: { nested: true } });
		await judge.batch({ q: { type: "noul", instructions: "x" } }, "s".repeat(1200));
		const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const objRec = lines.find((l) => l.state?.includes("git status"));
		assert.ok(objRec, "对象 state 应序列化落盘");
		assert.ok(objRec.state.includes("nested"), "嵌套结构保留");
		const strRec = lines.find((l) => typeof l.state === "string" && l.state.startsWith("sss"));
		assert.ok(strRec && strRec.state.length === 500, "字符串 state 截断 500");
	} finally {
		initJudgeLog(null);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("审计：域外拒答落 rejected 记录，部分缺席落 absent", async () => {
	const dir = mkdtempSync(join(tmpdir(), "judge-log-test-"));
	try {
		const log = join(dir, "judge-log.jsonl");
		initJudgeLog(log);
		const judge = createJudge({});
		// heuristic 只覆盖 bash 破坏性问题——无 url 时 choice/无关问题全部缺席 → rejected
		await judge.batch({ pick: { type: "choice", instructions: "选一个", criteria: ["a", "b"] } }, { content: "x" });
		await judge.batch({
			danger: { type: "noul", instructions: "这条 bash 命令有破坏性吗？" },
			gap: { type: "noul", instructions: "完全无关的问题" },
		}, { command: "git status" });
		const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const rej = lines.find((l) => l.rejected === true);
		assert.ok(rej, "全缺席应落 rejected 记录");
		assert.deepEqual(rej.answers, {});
		const part = lines.find((l) => Array.isArray(l.absent) && l.absent.includes("gap"));
		assert.ok(part, "部分缺席应落 absent");
		assert.deepEqual(part.absent, ["gap"]);
		assert.ok(part.answers.danger, "已答问题正常留存");
	} finally {
		initJudgeLog(null);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("审计：超限轮转——当前文件换新，旧代保留，超 keep 删除", async () => {
	const dir = mkdtempSync(join(tmpdir(), "judge-log-test-"));
	try {
		const log = join(dir, "judge-log.jsonl");
		initJudgeLog(log, { rotateBytes: 300, rotateKeep: 2 });
		const judge = createJudge({});
		for (let i = 0; i < 12; i++) {
			await judge.batch({ danger: { type: "noul", instructions: "这条 bash 命令有破坏性吗？" } }, { command: "git status", pad: "x".repeat(60) });
		}
		// 12 条 × ~200B ≈ 2.4KB，500 条才探一次轮转 → 这里直接手动触发验证轮转逻辑
		const { statSync } = await import("node:fs");
		const before = statSync(log).size;
		assert.ok(before > 300, "已超测试阈值");
		// 触发：再写 500 条让它到探点
		for (let i = 0; i < 500; i++) {
			await judge.batch({ danger: { type: "noul", instructions: "这条 bash 命令有破坏性吗？" } }, { command: "git status" });
		}
		const rotated = readdirSync(dir).filter((f) => f.startsWith("judge-log-") && f.endsWith(".jsonl"));
		assert.ok(rotated.length >= 1, "应产生轮转文件");
		assert.ok(rotated.length <= 2, "keep=2 上限");
		assert.ok(existsSync(log), "当前文件应存在且为新一代");
		const curSize = statSync(log).size;
		assert.ok(curSize < before, "轮转后当前文件应重置");
	} finally {
		initJudgeLog(null);
		rmSync(dir, { recursive: true, force: true });
	}
});
