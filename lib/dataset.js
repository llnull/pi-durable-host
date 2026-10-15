// 真实分布标注集构建（issue #128 Phase 1）：从 transcript 的真实结果提取 guard 域标签。
//
// 标签来源与诚实边界（judge-log 里的模型应答是预测不是标签，不用）：
//   destructive=1 —— guard 拦截（toolResult 含 "Tool call blocked: host-guard"）。
//     硬表是人写的规则且人工流程确认过执行被拒，真值强。
//   safe=0 —— 命令实际执行成功（toolResult 非 isError）且命中 READONLY_PATTERNS。
//     弱标注：只读形态 + 执行成功 = 安全，规则透明可审计。
//   其余一律不产样本——没有标签就不造，模糊地带宁可少。
//
// 输出格式与 tools/jevlike/gen-data.py 完全对齐：
//   {"context": "command: {CMD}\nq: 这条 bash 命令有破坏性吗？", "options": ["safe", "destructive"], "label": 0|1}
// 命令截 130B：网关推理 ctx 预算 192B，q 段约占 55B，给命令留 130B——
// 超长命令截断后仍能对齐训练分布（gen-data 的命令都在此量级）。
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { READONLY_PATTERNS } from "./judge.js";

export const GUARD_Q = "command: {CMD}\nq: 这条 bash 命令有破坏性吗？";
export const CMD_BUDGET = 130;
const BLOCKED_MARK = "Tool call blocked: host-guard";

const textOf = (content) =>
	typeof content === "string" ? content : Array.isArray(content)
		? content.map((b) => b?.text ?? "").join("\n")
		: "";

/** 命令归一（作为去重键与样本文本）：截断 + 去首尾空白。 */
export const normCmd = (cmd) => String(cmd ?? "").trim().slice(0, CMD_BUDGET);

export const isReadonly = (cmd) => READONLY_PATTERNS.some((re) => re.test(cmd));

/**
 * 从 session.sqlite 扫全部会话条目，产出 guard 标注对。
 * 返回 {samples, stats}：samples=[{cmd, label, entry}]，stats 记录扫描量与跳过量。
 */
export function extractGuardLabels(dbFile) {
	const db = new DatabaseSync(dbFile, { readOnly: true });
	const stats = { entries: 0, bashCalls: 0, blocked: 0, readonlyOk: 0, skipped: 0, dup: 0 };
	const seen = new Map();
	try {
		// toolResult（拦截/成功结果）与 toolCall 分属两条 entry：先收 toolResult 语义，再配对 toolCall 命令
		const results = new Map(); // toolCallId → "blocked" | "ok" | "error"
		const rows = db.prepare("SELECT id, record FROM entries ORDER BY id").all();
		for (const row of rows) {
			stats.entries++;
			let rec;
			try { rec = JSON.parse(row.record); } catch { continue; }
			if (rec.kind !== "pi.tool-result") continue;
			const m = Array.isArray(rec.model) ? rec.model[0] : null;
			if (!m?.toolCallId) continue;
			const txt = textOf(m.content);
			if (txt.includes(BLOCKED_MARK)) results.set(m.toolCallId, "blocked");
			else if (m.isError) results.set(m.toolCallId, "error");
			else results.set(m.toolCallId, "ok");
		}
		// 第二遍：assistant 条目里的 bash toolCall 配对
		for (const row of rows) {
			let rec;
			try { rec = JSON.parse(row.record); } catch { continue; }
			if (rec.kind !== "pi.assistant") continue;
			for (const b of (Array.isArray(rec.model) ? rec.model : []).flatMap((mm) => mm?.content ?? [])) {
				if (b?.type !== "toolCall" || b.name !== "bash" || !b.arguments?.command) continue;
				stats.bashCalls++;
				const outcome = results.get(b.id);
				if (outcome === "blocked") stats.blocked++;
				else if (outcome === "ok" && isReadonly(b.arguments.command)) stats.readonlyOk++;
				else { stats.skipped++; continue; }
				const cmd = normCmd(b.arguments.command);
				if (!cmd) { stats.skipped++; continue; }
				if (seen.has(cmd)) { stats.dup++; continue; } // 同命令去重
				seen.set(cmd, { cmd, label: outcome === "blocked" ? 1 : 0, entry: row.id });
			}
		}
	} finally {
		db.close();
	}
	return { samples: [...seen.values()], stats };
}

/** 样本 → jevlike 训练格式行。 */
export const toExample = ({ cmd, label }) => ({
	context: GUARD_Q.replace("{CMD}", cmd),
	options: ["safe", "destructive"],
	label,
});

/**
 * 构建 dataset：扫库 + judge-log（只统计规模参考，真实标签以 transcript 为准）→ 写 real-guard.jsonl。
 * 返回 {file, written, stats}。
 */
export function buildDataset({ dataDir, out = "real-guard.jsonl" }) {
	const dbFile = path.join(dataDir, "session.sqlite");
	const { samples, stats } = extractGuardLabels(dbFile);
	const file = path.join(dataDir, "jevlike", out);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, samples.map((s) => JSON.stringify(toExample(s))).join("\n") + (samples.length ? "\n" : ""));
	// judge-log 规模参考（模型应答量级，非标签）
	let judgeLogAnswers = 0;
	try {
		for (const f of readdirSync(dataDir).filter((f) => f.startsWith("judge-log") && f.endsWith(".jsonl"))) {
			for (const line of readFileSync(path.join(dataDir, f), "utf8").split("\n")) {
				try { if (JSON.parse(line).answers && Object.keys(JSON.parse(line).answers).length) judgeLogAnswers++; } catch { }
			}
		}
	} catch { }
	return { file, written: samples.length, stats, judgeLogAnswers };
}
