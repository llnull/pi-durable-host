import { ConversationTranscript } from "@earendil-works/pi-durable";
import { summarizeReports } from "./reports.js";

// CLI output formatting shared by local execution and daemon forwarding, so
// `node host.js status` prints the same thing whether it ran against the
// storage directly or through the daemon's /api/status.
export function oneLine(text, max = 160) {
	const flat = String(text).replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function textOf(message) {
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block) => block && block.type === "text")
			.map((block) => block.text)
			.join("");
	}
	return "";
}

/** Print a /api/history payload (chronological items: {kind, toolName?, text}). */
export function printHistory(items) {
	if (!items?.length) {
		console.log("(empty transcript)");
		return;
	}
	for (const item of items) {
		const head = item.toolName ? `${item.kind} ${item.toolName}` : item.kind;
		console.log(`${head}: ${oneLine(item.text)}`);
	}
}

/**
 * 活跃段：最新 head marker（压缩摘要 / 重置，entry.head = "First entry in the active context selected by this
 * entry"）的 head 起到末尾——与 pi-durable 1.3.0 视图的呈现范围逐条一致（真实数据核对 582/378/852/89 条全吻合）。
 * marker 取 id 最大的那个：一批条目里可能有多个 marker，取最旧的会把起点提前、多显示已被压缩掉的历史。
 */
export function activeEntries(entries) {
	const head = entries.findLast((e) => e.head !== undefined)?.head;
	return head === undefined ? entries : entries.filter((e) => e.id >= head);
}

/**
 * 把一个（窗口化的）view 补齐成「完整活跃段」视图：entries 是全量活跃段数组，其余字段原样。
 * pi-durable 1.5 起 view.entries 只是窗口（首值最新 50 条，超 100 条裁回 50），不再是整本 transcript；
 * ConversationTranscript 负责翻页与补洞，这里决定翻到哪为止：已加载到最新的 head marker、且覆盖了它的 head
 * （活跃段起点；压缩保留近段，head 常早于 marker 自身）即停——marker 之前的条目不进视图；没见过 marker 则翻到开头。
 * daemon 的 SSE 基线与 CLI status 共用这一份逻辑。
 * entries 落账后不可变 → 活跃段数组只增不改，前缀比较（diffFrames）照旧成立。
 */
export async function fillActiveView(transcript, view, context) {
	const entriesOf = (t) => t.items.filter((item) => item.kind === "entry").map((item) => item.entry);
	let tv = transcript.merge(view);
	for (let guard = 0; guard < 100_000; guard++) {
		const entries = entriesOf(tv);
		const head = entries.findLast((e) => e.head !== undefined)?.head; // 已加载范围内最新的 marker 的活跃段起点
		// 翻页停止条件 = 活跃段已完整载入：见过 marker，且已加载的最老条目不晚于 head。
		// 不能「见到 marker 就停」——压缩会保留近段，head 往往早于 marker 自身（实测 default 会话：head 2269 < marker 2438，
		// 见 marker 即停只载入 501/582 条）。没见过 marker 则翻到 transcript 开头。
		const needEarlier = head === undefined || entries[0].id > head;
		const hole = tv.items.find((item) => item.kind === "gap" || (item.kind === "earlier" && needEarlier));
		if (!hole) break;
		tv = hole.kind === "gap" ? await transcript.fillGap(hole, context) : await transcript.loadEarlier(context);
	}
	return { ...view, entries: activeEntries(entriesOf(tv)) };
}

/**
 * 一次性读取会话视图。pi-durable 1.5 移除了 `Conversation.viewState()`：改为挂一个最小窗口的 watch，读首值即停
 * ——不占 Session 线、不留常驻观察者。`full` 时经 fillActiveView 补齐成完整活跃段（与旧 viewState 等价，
 * status 的 entries 计数需要）；否则只有最新一条（只要 docs 时用）。
 */
export async function readView(conv, context, { full = false } = {}) {
	const watch = await conv.watch(context, { min: 1, max: full ? 100 : 1 });
	try {
		if (!full) return watch.value;
		const transcript = new ConversationTranscript((query, limit, ctx) => conv.entries(query, limit, undefined, ctx), { pageSize: 500 });
		return await fillActiveView(transcript, watch.value, context);
	} finally {
		await watch.stop();
	}
}

