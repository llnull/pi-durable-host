// Multi-host model layer: the same host code runs on every machine and reuses
// whatever the local pi CLI config (~/.pi/agent) provides — the host keeps no
// provider config of its own:
//
//   - models.json        providers layered over the built-in catalog, read with
//                        pi's lenient JSON (BOM, // line comments, trailing
//                        commas) and composed with pi's semantics: an entry
//                        whose id matches a built-in provider changes it (its
//                        models merge by id in place; provider baseUrl / compat
//                        apply to the built-in models too; modelOverrides patch
//                        them field by field); any other id adds a provider.
//                        apiKey / headers values support $VAR / ${VAR}.
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

/**
 * pi 的宽松 JSON（pi-coding-agent utils/json.ts 同源）：去 BOM，去 `//` 行注释与尾逗号，
 * 字符串字面量原样保留（URL 里的 `//` 不受影响）。pi 允许在 models.json 里写注释——
 * 用严格 JSON.parse 读会让整个文件（连同其中的自定义模型）被静默丢弃。
 */
export function stripJsonComments(input) {
	return input
		.replace(/^\uFEFF/, "")
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => (m[0] === '"' ? m : tail));
}

function readLenientJson(file) {
	try {
		return JSON.parse(stripJsonComments(readFileSync(file, "utf8")));
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

const isChat = (m) => (m?.type ?? "chat") === "chat";

/** Chat models of one provider as stored by pi's models-store.json (the built-in catalog cache). */
function piModelsFor(providerId) {
	const store = readJson(path.join(PI_DIR, "models-store.json"));
	const models = store?.[providerId]?.models;
	return Array.isArray(models) ? models.filter(isChat) : [];
}

/** pi's own default { defaultProvider, defaultModel } from settings.json. */
function piDefaults() {
	const settings = readJson(path.join(PI_DIR, "settings.json"));
	return { provider: settings?.defaultProvider, model: settings?.defaultModel };
}

/** ~/.pi/agent/models.json 的 providers（pi CLI 的自定义/覆盖配置，host 直接复用；宽松 JSON）。 */
function modelsJsonProviders() {
	const raw = readLenientJson(path.join(PI_DIR, "models.json"));
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

// --- 组合语义（pi-coding-agent core/provider-composer.ts 同源）-----------------
// 以下四个函数逐字段对应 pi 的实现，保证同一份 models.json 在 pi CLI 与本 host 里得到同一个模型目录。

function mergeCompat(base, override) {
	if (!override) return base;
	const merged = { ...base, ...override };
	for (const key of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs", "chatTemplateArgs"]) {
		const b = base?.[key];
		const o = override[key];
		if ((typeof b === "object" && b !== null) || (typeof o === "object" && o !== null)) merged[key] = { ...b, ...o };
	}
	return merged;
}

function mergeInputLimits(base, override) {
	if (!override) return base;
	return {
		...base,
		...override,
		images: override.images
			? { ...base?.images, ...override.images, resize: override.images.resize ? { ...base?.images?.resize, ...override.images.resize } : base?.images?.resize }
			: base?.images,
	};
}

function mergeSamplingParamsByThinkingLevel(base, override) {
	if (!override) return base;
	const merged = { ...base };
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		if (override[level]) merged[level] = { ...base?.[level], ...override[level] };
	}
	return merged;
}

/** pi modelOverrides：对象型字段（cost / compat / inputLimits / promptCache / samplingParams…）逐字段合并，其余整体替换。 */
function applyModelOverride(model, override) {
	if (!override || typeof override !== "object") return model;
	return {
		...model,
		name: override.name ?? model.name,
		reasoning: override.reasoning ?? model.reasoning,
		thinkingLevelMap: override.thinkingLevelMap ? { ...model.thinkingLevelMap, ...override.thinkingLevelMap } : model.thinkingLevelMap,
		input: override.input ?? model.input,
		inputLimits: mergeInputLimits(model.inputLimits, override.inputLimits),
		cost: override.cost
			? {
				input: override.cost.input ?? model.cost?.input,
				output: override.cost.output ?? model.cost?.output,
				cacheRead: override.cost.cacheRead ?? model.cost?.cacheRead,
				cacheWrite: override.cost.cacheWrite ?? model.cost?.cacheWrite,
				tiers: override.cost.tiers ?? model.cost?.tiers,
			}
			: model.cost,
		promptCache: override.promptCache ? { ...model.promptCache, ...override.promptCache } : model.promptCache,
		contextWindow: override.contextWindow ?? model.contextWindow,
		maxTokens: override.maxTokens ?? model.maxTokens,
		samplingParams: override.samplingParams ? { ...model.samplingParams, ...override.samplingParams } : model.samplingParams,
		samplingParamsByThinkingLevel: mergeSamplingParamsByThinkingLevel(model.samplingParamsByThinkingLevel, override.samplingParamsByThinkingLevel),
		compat: mergeCompat(model.compat, override.compat),
	};
}

/** pi modelFromJson：models.json 的一个 models 条目 → 完整模型对象（缺省值与 pi 一致：contextWindow 128000 / maxTokens 16384）。 */
function modelFromJson(providerId, def, cfg, models) {
	if (!def || typeof def !== "object" || typeof def.id !== "string" || !def.id) throw new Error(`models.json provider ${providerId}：模型条目缺少 string 类型的 id`);
	const existing = models.filter(isChat);
	const wantedApi = def.api ?? cfg.api;
	const defaults =
		existing.find((m) => m.id === def.id) ??
		(wantedApi ? existing.find((m) => m.api === wantedApi) : undefined) ??
		existing.find((m) => m.api === "openai-completions") ??
		existing[0];
	const api = def.api ?? cfg.api ?? defaults?.api;
	if (typeof api !== "string") throw new Error(`models.json provider ${providerId} 模型 ${def.id}：缺少 api（provider 或 model 级，如 "anthropic-messages"）`);
	const baseUrl = def.baseUrl ?? cfg.baseUrl ?? defaults?.baseUrl;
	if (typeof baseUrl !== "string") throw new Error(`models.json provider ${providerId}：自定义模型需要 baseUrl`);
	if (def.contextWindow !== undefined && !(def.contextWindow > 0)) throw new Error(`models.json provider ${providerId} 模型 ${def.id}：contextWindow 非法`);
	if (def.maxTokens !== undefined && !(def.maxTokens > 0)) throw new Error(`models.json provider ${providerId} 模型 ${def.id}：maxTokens 非法`);
	return {
		id: def.id,
		name: def.name ?? def.id,
		api,
		provider: providerId,
		baseUrl,
		reasoning: def.reasoning ?? false,
		thinkingLevelMap: def.thinkingLevelMap,
		input: def.input ?? ["text"],
		inputLimits: def.inputLimits,
		cost: def.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		promptCache: def.promptCache,
		contextWindow: def.contextWindow ?? 128000,
		maxTokens: def.maxTokens ?? 16384,
		samplingParams: def.samplingParams,
		samplingParamsByThinkingLevel: def.samplingParamsByThinkingLevel,
		compat: mergeCompat(cfg.compat, def.compat),
	};
}

/**
 * pi applyModelsJson 同源：models.json 的 provider 条目叠加在内置目录之上。
 * 返回 { models, error }——组合失败（缺 api/baseUrl 等）时 models 为 undefined、error 带说明，由调用方决定是否跳过。
 */
function composeModels(providerId, cfg, base) {
	try {
		if (cfg && typeof cfg !== "object") throw new Error("provider 条目不是对象");
		let models = base.map((m) => ({ ...m, baseUrl: cfg?.baseUrl ?? m.baseUrl, ...(cfg?.compat ? { compat: mergeCompat(m.compat, cfg.compat) } : {}) }));
		for (const def of Array.isArray(cfg?.models) ? cfg.models : []) {
			const model = modelFromJson(providerId, def, cfg ?? {}, models);
			const index = models.findIndex((m) => m.id === model.id);
			if (index >= 0) models[index] = model; // 同 id → 原位替换（pi 语义）
			else models.push(model);
		}
		const overrides = cfg?.modelOverrides && typeof cfg.modelOverrides === "object" ? cfg.modelOverrides : {};
		models = models.map((m) => (overrides[m.id] ? applyModelOverride(m, overrides[m.id]) : m));
		if (models.length === 0) throw new Error(cfg ? "没有模型" : "没有可用模型");
		return { models };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * One provider's runtime target: its composed chat models, the default model,
 * and where its credential comes from. Same id in models.json and the built-in
 * catalog composes (pi semantics); models.json alone is a custom provider.
 */
function providerTarget(providerId) {
	const cfg = modelsJsonProviders()[providerId];
	const base = piModelsFor(providerId);
	if (!cfg && base.length === 0) {
		throw new Error(
			`本机 pi 配置中找不到 provider ${providerId}（${path.join(PI_DIR, "models.json")} / models-store.json）。` +
				"自定义端点请在 models.json 配置，内置目录缺失可在 pi 里跑 `pi update --models`。",
		);
	}
	const composed = composeModels(providerId, cfg, base);
	if (!composed.models) throw new Error(`models.json provider ${providerId}：${composed.error}`);
	const models = composed.models;
	const defaults = piDefaults();
	const wanted = process.env.PI_DURABLE_MODEL ?? (defaults.provider === providerId ? defaults.model : undefined);
	const defaultModel = wanted && models.some((m) => m.id === wanted) ? wanted : models[0].id;
	const custom = Boolean(cfg) && base.length === 0;
	return {
		id: providerId,
		kind: custom ? "custom" : "credential",
		name: (typeof cfg?.name === "string" && cfg.name) || providerId,
		baseUrl: models[0].baseUrl,
		defaultModel,
		models,
		envVars: [`PI_DURABLE_KEY_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`],
		piProviderId: providerId,
		apiKeyOverride: cfg?.apiKey !== undefined ? resolveConfigValue(cfg.apiKey) : undefined,
		headers: cfg?.headers && typeof cfg.headers === "object" ? cfg.headers : undefined,
		authHeader: cfg?.authHeader === true,
		authSource: cfg
			? `~/.pi/agent/models.json (${providerId})${base.length ? " ⊕ 内置目录" : ""}`
			: `~/.pi/agent/auth.json (${providerId})`,
	};
}

/**
 * Resolve which backend this run uses. PI_DURABLE_PROVIDER wins; then the
 * machine's pi config: settings.json defaultProvider, then models.json
 * providers, then auth.json credentials.
 */
export function resolveModelTarget() {
	const explicit = process.env.PI_DURABLE_PROVIDER;
	if (explicit) return providerTarget(explicit);

	const tried = [];
	const candidates = [];
	const defaults = piDefaults();
	if (defaults.provider) candidates.push(defaults.provider);
	for (const id of Object.keys(modelsJsonProviders())) if (!candidates.includes(id)) candidates.push(id);
	for (const id of piAuthProviders()) if (!candidates.includes(id)) candidates.push(id);
	for (const id of candidates) {
		try {
			return providerTarget(id);
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

/** 枚举全部可用 provider（按默认解析顺序）：解析不出 key 的跳过。 */
function listProviderTargets() {
	const ids = [];
	const defaults = piDefaults();
	if (defaults.provider) ids.push(defaults.provider);
	for (const id of Object.keys(modelsJsonProviders())) if (!ids.includes(id)) ids.push(id);
	for (const id of piAuthProviders()) if (!ids.includes(id)) ids.push(id);
	const out = [];
	for (const id of ids) {
		try {
			const target = providerTarget(id);
			if (!resolveApiKey(target).auth.apiKey) continue;
			out.push(target);
		} catch {}
	}
	return out;
}

/**
 * Api-key resolve core（同步）。优先级（pi 同源）：PI_DURABLE_KEY_<ID> 专有 env 覆盖 >
 * models.json 的 apiKey（配置键优先于登录凭证——pi 的 composeApiKeyAuth 同序）> pi 的 auth.json。
 * models.json 的 headers / authHeader 随凭证一起下发（值与 apiKey 同样支持 $VAR 引用）。
 */
function resolveApiKey({ envVars, piProviderId, apiKeyOverride, headers, authHeader }) {
	let key;
	let source;
	for (const v of envVars ?? []) {
		if (process.env[v]) {
			key = process.env[v];
			source = v;
			break;
		}
	}
	if (key === undefined && apiKeyOverride) {
		key = apiKeyOverride;
		source = "~/.pi/agent/models.json";
	}
	if (key === undefined && piProviderId) {
		const auth = readJson(path.join(PI_DIR, "auth.json"));
		const stored = auth?.[piProviderId]?.key;
		if (stored) {
			key = stored;
			source = `~/.pi/agent/auth.json (${piProviderId})`;
		}
	}
	if (key === undefined) return { auth: {} };
	const resolvedHeaders = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (typeof value === "string") resolvedHeaders[name] = resolveConfigValue(value);
	}
	if (authHeader) resolvedHeaders.Authorization = `Bearer ${key}`;
	return { auth: { apiKey: key, ...(Object.keys(resolvedHeaders).length ? { headers: resolvedHeaders } : {}) }, source };
}

/** Api-key auth resolver for createProvider（懒解析，核心见 resolveApiKey）。 */
function apiKeyAuth(name, options) {
	return { name, resolve: async () => resolveApiKey(options) };
}

/**
 * Build the pi-ai models registry plus the default { provider, modelId }.
 * Every usable provider in the local pi config is registered — models.json
 * providers (custom, or layered over the built-in catalog) and auth.json
 * credential providers alike — so the web UI can switch across providers
 * without a restart. The default follows the usual resolution order
 * (PI_DURABLE_PROVIDER → settings.json → models.json → auth.json). Providers
 * with no known api implementation or no resolvable credential are skipped;
 * failing to register the default target is fatal.
 */
export function openModelLayer() {
	const defaultTarget = resolveModelTarget();
	const targets = listProviderTargets();
	if (!targets.some((t) => t.id === defaultTarget.id)) targets.unshift(defaultTarget);
	const apiMap = {
		"anthropic-messages": anthropicMessagesApi(),
		"openai-completions": openAICompletionsApi(),
	};
	const models = createModels();
	const providers = [];
	for (const target of targets) {
		const usable = target.models.filter((m) => m.api === "anthropic-messages" || m.api === "openai-completions");
		if (usable.length === 0) {
			if (target.id === defaultTarget.id) throw new Error(`provider ${target.id} 的模型没有已知的 api 实现（${target.models.map((m) => m.api).join(", ")}）`);
			continue;
		}
		models.setProvider(createProvider({
			id: target.id,
			name: target.name,
			baseUrl: target.baseUrl,
			auth: { apiKey: apiKeyAuth(`${target.name} API key`, target) },
			models: usable,
			api: apiMap,
		}));
		providers.push({
			id: target.id,
			kind: target.kind,
			name: target.name,
			defaultModel: target.defaultModel,
			models: usable.map((m) => ({ id: m.id, name: m.name ?? m.id, api: m.api, reasoning: Boolean(m.reasoning), input: m.input ?? ["text"], contextWindow: m.contextWindow, maxTokens: m.maxTokens })),
		});
	}
	return {
		models,
		model: { provider: defaultTarget.id, modelId: defaultTarget.defaultModel },
		source: `${defaultTarget.id}/${defaultTarget.defaultModel} via ${defaultTarget.authSource}（本机 pi 配置）`,
		// Default provider's models（向后兼容字段）。
		catalog: providers.find((p) => p.id === defaultTarget.id)?.models ?? [],
		// [{ id, kind, name, defaultModel, models }] — 全部已注册的可用 provider。
		providers,
	};
}
