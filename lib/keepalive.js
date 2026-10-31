// daemon → judge 网关的 HTTP 出口统一走本模块：进程级 keep-alive 连接池。
// 背景（2026-10-31 排查）：global fetch（undici）连接池空闲 ~4s 即断开，而 UI 每 10s
// 轮询网关状态、sidecar 每 60s 探活、judge 每次调用一条——每次都开新连接、给内核
// 留一个 30s 的 TIME_WAIT。在 TIME_WAIT 回收迟滞的内核上（实测同一 (ip,port) 元组
// 堆积 ~5k 后新 SYN 被静默丢弃：探活全灭 → daemon 判死换血 → 换血风暴又制造更多
// 连接 → 慢性循环，issue #146 的 502 次换血即此病），host 自己就是连接垃圾的最大
// 制造者。原生 http(s).Agent 空闲不掐线：10s 间隔的轮询恰好一直续命，稳态连接
// 创建数 ≈ 0——host 不得有能力把机器 TCP 表毒化到需要重启系统。
import http from "node:http";
import https from "node:https";

const agents = {
	"http:": new http.Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 8, maxFreeSockets: 4 }),
	"https:": new https.Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 8, maxFreeSockets: 4 }),
};

/**
 * POST JSON，resolve { status, json() }。任何 HTTP 应答（含 4xx/5xx）都 resolve——
 * 状态码语义留给调用方（探活约定「任何应答都算在位」）。
 * 池化空闲 socket 可能刚好被对端关闭（ECONNRESET/EPIPE）——这是复用语义而非故障：
 * 自动换新 socket 重试一次（探活/judge 调用均幂等，重试安全）。
 */
export function postJson(urlStr, body, timeoutMs = 5000, extraHeaders = {}) {
	return new Promise((resolve, reject) => {
		const attempt = (retried) => {
			let u;
			try { u = new URL(urlStr); } catch (err) { reject(err); return; }
			const mod = u.protocol === "https:" ? https : http;
			const agent = agents[u.protocol] ?? agents["http:"];
			const payload = Buffer.from(JSON.stringify(body ?? {}));
			const req = mod.request(
				{
					hostname: u.hostname,
					port: u.port || (u.protocol === "https:" ? 443 : 80),
					path: `${u.pathname}${u.search}`,
					method: "POST",
					agent,
					headers: { "content-type": "application/json", "content-length": payload.length, ...extraHeaders },
				},
				(res) => {
					const chunks = [];
					res.on("data", (c) => chunks.push(c));
					res.on("end", () => {
						const text = Buffer.concat(chunks).toString("utf8");
						resolve({
							status: res.statusCode,
							json: () => {
								try { return Promise.resolve(JSON.parse(text)); } catch (err) { return Promise.reject(err); }
							},
						});
					});
				},
			);
			req.setTimeout(timeoutMs, () => req.destroy(new Error(`postJson timeout after ${timeoutMs}ms`)));
			req.on("error", (err) => {
				if (!retried && (err.code === "ECONNRESET" || err.code === "EPIPE")) { attempt(true); return; }
				reject(err);
			});
			req.end(payload);
		};
		attempt(false);
	});
}
