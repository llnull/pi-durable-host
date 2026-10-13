// Approval allowlist + pending-blocked list, shared by the CLI (host.js), the
// daemon (lib/server.js) and the guard hook (lib/extensions.js).
//
//   data/approvals.json          commands the user has approved; the guard
//                                re-reads it on every call, so approvals from
//                                any process take effect on the next tool run.
//   data/approvals-pending.json  dangerous commands the guard blocked, shown
//                                in the web UI for one-click approval.
//
// Writes are tmp-file + rename (atomic for readers); files stay tiny. The
// daemon is the only pending writer during a run, and the CLI is the only
// approvals writer a human drives, so last-write-wins is fine here.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const PENDING_CAP = 100;

function readJsonArray(file) {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return Array.isArray(parsed?.items) ? parsed.items : [];
	} catch {
		return [];
	}
}

function writeJsonArray(file, items) {
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify({ items }, null, "\t")}\n`);
	renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// approved
// ---------------------------------------------------------------------------

export function readApprovals(file) {
	return readJsonArray(file);
}

/** An entry ending in "*" approves every command with that prefix. Pure; no file access. */
export function matchesApproval(approved, command) {
	const needle = String(command ?? "").trim();
	const pattern = String(approved ?? "").trim();
	if (!pattern) return false;
	return pattern.endsWith("*") ? needle.startsWith(pattern.slice(0, -1)) : needle === pattern;
}

export function isApproved(file, command) {
	return readApprovals(file).some((item) => matchesApproval(item?.command, command));
}

export function approveCommand(file, command) {
	const items = readApprovals(file);
	if (items.some((item) => item.command === command)) return { added: false, items };
	items.push({ command, addedAt: new Date().toISOString() });
	writeJsonArray(file, items);
	clearPending(pendingFileOf(file), command);
	return { added: true, items };
}

export function revokeApprovalAt(file, index) {
	const items = readApprovals(file);
	if (!Number.isInteger(index) || index < 1 || index > items.length) return undefined;
	const [removed] = items.splice(index - 1, 1);
	writeJsonArray(file, items);
	return removed;
}

/**
 * 清空已批准清单（issue #106）：一次性命令的精确匹配永不再命中，留着只是堆积。
 * 不归档：命令执行在 transcript、审批动作在 judge-log/serve.log 各有完整留痕，
 * 这里再存一份是冗余（囤积或留存器式的"以防万一"正是当初堆积的病因）。
 */
export function clearApprovals(file) {
	const count = readApprovals(file).length;
	if (count === 0) return { archived: 0 };
	writeJsonArray(file, []);
	return { archived: count };
}

// ---------------------------------------------------------------------------
// pending (blocked by the guard, awaiting a human)
// ---------------------------------------------------------------------------

/** Convention: pending lives next to the approvals file. */
export function pendingFileOf(approvalsFile) {
	return approvalsFile.replace(/\.json$/, "") + "-pending.json";
}

export function readPending(file) {
	return readJsonArray(file);
}

export function addPending(file, { command, why }) {
	if (!command) return;
	const items = readPending(file).filter((item) => item.command !== command);
	items.push({ command, why, blockedAt: new Date().toISOString() });
	writeJsonArray(file, items.slice(-PENDING_CAP));
}

export function clearPending(file, command) {
	if (!existsSync(file)) return;
	const items = readPending(file);
	if (!items.some((item) => item.command === command)) return;
	writeJsonArray(file, items.filter((item) => item.command !== command));
}
