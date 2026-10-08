// Single-writer lock for the pi-durable host.
//
// pi-durable storage has no cross-process locking: one storage may only be
// opened by one process at a time. This lockfile enforces that discipline for
// the host, tolerating stale locks left behind by a killed process: the PID is
// stored in the file, and a lock whose holder is no longer alive is taken over.
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM"; // alive but owned by another user
	}
}

function readPid(lockPath) {
	try {
		const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
		return Number.isInteger(pid) ? pid : NaN;
	} catch {
		return NaN;
	}
}

export { readPid };

/**
 * Acquire the host lock. Throws when another live process holds it.
 * Takes over a stale lock whose holder process no longer exists.
 * With waitMs > 0, a live foreign holder is retried until the deadline — that is
 * how a restarted daemon (POST /api/restart) takes over from its predecessor:
 * the successor starts first, then waits for the old process to exit.
 */
export async function acquireLock(lockPath, { label = "pi-durable host", waitMs = 0 } = {}) {
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			return acquireLockNow(lockPath, { label });
		} catch (err) {
			if (waitMs <= 0 || Date.now() >= deadline || !String(err?.message ?? "").includes("正在运行")) throw err;
			await new Promise((r) => setTimeout(r, 250));
		}
	}
}

function acquireLockNow(lockPath, { label }) {
	if (existsSync(lockPath)) {
		const pid = readPid(lockPath);
		if (Number.isInteger(pid) && pid !== process.pid && isAlive(pid)) {
			throw new Error(
				`另一个 ${label} 进程 (pid ${pid}) 正在运行，持有锁 ${lockPath}。\n` +
					"同一存储同一时刻只能被一个进程打开。\n" +
					`请先停止该进程；若它是 host.js serve，请直接使用它的 HTTP 接口。`,
			);
		}
		// Stale lock: holder dead or unreadable file. Take over.
		try {
			unlinkSync(lockPath);
		} catch {}
	}
	try {
		const fd = openSync(lockPath, "wx");
		try {
			writeSync(fd, String(process.pid));
		} finally {
			closeSync(fd);
		}
	} catch (err) {
		if (err.code === "EEXIST") {
			// Raced with another process; re-run once to resolve via the PID check.
			return acquireLockNow(lockPath, { label });
		}
		throw err;
	}
	return lockPath;
}

/** Release the lock, but only if this process still owns it. */
export function releaseLock(lockPath) {
	if (readPid(lockPath) === process.pid) {
		try {
			unlinkSync(lockPath);
		} catch {}
	}
}
