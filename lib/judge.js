// Judge 子系统：Jev-like 类型化判断接入 host 控制面（issue #70）。
//
// System One 模型（如 Jev）不生成文本：state 进 → 类型化决策出。三原语：
//   Noul  —— 这个陈述为真吗？          → 概率 p（0-1，本身就是分布，无独立 confidence）
//   Choice —— 从选项列表选一个          → { choice, probabilities, confidence }
//   Score  —— 按 rubric 定级（0-1）     → { score, confidence }
//
// 设计原则（对应报告 §1/§8）：
//   原子问题、代码组合 —— 每个判断一个问题，权重逻辑在 host 代码；
//   置信路由 —— 高置信自动、中置信标记、低置信转人工；破坏性操作永远人工；
//   控制面/数据面分离 —— 判断结果不进 conversation context（不污染 fork/context 语义），
//     全量审计落 data/judge-log.jsonl；
//   降级 —— judge 不可用（未配置/超时/出错）返回 null，调用方走保守路径（现有行为），
//     安全功能永不禁用。
//
// Provider 两种：
//   heuristic —— 内置规则判断，无概率语义（置信度按规则来源标注）。价值：接口形状、
//     统计判断（只读命令分类等）、审计落盘。默认。
//   system-one —— Jev/jevlike 兼容 HTTP 端点（PI_DURABLE_JUDGE_URL 配置即启用）。
//     请求形状按官方 system-one-adapter 的最小面约定：POST { primitive, question,
//     options?, rubric?, state } → { p? | choice?, score?, probabilities?, confidence }。
import { appendFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// 审计日志
// ---------------------------------------------------------------------------

let logFile = null;

/** 配置审计日志路径（host.js 启动时调用一次）。 */
export function initJudgeLog(file) {
	logFile = file;
}

/** 追加一条判断记录；日志失败不影响主流程（judge 是控制面，不阻塞 agent）。 */
function audit(record) {
	if (!logFile) return;
	try {
		appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
	} catch {}
}

// ---------------------------------------------------------------------------
// heuristic provider（内置规则判断）
// ---------------------------------------------------------------------------

// 高置信只读命令：模式命中即判定「无破坏性」（p≈0.02），供 guard 置信路由。
// 只匹配「命令首词/子命令」级形态，不解析整条管道——管道右端仍由 DANGEROUS_PATTERNS 兜底。
export const READONLY_PATTERNS = [
	/^(?:ls|pwd|cat|head|tail|wc|file|stat|du|df|which|whoami|date|env|printenv)\b/,
	/^(?:grep|rg|find|locate|ag)\b/,
	/^git\s+(?:status|log|diff|show|branch|remote|tag|describe|blame|shortlog|rev-parse|ls-files|config\s+--get)\b/,
	/^(?:node|npm|npx|python3?|pip3?)\s+(?:--version|-v|--help|-h)\b/,
	/^npm\s+(?:ls|list|outdated|view|search|run\s+--help)\b/,
	/^(?:echo|printf|true|false|test|\[)\b/,
	/^(?:ps|top|-?htop|free|uname|uptime|lscpu|lsblk)\b/,
	/^curl\s+(?:-I|--head|-s|-S|-X\s*GET)\b/,
];

function heuristicNoul(statement, state) {
	const s = String(statement ?? "");
	const cmd = state?.command ?? "";
	// 问题域 1：这条 bash 命令有破坏性吗？
	if (/破坏|危险|destructive|harmful/i.test(s) && cmd) {
		if (READONLY_PATTERNS.some((re) => re.test(cmd.trim()))) {
			return { p: 0.02, confidence: 0.9, source: "readonly-pattern" };
		}
		return null; // 规则未覆盖 → 不装懂，交给调用方保守路径
	}
	return null;
}

function heuristicChoice(question, options, state) {
	// 问题域：忙时路由——这条消息是纠偏（steer）还是新指令（followUp）？
	if (/路由|route|转向|纠偏|steer/i.test(question)) {
		const text = String(state?.content ?? "");
		const steerRe = /(?:^|[，。,.：:！!？?\s])(别|不要|不许|停止|停一下|算了|改成|换成|instead|no[, ]|don't|stop\b)/i;
		if (options.includes("steer") && options.includes("followUp")) {
			return steerRe.test(text)
				? { choice: "steer", probabilities: { steer: 0.8, followUp: 0.2 }, confidence: 0.7, source: "steer-pattern" }
				: { choice: "followUp", probabilities: { steer: 0.15, followUp: 0.85 }, confidence: 0.7, source: "steer-pattern" };
		}
	}
	return null;
}

function heuristicScore(question, rubric, state) {
	// 问题域：run 体检——这次 run 的工具执行健康吗？（rubric 0-1，1 = 健康）
	if (/健康|healthy|体检|checkup/i.test(question) && state?.toolStats) {
		const { calls, errors } = state.toolStats;
		if (!calls) return { score: 1, confidence: 0.6, source: "tool-stats" };
		const rate = errors / calls;
		if (rate === 0) return { score: 1, confidence: 0.8, source: "tool-stats" };
		if (rate >= 0.5) return { score: 0.1, confidence: 0.8, source: "tool-stats" };
		return { score: 0.5, confidence: 0.5, source: "tool-stats" };
	}
	return null;
}

// ---------------------------------------------------------------------------
// system-one provider（HTTP 端点）
// ---------------------------------------------------------------------------

async function remoteCall({ url, key, model }, body, timeoutMs) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
			body: JSON.stringify({ model, ...body }),
			signal: ctrl.signal,
		});
		if (!res.ok) throw new Error(`judge 端点 ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 创建 judge。config: { url?, key?, model?, timeoutMs? }
 * 无 url → heuristic；有 url → system-one 端点，出错自动降级 heuristic（再不行 → null）。
 */
export function createJudge(config = {}) {
	const { url, key, model = "jev-latest", timeoutMs = 3000, log } = config;
	if (log) initJudgeLog(log);
	const providerName = url ? "system-one" : "heuristic";

	async function invoke(primitive, payload, state) {
		const started = Date.now();
		let answer = null;
		let used = providerName;
		if (url) {
			try {
				answer = await remoteCall({ url, key, model }, { primitive, ...payload, state }, timeoutMs);
			} catch (e) {
				audit({ primitive, ...payload, provider: "system-one", error: String(e?.message ?? e), decision: "degraded" });
				used = "heuristic"; // 端点失败降级，不让 agent 停摆
			}
		}
		if (!answer) {
			const h = primitive === "noul" ? heuristicNoul(payload.statement, state)
				: primitive === "choice" ? heuristicChoice(payload.question, payload.options, state)
				: heuristicScore(payload.question, payload.rubric, state);
			answer = h;
		}
		if (!answer) return null; // 双层都没覆盖 → 调用方保守路径
		const out = { ...answer, provider: used, ms: Date.now() - started };
		audit({ primitive, ...payload, answer: out });
		return out;
	}

	return {
		provider: providerName,
		/** 这个陈述为真吗？→ { p, confidence?, provider, ms } | null */
		noul: (statement, state) => invoke("noul", { statement }, state),
		/** 从选项选一个 → { choice, probabilities?, confidence?, provider, ms } | null */
		choice: (question, options, state) => invoke("choice", { question, options }, state),
		/** 按 rubric 定级 0-1 → { score, confidence?, provider, ms } | null */
		score: (question, rubric, state) => invoke("score", { question, rubric }, state),
	};
}
