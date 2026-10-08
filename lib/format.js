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

/** Assemble the status payload (server /api/status and local `host.js status`). */
export async function collectStatus({ harness, conv, modelSource, context }) {
	const view = (await conv.viewState(context)).value ?? {};
	const live = view.docs?.["pi.live"] ?? {};
	const agent = await conv.agent(context);
	const graph = await harness.taskGraph(context);
	const nodes = Object.values((graph.value ?? graph).tasks ?? {});
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
		tasks: nodes.map((node) => ({
			id: node.id,
			kind: node.kind,
			status: node.state.status,
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
	for (const c of status.compactions ?? []) console.log(`compaction: ${c.reason}${c.blocking ? " (blocking)" : ""} attempt ${c.attempt}`);
	console.log("inbox:", (status.inbox ?? []).length === 0 ? "(empty)" : "");
	for (const item of status.inbox ?? []) console.log(`  [${item.mode}] ${oneLine(String(item.content), 100)}`);
	console.log("entries:", status.entries);
	const agent = status.agent ?? {};
	console.log(
		`agent: ${agent.model?.provider}/${agent.model?.modelId} · cwd=${agent.cwd} · extensions=${(agent.extensions ?? []).map((e) => e.name).join(",")}`,
	);
	const u = status.usage ?? {};
	console.log(`usage: input=${u.input ?? 0} output=${u.output ?? 0} cacheRead=${u.cacheRead ?? 0} (tokens)`);
	console.log("live tasks:", (status.tasks ?? []).length === 0 ? "(none)" : "");
	for (const node of status.tasks ?? []) {
		console.log(`  #${node.id} ${node.kind} ${node.state.status}${node.background ? " (background)" : ""}${node.owner ? ` (owner #${node.owner})` : ""}`);
	}
}
