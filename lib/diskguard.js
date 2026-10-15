// 磁盘水位守卫（issue #127）：host 写的 append-only 日志全部有封口，
// 但「长驻不重启 + 崩溃栈狂刷」仍可能让单代超限——定时扫补刀；
// 并对文件系统剩余空间做水位告警（host 自身只占 17MB 量级，
// 真正的风险是宿主盘被别的东西写满，host 应当喊出来而不是闷声死）。
import { readdirSync, renameSync, statSync, statfsSync, unlinkSync } from "node:fs";
import path from "node:path";

const GB = 1024 ** 3;

/** 单文件轮转（超过 maxBytes 换 .1 代，只保一代——调用方负责重复调用的幂等性）。 */
export function rotateCap(file, maxBytes = 1024 * 1024) {
	try {
		if (statSync(file).size < maxBytes) return false;
	} catch {
		return false; // 不存在
	}
	try {
		try { unlinkSync(`${file}.1`); } catch { }
		renameSync(file, `${file}.1`);
		return true;
	} catch {
		return false;
	}
}

/**
 * 磁盘守卫：封口 dataDir 下的已知 append-only 日志 + 文件系统水位。
 * 返回 { freeBytes, level, rotated }；level: ok | warn | alarm。
 * 阈值默认：warn 10GB、alarm 1GB（host 日志总量撑死几十 MB，
 * alarm 的语义是「盘要满了，先喊，别等 sqlite 写坏」）。
 */
export function diskGuard(dataDir, {
	logFiles = ["serve.log", "tool-timing.log", "jevlike/gateway.log", "jevlike/timing.jsonl"],
	maxBytes = 1024 * 1024,
	warnFreeBytes = 10 * GB,
	alarmFreeBytes = 1 * GB,
} = {}) {
	const rotated = [];
	for (const rel of logFiles) {
		if (rotateCap(path.join(dataDir, rel), maxBytes)) rotated.push(rel);
	}
	let freeBytes = null;
	let level = "ok";
	try {
		freeBytes = statfsSync(dataDir).bavail * statfsSync(dataDir).bsize;
		if (freeBytes < alarmFreeBytes) level = "alarm";
		else if (freeBytes < warnFreeBytes) level = "warn";
	} catch { } // statfs 不可得（如某些挂载）→ 不告警也不报错
	return { freeBytes, level, rotated };
}
