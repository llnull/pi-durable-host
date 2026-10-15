#!/usr/bin/env python3
"""eval 门算分（issue #128 Phase 1）：champion vs challenger 双 ckpt 对比报告。

只算分不决策——晋升判定在 tools/jevlike/gate-decide.js（node，独立可测）。
输出 JSON：{champion:{accuracy,domains:{guard,routing,screen}}, challenger:{...}, probes:[{name,ok,want,got}], meta}

用法：
  ~/.venvs/jevlike/bin/python tools/jevlike/eval-gate.py \
    --champion data/jevlike/host-v8.pt --challenger runs/host-v9.pt \
    --test data-host/test.jsonl [--real data/jevlike/real-guard.jsonl]

test.jsonl 来自 tools/jevlike/gen-data.py（seed 42 确定性，同模板整组进同一 split）。
真实集（real-guard.jsonl）单独报 real_accuracy——样本即分布，目前量小，仅供参考不进门。
"""
import argparse
import json
import sys
from pathlib import Path

import torch
from jevlike.model import load_checkpoint
from jevlike.data import ChoiceExample
from jevlike.train import move

GUARD_PREFIX = "command: "


def domain_of(ctx: str) -> str:
    if ctx.startswith("command:"):
        return "guard"
    if ctx.startswith("content:"):
        return "routing"
    if ctx.startswith("output:"):
        return "screen"
    return "other"


def score_ckpt(model, collator, rows) -> dict:
    by = {}
    device = torch.device("cpu")
    for r in rows:
        ctx, options, label = r["context"], r["options"], r["label"]
        batch = move(collator([ChoiceExample(ctx, tuple(options), 0)]), device)
        with torch.no_grad():
            probs = model(batch).softmax(-1)[0, : len(options)].tolist()
        pred = max(range(len(probs)), key=lambda i: probs[i])
        dom = domain_of(ctx)
        d = by.setdefault(dom, {"n": 0, "correct": 0})
        d["n"] += 1
        d["correct"] += pred == label
    domains = {k: round(v["correct"] / v["n"], 4) for k, v in by.items()}
    total_n = sum(v["n"] for v in by.values())
    total_c = sum(v["correct"] for v in by.values())
    return {
        "accuracy": round(total_c / total_n, 4) if total_n else 0,
        "domains": domains,
        "n": total_n,
    }


def run_probes(model, collator, probes) -> list:
    device = torch.device("cpu")
    out = []
    for p in probes:
        batch = move(collator([ChoiceExample(p["ctx"], tuple(p["options"]), 0)]), device)
        with torch.no_grad():
            probs = model(batch).softmax(-1)[0, : len(p["options"])].tolist()
        got = p["options"][max(range(len(probs)), key=lambda i: probs[i])]
        out.append({"name": p["name"], "ok": got == p["want"], "want": p["want"], "got": got})
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--champion", required=True)
    ap.add_argument("--challenger", required=True)
    ap.add_argument("--test", required=True, help="gen-data.py 产出的 test.jsonl")
    ap.add_argument("--real", default=None, help="real-guard.jsonl（真实集，参考分不进门）")
    ap.add_argument("--probes", default=None, help="gate-decide.js 导出的 SENTINEL_PROBES JSON（node -e 'console.log(JSON.stringify(require(...).SENTINEL_PROBES))' 传入）；缺省跳过探针")
    args = ap.parse_args()

    rows = [json.loads(l) for l in open(args.test, encoding="utf-8") if l.strip()]
    real_rows = []
    if args.real and Path(args.real).exists():
        real_rows = [json.loads(l) for l in open(args.real, encoding="utf-8") if l.strip()]

    report = {"meta": {"test_rows": len(rows), "real_rows": len(real_rows)}}
    probes = json.loads(args.probes) if args.probes else []
    for name, path_ in (("champion", args.champion), ("challenger", args.challenger)):
        model, collator, _ = load_checkpoint(path_, torch.device("cpu"))
        model.eval()
        report[name] = score_ckpt(model, collator, rows)
        if real_rows:
            report[name]["real"] = score_ckpt(model, collator, real_rows)
        if probes:
            report["probes"] = run_probes(model, collator, probes) if name == "challenger" else report.get("probes", [])
    print(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
