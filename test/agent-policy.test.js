// 会话运行策略的校验与规整（lib/agent-policy.js）：思考档位按模型的 thinkingLevelMap 判定、轮数上限、压缩策略。
import test from "node:test";
import assert from "node:assert/strict";
import { describePolicy, normalizePolicy, thinkingLevelsOf } from "../lib/agent-policy.js";

const GLM = { provider: "zai-coding-cn", modelId: "glm-5.4", thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" } };

test("thinkingLevelsOf：只保留 thinkingLevelMap 里非 null 的档位；没有 map 用默认集合", () => {
	assert.deepEqual(thinkingLevelsOf(GLM), ["low", "high", "max"]);
	assert.deepEqual(thinkingLevelsOf({ provider: "p", modelId: "m" }), ["off", "minimal", "low", "medium", "high"]);
	assert.deepEqual(thinkingLevelsOf(undefined), ["off", "minimal", "low", "medium", "high"]);
});

test("思考档位：支持的可设，不支持的 / 非法的拒绝并说明可选值；null 清除", () => {
	assert.deepEqual(normalizePolicy({ thinkingLevel: "max" }, { model: GLM }), { thinkingLevel: "max" });
	assert.throws(() => normalizePolicy({ thinkingLevel: "off" }, { model: GLM }), /不支持思考档位 off（支持：low \/ high \/ max）/);
	assert.throws(() => normalizePolicy({ thinkingLevel: "ultra" }, { model: GLM }), /thinkingLevel 非法/);
	assert.deepEqual(normalizePolicy({ thinkingLevel: null }), { thinkingLevel: null });
	// 没有 map 的模型（pi 文档）：未映射的档位走 provider 默认值到 high 为止，xhigh / max 视为不支持
	assert.deepEqual(normalizePolicy({ thinkingLevel: "high" }, { model: { provider: "p", modelId: "m" } }), { thinkingLevel: "high" });
	assert.throws(() => normalizePolicy({ thinkingLevel: "xhigh" }, { model: { provider: "p", modelId: "m" } }), /不支持思考档位 xhigh/);
});

test("轮数上限：正整数；null / 空串清除；其余拒绝", () => {
	assert.deepEqual(normalizePolicy({ maxTurns: 50 }), { maxTurns: 50 });
	assert.deepEqual(normalizePolicy({ maxTurns: "30" }), { maxTurns: 30 });
	assert.deepEqual(normalizePolicy({ maxTurns: null }), { maxTurns: null });
	assert.deepEqual(normalizePolicy({ maxTurns: "" }), { maxTurns: null });
	assert.throws(() => normalizePolicy({ maxTurns: 0 }), /≥1/);
	assert.throws(() => normalizePolicy({ maxTurns: 2.5 }), /≥1/);
	assert.throws(() => normalizePolicy({ maxTurns: "many" }), /≥1/);
});

test("压缩策略：部分字段即可，空字段忽略，非法类型 / 负数拒绝；null 清除", () => {
	assert.deepEqual(normalizePolicy({ compaction: { enabled: false } }), { compaction: { enabled: false } });
	assert.deepEqual(normalizePolicy({ compaction: { reserveTokens: "8000", keepRecentTokens: "", backgroundTokens: 12000 } }), { compaction: { reserveTokens: 8000, backgroundTokens: 12000 } });
	assert.deepEqual(normalizePolicy({ compaction: null }), { compaction: null });
	assert.throws(() => normalizePolicy({ compaction: [] }), /必须是对象/);
	assert.throws(() => normalizePolicy({ compaction: { enabled: "no" } }), /enabled 必须是布尔/);
	assert.throws(() => normalizePolicy({ compaction: { reserveTokens: -1 } }), /reserveTokens/);
});

test("没有策略字段时返回空变更；未知字段不透传", () => {
	assert.deepEqual(normalizePolicy({ cwd: "/x", whatever: 1 }), {});
	assert.deepEqual(normalizePolicy(undefined), {});
});

test("describePolicy：只在有覆盖时输出", () => {
	assert.equal(describePolicy({}), "");
	assert.equal(describePolicy({ thinkingLevel: "high", maxTurns: 50, compaction: { enabled: false } }), "思考 高 · 轮数上限 50 · 压缩 关");
	assert.equal(describePolicy({ compaction: { reserveTokens: 1, keepRecentTokens: 2, backgroundTokens: 3 } }), "压缩 1/2/3");
});
