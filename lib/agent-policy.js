// 会话运行策略（pi-durable 1.4 / 1.5 的每会话 agent 配置）：思考档位、单次 run 的工具轮数上限、压缩策略。
// 纯校验与规整——daemon 的 /api/config 与单测共用；非法值抛带说明的 Error（daemon 直接回给调用方）。
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";

/** pi-ai 的 ModelThinkingLevel。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** 没有 thinkingLevelMap 的模型：上游把 xhigh / max 视为不支持，其余走 provider 默认值。 */
const DEFAULT_SUPPORTED_LEVELS = ["off", "minimal", "low", "medium", "high"];
const LABELS = { off: "关闭", minimal: "极简", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大" };

/** 档位的中文标签（CLI / UI 共用）。 */
export const thinkingLevelLabel = (level) => LABELS[level] ?? String(level ?? "");

/**
 * 模型支持的思考档位：thinkingLevelMap 里映射为 null 的是不支持的档位。
 * 例：GLM-5.4 的 map 是 { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" } → ["low", "high", "max"]。
 */
export function thinkingLevelsOf(model) {
	const map = model?.thinkingLevelMap;
	if (!map || typeof map !== "object") return [...DEFAULT_SUPPORTED_LEVELS];
	const levels = THINKING_LEVELS.filter((level) => map[level] !== null && map[level] !== undefined);
	return levels.length ? levels : [...DEFAULT_SUPPORTED_LEVELS];
}

const isCount = (v) => Number.isInteger(v) && v >= 0;

/**
 * 把 /api/config 里的策略字段规整成 AgentChange 片段（未知字段忽略；null = 清除回默认）。
 * model：校验思考档位时所针对的模型对象（切换模型与档位同时提交时用切换后的）。
 */
export function normalizePolicy(input, { model } = {}) {
	const src = input && typeof input === "object" ? input : {};
	const change = {};
	if (src.thinkingLevel !== undefined) {
		const v = src.thinkingLevel;
		if (v === null || v === "") change.thinkingLevel = null;
		else {
			if (!THINKING_LEVELS.includes(v)) throw new Error(`thinkingLevel 非法：${JSON.stringify(v)}（可选：${THINKING_LEVELS.join(" / ")}，null 清除）`);
			const supported = thinkingLevelsOf(model);
			if (!supported.includes(v)) throw new Error(`模型 ${model?.provider ?? "?"}/${model?.modelId ?? model?.id ?? "?"} 不支持思考档位 ${v}（支持：${supported.join(" / ")}）`); // pi-ai 的模型对象字段是 id
			change.thinkingLevel = v;
		}
	}
	if (src.maxTurns !== undefined) {
		const v = src.maxTurns;
		if (v === null || v === "") change.maxTurns = null;
		else {
			const n = Number(v);
			if (!Number.isInteger(n) || n < 1) throw new Error("maxTurns 必须是 ≥1 的整数（单次 run 的工具轮数上限；null 清除）");
			change.maxTurns = n;
		}
	}
	if (src.compaction !== undefined) {
		if (src.compaction === null) change.compaction = null;
		else {
			const c = src.compaction;
			if (typeof c !== "object" || c === null || Array.isArray(c)) throw new Error("compaction 必须是对象");
			const out = {};
			if (c.enabled !== undefined) {
				if (typeof c.enabled !== "boolean") throw new Error("compaction.enabled 必须是布尔");
				out.enabled = c.enabled;
			}
			for (const key of ["reserveTokens", "keepRecentTokens", "backgroundTokens"]) {
				if (c[key] === undefined || c[key] === "") continue;
				const n = Number(c[key]);
				if (!isCount(n)) throw new Error(`compaction.${key} 必须是 ≥0 的整数（tokens）`);
				out[key] = n;
			}
			if (Object.keys(out).length) change.compaction = out;
		}
	}
	return change;
}

/** 压缩策略的有效值：会话设置覆盖 harness 默认（host 的默认与上游 DEFAULT_COMPACTION_POLICY 同值）。 */
export function effectiveCompaction(session) {
	return { ...DEFAULT_COMPACTION_POLICY, ...(session && typeof session === "object" ? session : {}) };
}

/** 策略的一句话摘要（CLI status 用），没有任何覆盖时返回空串。 */
export function describePolicy(agent) {
	const bits = [];
	if (agent?.thinkingLevel) bits.push(`思考 ${thinkingLevelLabel(agent.thinkingLevel)}`);
	if (agent?.maxTurns) bits.push(`轮数上限 ${agent.maxTurns}`);
	const c = agent?.compaction;
	if (c) bits.push(`压缩 ${c.enabled === false ? "关" : [c.reserveTokens, c.keepRecentTokens, c.backgroundTokens].filter((n) => n !== undefined).join("/")}`);
	return bits.join(" · ");
}
