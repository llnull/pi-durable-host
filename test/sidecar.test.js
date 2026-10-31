// lib/sidecar.js 单测（issue #110）：探测、复用、拉起、换代、不越权接管。
// 约定：所有拉起的子进程登记进 spawned、临时目录登记进 dataDirs，
// after() 里统一 SIGKILL 并等 exit——活子进程的 uv 句柄会钉住测试文件的
// 事件循环（首版孤儿 fixture 让整个文件挂满 60s，教训记录在此）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { ensureJudgeSidecar, probeGateway } from "../lib/sidecar.js";

const spawned = [];
const dataDirs = [];

after(async () => {
	for (const child of spawned) {
		if (child.exitCode === null) {
			try { child.kill("SIGKILL"); } catch { }
		}
	}
	await Promise.all(spawned.map((child) => child.exitCode !== null
		? Promise.resolve()
		: once(child, "exit").then(() => { }, () => { })));
	for (const dir of dataDirs) {
		try { rmSync(dir, { recursive: true, force: true }); } catch { }
	}
});

function tmpData() {
	const dir = mkdtempSync(path.join(tmpdir(), "sidecar-test-"));
	dataDirs.push(dir);
	return dir;
}

async function freePort() {
	return await new Promise((resolve, reject) => {
		const srv = http.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = srv.address().port;
			srv.close(() => resolve(port));
		});
		srv.once("error", reject);
	});
}

/** 独立进程版假网关（供 spawn 拉起测试）：127.0.0.1:port 上对任何请求回 200。 */
function writeFixture(dataDir, port) {
	const file = path.join(dataDir, "fixture-gateway.mjs");
	writeFileSync(file, `import http from "node:http";
http.createServer((req, res) => { res.writeHead(200); res.end("{}"); }).listen(${port}, "127.0.0.1");
`);
	return file;
}

test("ensureJudgeSidecar：未配置 sidecar 或无 judge url → 不作为", async () => {
	assert.equal(await ensureJudgeSidecar({ url: "http://127.0.0.1:1", dataDir: tmpData(), sidecar: undefined }), null);
	assert.equal(await ensureJudgeSidecar({ url: undefined, dataDir: tmpData(), sidecar: { command: "/bin/true" } }), null);
	assert.equal(await ensureJudgeSidecar({ url: "http://127.0.0.1:1", dataDir: tmpData(), sidecar: {} }), null);
});

test("ensureJudgeSidecar：命令立即退出 → exited 标记，不误报就绪", async () => {
	const dataDir = tmpData();
	const handle = await ensureJudgeSidecar({
		url: "http://127.0.0.1:1",
		dataDir,
		sidecar: { command: process.execPath, args: ["-e", "process.exit(1)"] },
	});
	spawned.push(handle?.child);
	assert.ok(handle?.child, "应返回子进程句柄");
	assert.equal(handle.exited, true, "立即退出的命令应带 exited 标记");
	assert.equal(await probeGateway("http://127.0.0.1:1"), false, "死端口不应有假网关");
});

test("ensureJudgeSidecar：死端口 → 拉起 → 配置一致则复用同一 pid", async () => {
	const port = await freePort();
	const dataDir = tmpData();
	const fixture = writeFixture(dataDir, port);
	const sidecar = { command: process.execPath, args: [fixture] };
	const first = await ensureJudgeSidecar({ url: `http://127.0.0.1:${port}`, dataDir, sidecar });
	spawned.push(first?.child);
	assert.ok(first?.child, "应拉起子进程");
	assert.ok(!first.exited && !first.failed, `子进程应存活在位（${JSON.stringify(first)}）`);
	assert.equal(await probeGateway(`http://127.0.0.1:${port}`), true, "fixture 网关应就绪");
	const second = await ensureJudgeSidecar({ url: `http://127.0.0.1:${port}`, dataDir, sidecar });
	assert.equal(second?.reused, true, "健康且配置一致应复用");
	assert.equal(second.pid, first.child.pid, "复用的是同一个 pid");
});

