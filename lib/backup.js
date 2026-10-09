// Consistent SQLite snapshot via `VACUUM INTO` on a second connection.
//
// WAL mode allows concurrent readers while the storage connection writes, and
// VACUUM INTO copies a read-transaction snapshot — so a backup taken by the
// daemon is consistent without pausing any run. Retention: keep the newest N.
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const KEEP = 20;

export function backupDirOf(dataFile) {
	return path.join(path.dirname(dataFile), "backups");
}

/**
 * Snapshot `dataFile` into `target` (default data/backups/session-<ts>.sqlite)
 * and prune old backups. Returns the written file path.
 */
export function backupStorageFile(dataFile, target, { keep = KEEP } = {}) {
	if (!existsSync(dataFile)) throw new Error(`存储不存在：${dataFile}`);
	const dir = backupDirOf(dataFile);
	mkdirSync(dir, { recursive: true });
	const file = target
		? path.resolve(target)
		: path.join(dir, `session-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
	if (existsSync(file)) throw new Error(`备份文件已存在：${file}`);
	const db = new DatabaseSync(dataFile);
	try {
		db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
	} finally {
		db.close();
	}
	const prefix = path.basename(dataFile, ".sqlite");
	const olds = readdirSync(dir)
		.filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".sqlite"))
		.map((name) => ({ name, mtime: statSync(path.join(dir, name)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime)
		.slice(keep);
	for (const old of olds) {
		try {
			unlinkSync(path.join(dir, old.name));
		} catch {}
	}
	return file;
}

/** Rotate a log file when it exceeds maxBytes (keeps one .1 generation). */
export function rotateLog(file, maxBytes = 1024 * 1024) {
	try {
		const stat = statSync(file);
		if (stat.size < maxBytes) return false;
		renameSync(file, `${file}.1`);
		return true;
	} catch {
		return false;
	}
}