/** 一次性读取任务图（pi-durable 1.5 移除了 `Harness.taskGraph()`；同 readView 的挂-读-停）。 */
export async function readTaskGraph(harness, context) {
	const watch = await harness.watchTaskGraph(context);
	try {
		return watch.value;
	} finally {
		await watch.stop();
	}
}

/** Assemble the status payload (server /api/status and local `host.js status`). */
export async function collectStatus({ harness, conv, modelSource, context, reports }) {
	// full：entries 计数要是完整活跃段的条数（与 pi-durable 1.3.0 的 viewState 一致），窗口里的条数没有意义
	const view = await readView(conv, context, { full: true });
	const live = view.docs?.["pi.live"] ?? {};
	const agent = await conv.agent(context);
	const graph = await readTaskGraph(harness, context);
	const nodes = Object.values(graph?.tasks ?? {});
	let input = 0, output = 0, cacheRead = 0;
	for (const u of Object.values((await harness.usage(context))?.models ?? {})) {
		input += u.input ?? 0;
		output += u.output ?? 0;
		cacheRead += u.cacheRead ?? 0;
	}
	return {
		conversationId: conv.id,
		modelSource,
		busy: Boolean(live.run),
		run: live.run ? { taskId: live.run.taskId, inputs: live.run.inputs } : undefined,
		generation: live.generation,
		tools: live.tools ?? [],
		compactions: live.compactions ?? [],
		inbox: (view.docs?.["pi.inbox"]?.items ?? []).map((item) => ({
			mode: item.mode,
			content: item.content?.content ?? JSON.stringify(item.entry ?? ""),
		})),
		entries: (view.entries ?? []).length,
		agent,
		usage: { input, output, cacheRead },
		...(reports ? { reports: summarizeReports(reports) } : {}),
		tasks: nodes.map((node) => ({
			id: node.id,
			kind: node.kind,
			status: node.state?.status ?? "unknown",
			background: node.background,
			owner: node.owner,
		})),
	};
}

/** Print a /api/status payload (same shape the server assembles locally). */
export function printStatus(status) {
	console.log("conversation:", String(status.conversationId));
	console.log("model source:", status.modelSource);
	console.log(
		"busy:",
		status.busy ? `yes (run task ${status.run?.taskId}, inputs: ${(status.run?.inputs ?? []).join(", ")})` : "no",
	);
	if (status.busy && status.generation) {
		console.log(
			`generation: attempt ${status.generation.attempt}${status.generation.retry ? ` · retrying: ${status.generation.retry.error}` : ""}`,
		);
	}
	for (const tool of status.tools ?? []) console.log(`tool: ${tool.name} ${tool.status}`);
	// pi-durable 1.5：CompactionStatus.reason 更名 trigger（a run failure's `reason` is why it failed）；旧字段兜底只为协议兼容
	for (const c of status.compactions ?? []) console.log(`compaction: ${c.trigger ?? c.reason}${c.blocking ? " (blocking)" : ""} attempt ${c.attempt}`);
	console.log("inbox:", (status.inbox ?? []).length === 0 ? "(empty)" : "");
	for (const item of status.inbox ?? []) console.log(`  [${item.mode}] ${oneLine(String(item.content), 100)}`);
	console.log("entries:", status.entries);
	const agent = status.agent ?? {};
	console.log(
		`agent: ${agent.model?.provider}/${agent.model?.modelId} · cwd=${agent.cwd} · extensions=${(agent.extensions ?? []).map((e) => e.name).join(",")}`,
	);
	const u = status.usage ?? {};
	console.log(`usage: input=${u.input ?? 0} output=${u.output ?? 0} cacheRead=${u.cacheRead ?? 0} (tokens)`);
	if (status.reports?.count) {
		const last = status.reports.last;
		console.log(`系统事件: ${status.reports.count} 条（自 ${status.reports.since.slice(11, 19)}）· 最近：${last.label}${last.message ? " — " + oneLine(last.message, 100) : ""}`);
	}
	console.log("live tasks:", (status.tasks ?? []).length === 0 ? "(none)" : "");
	for (const node of status.tasks ?? []) {
		// collectStatus 映射后的节点是扁平形状（顶层 status），不是 graph 原始节点（state.status）
		console.log(`  #${node.id} ${node.kind} ${node.status ?? "?"}${node.background ? " (background)" : ""}${node.owner ? ` (owner #${node.owner})` : ""}`);
	}
}
