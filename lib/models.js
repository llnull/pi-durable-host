// Multi-host model layer: the same host code runs on every machine, picking
// the model backend that the machine provides.
//
//   1. PI_DURABLE_PROVIDER=ark          → Ark relay (anthropic-messages): needs
//      ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY, plus the relay URL from
//      ARK_BASE_URL or the machine-local data/ark.json (never in the repo).
//   2. PI_DURABLE_PROVIDER=<pi id>       → a provider from this machine's pi
//      CLI config, e.g. PI_DURABLE_PROVIDER=zai-coding-cn.
//   3. auto (recommended): if ~/.pi/agent holds an authenticated provider, use
//      it — provider id, API key and the full model catalog are read from the
//      local pi config (auth.json / models-store.json), and the default model
//      follows pi's own settings.json. Otherwise fall back to the Ark relay
//      when a relay token is present.
//
// PI_DURABLE_MODEL overrides the default model id on any path.
// PI_DURABLE_PI_DIR overrides the pi agent directory (default ~/.pi/agent).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const PI_DIR = process.env.PI_DURABLE_PI_DIR ?? path.join(homedir(), ".pi", "agent");
// 机器本地数据目录（与 host.js 的 PI_DURABLE_DATA_DIR 解析一致）；ark.json 属于机器配置，不入库
const DATA_DIR = process.env.PI_DURABLE_DATA_DIR
	? path.resolve(process.env.PI_DURABLE_DATA_DIR)
	: path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "data");
// Ark relay 地址：env 覆盖 > 机器本地 data/ark.json；仓库不含任何默认地址
const ARK_BASE_URL = process.env.ARK_BASE_URL ?? readJson(path.join(DATA_DIR, "ark.json"))?.baseUrl ?? "";

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** Provider ids that hold an api_key credential in the local pi auth.json. */
function piAuthProviders() {
	const auth = readJson(path.join(PI_DIR, "auth.json"));
	if (!auth || typeof auth !== "object") return [];
	return Object.keys(auth).filter((id) => auth[id]?.type === "api_key" && auth[id]?.key);
}

/** Chat models of one provider as stored by pi's models-store.json. */
function piModelsFor(providerId) {
	const store = readJson(path.join(PI_DIR, "models-store.json"));
	const models = store?.[providerId]?.models;
	return Array.isArray(models) ? models.filter((m) => (m.type ?? "chat") === "chat") : [];
}

/** pi's own default { defaultProvider, defaultModel } from settings.json. */
function piDefaults() {
	const settings = readJson(path.join(PI_DIR, "settings.json"));
	return { provider: settings?.defaultProvider, model: settings?.defaultModel };
}

