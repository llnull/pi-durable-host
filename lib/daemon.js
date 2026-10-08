// Daemon discovery + HTTP forwarding for the CLI (host.js).
//
// While `host.js serve` runs it owns the storage lock, so every other CLI
// command would be rejected. Instead of failing, those commands detect the
// daemon through data/serve.json and forward over HTTP — the CLI becomes a
// thin client of the one process that may touch the storage.
//
// serve.json holds no secret: only pid / port / host / whether a token is
// required. The token (when set) comes from the caller's PI_DURABLE_TOKEN.
import { renameSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { readPid } from "./lock.js";

export function serveInfoFile(dataDir) {
	return `${dataDir}/serve.json`;
}

/** The daemon writes its contact info when it starts listening. */
export function writeServeInfo(file, { pid, port, host, hasToken }) {
	const tmp = `${file}.tmp-${pid}`;
	writeFileSync(tmp, `${JSON.stringify({ pid, port, host, hasToken: Boolean(hasToken) }, null, "\t")}\n`);
	renameSync(tmp, file);
}

export function clearServeInfo(file) {
	try {
		const info = readServeInfo(file);
		if (!info || info.pid === process.pid) unlinkSync(file);
	} catch {}
}

export function readServeInfo(file) {
	try {
		const info = JSON.parse(readFileSync(file, "utf8"));
		if (Number.isInteger(info?.pid) && Number.isInteger(info?.port)) return info;
	} catch {}
	return undefined;
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM";
	}
}

/**
 * The running daemon this CLI should forward to, or null.
 * Trusts serve.json only when its pid is alive and still holds the host lock.
 */
export function detectDaemon(dataDir) {
	const info = readServeInfo(serveInfoFile(dataDir));
	if (!info) return null;
	if (!isAlive(info.pid)) return null;
	const lockPid = readPid(`${dataDir}/host.lock`);
	if (lockPid !== info.pid) return null;
	const token = process.env.PI_DURABLE_TOKEN;
	if (info.hasToken && !token) {
		throw new Error(
			`daemon 正在运行（pid ${info.pid}）且需要 token：请设置 PI_DURABLE_TOKEN 后重试本命令。`,
		);
	}
	const host = info.host === "0.0.0.0" || info.host === "::" ? "127.0.0.1" : (info.host ?? "127.0.0.1");
	return { pid: info.pid, port: info.port, baseUrl: `http://${host}:${info.port}`, headers: token ? { "x-token": token } : {} };
}

/** Fetch a daemon API endpoint and return the parsed JSON; throws on error status. */
export async function daemonApi(daemon, method, pathname, body) {
	const res = await fetch(daemon.baseUrl + pathname, {
		method,
		headers: { "content-type": "application/json", ...daemon.headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data?.error ?? `${method} ${pathname} → HTTP ${res.status}`);
	return data;
}
