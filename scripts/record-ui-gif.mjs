// 录制 Web UI 演示 GIF：CDP screencast 逐帧抓取 → ffmpeg 合成 GIF。
// 零 npm 依赖：Node 内置 WebSocket 直连 chrome-headless-shell 的 browser CDP 端点，
// 单条 WS + flatten session 同时控页与收帧。
// 场景：打开 UI → 提问（流式生成+工具卡片）→ 悬停提问显示 ⑂ → 分叉切换。
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
const PORT = 9333;
const UI = "http://127.0.0.1:7600/";
const DAEMON = "http://127.0.0.1:7600";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (path, body) => fetch(DAEMON + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

// —— 启动 chrome ——
const dir = mkdtempSync(join(tmpdir(), "gifrec-"));
const chrome = execFile(CHROME, [
  "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${dir}/profile`, "--window-size=1600,1000", "--hide-scrollbars", "--no-first-run",
  "about:blank",
]);
const cdpBase = await new Promise((resolve, reject) => {
  const t = setInterval(() => {
    fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).then((j) => { clearInterval(t); resolve(j.webSocketDebuggerUrl.replace("ws://localhost", "ws://127.0.0.1")); }).catch(() => {});
  }, 200);
  setTimeout(() => { clearInterval(t); reject(new Error("chrome CDP 未就绪")); }, 15000);
});
console.log("CDP 就绪");

// —— 单条 browser WS，flatten session 控页 ——
const ws = new WebSocket(cdpBase);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let msgId = 0;
const pending = new Map();
const frameHandlers = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) for (const h of frameHandlers) h(m);
};
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  const id = ++msgId;
  pending.set(id, resolve);
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
});

const { result: created } = await send("Target.createTarget", { url: UI });
const { result: attached } = await send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
const sid = attached.sessionId;
console.log("target 已 attach:", sid.slice(0, 12) + "…");

// —— screencast 收帧 ——
const frames = [];
frameHandlers.push((m) => {
  if (m.sessionId === sid && m.method === "Page.screencastFrame") {
    frames.push({ at: Date.now(), data: m.params.data });
    send("Page.screencastFrameAck", { sessionId: m.params.sessionId }, sid);
  }
});
await send("Page.enable", {}, sid);
await send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: 1600, maxHeight: 1000 }, sid);
const shot = async (name) => { await sleep(700); console.log("…", name, `（已收 ${frames.length} 帧）`); };

// —— 场景编排 ——
await sleep(2500); await shot("UI 加载");
// 1. 流式提问（daemon HTTP 触发；UI SSE 实时显示）
await api("/api/ask", { content: "用一句话介绍你自己，然后运行 echo hello-demo 展示工具调用" }).catch(() => {});
await shot("ask 提交");
// 等 run 结束（最多 120s）
for (let i = 0; i < 120; i++) {
  const st = await api("/api/status").catch(() => null);
  if (st && !st.live?.run) break;
  await sleep(1000);
}
await shot("回答完成");
// 2. 分叉：hover 出 ⑂ → 自动确认 → 点击
await send("Runtime.evaluate", { expression: `
  (() => {
    const btns = [...document.querySelectorAll(".fork-btn")];
    const btn = btns[btns.length - 1];
    if (!btn) return "no-fork-btn";
    btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    return "ok";
  })()
`}, sid);
await sleep(400);
const clickRes = await send("Runtime.evaluate", { expression: `
  (() => {
    const btns = [...document.querySelectorAll(".fork-btn")];
    const btn = btns[btns.length - 1];
    if (!btn) return "no-fork-btn";
    window.confirm = () => true;
    btn.click();
    return "clicked";
  })()
`}, sid);
console.log("fork 点击:", clickRes.result?.result?.value);
await shot("分叉切换");
await sleep(1500); await shot("新会话");

// —— 落盘帧 ——
await send("Page.stopScreencast", {}, sid).catch(() => {});
ws.close();
chrome.kill();
const fdir = mkdtempSync(join(tmpdir(), "gifframes-"));
frames.forEach((f, i) => writeFileSync(join(fdir, `f${String(i).padStart(5, "0")}.png`), Buffer.from(f.data, "base64")));
console.log(`共 ${frames.length} 帧 → ${fdir}`);
