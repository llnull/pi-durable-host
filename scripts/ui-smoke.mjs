#!/usr/bin/env node
// Web UI 冒烟检查（零 npm 依赖）：用 Playwright 缓存里的 chrome-headless-shell 真实加载页面，
// 经 CDP 收集页面异常/控制台错误，断言关键控件已渲染，可选截图与执行任意 JS。
//
//   node scripts/ui-smoke.mjs                       # 加载 + 基本断言，有页面错误则非零退出
//   node scripts/ui-smoke.mjs --shot /tmp/ui.png     # 另存一张截图（1500×1000）
//   node scripts/ui-smoke.mjs --eval 'document.querySelectorAll(".run").length'
//   node scripts/ui-smoke.mjs --eval 'document.getElementById("btnCompact").click(); "ok"'
//   node scripts/ui-smoke.mjs --wait 6000            # 首屏后多等几秒再断言（SSE/异步面板）
//
// CHROME 环境变量可指定浏览器可执行文件；不设则按 Playwright 的默认缓存目录找 chrome-headless-shell。
// --url 默认 http://127.0.0.1:7600/（需要 daemon 在跑；只读访问，--eval 除外）。
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => {
	const i = args.indexOf(name);
	return i === -1 ? def : args[i + 1];
};
const URL_ = opt("--url", "http://127.0.0.1:7600/");
const SHOT = opt("--shot", null);
const EVAL = opt("--eval", null);
const WAIT = Number(opt("--wait", 2500));
const WIDTH = Number(opt("--width", 1500));
const HEIGHT = Number(opt("--height", 1000));

function findChrome() {
	if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
	const roots = [path.join(homedir(), "Library", "Caches", "ms-playwright"), path.join(homedir(), ".cache", "ms-playwright")];
	for (const root of roots) {
		if (!existsSync(root)) continue;
		const dirs = readdirSync(root).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse();
		for (const d of dirs) {
			for (const bin of ["chrome-headless-shell-mac-arm64/chrome-headless-shell", "chrome-headless-shell-mac-x64/chrome-headless-shell", "chrome-headless-shell-linux64/chrome-headless-shell"]) {
				const p = path.join(root, d, bin);
				if (existsSync(p)) return p;
			}
		}
	}
	throw new Error("找不到 chrome-headless-shell：请设置 CHROME 环境变量，或 `npx playwright install chromium`");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(path.join(tmpdir(), "ui-smoke-"));
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = execFile(findChrome(), [
	"--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--mute-audio",
	`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${WIDTH},${HEIGHT}`,
	"about:blank",
], { stdio: "ignore" });

let failed = 0;
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failed++;
};

try {
	const base = await new Promise((resolve, reject) => {
		const t = setInterval(() => {
			fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).then((j) => { clearInterval(t); resolve(j.webSocketDebuggerUrl); }).catch(() => {});
		}, 150);
		setTimeout(() => { clearInterval(t); reject(new Error("CDP 15s 内未就绪")); }, 15000);
	});
	const ws = new WebSocket(base);
	await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
	let msgId = 0;
	const pending = new Map();
	const pageErrors = [];
	const consoleErrors = [];
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data);
		if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
		if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? "exception");
		if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
		if (m.method === "Log.entryAdded" && m.params.entry.level === "error") consoleErrors.push(`${m.params.entry.source}: ${m.params.entry.text}`);
	};
	const send = (method, params = {}, sessionId) => new Promise((resolve) => {
		const id = ++msgId;
		pending.set(id, resolve);
		ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
	});
	const { result: created } = await send("Target.createTarget", { url: "about:blank" });
	const { result: attached } = await send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
	const sid = attached.sessionId;
	await send("Page.enable", {}, sid);
	await send("Runtime.enable", {}, sid);
	await send("Log.enable", {}, sid);
	const evalJs = async (expression) => {
		const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid);
		if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
		return r.result?.result?.value;
	};
	await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, sid);
	await send("Page.navigate", { url: URL_ }, sid);

	// 等 UI 完成首屏：连接徽标变「已连接」且会话下拉有选项
	let ready = false;
	for (let i = 0; i < 60 && !ready; i++) {
		await sleep(250);
		ready = await evalJs(`document.getElementById("conn")?.textContent === "已连接" && document.getElementById("sessionSel")?.options.length > 0`).catch(() => false);
	}
	await sleep(WAIT);

	check("UI 加载并连上 SSE（#conn=已连接，会话下拉非空）", ready);
	check("模型下拉已填充", (await evalJs(`document.querySelectorAll("#modelSel option").length`)) > 0);
	const runs = await evalJs(`document.querySelectorAll("#transcript .run").length`);
	const placeholder = await evalJs(`document.querySelector("#transcript .muted")?.textContent ?? ""`);
	check("对话流已渲染（run 分组或空态占位）", runs > 0 || /暂无对话|无匹配/.test(placeholder), `runs=${runs} ${placeholder ? `placeholder="${placeholder.trim()}"` : ""}`);
	check("无未捕获页面异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));
	check("无控制台 error", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 400));

	if (EVAL !== null) {
		try { console.log("eval →", JSON.stringify(await evalJs(EVAL))); } catch (e) { check("--eval 执行", false, e.message); }
	}
	if (SHOT) {
		const { result } = await send("Page.captureScreenshot", { format: "png" }, sid);
		writeFileSync(SHOT, Buffer.from(result.data, "base64"));
		console.log(`截图 → ${SHOT}`);
	}
	ws.close();
} catch (err) {
	check("冒烟脚本执行", false, err?.message ?? String(err));
} finally {
	chrome.kill("SIGKILL");
	try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(failed ? `✖ ${failed} 项失败` : "✔ UI 冒烟通过");
process.exit(failed ? 1 : 0);
