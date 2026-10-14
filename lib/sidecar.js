// jevlike 网关 sidecar（issue #110）：本机无 systemd（WSL2 init），网关进程由 daemon 托管生命周期。
// 语义：
//   serve 启动 → 探测 judge url：健康且代际记录的配置一致 → 复用（daemon 重启无间隙）；
//   健康但无代际记录（手拉网关）→ 不越权接管，提示人工处理；
//   不健康或 sidecar 配置已变 → 停掉上一代（pid 记录于代际文件，核对 /proc cmdline 防误杀）、拉起新进程；
//   运行中由 server.js 每 60s 再调本函数自愈（网关崩溃自动复活）；
//   daemon 停止不杀网关——无状态服务，留给下一个 daemon 复用。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 网关存活探测：任何 HTTP 应答都算在位（404 也算——端口被占就不该重复拉起）。 */
export async function probeGateway(baseUrl, timeoutMs = 700) {
	try {
		const base = String(baseUrl ?? "").replace(/\/$/, "");
		await fetch(base.endsWith("/v1/systemone") ? base : `${base}/v1/systemone`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
			signal: AbortSignal.timeout(timeoutMs),
		});
		return true;
	} catch {
		return false;
	}
}

function genPath(dataDir) {
	return path.join(dataDir, "jevlike", "gateway.json");
}

function argsHash(args) {
	return createHash("sha256").update(JSON.stringify(args ?? [])).digest("hex").slice(0, 12);
}

/** 停掉上一代网关（pid 来自 gateway.json；核对 /proc cmdline 与代际记录的脚本名，防 pid 复用误杀）。 */
function killPrevious(dataDir, log) {
	try {
		const gen = JSON.parse(readFileSync(genPath(dataDir), "utf8"));
		if (!gen.pid) return;
		try {
			const cmdline = readFileSync(`/proc/${gen.pid}/cmdline`, "utf8");
			if (gen.script && !cmdline.includes(gen.script)) return;
			process.kill(gen.pid, "SIGTERM");
			log(`[sidecar] 上一代网关（pid ${gen.pid}，配置已变更）已停止，等待端口释放…`);
		} catch { /* 进程已不在 */ }
	} catch { /* 无代际记录 */ }
}

/**
 * 确保 judge 网关在位。返回 null（未配置）| {reused:true, pid} | {child}（可能带 exited/failed 标记）。
 * 复用判定：端口健康 且 gateway.json 的 argsHash 与当前配置一致（不一致 → 换代重拉）。
 */
export async function ensureJudgeSidecar({ url, sidecar, dataDir, log = console.error, quiet = false }) {
	if (!sidecar?.command || !url) return null;
	if (await probeGateway(url)) {
		let gen = null;
		try { gen = JSON.parse(readFileSync(genPath(dataDir), "utf8")); } catch { }
		if (gen?.argsHash === argsHash(sidecar.args)) {
			if (!quiet) log(`[sidecar] judge 网关已在位（pid ${gen.pid ?? "?"}，配置一致），复用`);
			return { reused: true, pid: gen?.pid };
		}
		if (!gen?.pid) {
			// 端口活着但不是 daemon 拉的（无代际记录）——不越权杀非己所生，提示人工处理
			if (!quiet) log("[sidecar] 端口已被占用（非 daemon 拉起的网关，无代际记录），本次不接管；如需切换请先手动停掉旧网关");
			return { reused: true, unmanaged: true };
		}
		killPrevious(dataDir, log);
		// WSL2 /mnt/d（9p）上 python 收 SIGTERM 后退出可达 3s+，等短了会撞 EADDRINUSE（实测 #110）
		for (let t = 0; t < 8000 && (await probeGateway(url)); t += 300) await sleep(300);
	}
	const logPath = sidecar.log ?? path.join(dataDir, "jevlike", "gateway.log");
	mkdirSync(path.dirname(logPath), { recursive: true });
	appendFileSync(logPath, `\n[sidecar] ${new Date().toISOString()} daemon(pid ${process.pid}) 拉起网关\n`);
	const fd = openSync(logPath, "a");
	let failed = false;
	const child = spawn(sidecar.command, sidecar.args ?? [], { stdio: ["ignore", fd, fd], env: process.env });
	closeSync(fd);
	child.unref?.(); // daemon 不应被网关句柄钉住（长期驻留进程，自然退出时也不等它）
	child.on("error", (err) => {
		failed = true;
		log(`[sidecar] 网关进程异常: ${err.message}`);
	});
	mkdirSync(path.dirname(genPath(dataDir)), { recursive: true });
	writeFileSync(genPath(dataDir), JSON.stringify({
		pid: child.pid,
		argsHash: argsHash(sidecar.args),
		script: path.basename(sidecar.args?.[0] ?? ""),
		startedAt: new Date().toISOString(),
		command: sidecar.command,
	}));
	log(`[sidecar] 已拉起 judge 网关 pid ${child.pid}（日志 ${logPath}）`);
	const readyMs = sidecar.readyMs ?? 8000;
	for (let t = 250; t <= readyMs; t += 250) {
		await sleep(250);
		if (failed) return { child, failed: true };
		if (child.exitCode !== null) {
			log(`[sidecar] 网关进程退出（code ${child.exitCode}），详见 ${logPath}`);
			return { child, exited: true };
		}
		if (await probeGateway(url)) return { child };
	}
	log(`[sidecar] 网关 ${Math.round(readyMs / 1000)}s 内未就绪（judge 暂走缺席降级，自愈探测稍后重试）`);
	return { child };
}
