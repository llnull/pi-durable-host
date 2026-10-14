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
LLM: dict | None = None  # {baseUrl, key, model} —— ckpt 覆盖区外的语义问题转 LLM（混合网关）


def _load_llm(provider_id: str, model_id: str) -> dict | None:
    """从 ~/.pi/agent/{models-store,auth}.json 取 OpenAI 兼容端点；缺失返回 None（保持纯 ckpt 行为）。"""
    import json as _json
    from urllib.request import urlopen
    from pathlib import Path as _Path
    agent = _Path.home() / ".pi" / "agent"
    try:
        store = _json.loads((agent / "models-store.json").read_text(encoding="utf-8"))
        auth = _json.loads((agent / "auth.json").read_text(encoding="utf-8"))
        entry = next(m for m in store[provider_id]["models"] if m["id"] == model_id)
        return {"baseUrl": entry["baseUrl"].rstrip("/"), "key": auth[provider_id]["key"], "model": model_id}
    except Exception as e:  # 配置缺失不应让网关拒启
        print(f"[jevlike-server] LLM 配置不可用（{e}），覆盖区外仍按 fallback={FALLBACK} 处理", file=sys.stderr)
        return None


def llm_spec(q: dict) -> tuple[str, str]:
    """问题 → (给 LLM 的判定说明, 期望的 JSON 字段描述)。"""
    t = q.get("type")
    if t == "choice":
        crit = q.get("criteria") or {}
        opts = list(crit.keys()) if isinstance(crit, dict) else [str(i) for i in range(len(crit))]
        return f"从这些选项里选一个: {opts}", '{"choice": <选项>, "confidence": <0-1>}'
    if t == "score":
        levels = q.get("criteria") or ["不健康", "健康"]
        return f"按等级评估（答 level 序号，0 起）: {levels}", '{"level": <序号>, "confidence": <0-1>}'
    return "陈述为真的概率（0-1）", '{"p": <0-1>}'


def llm_answer_batch(questions: dict, context: str) -> dict:
    """全部覆盖区外问题 → 一次 LLM 调用批量类型化应答。失败抛异常，调用方按单题 error 处理。"""
    import json as _json
    from urllib.request import Request, urlopen
    specs = []
    shape = {}
    for qid, q in questions.items():
        spec, fields = llm_spec(q)
        specs.append(f"[{qid}] {q.get('instructions', '')}\n  {spec}")
        shape[qid] = fields
    prompt = (
        f"你是类型化判断器（不生成正文）。根据状态逐一回答下列问题，只输出一个 JSON 对象。\n"
        f"状态：\n{context[:6000]}\n\n问题：\n" + "\n".join(specs)
        + f"\n输出格式（严格 JSON，键为问题 id，无其他文字）：{_json.dumps(shape, ensure_ascii=False)}"
    )
    req = Request(
        LLM["baseUrl"] + "/chat/completions",
        data=_json.dumps({
            "model": LLM["model"],
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            "max_tokens": 2000,
        }).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {LLM['key']}"},
    )
    with urlopen(req, timeout=60) as r:
        body = _json.loads(r.read())
    text = body["choices"][0]["message"]["content"]
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError(f"LLM 响应非 JSON: {text[:120]}")
    raw = _json.loads(text[start:end + 1])
    out = {}
    for qid, q in questions.items():
        o = raw.get(qid)
        if isinstance(o, str):  # 模型可能把值序列化成 JSON 字符串（跟随模板形状）
            try:
                o = _json.loads(o)
            except Exception:
                o = {"p": o, "choice": o, "level": o}
        o = o if isinstance(o, dict) else {}
        t = q.get("type")
        try:
            if t == "choice":
                out[qid] = {"type": "choice", "choice": str(o.get("choice")), "confidence": float(o.get("confidence", 0.5)), "provider": "llm"}
            elif t == "score":
                levels = q.get("criteria") or ["不健康", "健康"]
                lv = max(0, min(int(o.get("level", 0)), len(levels) - 1))
                out[qid] = {"type": "score", "score": round(lv / (len(levels) - 1), 4), "confidence": float(o.get("confidence", 0.5)), "provider": "llm"}
            else:
                out[qid] = {"type": "noul", "noul": round(max(0.0, min(1.0, float(o.get("p", 0.5)))), 4), "provider": "llm"}
        except Exception as e:
            out[qid] = {"type": t, "error": f"parse: {e}"}
    return out


def llm_answer_one(q: dict, context: str) -> dict:
    """兼容旧路径：单问批量。"""
    qid = "q"
    return llm_answer_batch({qid: q}, context)[qid]


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
        if LLM is None:
            return {"type": q.get("type"), "error": "no-matching-domain"}  # 调用方按缺席处理
        return llm_answer_one(q, context)
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

    def handle_one_request(self):
        # 客户端中途断开（超时取消、进程被杀）不是服务错误：BrokenPipe/ConnectionReset
        # 静默吞掉，否则 http.server 每次客户端断开都往 stderr 打整段 traceback，
        # 把网关面板日志尾染成一屏“error”（实测 issue #121）。
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

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
        llm_pending = {}  # ckpt 覆盖区外的问题 → 一次 LLM 批量调答（串行逐问会撞 judge 侧超时）
        for qid, q in questions.items():
            if pick_model(state) is None and LLM is not None:
                llm_pending[qid] = q
                continue
            try:
                answers[qid] = answer_one(q, state, CTX_BUDGET)
            except Exception as e:  # 单问失败不出错整体
                answers[qid] = {"type": q.get("type"), "error": str(e)}
        if llm_pending:
            try:
                answers.update(llm_answer_batch(llm_pending, state))
            except Exception as e:
                for qid, q in llm_pending.items():
                    answers[qid] = {"type": q.get("type"), "error": f"llm-batch: {e}"}
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
    ap.add_argument("--llm", default=None, metavar="MODEL",
                    help="覆盖区外问题转 LLM（OpenAI 兼容，读 ~/.pi/agent 配置），如 --llm glm-5.3-flash")
    ap.add_argument("--llm-provider", default="zai-coding-cn")
    ap.add_argument("--context-tokens", type=int, default=192)
    args = ap.parse_args()
    CTX_BUDGET = args.context_tokens
    MODEL_NAME = args.name
    global FALLBACK
    FALLBACK = args.fallback
    global LLM
    if args.llm:
        LLM = _load_llm(args.llm_provider, args.llm)
        if LLM:
            print(f"[jevlike-server] LLM 回退 → {args.llm_provider}/{args.llm} @ {LLM['baseUrl']}", file=sys.stderr)
    for spec in args.ckpt:
        prefix, _, path = spec.partition("=")
        MODELS[prefix] = load_checkpoint(path, DEVICE)
        print(f"[jevlike-server] {prefix!r} → {path}", file=sys.stderr)

    class Server(ThreadingHTTPServer):
        daemon_threads = True

        def handle_error(self, request, client_address):
            # 客户端断开（超时取消/进程被杀）不是服务错误：任何线程里冒出的
            # BrokenPipe/ConnectionReset 都静默；其余异常才走默认打栈（真问题不掩盖）。
            exc = sys.exc_info()[1]
            if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
                return
            super().handle_error(request, client_address)

    srv = Server(("127.0.0.1", args.port), Handler)
    print(f"[jevlike-server] http://127.0.0.1:{args.port}/v1/systemone", file=sys.stderr)
    srv.serve_forever()


if __name__ == "__main__":
    main()