function arkTarget() {
	if (!ARK_BASE_URL) throw new Error("使用 Ark relay 需要提供地址：设置 ARK_BASE_URL，或在 data/ark.json 写 {\"baseUrl\": \"...\"}");
	return {
		kind: "ark",
		id: "ark",
		name: "Ark Code relay",
		baseUrl: ARK_BASE_URL,
		defaultModel: process.env.PI_DURABLE_MODEL ?? "ark-code-latest",
		models: [
			{
				id: process.env.PI_DURABLE_MODEL ?? "ark-code-latest",
				name: "Ark Code (relay)",
				api: "anthropic-messages",
				provider: "ark",
				baseUrl: ARK_BASE_URL,
				reasoning: true,
				input: ["text"],
				contextWindow: 200000,
				maxTokens: 65536,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
		envVars: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"],
		piProviderId: undefined,
		authSource: "ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY",
	};
}

function piTarget(providerId) {
	const models = piModelsFor(providerId);
	if (models.length === 0) {
		throw new Error(
			`本机 pi 配置中 provider ${providerId} 没有可用模型（${path.join(PI_DIR, "models-store.json")}）。` +
				"在 pi 里跑 `pi update --models` 后重试。",
		);
	}
	const defaults = piDefaults();
	const wanted = process.env.PI_DURABLE_MODEL ?? (defaults.provider === providerId ? defaults.model : undefined);
	const defaultModel = (wanted && models.some((m) => m.id === wanted) ? wanted : models[0].id);
	return {
		kind: "pi",
		id: providerId,
		name: providerId,
		baseUrl: models[0].baseUrl,
		defaultModel,
		models,
		envVars: [`PI_DURABLE_KEY_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`],
		piProviderId: providerId,
		authSource: `~/.pi/agent/auth.json (${providerId})`,
	};
}

/**
 * Resolve which backend this run uses. PI_DURABLE_PROVIDER wins; then the
 * local pi config; then the Ark relay when a token is present.
 */
export function resolveModelTarget() {
	const explicit = process.env.PI_DURABLE_PROVIDER;
	if (explicit === "ark") return arkTarget();
	if (explicit) return piTarget(explicit);

	const providers = piAuthProviders();
	if (providers.length > 0) {
		const defaults = piDefaults();
		const id = defaults.provider && providers.includes(defaults.provider) ? defaults.provider : providers[0];
		return piTarget(id);
	}
	if (ARK_BASE_URL && (process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY)) return arkTarget();
	throw new Error(
		"找不到模型来源。两种主机任选其一：\n" +
			"  1. 本机 pi 配置：在 pi 里 /login 一个 api-key provider（~/.pi/agent/auth.json）\n" +
			"  2. Ark relay：export ANTHROPIC_AUTH_TOKEN=... 与 ARK_BASE_URL=...（或在 data/ark.json 配置地址）\n" +
			"或用 PI_DURABLE_PROVIDER=ark|<pi provider id> 显式指定。",
	);
}

/** Api-key auth: dedicated env var wins, then the local pi credential store. */
function apiKeyAuth(name, { envVars, piProviderId }) {
	return {
		name,
		resolve: async () => {
			for (const v of envVars) {
				const value = process.env[v];
				if (value) return { auth: { apiKey: value }, source: v };
			}
			if (piProviderId) {
				const auth = readJson(path.join(PI_DIR, "auth.json"));
				const key = auth?.[piProviderId]?.key;
				if (key) return { auth: { apiKey: key }, source: `~/.pi/agent/auth.json (${piProviderId})` };
			}
			return { auth: {} };
		},
	};
}

/**
 * Build the pi-ai models registry plus the default { provider, modelId }.
 * Api implementations are dispatched by each model's `api` field, so a
 * provider catalog may mix anthropic-messages and openai-completions models.
 */
export function openModelLayer() {
	const target = resolveModelTarget();
	const models = createModels();
	const apiMap = {};
	for (const model of target.models) {
		if (model.api === "anthropic-messages" && !apiMap["anthropic-messages"]) {
			apiMap["anthropic-messages"] = anthropicMessagesApi();
		} else if (model.api === "openai-completions" && !apiMap["openai-completions"]) {
			apiMap["openai-completions"] = openAICompletionsApi();
		}
	}
	if (Object.keys(apiMap).length === 0) {
		throw new Error(`provider ${target.id} 的模型没有已知的 api 实现（${target.models.map((m) => m.api).join(", ")}）`);
	}
	const provider = createProvider({
		id: target.id,
		name: target.name,
		baseUrl: target.baseUrl,
		auth: { apiKey: apiKeyAuth(`${target.name} API key`, { envVars: target.envVars, piProviderId: target.piProviderId }) },
		models: target.models,
		api: apiMap,
	});
	models.setProvider(provider);
	return {
		models,
		model: { provider: target.id, modelId: target.defaultModel },
		source: `${target.id}/${target.defaultModel} via ${target.authSource}` + (target.kind === "pi" ? "（本机 pi 配置）" : ""),
		// [{ id, name, api, reasoning }] for /api/models and the web UI switcher.
		catalog: target.models.map((m) => ({ id: m.id, name: m.name ?? m.id, api: m.api, reasoning: Boolean(m.reasoning) })),
	};
}
