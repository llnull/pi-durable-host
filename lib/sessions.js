// Named sessions: a session name maps to a durable conversation id.
// "default" is always the reserved root conversation (ROOT_CONVERSATION_ID = 1)
// so existing data keeps working; every other session is an ownerless
// conversation created on demand (scheduled by the harness like the root).
//
//   data/sessions.json  { current: "default", sessions: { name: { conversationId, createdAt, note } } }
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";

export const DEFAULT_SESSION = "default";

const NAME_RE = /^[\w][\w.-]{0,63}$/; // letters/digits/_/-/. — safe as a filename and for shell display

export function assertSessionName(name) {
	if (!NAME_RE.test(String(name ?? ""))) {
		throw new Error(`会话名不合法：${name}（字母/数字开头，可含 _ . -，最长 64）`);
	}
}

export function readSessions(file) {
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		parsed = undefined;
	}
	const sessions = { ...parsed?.sessions };
	if (!sessions[DEFAULT_SESSION] || !Number.isInteger(sessions[DEFAULT_SESSION].conversationId)) {
		sessions[DEFAULT_SESSION] = { conversationId: ROOT_CONVERSATION_ID, createdAt: new Date(0).toISOString(), note: "root conversation" };
	}
	const current = parsed?.current && sessions[parsed.current] ? parsed.current : DEFAULT_SESSION;
	return { current, sessions };
}

export function writeSessions(file, { current, sessions }) {
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify({ current, sessions }, null, "\t")}\n`);
	renameSync(tmp, file);
}

export function sessionsFile(dataDir) {
	return `${dataDir}/sessions.json`;
}

/** The durable conversation id a session name refers to. */
export function sessionConversationId(store, name) {
	const entry = store.sessions[name];
	if (!entry) throw new Error(`会话不存在：${name}（node host.js sessions 查看）`);
	return entry.conversationId;
}
