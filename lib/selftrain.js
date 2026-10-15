// 自训编排的纯函数核心（issue #130 Phase 3）：切分、合并、提案校验、留档封口。
// 与 IO/进程编排（tools/jevlike/selftrain.js）分离——本文件无重副作用、可测。
import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * real 样本确定性分层切分：hash(context) mod 5 <4 → train（80%），否则 holdout。
 * 确定性（同输入同切分，重训可复现）且分层（destructive/safe 各自独立切，保占比）。
 */
export function splitReal(samples) {
	const h = (s) => createHash("sha1").update(s).digest().readUInt32BE(0);
	const train = [], holdout = [];
	for (const s of samples) (h(s.context) % 5 < 4 ? train : holdout).push(s);
	return { train, holdout };
}

/** 合并训练集：合成 train + real-train × weight（权重靠复制实现——jevlike.train 无样本权重参数）。 */
export function mergeWithWeight(syntheticTrainLines, realTrainLines, weight = 2) {
	const lines = [...syntheticTrainLines];
	for (let i = 0; i < weight; i++) lines.push(...realTrainLines);
	return lines;
}

/**
 * 晋升提案校验（apply 端点用，不信任提案文件自身）：
 *   - 用传入的 decide 对报告重算门判定，必须 pass
 *   - 候选 ckpt 必须存在且在 jevDir 之内（防路径逃逸）
 * 返回 {ok, error?}。
 */
export function validateProposal(proposal, { decide, jevDir }) {
	if (!proposal || proposal.applied) return { ok: false, error: "提案不存在或已应用" };
	const { candidate, report } = proposal;
	if (!candidate || !report) return { ok: false, error: "提案缺 candidate/report" };
	const abs = String(candidate);
	if (!abs.startsWith(String(jevDir) + path.sep)) return { ok: false, error: "候选必须在 jevlike 目录内" };
	if (!existsSync(abs)) return { ok: false, error: "候选 ckpt 不存在" };
	const decision = decide(report);
	if (!decision.pass) return { ok: false, error: "门判定未通过：" + decision.reasons.join("；") };
	return { ok: true };
}

/**
 * 候选留档封口：runs 目录（run-<ts> 子目录）只留最近 keep 代，旧的整目录删。
 * 只碰 run-* 前缀——永不触碰 jevlike 顶层（晋升名/champion/gateway.json 等）。
 */
export function pruneRuns(runsDir, keep = 3) {
	let names;
	try {
		names = readdirSync(runsDir).filter((n) => n.startsWith("run-")).sort();
	} catch {
		return []; // 目录不存在 → 无可清理
	}
	const removed = [];
	for (const name of names.slice(0, Math.max(0, names.length - keep))) {
		try { rmSync(path.join(runsDir, name), { recursive: true, force: true }); removed.push(name); } catch { }
	}
	return removed;
}

/** 失败归档封口：failed-*.json 只留最近 keep 份（每次失败一份，不封口会无限累积）。 */
export function pruneFailed(runsDir, keep = 10) {
	let names;
	try {
		names = readdirSync(runsDir).filter((n) => n.startsWith("failed-")).sort();
	} catch {
		return [];
	}
	const removed = [];
	for (const name of names.slice(0, Math.max(0, names.length - keep))) {
		try { rmSync(path.join(runsDir, name)); removed.push(name); } catch { }
	}
	return removed;
}

/**
 * 定时器节流：距上次 run-* 目录不足 intervalMs 则跳过（daemon 频繁重启时，
 * 重训不跟着每次重启跑——按 cron 语义「每 interval 最多一次」）。
 */
export function shouldRun(runsDir, intervalMs, now = Date.now()) {
	let names;
	try {
		names = readdirSync(runsDir).filter((n) => n.startsWith("run-")).sort();
	} catch {
		return true; // 没跑过 → 跑
	}
	if (!names.length) return true;
	const last = names[names.length - 1];
	const m = /^run-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/.exec(last);
	if (!m) return true;
	const lastMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
	return now - lastMs >= intervalMs;
}

/** 晋升后的不可变 ckpt 名：host-promoted-<compact-ts>.pt（apply 时由候选拷贝生成）。 */
export function promotedName(at = new Date()) {
	const s = at.toISOString().replace(/[-:T]/g, "").slice(0, 14);
	return `host-promoted-${s}.pt`;
}
