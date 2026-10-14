// lib/sidecar.js 单测（issue #110）：探测、复用、拉起、换代、不越权接管。
// 约定：所有拉起的子进程登记进 spawned、临时目录登记进 dataDirs，
// after() 里统一 SIGKILL 并等 exit——活子进程的 uv 句柄会钉住测试文件的
// 事件循环（首版孤儿 fixture 让整个文件挂满 60s，教训记录在此）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
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
		sidecar: { command: "/bin/false", args: [] },
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
			sidecar: { command: "/bin/true", args: [] },
		});
		assert.equal(handle?.unmanaged, true, "无代际记录应标记 unmanaged");
		assert.ok(!handle.child, "不应拉起新进程");
	} finally {
		server.close();
		await once(server, "close");
	}
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
	const gen = { pid: 4321, argsHash: "abcd1234efgh", script: "server.py", startedAt: "2026-10-14T02:59:22.619Z", command: "python" };
	writeFileSync(path.join(dir, "jevlike", "gateway.json"), JSON.stringify(gen));
	writeFileSync(path.join(dir, "jevlike", "gateway.log"), ["行一", "行二", "行三", "行四", "行五"].join("\n"));
	writeFileSync(path.join(dir, "jevlike", "host-v8.pt"), Buffer.alloc(2048));
	const s = await readGatewayStatus({ url: "http://127.0.0.1:1", sidecar: { command: "python", args: ["server.py"] }, dataDir: dir, probeTimeoutMs: 120 });
	assert.equal(s.configured, true);
	assert.equal(s.managed, true);
	assert.equal(s.gen?.pid, 4321);
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