test("ensureJudgeSidecar：端口被无代际记录的进程占用 → 不越权接管", async () => {
	const port = await freePort();
	const server = http.createServer((req, res) => {
		res.writeHead(200);
		res.end("{}");
	});
	await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
	try {
		const handle = await ensureJudgeSidecar({
			url: `http://127.0.0.1:${port}`,
			dataDir: tmpData(),
			sidecar: { command: process.execPath, args: ["-e", ""] },
		});
		assert.equal(handle?.unmanaged, true, "无代际记录应标记 unmanaged");
		assert.ok(!handle.child, "不应拉起新进程");
	} finally {
		server.close();
		await once(server, "close");
	}
});

/** 挂死型假网关：监听但永不应答（进程活着、探活超时——误判重启事故的复现形状）。 */
function writeStallFixture(dataDir, port) {
	const file = path.join(dataDir, "fixture-stall-gateway.mjs");
	writeFileSync(file, `import http from "node:http";
http.createServer((req, res) => { /* 永不应答 */ }).listen(${port}, "127.0.0.1");
`);
	return file;
}

test("ensureJudgeSidecar：探活未过但进程在 → 连续 N 次才判死换血（issue #147 回归）", async () => {
	const port = await freePort();
	const dataDir = tmpData();
	const fixture = writeStallFixture(dataDir, port);
	const sidecar = { command: process.execPath, args: [fixture], probeTimeoutMs: 150, readyMs: 1000, missesBeforeRestart: 3 };
	const first = await ensureJudgeSidecar({ url: `http://127.0.0.1:${port}`, dataDir, sidecar });
	spawned.push(first?.child);
	assert.ok(first?.child, "应拉起子进程");
	assert.ok(first?.child.exitCode === null, "挂死型网关进程应活着");
	const pid = first.child.pid;
	// 探活持续超时（进程在、不应答）：前 threshold-1 次都应暂不换血
	for (let i = 1; i < 3; i++) {
		const r = await ensureJudgeSidecar({ url: `http://127.0.0.1:${port}`, dataDir, sidecar });
		assert.equal(r?.stalling, true, `第 ${i} 次未过应标记 stalling 暂不换血`);
		assert.equal(r.pid, pid, "stalling 期间不换 pid");
		const gen = JSON.parse(readFileSync(path.join(dataDir, "jevlike", "gateway.json"), "utf8"));
		assert.equal(gen.misses, i, "misses 应累加");
	}
	// 第 threshold 次判死换血
	const fourth = await ensureJudgeSidecar({ url: `http://127.0.0.1:${port}`, dataDir, sidecar });
	spawned.push(fourth?.child);
	assert.ok(fourth?.child, "连续未过达阈值应换血拉新");
	assert.notEqual(fourth.child.pid, pid, "换血后是新 pid");
	await Promise.race([once(first.child, "exit"), new Promise((r) => setTimeout(r, 3000))]);
	// 信号致死：exitCode 为 null、signal 非空（首版断言只看 exitCode 误判未死）
	assert.ok(first.child.exitCode !== null || first.child.signal !== null, "旧网关应被停止");
});

test("ensureJudgeSidecar：配置换代 → 停旧拉新", async () => {
	const port = await freePort();
	const dataDir = tmpData();
	const fixture = writeFixture(dataDir, port);
	const first = await ensureJudgeSidecar({
		url: `http://127.0.0.1:${port}`,
		dataDir,
		sidecar: { command: process.execPath, args: [fixture] },
	});
	assert.ok(first?.child, "第一代应拉起");
	spawned.push(first.child);
	const second = await ensureJudgeSidecar({
		url: `http://127.0.0.1:${port}`,
		dataDir,
		sidecar: { command: process.execPath, args: [fixture, "gen2"] },
	});
	spawned.push(second?.child);
	assert.ok(second?.child, "换代应拉起新进程");
	assert.notEqual(second.child.pid, first.child.pid, "应是新 pid");
	for (let t = 0; t < 2000 && first.child.exitCode === null && first.child.signalCode === null; t += 100) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.ok(first.child.exitCode !== null || first.child.signalCode, "旧进程应已被停止");
});

test("probeGateway：健康网关 true / 死端口 false", async () => {
	const port = await freePort();
	const server = http.createServer((req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end("{}");
	});
	await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
	try {
		assert.equal(await probeGateway(`http://127.0.0.1:${port}`), true);
	} finally {
		server.close();
		await once(server, "close");
	}
	assert.equal(await probeGateway(`http://127.0.0.1:${port}`), false);
});

