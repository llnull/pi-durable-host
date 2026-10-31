// bash 默认超时注入的回归测试（2026-10-31 事故，issue #147：模型跑死循环命令不传 timeout，
// env.exec 无限等待 → run 挂死 → daemon 优雅停止/热重启全部失效）。
// 用假 env 捕获 exec 收到的 options.timeout，不真跑命令。
import test from "node:test";
import assert from "node:assert/strict";
import { buildGuard } from "../lib/extensions.js";

// 从 buildGuard 扩展里取出对 bash 的 wrapTool（{ tool, wrap }），包一个捕获参数的底座工具。
function wrappedBash(bashTimeout) {
	const ext = buildGuard({ bashTimeout });
	const w = ext.wraps.find((x) => x.tool === "bash");
	assert.ok(w, "guard 扩展应包含 bash 的 wrap");
	let captured;
	const base = {
		name: "bash",
		execute: async (args) => {
			captured = args;
			return {};
		},
	};
	const wrapped = w.wrap(base);
	return { wrapped, getCaptured: () => captured };
}

const fakeApi = {
	env: { cwd: process.cwd() },
	output: () => {},
	retainedOutput: () => ({ text: "", truncated: false }),
	diagnostic: () => {},
};

test("模型未传 timeout 时注入默认值", async () => {
	const { wrapped, getCaptured } = wrappedBash(2);
	await wrapped.execute({ command: "sleep 30" }, fakeApi, {});
	assert.equal(getCaptured().timeout, 2);
});

test("模型显式传更大值时封顶", async () => {
	const { wrapped, getCaptured } = wrappedBash(2);
	await wrapped.execute({ command: "sleep 30", timeout: 3600 }, fakeApi, {});
	assert.equal(getCaptured().timeout, 2);
});

test("模型显式传更小值时尊重", async () => {
	const { wrapped, getCaptured } = wrappedBash(300);
	await wrapped.execute({ command: "make", timeout: 60 }, fakeApi, {});
	assert.equal(getCaptured().timeout, 60);
});

test("bashTimeout=0 时不设防（保持原语义）", async () => {
	const { wrapped, getCaptured } = wrappedBash(0);
	await wrapped.execute({ command: "sleep 30" }, fakeApi, {});
	assert.equal(getCaptured().timeout, undefined);
});
