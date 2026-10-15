#!/usr/bin/env node
// 自训编排器（issue #130 Phase 3）：数据飞轮全管线一键化。
//
//   dataset（真实标签） → gen-data（合成集） → 分层切分 + 权重合并
//   → jevlike.train（混训） → eval-gate（champion vs challenger 算分）
//   → gate-decide（门判定） → pass: promotion.json 提案 / fail: failed-<ts>.json 归档
//
// 手动：node tools/jevlike/selftrain.js [--data-dir data] [--weight 2] [--epochs 25]
// 自动：daemon 定时器 spawn 本脚本（host.json judge.retrain.enabled，默认关）。
// 留档：data/jevlike/selftrain/runs/run-<ts>/（候选 ckpt+报告，封口 keep 3 代——磁盘红线）。
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDataset } from "../../lib/dataset.js";
import { splitReal, mergeWithWeight, pruneRuns, pruneFailed, shouldRun } from "../../lib/selftrain.js";
import { SENTINEL_PROBES } from "./gate-decide.js";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // tools/jevlike
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

const dataDir = path.resolve(argOf("--data-dir", "data"));
const weight = Number(argOf("--weight", 2));
const epochs = Number(argOf("--epochs", 25));
const jevDir = path.join(dataDir, "jevlike");
const runsDir = path.join(jevDir, "selftrain", "runs");

// python 取 sidecar 同款（host.json judge.sidecar.command）——训练与推理同一个 venv
let python = argOf("--python", null);
if (!python) {
	try {
		python = JSON.parse(readFileSync(path.join(dataDir, "host.json"), "utf8")).judge?.sidecar?.command ?? "python3";
	} catch { python = "python3"; }
}
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = path.join(runsDir, `run-${ts}`);
const log = (m) => console.error(`[selftrain] ${m}`);
const die = (m) => { log(`失败：${m}`); process.exit(1); };

/** 跑外部命令；capture=true 时返回 stdout（eval-gate 的报告走 stdout）。 */
const sh = (cmd, argv, { capture = false, timeout = 900_000 } = {}) => {
	log(`+ ${path.basename(String(cmd))} ${argv.filter((a) => !a.includes(" Probe")).join(" ").slice(0, 140)}`);
	const r = spawnSync(cmd, argv, { encoding: "utf8", timeout });
	if (r.status !== 0) die(`${path.basename(String(cmd))} 退出 ${r.status}：${String(r.stderr ?? "").slice(-1500)}`);
	return capture ? r.stdout : r.stderr;
};

// 0. 候选留档封口（先清旧再跑——磁盘红线）
const pruned = pruneRuns(runsDir, 3);
if (pruned.length) log(`留档封口：清理 ${pruned.length} 个旧 run`);
mkdirSync(runDir, { recursive: true });

// 1. 真实标签集（transcript 真值，非模型应答）
const ds = buildDataset({ dataDir });
log(`real-guard: ${ds.written} 条（拦截 ${ds.stats.blocked} / 只读成功 ${ds.stats.readonlyOk}）`);
if (ds.written < 20) die(`real 样本仅 ${ds.written} 条（<20），切分后 holdout 无统计意义——再攒攒`);

// 2. 合成集（gen-data seed 42 确定性，test split 即门的固定评审集）
const synDir = path.join(runDir, "syn");
sh(python, [path.join(HERE, "gen-data.py"), synDir]);
for (const f of ["train.jsonl", "val.jsonl", "test.jsonl"]) {
	if (!existsSync(path.join(synDir, f))) die(`gen-data 未产出 ${f}`);
}

// 3. 确定性分层切分 + 权重合并（val 保持纯合成——评审集不被 real 污染）
const realRows = readFileSync(ds.file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const { train: realTrain, holdout } = splitReal(realRows);
const synTrain = readFileSync(path.join(synDir, "train.jsonl"), "utf8").trim().split("\n").filter(Boolean);
const merged = mergeWithWeight(synTrain, realTrain.map((r) => JSON.stringify(r)), weight);
writeFileSync(path.join(runDir, "train-mixed.jsonl"), merged.join("\n") + "\n");
writeFileSync(path.join(runDir, "real-holdout.jsonl"), holdout.map((r) => JSON.stringify(r)).join("\n") + "\n");
log(`混训集：合成 ${synTrain.length} + real ${realTrain.length}×${weight} = ${merged.length}；holdout ${holdout.length} 条`);

// 4. 混训（v8 同架构超参：width/rank 96、lr 1.5e-3）
const candidate = path.join(runDir, "candidate.pt");
sh(python, ["-m", "jevlike.train", path.join(runDir, "train-mixed.jsonl"),
	"--validation", path.join(synDir, "val.jsonl"), "--output", candidate,
	"--epochs", String(epochs), "--width", "96", "--rank", "96", "--learning-rate", "1.5e-3"]);

// 5. 门算分 + 判定（champion = host.json 当前指向；判定重算在 apply 端点还会做一次）
const cfg = JSON.parse(readFileSync(path.join(dataDir, "host.json"), "utf8"));
const ckptArg = (cfg.judge?.sidecar?.args ?? []).find((a) => String(a).startsWith("command:="));
if (!ckptArg) die("host.json 无 command:= ckpt 映射，champion 未知");
const champion = ckptArg.slice("command:=".length);
const report = JSON.parse(sh(python, [path.join(HERE, "eval-gate.py"),
	"--champion", champion, "--challenger", candidate,
	"--test", path.join(synDir, "test.jsonl"), "--real", path.join(runDir, "real-holdout.jsonl"),
	"--probes", JSON.stringify(SENTINEL_PROBES)], { capture: true }));
writeFileSync(path.join(runDir, "gate-report.json"), JSON.stringify(report, null, 1) + "\n");
log(`champion ${champion.split(path.sep).pop()} → challenger: ` +
	`合成 ${report.champion.accuracy}→${report.challenger.accuracy} | ` +
	`guard ${report.champion.domains.guard}→${report.challenger.domains.guard} | ` +
	`真实 ${report.champion.real?.accuracy}→${report.challenger.real?.accuracy}`);

// 6. 门判定（node 侧，规则与 apply 端点同一实现）
const { decide } = await import("./gate-decide.js");
const decision = decide(report);
writeFileSync(path.join(runDir, "gate-decision.json"), JSON.stringify(decision, null, 1) + "\n");

if (decision.pass) {
	const proposal = {
		at: new Date().toISOString(),
		candidate,
		run: runDir,
		weight,
		epochs,
		champion,
		report,
		decision,
		applied: false,
	};
	writeFileSync(path.join(jevDir, "promotion.json"), JSON.stringify(proposal, null, 1) + "\n");
	log(`✓ 过门 → 晋升提案就绪：${path.join(jevDir, "promotion.json")}（等人在 UI 应用）`);
} else {
	const failFile = path.join(jevDir, `selftrain`, `failed-${ts}.json`);
	writeFileSync(failFile, JSON.stringify({ at: new Date().toISOString(), candidate, report, decision }, null, 1) + "\n");
	const prunedF = pruneFailed(path.join(jevDir, "selftrain"), 10);
	if (prunedF.length) log(`失败归档封口：清理 ${prunedF.length} 份`);
	log(`✗ 未过门 → 归档 ${failFile}（${decision.reasons.join("；")}）`);
}
