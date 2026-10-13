#!/usr/bin/env python3
"""jevlike-server: local System One contract gateway for pi-durable-host.

实现 judge.js（lib/judge.js）所说的官方契约子集：
  POST /v1/systemone   {"state", "model", "questions": {id: {type, instructions, criteria?}}}
  →                    {"model", "answers": {id: {...}}, "usage": {}}

类型映射（jevlike 只有 choice 打分头）：
  choice → 原生：criteria 的键/值作为 options，label 无（推理只出概率）
  noul   → 二元 choice ["true","false"]，answer.noul = p(true)
  score  → 等级 choice（criteria 数组），answer.score = argmax 等级 / (等级数-1) 归一 0-1

域路由：checkpoint 按 domain 前缀配置（--ckpt name=path ...），
context 以对应前缀开头时用该 checkpoint（与 gen-data.py 的 context 结构对应）。

依赖（venv）：numpy, torch, jevlike（github.com/vinnylarouge/jevlike）。零额外依赖。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch

from jevlike.data import ChoiceExample
from jevlike.model import load_checkpoint
from jevlike.train import move

DEVICE = torch.device("cpu")
MODELS: dict[str, tuple] = {}  # prefix -> (model, collator, config)
FALLBACK = "reject"


def serialize_state(state) -> str:
    if isinstance(state, str):
        return state
    if isinstance(state, dict):
        # 与 gen-data.py 对齐的结构化序列化：键值平铺
        parts = []
        for k, v in state.items():
            parts.append(f"{k}: {v}")
        return "\n".join(parts)
    return json.dumps(state, ensure_ascii=False)


def options_for(q: dict) -> tuple[list[str], str]:
    """问题 → (选项列表, 类型)。noul→二元，score→等级数组，choice→criteria 键序。"""
    t = q.get("type")
    if t == "noul":
        return ["true", "false"], "noul"
    if t == "score":
        levels = q.get("criteria")
        if not isinstance(levels, list) or len(levels) < 2:
            levels = ["bad", "good"]
        return [str(x) for x in levels], "score"
    if t == "choice":
        c = q.get("criteria")
        if isinstance(c, dict):
            return [str(k) for k in c.keys()], "choice"
        if isinstance(c, list):
            return [str(i) for i in range(len(c))], "choice"
        return ["yes", "no"], "choice"
    raise ValueError(f"unsupported question type: {t}")


def pick_model(context: str):
    best = None
    for prefix in MODELS:
        if context.startswith(prefix) and (best is None or len(prefix) > len(best)):
            best = prefix
    if best is None:
        if FALLBACK == "reject":
            return None
        best = next(iter(MODELS))
    return MODELS[best]


def answer_one(q: dict, context: str, ctx_budget: int) -> dict:
    picked = pick_model(context)
    if picked is None:
        return {"type": q.get("type"), "error": "no-matching-domain"}  # 调用方按缺席处理
    model, collator, _ = picked
    options, t = options_for(q)
    # context 预算对齐训练配置（tiny 默认 192 字节）
    context = context[:ctx_budget]
    question_text = q.get("instructions", "")[:72]
    # 官方契约里 instructions 是问题语义，拼进 context（与训练数据的 "\nq: " 段对应）
    full_ctx = f"{context}\nq: {question_text}"
    batch = move(collator([ChoiceExample(full_ctx, tuple(options), 0)]), DEVICE)
    model.eval()
    with torch.no_grad():
        probs = model(batch).softmax(-1)[0, : len(options)].tolist()
    if t == "noul":
        return {"type": "noul", "noul": round(probs[0], 4)}  # p(true)
    if t == "score":
        idx = max(range(len(options)), key=lambda i: probs[i])
        norm = idx / (len(options) - 1)
        return {"type": "score", "score": round(norm, 4), "confidence": round(max(probs), 4), "legend": {str(i): o for i, o in enumerate(options)}}
    idx = max(range(len(options)), key=lambda i: probs[i])
    return {
        "type": "choice",
        "choice": options[idx],
        "confidence": round(max(probs), 4),
        "probabilities": {o: round(p, 4) for o, p in zip(options, probs)},
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 安静
        pass

    def do_POST(self):
        if not self.path.endswith("/v1/systemone"):
            self.send_error(404)
            return
        started = time.time()
        n = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        state = serialize_state(body.get("state"))
        questions = body.get("questions") or {}
        answers = {}
        for qid, q in questions.items():
            try:
                answers[qid] = answer_one(q, state, CTX_BUDGET)
            except Exception as e:  # 单问失败不出错整体
                answers[qid] = {"type": q.get("type"), "error": str(e)}
        out = json.dumps({"model": MODEL_NAME, "answers": answers, "usage": {"input_tokens": len(state), "output_tokens": 0, "latency_ms": int((time.time() - started) * 1000)}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


def main():
    global CTX_BUDGET, MODEL_NAME
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=7610)
    ap.add_argument("--ckpt", action="append", required=True,
                    help="prefix=path/to/checkpoint.pt（可多次；context 以 prefix 开头时用该模型）")
    ap.add_argument("--name", default="jevlike-local")
    ap.add_argument("--fallback", choices=("first", "reject"), default="reject",
                    help="无前缀匹配时：reject=返回空 answers（judge 缺席语义，推荐）；first=用第一个模型")
    ap.add_argument("--context-tokens", type=int, default=192)
    args = ap.parse_args()
    CTX_BUDGET = args.context_tokens
    MODEL_NAME = args.name
    global FALLBACK
    FALLBACK = args.fallback
    for spec in args.ckpt:
        prefix, _, path = spec.partition("=")
        MODELS[prefix] = load_checkpoint(path, DEVICE)
        print(f"[jevlike-server] {prefix!r} → {path}", file=sys.stderr)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[jevlike-server] http://127.0.0.1:{args.port}/v1/systemone", file=sys.stderr)
    srv.serve_forever()


if __name__ == "__main__":
    main()
