// 审批闸门（pi-durable 1.6 signals / gates）状态机单测：
// 危险命令在 block 模式下不再直接拦截，而是挂起等待人工决定；批准后调用自动继续执行。
// 用假的 HookApi（memo / readSignal / now）直接驱动 beforeTool，不碰存储与模型。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApprovalDecision, approvalKey, buildGuard } from "../lib/extensions.js";
import { approveCommand, clearPending, pendingFileOf, readApprovals, readPending } from "../lib/approvals.js";

const CMD = "rm -f /tmp/victim.txt";
const OTHER = "git push --force origin main";

/** 一个可驱动时钟与信号值的假 HookApi + 临时审批文件；t.after 负责清理。 */
function fixture(t, { mode = "block", approvalTimeoutMs = 60_000, approved = [] } = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "gate-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const approvalsFile = path.join(dir, "approvals.json");
	const pendingFile = pendingFileOf(approvalsFile);
	for (const command of approved) approveCommand(approvalsFile, command);
	const ext = buildGuard({ approvalsFile, mode, approvalTimeoutMs });
	const gate = ext.hooks.find((h) => h.handlers?.beforeTool).handlers.beforeTool;
	const memos = {};
	const signals = {};
	let now = 1_000_000;
	const api = {
		taskId: 4242,
		now: () => now,
		memo: async (name, candidate) => (name in memos ? memos[name] : (memos[name] = candidate)),
		readSignal: async (_token, key) => signals[key],
	};
	return { gate, api, approvalsFile, pendingFile, signals, advance: (ms) => { now += ms; }, call: (command = CMD) => ({ name: "bash", arguments: { command } }) };
}

test("首次命中：挂起等待审批信号（带截止时间），并登记待批（含投递信号所需的 taskId / key）", async (t) => {
	const f = fixture(t);
	const key = approvalKey(CMD);
	const r = await f.gate(f.call(), f.api, {});
	assert.deepEqual(r, { sleep: { signals: [ApprovalDecision.key(key)], until: f.api.now() + 60_000 } });
	const pending = readPending(f.pendingFile);
	assert.equal(pending.length, 1);
	assert.equal(pending[0].command, CMD);
	assert.equal(pending[0].taskId, 4242);
	assert.equal(pending[0].key, key);
	assert.match(pending[0].why, /强制删除/);
	assert.equal(readApprovals(f.approvalsFile).length, 0, "挂起不等于批准");
});

test("外部唤醒但没有决定（重开 Harness / 注册表变化）：再次挂起，复用同一截止时间，待批不重复登记", async (t) => {
	const f = fixture(t);
	const first = await f.gate(f.call(), f.api, {});
	const at = readPending(f.pendingFile)[0].blockedAt;
	f.advance(30_000); // 半个超时周期过去了
	const again = await f.gate(f.call(), f.api, {});
	assert.equal(again.sleep.until, first.sleep.until, "一个问题一个截止时间：memo 过的 deadline 不随唤醒滚动");
	const pending = readPending(f.pendingFile);
	assert.equal(pending.length, 1, "幂等：同一命令不重复登记");
	assert.equal(pending[0].blockedAt, at, "保留首次拦截时间");
});

test("批准（进批准清单 + 投递信号）：放行执行；待批条目由批准方清（闸门在清单命中时提前返回）", async (t) => {
	const f = fixture(t);
	await f.gate(f.call(), f.api, {});
	approveCommand(f.approvalsFile, CMD); // /api/approve 先写批准清单（现在不动待批）
	f.signals[approvalKey(CMD)] = { value: { allow: true, by: "ui" } }; // 再投递信号唤醒
	assert.equal(await f.gate(f.call(), f.api, {}), undefined);
	assert.equal(readPending(f.pendingFile).length, 1, "闸门从清单判定放行，不负责清条目");
	clearPending(f.pendingFile, CMD); // /api/approve 与本地 ask 的代投逻辑都会在投递后清
	assert.equal(readPending(f.pendingFile).length, 0);
});

test("只有信号同意、没进批准清单：同样放行（信号本身就是用户的决定）", async (t) => {
	const f = fixture(t);
	await f.gate(f.call(), f.api, {}); // 先挂起并登记待批
	f.signals[approvalKey(CMD)] = { value: { allow: true, by: "ui" } };
	assert.equal(await f.gate(f.call(), f.api, {}), undefined);
	assert.equal(readPending(f.pendingFile).length, 0, "经信号放行时闸门自己清条目");
});

test("拒绝：拦截并说明理由，待批清除，不进批准清单", async (t) => {
	const f = fixture(t);
	await f.gate(f.call(), f.api, {});
	f.signals[approvalKey(CMD)] = { value: { allow: false, by: "ui", note: "不想删" } };
	const r = await f.gate(f.call(), f.api, {});
	assert.match(r.block, /用户拒绝了该命令/);
	assert.match(r.block, /不要换个写法绕过/);
	assert.equal(readPending(f.pendingFile).length, 0);
	assert.equal(readApprovals(f.approvalsFile).length, 0);
});

test("超时：拦截并提示重新发起，待批清除", async (t) => {
	const f = fixture(t);
	await f.gate(f.call(), f.api, {});
	f.signals[approvalKey(CMD)] = { expired: true };
	const r = await f.gate(f.call(), f.api, {});
	assert.match(r.block, /审批超时（1 分钟内未获批准）/);
	assert.equal(readPending(f.pendingFile).length, 0);
});

test("flag 模式只审计不挂起；off 模式不装闸门", async (t) => {
	const flag = fixture(t, { mode: "flag" });
	assert.equal(await flag.gate(flag.call(), flag.api, {}), undefined);
	assert.equal(readPending(flag.pendingFile).length, 0, "flag 模式不写待批（issue #106）");
	const dir = mkdtempSync(path.join(tmpdir(), "gate-off-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	assert.equal(buildGuard({ approvalsFile: path.join(dir, "a.json"), mode: "off" }), undefined);
});

test("已批准的命令、非 bash 调用、无害命令都不挂起", async (t) => {
	const f = fixture(t, { approved: [CMD] });
	assert.equal(await f.gate(f.call(), f.api, {}), undefined, "精确匹配已批准");
	assert.equal(await f.gate(f.call("ls -la"), f.api, {}), undefined, "无害命令");
	assert.equal(await f.gate({ name: "read", arguments: { path: "/etc/passwd" } }, f.api, {}), undefined, "guard 只管 bash");
});

test("不同命令是不同的问题：key 与 deadline 备忘互不干扰", async (t) => {
	const f = fixture(t, { approvalTimeoutMs: 5_000 });
	const a = await f.gate(f.call(), f.api, {});
	f.advance(4_000);
	const b = await f.gate(f.call(OTHER), f.api, {});
	assert.notEqual(approvalKey(CMD), approvalKey(OTHER));
	assert.equal(b.sleep.until, f.api.now() + 5_000, "另一条命令有自己的截止时间");
	assert.equal(readPending(f.pendingFile).length, 2);
	assert.deepEqual(readPending(f.pendingFile).map((p) => p.key), [approvalKey(CMD), approvalKey(OTHER)]);
	// 坏文件不致命：待批清单被外力写坏时，闸门照常挂起，并把文件写回合法 JSON
	writeFileSync(f.pendingFile, "{not json");
	const again = await f.gate(f.call(OTHER), f.api, {});
	assert.ok(again?.sleep, "坏文件不影响挂起");
	assert.equal(again.sleep.until, b.sleep.until, "截止时间仍复用（memo 在任务上，不在文件上）");
	assert.deepEqual(readPending(f.pendingFile).map((p) => p.command), [OTHER]);
});
