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

/**
 * Acquire the host lock. Throws when another live process holds it.
 * Takes over a stale lock whose holder process no longer exists.
 */
export function acquireLock(lockPath, { label = "pi-durable host" } = {}) {
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
			return acquireLock(lockPath, { label });
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