// ---- readGatewayStatus（issue #113：UI 网关面板数据源）----
import { readGatewayStatus } from "../lib/sidecar.js";
import { mkdirSync } from "node:fs";

test("readGatewayStatus：空目录 → 全空快照，url 为空不探测", async () => {
	const dir = tmpData();
	const s = await readGatewayStatus({ url: null, sidecar: null, dataDir: dir });
	assert.equal(s.configured, false);
	assert.equal(s.alive, false);
	assert.equal(s.managed, false);
	assert.equal(s.gen, null);
	assert.deepEqual(s.log, []);
	assert.deepEqual(s.ckpts, []);
	assert.equal(s.url, null);
});

test("readGatewayStatus：装配代际记录/日志尾/ckpt 清单", async () => {
	const dir = tmpData();
	mkdirSync(path.join(dir, "jevlike"), { recursive: true });
	// managed 语义 = 代际 pid 存活（#113），fixture 用真活进程
	const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
	spawned.push(sleeper);
	const gen = { pid: sleeper.pid, argsHash: "abcd1234efgh", script: "server.py", startedAt: "2026-10-14T02:59:22.619Z", command: "python" };
	writeFileSync(path.join(dir, "jevlike", "gateway.json"), JSON.stringify(gen));
	writeFileSync(path.join(dir, "jevlike", "gateway.log"), ["行一", "行二", "行三", "行四", "行五"].join("\n"));
	writeFileSync(path.join(dir, "jevlike", "host-v8.pt"), Buffer.alloc(2048));
	const s = await readGatewayStatus({ url: "http://127.0.0.1:1", sidecar: { command: "python", args: ["server.py"] }, dataDir: dir, probeTimeoutMs: 120 });
	assert.equal(s.configured, true);
	assert.equal(s.managed, true);
	assert.equal(s.gen?.pid, sleeper.pid);
	assert.deepEqual(s.log, ["行一", "行二", "行三", "行四", "行五"]); // 尾 12 行 > 实际 5 行，全保留；截断逻辑由下个用例覆盖
	assert.equal(s.ckpts.length, 1);
	assert.equal(s.ckpts[0].file, "host-v8.pt");
	assert.equal(s.ckpts[0].bytes, 2048);
	assert.ok(s.ckpts[0].mtime);
	assert.equal(s.alive, false); // 端口 1 无服务，探测失败不算崩——快照如实报告
});

test("readGatewayStatus：logTail 截断 + 非法代际 JSON 不致命", async () => {
	const dir = tmpData();
	mkdirSync(path.join(dir, "jevlike"), { recursive: true });
	writeFileSync(path.join(dir, "jevlike", "gateway.json"), "{broken json");
	const lines = Array.from({ length: 20 }, (_, i) => `log-${i + 1}`);
	writeFileSync(path.join(dir, "jevlike", "gateway.log"), lines.join("\n"));
	const s = await readGatewayStatus({ url: null, sidecar: null, dataDir: dir, logTail: 3 });
	assert.equal(s.gen, null);
	assert.deepEqual(s.log, ["log-18", "log-19", "log-20"]);
	assert.equal(s.managed, false);
});

test("readGatewayStatus：日志尾只取当前代（从最后一条拉起标记起算）", async () => {
	const dir = tmpData();
	mkdirSync(path.join(dir, "jevlike"), { recursive: true });
	const lines = [
		"[sidecar] 2026-10-14T02:53:47.072Z daemon(pid 408) 拉起网关",
		"旧代崩溃栈 EADDRINUSE",
		"[sidecar] 2026-10-14T07:46:40.800Z daemon(pid 5460) 拉起网关",
		"当前代就绪",
	];
	writeFileSync(path.join(dir, "jevlike", "gateway.log"), lines.join("\n"));
	const s = await readGatewayStatus({ url: null, sidecar: null, dataDir: dir });
	assert.deepEqual(s.log, [lines[2], lines[3]]); // 旧代崩溃栈不惊扰当前状态
});


