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

Python 要求 **≥3.10**（torch CPU 轮子目前最高支持 3.13）。先看 `python3 --version`：

- **3.10–3.13**：直接用系统 python3，走下面 pip 路径（大多数 Linux 发行版在此区间）
- **其他**（太老如 macOS 自带 3.9，或太新无 torch 轮子）：用 [uv](https://docs.astral.sh/uv/) 拉一个 3.12 最省事：

```sh
# uv 安装（任选其一；macOS 也可 brew install uv）
curl -LsSf https://astral.sh/uv/install.sh | sh
# 建 venv 后，把下文的 ~/.venvs/jevlike/bin/pip 换成：
#   uv pip install --python ~/.venvs/jevlike/bin/python …
uv venv ~/.venvs/jevlike --python 3.12
```

```sh
# 1) venv（一次性；~200MB torch CPU）
python3 -m venv ~/.venvs/jevlike
~/.venvs/jevlike/bin/pip install numpy torch --index-url https://download.pytorch.org/whl/cpu
~/.venvs/jevlike/bin/pip install "jevlike @ git+https://github.com/vinnylarouge/jevlike"

# 2) 生成训练数据（host 判断域模板）+ 训练（CPU，~1 分钟）
cd tools/jevlike
~/.venvs/jevlike/bin/python gen-data.py data-host
~/.venvs/jevlike/bin/jevlike-train data-host/train.jsonl \
  --validation data-host/val.jsonl --output ../../data/jevlike/host-v8.pt --epochs 25 --width 96 --rank 96

# 3) 不需手动起服务：data/host.json 配好 judge.sidecar 后，daemon 自动拉起/托管（见下方生产拓扑）

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

## 生产拓扑（本机实装）

代码、运行时状态、配置三分离，各自唯一真相源：

| 角色 | 位置 | 说明 |
|---|---|---|
| 代码（canonical） | repo `tools/jevlike/` | 网关只从 repo 工作树跑（与 host.js 同一约定），改动走 PR |
| 运行时状态 | `data/jevlike/` | checkpoint（host-v8.pt）、gateway.json 代际记录、gateway.log |
| 配置 | `data/host.json` | judge.url/model + **judge.sidecar**（command/args/log/readyMs） |
| PoC 存档 | `~/jevlike-lab/` | 评测脚本、历史 checkpoint、jevlike-src、GGUF——不再参与运行 |

**生命周期由 daemon 托管**（本机 WSL2 无 systemd）：serve 启动时探测 judge url——健康且代际记录
（argsHash）一致 → 复用（重启无间隙）；不健康或配置已变 → 停旧拉新（/proc cmdline 核对防误杀）；
运行中每 60s 自愈探测，网关崩溃自动复活；daemon 停止不杀网关（无状态，留给下一个 daemon）。
手拉网关（无代际记录）占着端口时 sidecar 不越权接管，日志提示人工处理。

激活只需 `data/host.json`（无 sidecar 段则网关不受管，行为同旧版）：

```json
{
  "judge": {
    "url": "http://127.0.0.1:7610",
    "model": "jevlike-local",
    "sidecar": {
      "command": "~/.venvs/jevlike/bin/python",
      "args": ["<repo>/tools/jevlike/server.py", "--port", "7610",
               "--ckpt", "command:=<repo>/data/jevlike/host-v8.pt",
               "--ckpt", "content:=<repo>/data/jevlike/host-v8.pt",
               "--ckpt", "output:=<repo>/data/jevlike/host-v8.pt",
               "--fallback", "reject"]
    }
  },
  "guard": { "mode": "block" }
}
```

### 运维 runbook

| 症状 | 处置 |
|---|---|
| 网关响应慢/无响应 | `tail data/jevlike/gateway.log`；sidecar 60s 内自动复活，无需人工 |
| 换 checkpoint/改参数 | 改 `host.json` sidecar.args → `POST /api/restart`；代际哈希变化自动停旧拉新 |
| 端口被手拉进程占用 | sidecar 不越权接管：手动停旧进程后自愈即接管 |
| venv 丢失 | `python3 -m venv ~/.venvs/jevlike` + 重跑部署第 1 步（pip cache 离线秒装） |
| 数据/checkpoint 全丢 | `gen-data.py`（seed 42/7）+ `jevlike-train` 可复现；lab 存档还有历史版本 |

## 限制

- byte-level encoder，192 字节 context（可加大但 tiny 头容量有限）
- 只支持 Choice 打分头：noul/score 是映射（官方语义等价性未经官方端点校验）
- 中文占 3 字节/字，192 字节预算下 context 实际容量 ~60 汉字
- 服务是标准库 http.server（ThreadingHTTPServer），并发足够本机 judge 旁路使用
