// 录制 Web UI 演示 GIF（v2）：真实交互路径 + 高帧率紧凑剪辑。
// 零 npm 依赖：Node 内置 WebSocket 直连 chrome-headless-shell 的 browser CDP（flatten session）。
//
// 对比 v1 的改进（v1 看着像静态图的三个原因）：
//   1. ask 用 daemon HTTP 直发 —— composer 无输入动画，画面长时间不动 → 改为 CDP 真实键盘逐字输入
//   2. fork 用 Runtime.evaluate 合成 click —— CSS :hover 不触发，⑂ 按钮从未出现 → 改为
//      Input.dispatchMouseEvent 真实鼠标移动/点击（真实 hover 才会让按钮显形）
//   3. 128 色 + bayer 抖动 + 流式期占片长 2/3 —— 改为短提问、10fps、256 色、sierra2_4a 抖动
//
// 场景：加载 → 逐字输入提问 → Enter → 流式生成+工具卡片 → hover 出 ⑂ → 点击 → 真实 confirm 弹窗
//（Page.javascriptDialogOpening 事件应答 accept）→ 切到新会话（transcript 清空）→ 结束。
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

const ws = new WebSocket(cdpBase);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let msgId = 0;
const pending = new Map();
const dialogQueue = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === "Page.javascriptDialogOpening") dialogQueue.push(m.params);
};
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  const id = ++msgId;
  pending.set(id, resolve);
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
});

const { result: created } = await send("Target.createTarget", { url: UI });
const { result: attached } = await send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
const sid = attached.sessionId;

// —— screencast 收帧（带阶段标记与时间戳，供剪辑分段采样） ——
const frames = [];
let phase = "load";
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.sessionId === sid && m.method === "Page.screencastFrame") {
    frames.push({ at: Date.now(), phase, data: m.params.data });
    send("Page.screencastFrameAck", { sessionId: m.params.sessionId }, sid);
  }
});
await send("Page.enable", {}, sid);
await send("Runtime.enable", {}, sid);
await send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: 1600, maxHeight: 1000 }, sid);

const shot = (name) => sleep(600).then(() => console.log("…", name, `（${frames.length} 帧）`));
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true }, sid);
  return r.result?.result?.value;
};

// —— 场景 ——
await sleep(2500); await shot("UI 加载");

// 1. 聚焦 composer 并逐字真实输入（Input.dispatchKeyEvent 产生真实 input 事件）
const question = "运行 echo demo-gif 再用一句话总结";
await evalJs(`document.getElementById("input").focus()`);
phase = "typing";
for (const ch of question) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch }, sid);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }, sid);
  await sleep(28);
}
await shot("输入完成");
console.log("composer 值:", await evalJs(`document.getElementById("input").value`));

// 2. Enter 发送（真实回车键）
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, sid);
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, sid);
await sleep(400);
console.log("busy:", await evalJs(`document.getElementById("status").textContent`));
await shot("已发送");

// 3. 等生成结束（最长 60s；流式期间帧自然收录）
phase = "stream"; // 流式生成期：剪辑时长段抽稀
for (let i = 0; i < 60; i++) {
  const st = await evalJs(`document.getElementById("status").textContent`).catch(() => "busy");
  if (st === "空闲") break;
  await sleep(1000);
}
phase = "act"; // 完成帧、hover、点击、切换：全保
await shot("回答完成");

// 4. hover 最后一条用户提问 → ⑂ 显形（真实鼠标移动才有 CSS :hover）
const rect = await evalJs(`(() => {
  const btns = [...document.querySelectorAll(".fork-btn")];
  const btn = btns[btns.length - 1];
  btn.scrollIntoView({ block: "center" });
  const r = btn.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x + 60, y: rect.y }, sid); // 先移到气泡上
await sleep(250);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y }, sid); // 再移到 ⑂
await sleep(400);
await shot("⑂ 显形");

// 5. 真实点击 → confirm 弹窗由 Page.javascriptDialogOpening 应答 accept
const clickPromise = (async () => {
  for (let i = 0; i < 40; i++) {
    if (dialogQueue.length) {
      await send("Page.handleJavaScriptDialog", { accept: true }, sid);
      return "dialog-accepted";
    }
    await sleep(100);
  }
  return "no-dialog";
})();
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sid);
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sid);
console.log("fork:", await clickPromise);
await sleep(1200);
console.log("当前会话:", await evalJs(`document.getElementById("sessionSel").selectedOptions[0]?.textContent`));
await shot("分叉切换");
await sleep(1200); await shot("新会话");

// —— 落盘 ——
await send("Page.stopScreencast", {}, sid).catch(() => {});
ws.close();
chrome.kill();
const fdir = mkdtempSync(join(tmpdir(), "gifframes-"));
frames.forEach((f, i) => writeFileSync(join(fdir, `f${String(i).padStart(5, "0")}.png`), Buffer.from(f.data, "base64")));
writeFileSync(join(fdir, "meta.json"), JSON.stringify({ t0: frames[0].at, frames: frames.map((f, i) => ({ at: f.at - frames[0].at, phase: f.phase, f: `f${String(i).padStart(5, "0")}.png` })) }));
console.log(`共 ${frames.length} 帧 → ${fdir}`);
