// Multi-host model layer: the same host code runs on every machine and reuses
// whatever the local pi CLI config (~/.pi/agent) provides — the host keeps no
// provider config of its own:
//
//   - models.json        custom providers (relay / self-hosted endpoints):
//                        baseUrl + api + model catalog; apiKey values support
//                        $VAR / ${VAR} environment references
//   - auth.json          api-key credentials stored by pi /login
//   - models-store.json  model catalogs maintained by `pi update --models`
//   - settings.json      defaultProvider / defaultModel
//
// PI_DURABLE_PROVIDER=<id> picks a provider explicitly (custom providers and
// auth-store providers alike). PI_DURABLE_MODEL overrides the default model id
// on any path. PI_DURABLE_KEY_<ID> overrides a credential.
// PI_DURABLE_PI_DIR overrides the pi agent directory (default ~/.pi/agent).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const PI_DIR = process.env.PI_DURABLE_PI_DIR ?? path.join(homedir(), ".pi", "agent");

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

/** ~/.pi/agent/models.json 的自定义 providers（pi CLI 的自定义端点配置，host 直接复用）。 */
function modelsJsonProviders() {
	const raw = readJson(path.join(PI_DIR, "models.json"));
	return raw && typeof raw === "object" && raw.providers && typeof raw.providers === "object" ? raw.providers : {};
}

/** models.json 配置值：$VAR / ${VAR} → 环境变量，其余字面量（pi 的 "!command" 形式本 host 不支持）。 */
function resolveConfigValue(value) {
	if (typeof value !== "string") return value;
	if (value.startsWith("!")) throw new Error(`models.json 的 "!command" 配置值本 host 不支持：${value.slice(0, 40)}`);
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a, b) => {
		const name = a || b;
		const v = process.env[name];
		if (v === undefined) throw new Error(`models.json 引用的环境变量 ${name} 未设置`);
		return v;
	});
}

/** models.json 自定义 provider → 与 models-store 同构的 target（api/baseUrl 在 provider 级，模型继承）。 */
function customTarget(id, cfg) {
	const api = cfg.api;
	if (typeof api !== "string") throw new Error(`models.json provider ${id}：缺少 string 类型的 api 字段（如 "anthropic-messages"）`);
	const baseUrl = typeof cfg.baseUrl === "string" ? cfg.baseUrl : undefined;
	const models = (Array.isArray(cfg.models) ? cfg.models : []).map((m) => ({
		id: m.id,
		name: m.name ?? m.id,
		type: "chat",
		api,
		provider: id,
		baseUrl: m.baseUrl ?? baseUrl,
		reasoning: Boolean(m.reasoning),
		input: Array.isArray(m.input) ? m.input : ["text"],
		contextWindow: m.contextWindow ?? 200000,
		maxTokens: m.maxTokens ?? 65536,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
	if (models.length === 0) throw new Error(`models.json provider ${id} 没有模型`);
	const defaults = piDefaults();
	const wanted = process.env.PI_DURABLE_MODEL ?? (defaults.provider === id ? defaults.model : undefined);
	const defaultModel = wanted && models.some((m) => m.id === wanted) ? wanted : models[0].id;
	return {
		kind: "pi",
		id,
		name: id,
		baseUrl: baseUrl ?? models[0].baseUrl,
		defaultModel,
		models,
		envVars: [],
		piProviderId: id,
		authSource: `~/.pi/agent/models.json (${id})`,
		apiKeyOverride: cfg.apiKey !== undefined ? resolveConfigValue(cfg.apiKey) : undefined,
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
 * machine's pi config: settings.json defaultProvider, then models.json custom
 * providers, then auth.json credentials.
 */
export function resolveModelTarget() {
	const explicit = process.env.PI_DURABLE_PROVIDER;
	if (explicit) return resolveProviderTarget(explicit);

	const tried = [];
	const candidates = [];
	const defaults = piDefaults();
	if (defaults.provider) candidates.push(defaults.provider);
	for (const id of Object.keys(modelsJsonProviders())) if (!candidates.includes(id)) candidates.push(id);
	for (const id of piAuthProviders()) if (!candidates.includes(id)) candidates.push(id);
	for (const id of candidates) {
		try {
			return resolveProviderTarget(id);
		} catch (error) {
			tried.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(
		"找不到模型来源（本机 pi 配置为空）。任选其一：\n" +
			"  1. 在 pi 里 /login 一个 api-key provider（~/.pi/agent/auth.json）\n" +
			"  2. 在 ~/.pi/agent/models.json 配置自定义 provider（中继/自建端点，见 README 示例）\n" +
			"  3. PI_DURABLE_PROVIDER=<provider id> 显式指定" +
			(tried.length ? `\n已尝试 → ${tried.join("；")}` : ""),
	);
}

/** 按 id 解析 provider：models.json 自定义优先，其次 models-store + auth.json。 */
function resolveProviderTarget(id) {
	const custom = modelsJsonProviders()[id];
	return custom ? customTarget(id, custom) : piTarget(id);
}

/** Api-key auth: dedicated env var wins, then the local pi credential store, then models.json. */
function apiKeyAuth(name, { envVars, piProviderId, apiKeyOverride }) {
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
			if (apiKeyOverride) return { auth: { apiKey: apiKeyOverride }, source: "~/.pi/agent/models.json" };
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
		auth: { apiKey: apiKeyAuth(`${target.name} API key`, { envVars: target.envVars, piProviderId: target.piProviderId, apiKeyOverride: target.apiKeyOverride }) },
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
