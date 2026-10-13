# jevlike 本地 provider（System One 契约网关）

不依赖外部 API 的本地判断头：[jevlike](https://github.com/vinnylarouge/jevlike)
（option-attention 打分头，byte-level tiny encoder，127KB 级 checkpoint，CPU 推理毫秒级）
包一层官方 System One 契约 HTTP，`PI_DURABLE_JUDGE_URL` 直接指向它，judge 子系统零改动激活。

## PoC 实测结论（2026-10，v1–v8 迭代实录）

| 判断域 | 数据（合成模板） | jevlike 实测 | n-gram LR 对照 | 结论 |
|---|---|---|---|---|
| 忙时路由（steer/followUp） | ~430 行 | **100%**（val/test） | 0.86 | ✅ 采用 |
| 工具输出注入判别 | ~130 行 | **100%** | 0.62 | ✅ 采用（需持续喂真实样本） |
| bash 破坏性（guard） | ~800 行 | 0.53–0.83 波动 | 0.84 | ❌ 保持 heuristic 正则 |

关键发现：
1. **插值器不是推理器**——模板覆盖区内近乎完美，模板外句式 60–90% 波动（train 100% + test 崩 = 记指纹）。
   「校准概率」只在覆盖区内可信，因此 server 对覆盖区外的问题**拒绝作答**（--fallback=reject），
   judge.js 的缺席语义让调用方安全降级 heuristic。
2. **训练/推理必须逐字节对齐**：state 平铺格式（`command: …` / `content: …` / `output: …`）、
   `q: <调用方 instructions 原文>` 段、options 语义（选项词即 id）。任何错位都会静默产生垃圾概率。
3. 数据飞轮正解：现在用合成模板 bootstrap；`data/judge-log.jsonl` + 审批历史攒厚后重训（真实分布）。

## 部署

```sh
# 1) venv（一次性；~200MB torch CPU）
python3 -m venv ~/.venvs/jevlike
~/.venvs/jevlike/bin/pip install numpy torch --index-url https://download.pytorch.org/whl/cpu
~/.venvs/jevlike/bin/pip install "jevlike @ git+https://github.com/vinnylarouge/jevlike"

# 2) 生成训练数据（host 判断域模板）+ 训练（CPU，~1 分钟）
cd tools/jevlike
~/.venvs/jevlike/bin/python gen-data.py data-host
~/.venvs/jevlike/bin/jevlike-train data-host/train.jsonl \
  --validation data-host/val.jsonl --output ckpt.pt --epochs 25 --width 96 --rank 96

# 3) 起服务（覆盖区前缀 → checkpoint；域外拒绝）
~/.venvs/jevlike/bin/python server.py --port 7610 \
  --ckpt "command:=ckpt.pt" --ckpt "content:=ckpt.pt" --ckpt "output:=ckpt.pt" --fallback reject

# 4) host 接上（host.js 环境）
PI_DURABLE_JUDGE_URL=http://127.0.0.1:7610
PI_DURABLE_JUDGE_KEY=local        # 本地服务忽略，但 judge.js 有 key 才发 header（无要求，可不设）
# 热重启：curl -X POST http://127.0.0.1:7600/api/restart
```

激活后：guard 异步旁路、忙时路由、护栏（host-screen）自动切到本地头（provider: system-one）；
guard 破坏性域因质量不足**建议保持 heuristic**（本地头对 guard 域返回的概率不可信——
若要强制，把 `--ckpt "command:=…"` 去掉即可让 guard 域缺席降级）。

## 文件

- `server.py` — 契约网关（choice 原生 / noul→二元 / score→等级归一），按 state 前缀域路由
- `gen-data.py` — 三个判断域的合成数据生成（模板组合 + 边界带 + held-out 切分；seed 固定 42/7，重建可复现）
- `train.py` — 训练 + 真实调用形状复测脚本

## 持久化（/tmp 是易失的）

一切可再生的东西不要放 /tmp。PoC 期的持久件在 `~/jevlike-lab/`（ext4 原生，勿放 /mnt/d——9p 慢盘加载模型慢百倍）：

```
~/jevlike-lab/
├── runs/host-v8.pt        # 当前最优 checkpoint（287KB）
├── data-host*/            # 已切分数据集（seed 固定，可用 gen-data.py 复现）
├── jevlike-src/           # jevlike 源码 clone（pip install -e 用）
├── models/                # llama.cpp 实验用 GGUF
├── llamacpp-probes/       # llama.cpp 评测脚本（logit_bias 打分法）
└── *.py                   # PoC 评测脚本（smoke/eval/baseline/verify）
```

venv 在 `~/.venvs/jevlike`（pip cache 持久，重建离线秒级）。
**主机重启后恢复只需一条命令**：

```sh
cd ~/jevlike-lab && ~/.venvs/jevlike/bin/python server.py --port 7610 \
  --ckpt "command:=runs/host-v8.pt" --ckpt "content:=runs/host-v8.pt" \
  --ckpt "output:=runs/host-v8.pt" --fallback reject
```

（若 venv 也丢了：`python3 -m venv ~/.venvs/jevlike` + 重跑部署第 1 步，pip cache 命中即秒装。）

## 限制

- byte-level encoder，192 字节 context（可加大但 tiny 头容量有限）
- 只支持 Choice 打分头：noul/score 是映射（官方语义等价性未经官方端点校验）
- 中文占 3 字节/字，192 字节预算下 context 实际容量 ~60 汉字
- 服务是标准库 http.server（ThreadingHTTPServer），并发足够本机 judge 旁路使用
