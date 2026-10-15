// jevlike 网关 sidecar（issue #110）：本机无 systemd（WSL2 init），网关进程由 daemon 托管生命周期。
// 语义（#113 面板实测补强：探活瞬断 ≠ 上一代已死；复用/换代都要求代际 pid 存活）：
//   探测 judge url：在位 且 代际 pid 存活 且 配置一致 → 复用（daemon 重启无间隙）；
//   在位但服务方不是记录的子进程（无记录/记录 pid 已死）→ 不越权接管，提示人工处理；
//   在位但配置已变，或探活失败但代际 pid 存活（瞬断/卡 9p）→ 先停旧（SIGTERM，8s 未收场升级
//   SIGKILL；cmdline 核对防误杀，Linux 读 /proc、macOS/BSD 走 ps）再拉新；
//   运行中由 server.js 每 60s 再调本函数自愈（网关崩溃自动复活）；
//   daemon 停止不杀网关——无状态服务，留给下一个 daemon 复用。
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { recordTiming } from "./jev-timing.js";

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

function logPathOf(dataDir) {
	return path.join(dataDir, "jevlike", "gateway.log");
}

/**
 * jevlike 网关运行态快照（UI 侧栏数据源，issue #113）：探测在位 + 代际记录 + 日志尾 + ckpt 清单。
 * 纯读操作：不改任何状态，网关不在位也照常返回（alive=false 由 UI 授徽）。
 */
export async function readGatewayStatus({ url, sidecar, dataDir, probeTimeoutMs = 900, logTail = 12 }) {
	const jevDir = path.join(dataDir, "jevlike");
	let gen = null;
	try {
		gen = JSON.parse(readFileSync(genPath(dataDir), "utf8"));
	} catch {}
	const alive = url ? await probeGateway(url, probeTimeoutMs) : false;
	let log = [];
	try {
		const all = readFileSync(logPathOf(dataDir), "utf8").trim().split("\n").filter(Boolean);
		// 日志跨代累积：只取当前代（最后一条「拉起网关」标记行起算），旧代崩溃栈不惊扰当前状态
		let lastSpawn = -1;
		for (let i = all.length - 1; i >= 0; i--) if (all[i].includes("拉起网关")) { lastSpawn = i; break; }
		log = (lastSpawn >= 0 ? all.slice(lastSpawn) : all).slice(-logTail);
	} catch {}
	let ckpts = [];
	try {
		ckpts = readdirSync(jevDir)
			.filter((f) => f.endsWith(".pt"))
			.map((f) => {
				const s = statSync(path.join(jevDir, f));
				return { file: f, bytes: s.size, mtime: s.mtime.toISOString() };
			})
			.sort((a, b) => b.mtime.localeCompare(a.mtime));
	} catch {}
	return {
		configured: Boolean(sidecar?.command && url),
		url: url ?? null,
		alive,
		managed: Boolean(gen?.pid && pidAlive(gen.pid)),
		gen,
		log,
		ckpts,
	};
}

function argsHash(args) {
	return createHash("sha256").update(JSON.stringify(args ?? [])).digest("hex").slice(0, 12);
}

