// 网关换代计时自适应（issue #124）：采集实测样本 + 证据化调参建议。
// 背景：readyMs=8000 / kill 等待 8s / 升级等待 2s / 探活超时 700ms 全是魔数
// （8000 是 WSL2 9p 慢退出撞车后拍的），换环境可能不合适——让样本说话。
//
// 数据流：sidecar 换代/自愈时 recordTiming 落 data/jevlike/timing.jsonl
//   → recommend(samples, current) 出建议（纯函数，可测）
//   → UI 人批 → server 写回 host.json judge.sidecar → 下次换代生效。
// jev 头接入点：recommend 是可插拔实现——本版纯统计（小样本诚实做法），
//   真实样本攒厚后可换/叠加本地 score 头（域前缀 duration:）。
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const TUNING_KEYS = ["readyMs", "killWaitMs", "escalateWaitMs", "probeTimeoutMs"];

/** 各参数的合理区间（clamp 用）：下限保可用性，上限防失控。只升不降。 */
const LIMITS = {
	readyMs: [3000, 30_000],
	killWaitMs: [3000, 20_000],
	escalateWaitMs: [2000, 10_000],
	probeTimeoutMs: [700, 3000],
};

const timingPathOf = (dataDir) => path.join(dataDir, "jevlike", "timing.jsonl");

/** 落一条计时样本。绝不抛——计时采集失败不该影响换代流程。 */
export function recordTiming(dataDir, entry) {
	try {
		const file = timingPathOf(dataDir);
		mkdirSync(path.dirname(file), { recursive: true });
		appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
	} catch { }
}

export function readSamples(dataDir) {
	try {
		return readFileSync(timingPathOf(dataDir), "utf8").trim().split("\n").filter(Boolean)
			.map((l) => { try { return JSON.parse(l); } catch { return null; } })
			.filter(Boolean);
	} catch { return []; }
}

const ceilTo = (v, step) => Math.ceil(v / step) * step;
const clamp = (v, [lo, hi]) => Math.min(Math.max(v, lo), hi);
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s` : `${Math.round(ms)}ms`);

/**
 * 由样本出调参建议。原则：
 *   只升不降（收紧有可用性风险，第一刀不做）；证据不足不吭声；
 *   建议值 = 观测极值 × 安全系数，clamp 到合理区间；每条附证据行。
 * current：当前生效值（host.json 缺省走 sidecar 默认）。
 */
export function recommend(samples, current = {}) {
	const cur = {
		readyMs: current.readyMs ?? 8000,
		killWaitMs: current.killWaitMs ?? 8000,
		escalateWaitMs: current.escalateWaitMs ?? 2000,
		probeTimeoutMs: current.probeTimeoutMs ?? 700,
	};
	const by = (kind) => samples.filter((s) => s.kind === kind && Number.isFinite(s.ms) && s.ms >= 0);
	const recs = [];
	const push = (key, proposed, evidence) => {
		proposed = clamp(ceilTo(proposed, key === "probeTimeoutMs" ? 250 : key === "readyMs" ? 500 : 1000), LIMITS[key]);
		if (proposed > cur[key]) recs.push({ key, current: cur[key], proposed, evidence });
	};

	// readyMs：spawn→就绪 的极值。就绪样本 ≥2 用 max×1.5；出现过 not-ready（readyMs 耗尽）
	// 直接是"当前值不够"的实证，即使没有成功就绪样本也要提。
	const ready = by("ready");
	const notReady = by("not-ready");
	if (ready.length >= 2) push("readyMs", Math.max(...ready.map((s) => s.ms)) * 1.5,
		ready.map((s) => `实测就绪 ${fmtMs(s.ms)}`));
	else if (notReady.length) push("readyMs", Math.max(cur.readyMs * 1.5, 12_000),
		notReady.map((s) => `readyMs ${fmtMs(s.ms)} 内未就绪（自愈兜底接管）`));

	// killWaitMs：SIGTERM→端口释放 极值。撞过 8s 上限的卡死样本不给 killWait 提建议（那是升级杀的活）。
	const kill = by("kill");
	if (kill.length >= 2) push("killWaitMs", Math.max(...kill.map((s) => s.ms)) * 2,
		kill.map((s) => `实测停止 ${fmtMs(s.ms)}`));

	// escalateWaitMs：出现过升级杀（SIGTERM 超时）本身不是问题——升级等 2s 是否够看 escalate 样本。
	const esc = by("escalate");
	if (esc.length) push("escalateWaitMs", Math.max(...esc.map((s) => s.ms)) * 2,
		esc.map((s) => `升级后 ${fmtMs(s.ms)} 释放`));

	// probeTimeoutMs：稳态探活的慢尾（>250ms 才记样本）。慢尾 ×2 仍小于当前值 → 不提。
	const slow = by("probe-slow");
	if (slow.length >= 2) push("probeTimeoutMs", Math.max(...slow.map((s) => s.ms)) * 2,
		slow.map((s) => `稳态探活 ${fmtMs(s.ms)}`));

	return { samples: samples.length, recs };
}