// ---- 换代健壮性（#113 面板实测暴露：代际 pid 已死 + SIGTERM 偶发未生效）----
test("ensureJudgeSidecar：代际 pid 已死而端口在位 → 降级 unmanaged，不越权接管", async () => {
	const port = await freePort();
	const dataDir = tmpData();
	const fixture = writeFixture(dataDir, port);
	const sidecar = { command: process.execPath, args: [fixture] };
	const first = await ensureJudgeSidecar({ url: `http://127.0.0.1:${port}`, dataDir, sidecar });
	spawned.push(first?.child);
	assert.ok(first?.child, "第一代应拉起");
	// 篡改代际记录：argsHash 保持一致（确保走到复用分支），pid 换成必不存在的
	const genFile = path.join(dataDir, "jevlike", "gateway.json");
	const gen = JSON.parse(readFileSync(genFile, "utf8"));
	writeFileSync(genFile, JSON.stringify({ ...gen, pid: 2147483646 }));
	const second = await ensureJudgeSidecar({ url: `http://127.0.0.1:${port}`, dataDir, sidecar });
	assert.equal(second?.unmanaged, true, "代际 pid 已死应降级 unmanaged");
	assert.ok(!second?.child, "不应拉起新进程");
	assert.equal(await probeGateway(`http://127.0.0.1:${port}`), true, "原网关不受干扰");
});

test("ensureJudgeSidecar：上一代拒收 SIGTERM → SIGKILL 升级，换代仍成功", async () => {
	const port = await freePort();
	const dataDir = tmpData();
	const stubborn = path.join(dataDir, "stubborn-gateway.mjs");
	writeFileSync(stubborn, `import http from "node:http";
process.on("SIGTERM", () => {}); // 拒收 SIGTERM（模拟 python 卡 9p / 自装 TERM 处理器）
http.createServer((req, res) => { res.writeHead(200); res.end("{}"); }).listen(${port}, "127.0.0.1");
`);
	const first = await ensureJudgeSidecar({
		url: `http://127.0.0.1:${port}`,
		dataDir,
		sidecar: { command: process.execPath, args: [stubborn] },
		readyMs: 4000,
	});
	assert.ok(first?.child, "第一代（拒收 TERM 的网关）应拉起");
	spawned.push(first.child);
	assert.equal(await probeGateway(`http://127.0.0.1:${port}`), true);
	const second = await ensureJudgeSidecar({
		url: `http://127.0.0.1:${port}`,
		dataDir,
		sidecar: { command: process.execPath, args: [stubborn, "gen2"] },
		readyMs: 4000,
	});
	spawned.push(second?.child);
	assert.ok(second?.child, "SIGKILL 升级后换代应拉起新进程");
	assert.notEqual(second.child.pid, first.child.pid, "应是新 pid");
	assert.ok(first.child.signalCode || first.child.exitCode !== null, "拒收 TERM 的旧进程应被 SIGKILL 收掉");
});

test("ensureJudgeSidecar：探活瞬断（上一代慢响应）→ 先停旧再拉新，不盲拉", async () => {
	// 复现 #113 事故：上一代活着但响应 >探活超时 → 旧代码直接盲拉，撞 EADDRINUSE
	const port = await freePort();
	const dataDir = tmpData();
	const slow = path.join(dataDir, "slow-gateway.mjs");
	writeFileSync(slow, `import http from "node:http";
http.createServer((req, res) => { setTimeout(() => { res.writeHead(200); res.end("{}"); }, 2000); }).listen(${port}, "127.0.0.1");
`);
	const first = await ensureJudgeSidecar({
		url: `http://127.0.0.1:${port}`,
		dataDir,
		sidecar: { command: process.execPath, args: [slow] },
		readyMs: 1500,
	});
	assert.ok(first?.child, "第一代（慢响应网关）应拉起");
	spawned.push(first.child);
	assert.equal(first.child.exitCode, null, "第一代应存活（就绪探测超时≠死亡）");
	const second = await ensureJudgeSidecar({
		url: `http://127.0.0.1:${port}`,
		dataDir,
		sidecar: { command: process.execPath, args: [slow, "gen2"] },
		readyMs: 1500,
	});
	spawned.push(second?.child);
	assert.ok(second?.child, "应停掉活着的上一代并拉起新进程");
	assert.ok(second.child.exitCode === null, "新进程不应撞端口死掉");
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.ok(first.child.signalCode || first.child.exitCode !== null, "上一代应已被停掉");
});