/** 停掉上一代网关（pid 来自 gateway.json；核对 /proc cmdline 与代际记录的脚本名，防 pid 复用误杀）。 */
function pidAlive(pid) {
	if (!pid) return false;
	try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * 读进程命令行（代际身份校验：确认 pid 还是我们的网关，防 pid 复用误杀）。
 * 跨平台：Linux 读 /proc；无 /proc 的平台（macOS/BSD）用 ps -o command=。
 * 都拿不到时返回 undefined——校验不可得时保守直停（代际记录+pid 存活已是双重门槛）。
 */
function pidCommand(pid) {
	try {
		const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8"); // 仅 Linux 存在
		if (cmdline) return cmdline.replace(/\0/g, " ");
	} catch {}
	try {
		const { status, stdout } = spawnSync("ps", ["-p", String(pid), "-o", "command="], { timeout: 2000 });
		if (status === 0) return stdout.toString().trim() || undefined;
	} catch {}
	return undefined;
}

function killPrevious(dataDir, log, { escalate = false } = {}) {
	try {
		const gen = JSON.parse(readFileSync(genPath(dataDir), "utf8"));
		if (!gen.pid) return;
		try {
			// 代际身份校验：pid 可能已被系统复用，只杀仍像我们网关的。
			// /proc 仅 Linux——macOS 上曾因读取 throw 直入 catch，换代永远杀不掉旧网关（EADDRINUSE，issue #119）。
			const cmdline = pidCommand(gen.pid);
			if (gen.script && cmdline !== undefined && !cmdline.includes(gen.script)) return;
			process.kill(gen.pid, escalate ? "SIGKILL" : "SIGTERM");
			log(`[sidecar] 上一代网关（pid ${gen.pid}）已${escalate ? "SIGKILL 强杀" : "停止"}${cmdline === undefined ? "（身份校验不可得，凭代际记录直停）" : ""}，等待端口释放…`);
		} catch (err) {
			log(`[sidecar] 停止上一代网关（pid ${gen.pid}）失败：${err?.message ?? err}`);
		}
	} catch { /* 无代际记录 */ }
}

/**
 * 确保 judge 网关在位。返回 null（未配置）| {reused:true, pid} | {child}（可能带 exited/failed 标记）。
 * 复用判定：端口健康 且 gateway.json 的 argsHash 与当前配置一致（不一致 → 换代重拉）。
 */
export async function ensureJudgeSidecar({ url, sidecar, dataDir, log = console.error, quiet = false }) {
	if (!sidecar?.command || !url) return null;
	const probeTimeoutMs = sidecar.probeTimeoutMs ?? 700;
	const probe0 = Date.now();
	const alive = await probeGateway(url, probeTimeoutMs);
	// 计时自适应（issue #124）：稳态探活慢尾只在首个探测上采样——这是复用/自愈路径打在
	// 健康网关上的探测；换代等待期的探测打在垂死进程上，采了会污染延迟分布。
	if (alive && Date.now() - probe0 > 250) recordTiming(dataDir, { kind: "probe-slow", ms: Date.now() - probe0 });
	let gen = null;
	try { gen = JSON.parse(readFileSync(genPath(dataDir), "utf8")); } catch { }
	const genOurs = Boolean(gen?.pid && pidAlive(gen.pid));
	if (alive && genOurs && gen.argsHash === argsHash(sidecar.args)) {
		if (!quiet) log(`[sidecar] judge 网关已在位（pid ${gen.pid}，配置一致），复用`);
		return { reused: true, pid: gen.pid };
	}
	if (alive && !genOurs) {
		// 端口活着但服务方不是我们记录的子进程（无记录/记录 pid 已死）——不杀不知来路的进程，提示人工处置
		if (!quiet) log("[sidecar] 端口已被占用（非 daemon 拉起的网关或代际记录已失效），本次不接管；如需切换请先手动停掉旧网关");
		return { reused: true, unmanaged: true };
	}
	if (genOurs) {
		// 到这里：探活失败但上一代还活着（瞬断≠死亡，#113 实测盲拉撞 EADDRINUSE），或配置换代——都必须先停旧
		killPrevious(dataDir, log);
		// WSL2 /mnt/d（9p）上 python 收 SIGTERM 后退出可达 3s+，等短了会撞 EADDRINUSE（实测 #110）。
		// 等待上限可配（host.json judge.sidecar.killWaitMs），实测样本回写 timing.jsonl 供调参（#124）。
		const killWaitMs = sidecar.killWaitMs ?? 8000;
		const t0 = Date.now();
		for (let t = 0; t < killWaitMs && (await probeGateway(url, probeTimeoutMs)); t += 300) await sleep(300);
		if (!(await probeGateway(url, probeTimeoutMs))) {
			recordTiming(dataDir, { kind: "kill", ms: Date.now() - t0 });
		} else {
			// SIGTERM 未生效（如 python 卡在 9p IO、或网关自装 TERM 处理器）：SIGKILL 兜底，否则换代必撞 EADDRINUSE
			killPrevious(dataDir, log, { escalate: true });
			const escalateWaitMs = sidecar.escalateWaitMs ?? 2000;
			const e0 = Date.now();
			for (let t = 0; t < escalateWaitMs && (await probeGateway(url, probeTimeoutMs)); t += 300) await sleep(300);
			if (!(await probeGateway(url, probeTimeoutMs))) {
				recordTiming(dataDir, { kind: "escalate", ms: Date.now() - e0 });
			} else {
				recordTiming(dataDir, { kind: "kill-stuck", ms: Date.now() - t0 });
				log(`[sidecar] 上代网关停止超时（SIGTERM+SIGKILL 共 ${Math.round((Date.now() - t0) / 1000)}s 仍未释放端口），继续换代有撞 EADDRINUSE 风险`);
			}
		}
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
	const spawnAt = Date.now();
	for (let t = 250; t <= readyMs; t += 250) {
		await sleep(250);
		if (failed) return { child, failed: true };
		if (child.exitCode !== null) {
			log(`[sidecar] 网关进程退出（code ${child.exitCode}），详见 ${logPath}`);
			return { child, exited: true };
		}
		if (await probeGateway(url, probeTimeoutMs)) {
			recordTiming(dataDir, { kind: "ready", ms: Date.now() - spawnAt });
			return { child };
		}
	}
	recordTiming(dataDir, { kind: "not-ready", ms: readyMs });
	log(`[sidecar] 网关 ${Math.round(readyMs / 1000)}s 内未就绪（judge 暂走缺席降级，自愈探测稍后重试）`);
	return { child };
}
