// 系统事件（pi-durable 1.4+ 的 onReport）：不影响调用方成功的失败——抛错的钩子/监听器、故障的任务、
// 被重启上限终止的任务、迁移失败，以及最终让 Session 失败的存储错误。此前这些在 host 里完全不可见。
//
// 记录去两处：内存环（最近 100 条，/api/reports + SSE "report"，daemon 重启清零）与 judge-log.jsonl
// （type:"report"，全量留痕）。记录失败绝不反过来影响 onReport 的调用方（Harness 对抛错的 onReport 只丢弃）。
import { appendFileSync } from "node:fs";

const CAP = 100;

/** 报告类别 → 严重度与中文标签（pi-durable ReportInfo 的 kind）。 */
export const REPORT_KINDS = {
	storage_failed: { severity: "critical", label: "存储失败" },
	task_faulted: { severity: "error", label: "任务故障" },
	task_interrupted: { severity: "error", label: "任务被重启中断" },
	migration_failed: { severity: "error", label: "任务迁移失败" },
	task_outdated: { severity: "warn", label: "任务无法接续" },
	task_error: { severity: "warn", label: "任务错误" },
	extension_error: { severity: "warn", label: "扩展错误" },
	host_error: { severity: "warn", label: "宿主回调错误" },
	listener_error: { severity: "warn", label: "监听器错误" },
};

/** 一行可审计、可下发的记录（纯函数）：Report → 扁平 JSON，错误信息截断、堆栈单独留档。 */
export function formatReport(report, at = new Date().toISOString()) {
	const kind = report?.kind ?? "unknown";
	const meta = REPORT_KINDS[kind] ?? { severity: "warn", label: kind };
	const err = report?.error;
	const message = err instanceof Error ? err.message : typeof err === "string" ? err : err !== undefined && err !== null ? JSON.stringify(err) : "";
	const rec = { at, type: "report", kind, severity: meta.severity, label: meta.label, message: String(message ?? "").slice(0, 500) };
	if (report?.task) rec.task = { id: report.task.id, kind: report.task.kind, conversationId: report.task.conversationId };
	for (const key of ["extension", "callback", "reason", "restarts", "conversationId"]) {
		if (report?.[key] !== undefined) rec[key] = report[key];
	}
	if (err instanceof Error && err.stack) rec.stack = String(err.stack).slice(0, 2000);
	return rec;
}

/** /api/status 用的摘要：条数与最近一条（没有则不带）。 */
export function summarizeReports(log) {
	return { since: log.since, count: log.items.length, last: log.items[0] ?? null };
}

/**
 * onReport 记录器。logFile 可省（测试）；sink.broadcast 由 server 启动后注入（与 screen 的 sink 同一模式）。
 */
export function createReportLog({ logFile, cap = CAP, onError = () => {} } = {}) {
	const items = [];
	const since = new Date().toISOString();
	const sink = {};
	const onReport = (report) => {
		try {
			const rec = formatReport(report);
			items.unshift(rec);
			if (items.length > cap) items.pop();
			if (logFile) appendFileSync(logFile, JSON.stringify(rec) + "\n");
			sink.broadcast?.("report", rec);
			const where = [rec.task ? `task#${rec.task.id} ${rec.task.kind}` : "", rec.extension ? `ext=${rec.extension}` : "", rec.callback ? `callback=${rec.callback}` : "", rec.reason ? `reason=${rec.reason}` : ""].filter(Boolean).join(" ");
			console.error(`[report] ${rec.severity} ${rec.kind}（${rec.label}）${where ? " " + where : ""}: ${rec.message}`);
		} catch (e) {
			onError(e);
		}
	};
	return { onReport, items, since, sink, snapshot: () => items.slice() };
}
