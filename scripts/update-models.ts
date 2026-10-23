// Regenerates src/models.ts from the upstream Neon AI Gateway catalog.
// Usage: npm run update-models
//
// The generated file owns NEON_MODELS and MODEL_CAPABILITIES. src/stream.ts
// reads MODEL_CAPABILITIES at request time, so upstream contract changes land
// here instead of in hand-coded branches.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MODELS_URL = "https://neon.com/models.json";

export interface UpstreamModel {
	id: string;
	type?: string;
	name?: string;
	family?: string;
	/** Upstream flags entries that are not yet generally available with released: false. */
	released?: boolean;
	reasoning?: boolean;
	/** Upstream reasoning controls, e.g. [{ type: "effort", values: ["low", "high"] }] for OpenAI models. */
	reasoning_options?: { type?: string; values?: string[] }[];
	tool_call?: boolean;
	temperature?: boolean;
	modalities?: { input?: string[] };
	limit?: { context?: number; output?: number };
	cost?: {
		input?: number;
		output?: number;
		/** USD per million tokens for cached input reads; omitted when not published. */
		cache_read?: number;
		/** USD per million tokens for cache writes; omitted when not published. */
		cache_write?: number;
	};
}

interface NeonModelInput {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	context: number;
	output: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * Canonical effort ladder used by Neon's OpenAI Responses endpoint
 * (https://neon.com/docs/ai-gateway/openai-responses). Live checks extended
 * it with "max" for gpt-6-1-sol and gpt-6-astra.
 */
const RESPONSES_EFFORT_LADDER = ["none", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * pi thinking levels (ModelThinkingLevel in @earendil-works/pi-ai:
 * off | minimal | low | medium | high | xhigh | max) mapped onto the desired
 * position in RESPONSES_EFFORT_LADDER. Levels the model does not support clamp
 * upward to the nearest supported effort so the gateway never receives an
 * effort value it rejects with 400.
 */
const PI_LEVEL_EFFORT_TARGET: Record<string, number> = {
	off: 0,
	minimal: 1,
	low: 1,
	medium: 2,
	high: 3,
	xhigh: 4,
	// Ladders that top out at xhigh fall back to the highest effort.
	max: 5,
};

interface ResponsesModelSpec {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	context: number;
	output: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	temperature: boolean;
	toolCall: boolean;
	efforts: readonly string[];
	/**
	 * True only for models that exist exclusively on the Responses endpoint
	 * and must be dropped from the chat catalog. Specs without the flag (the
	 * gpt-6-1-sol and gpt-6-astra entries) stay in both catalogs.
	 */
	responsesOnly?: boolean;
}

/**
 * Catalog for the `neon-responses` provider. gpt-5-3-codex and gpt-5-5-pro
 * are Responses-only; gpt-6-1-sol and gpt-6-astra reject "none" on chat so
 * function tools cannot work there, but they do full echo-tool round trips
 * with reasoning low on /openai/v1/responses (live-verified), so they are
 * exposed on both providers (text-only use keeps working on chat). Effort
 * values and metadata are reconciled against https://neon.com/models.json
 * at generation time.
 */
const RESPONSES_MODEL_SPECS: ResponsesModelSpec[] = [
	{
		id: "gpt-5-3-codex",
		name: "GPT-5.3 Codex",
		reasoning: true,
		input: ["text", "image"],
		context: 400_000,
		output: 128_000,
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
		temperature: true,
		toolCall: true,
		efforts: ["none", "low", "medium", "high", "xhigh"],
		responsesOnly: true,
	},
	{
		id: "gpt-5-5-pro",
		name: "GPT-5.5 Pro",
		reasoning: true,
		input: ["text", "image"],
		context: 1_050_000,
		output: 128_000,
		cost: { input: 30, output: 180, cacheRead: 0.175, cacheWrite: 0 },
		temperature: false,
		toolCall: true,
		efforts: ["medium", "high", "xhigh"],
		responsesOnly: true,
	},
	{
		id: "gpt-6-1-sol",
		name: "GPT-6.1 Sol",
		reasoning: true,
		input: ["text", "image"],
		context: 1_050_000,
		output: 128_000,
		cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		temperature: false,
		toolCall: true,
		efforts: ["low", "medium", "high", "xhigh", "max"],
	},
	{
		id: "gpt-6-astra",
		name: "GPT-6 Astra",
		reasoning: true,
		input: ["text", "image"],
		context: 1_050_000,
		output: 128_000,
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		temperature: false,
		toolCall: true,
		efforts: ["low", "medium", "high", "xhigh", "max"],
	},
];

/**
 * Canonical ids excluded from the chat catalog because they exist only on
 * the Responses endpoint. Derived from the responsesOnly flag so specs that
 * are also live-verified on chat (gpt-6-1-sol, gpt-6-astra) keep their chat
 * entries. The smoke-runner default routing uses this set too.
 */
export const RESPONSES_ONLY_MODELS = new Set(
	RESPONSES_MODEL_SPECS.filter((spec) => spec.responsesOnly).map((spec) => spec.id),
);

/**
 * Reconcile a Responses model's upstream reasoning_options against the
 * hardcoded effort values (including the shared gpt-6-1-sol and
 * gpt-6-astra entries). The thinkingLevelMap is derived from these values,
 * so upstream drift must fail the generation instead of emitting a wrong map.
 */
export function resolveResponsesEfforts(spec: ResponsesModelSpec, models: UpstreamModel[]): string[] {
	const upstream = models.find((model) => model.id.toLowerCase() === spec.id);
	if (!upstream || upstream.reasoning_options === undefined) return [...spec.efforts];
	const option = upstream.reasoning_options.find((entry) => entry.type === "effort");
	const actual = option?.values ?? [];
	if (
		actual.length !== spec.efforts.length ||
		actual.some((value, index) => value !== spec.efforts[index])
	) {
		throw new Error(
			`Upstream reasoning_options for ${spec.id} changed: expected [${spec.efforts.join(", ")}] but got [${actual.join(", ")}]. Update RESPONSES_MODEL_SPECS in scripts/update-models.ts and re-derive the thinkingLevelMap.`,
		);
	}
	return [...spec.efforts];
}

/**
 * Map pi thinking levels onto the model's supported effort values, clamping
 * upward when a level is unsupported. For gpt-5-5-pro this maps off and low
 * to "medium"; for gpt-6-1-sol and gpt-6-astra it clamps off and minimal up
 * to "low". The adapter would otherwise default effort to "none", which
 * these models reject with 400.
 */
export function thinkingLevelMapFor(efforts: readonly string[]): Record<string, string> {
	const ladderRank = new Map<string, number>(
		RESPONSES_EFFORT_LADDER.map((effort, index) => [effort, index] as const),
	);
	const unknown = efforts.filter((effort) => !ladderRank.has(effort));
	if (unknown.length > 0) {
		throw new Error(
			`Effort values [${unknown.join(", ")}] are not on the known ladder [${RESPONSES_EFFORT_LADDER.join(", ")}]. Update RESPONSES_EFFORT_LADDER and PI_LEVEL_EFFORT_TARGET in scripts/update-models.ts.`,
		);
	}
	const ranks = efforts.map((effort) => ladderRank.get(effort) as number);
	if (efforts.length === 0) {
		throw new Error("Effort values must not be empty; cannot derive a thinkingLevelMap.");
	}
	const fallback = efforts[efforts.length - 1] as string;
	const map: Record<string, string> = {};
	for (const [level, target] of Object.entries(PI_LEVEL_EFFORT_TARGET)) {
		const index = ranks.findIndex((rank) => rank >= target);
		map[level] = index === -1 ? fallback : (efforts[index] as string);
	}
	return map;
}

/**
 * Canonical Claude ids exposed on `/anthropic/v1/messages`. Mirrors the
 * upstream docs page (https://neon.com/docs/ai-gateway/anthropic-messages,
 * "Supported models" table). Update this set when a new Claude id lands
 * in the catalog and the docs page calls it out. The corresponding
 * `ANTHROPIC_MODELS` array is derived from `NEON_MODELS` by filtering on
 * this set, so every id here must also be present in the chat catalog.
 */
const ANTHROPIC_MODEL_IDS = new Set([
	"claude-fable-5",
	"claude-fable-5-1",
	"claude-haiku-4-5",
	"claude-haiku-5-5",
	"claude-opus-4-1",
	"claude-opus-4-5",
	"claude-opus-4-6",
	"claude-opus-4-7",
	"claude-opus-4-8",
	"claude-opus-5",
	"claude-opus-5-5",
	"claude-sonnet-4-5",
	"claude-sonnet-4-6",
	"claude-sonnet-5",
	"claude-sonnet-5-5",
]);

/** Models supported by this Chat Completions provider, excluding embeddings and Responses-only ids. */
export function isChatModel(model: UpstreamModel): boolean {
	return (model.type === undefined || model.type === "chat") &&
		!/embedding/i.test(model.family ?? "") && !RESPONSES_ONLY_MODELS.has(model.id.toLowerCase());
}

/**
 * Skip entries upstream has marked `released: false` (announced but not yet
 * generally available). An absent flag keeps the model so older snapshots
 * without the field still regenerate identical catalogs.
 */
export function isReleased(model: UpstreamModel): boolean {
	return model.released !== false;
}

const PI_INPUT = new Set(["text", "image"]);

/** Map an upstream entry onto the chat-model shape pi expects. */
export function toNeonModelInput(model: UpstreamModel): NeonModelInput {
	return {
		id: model.id,
		name: model.name ?? model.id,
		reasoning: model.reasoning === true,
		input: (model.modalities?.input ?? ["text"]).filter((m): m is "text" | "image" => PI_INPUT.has(m)),
		context: model.limit?.context ?? 0,
		output: model.limit?.output ?? 0,
		cost: {
			input: model.cost?.input ?? 0,
			output: model.cost?.output ?? 0,
			cacheRead: model.cost?.cache_read ?? 0,
			cacheWrite: model.cost?.cache_write ?? 0,
		},
	};
}

function fmt(n: number): string {
	return n >= 10_000 ? n.toLocaleString("en-US").replace(/,/g, "_") : String(n);
}

function entrySource(entry: NeonModelInput): string {
	return [
		"\tm({",
		`\t\tid: ${JSON.stringify(entry.id)},`,
		`\t\tname: ${JSON.stringify(entry.name)},`,
		`\t\treasoning: ${entry.reasoning},`,
		`\t\tinput: [${entry.input.map((i) => JSON.stringify(i)).join(", ")}],`,
		`\t\tcontext: ${fmt(entry.context)},`,
		`\t\toutput: ${fmt(entry.output)},`,
		`\t\tcost: { input: ${entry.cost.input}, output: ${entry.cost.output}, cacheRead: ${entry.cost.cacheRead}, cacheWrite: ${entry.cost.cacheWrite} },`,
		"\t}),",
	].join("\n");
}

function entrySourceAnthropic(entry: NeonModelInput): string {
	return entrySource(entry).replace(/^\tm\(\{/u, "\tmAnthropic({");
}

function entrySourceResponses(entry: NeonModelInput, thinkingLevelMap: Record<string, string>): string {
	const lines = entrySource(entry).split("\n");
	const mapLines = [
		"\t\tthinkingLevelMap: {",
		...Object.entries(thinkingLevelMap).map(
			([level, effort]) => `\t\t\t${level}: ${JSON.stringify(effort)},`,
		),
		"\t\t},",
	];
	return [...lines.slice(0, -1), ...mapLines, "\t}),"].join("\n");
}

function capabilityLine(id: string, temperature: boolean, toolCall: boolean): string {
	return `\t${JSON.stringify(id)}: { temperature: ${temperature}, toolCall: ${toolCall} },`;
}

function capabilitySource(id: string, model: UpstreamModel): string {
	return capabilityLine(id, model.temperature === true, model.tool_call === true);
}

export function buildModelsSource(models: UpstreamModel[]): string {
	// ANTHROPIC_MODELS is derived from this same list, so one filter covers both paths.
	const chat = models
		.filter((model) => isChatModel(model) && isReleased(model))
		.map(toNeonModelInput)
		.sort((a, b) => a.id.localeCompare(b.id));
	const capabilities = new Map<string, { temperature: boolean; toolCall: boolean }>();
	for (const entry of chat) {
		const upstream = models.find((model) => model.id === entry.id) as UpstreamModel;
		capabilities.set(entry.id, { temperature: upstream.temperature === true, toolCall: upstream.tool_call === true });
	}
	const responses = RESPONSES_MODEL_SPECS.map((spec) => {
		const upstream = models.find((model) => model.id.toLowerCase() === spec.id);
		capabilities.set(spec.id, {
			temperature: upstream ? upstream.temperature === true : spec.temperature,
			toolCall: upstream ? upstream.tool_call === true : spec.toolCall,
		});
		return { spec, thinkingLevelMap: thinkingLevelMapFor(resolveResponsesEfforts(spec, models)) };
	});
	const capEntries = Array.from(capabilities.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, cap]) => capabilityLine(id, cap.temperature, cap.toolCall))
		.join("\n");
	const anthropicEntries = chat
		.filter((entry) => ANTHROPIC_MODEL_IDS.has(entry.id))
		.sort((a, b) => a.id.localeCompare(b.id));
	const anthropicIds = Array.from(ANTHROPIC_MODEL_IDS).sort();
	const decisions = models
		.filter((model) => model.type === "decision" && isReleased(model))
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((model) => `\t{ id: ${JSON.stringify(model.id)}, name: ${JSON.stringify(model.name ?? model.id)}, inputCost: ${model.cost?.input ?? 0} },`)
		.join("\n");

	return `// Generated by scripts/update-models.ts from ${MODELS_URL}.
// Regenerate with \`npm run update-models\`. Do not edit by hand.
//
// Costs are USD per million tokens. cacheRead/cacheWrite come from the
// upstream cache_read/cache_write price keys and default to 0 when omitted.

import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";

type Api = "openai-completions";
type AnthropicApi = "anthropic-messages";
type ResponsesApi = "openai-responses";

interface NeonModelInput {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	context: number;
	output: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

interface CommonModelInput {
	id: string;
	name: string;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

function base(entry: NeonModelInput): CommonModelInput {
	return {
		id: entry.id,
		name: entry.name,
		baseUrl: "https://placeholder.invalid/v1",
		reasoning: entry.reasoning,
		input: entry.input,
		cost: entry.cost,
		contextWindow: entry.context,
		maxTokens: entry.output,
	};
}

function m(entry: NeonModelInput): Model<Api> {
	return { ...base(entry), api: "openai-completions", provider: "neon" };
}

function mAnthropic(entry: NeonModelInput): Model<AnthropicApi> {
	return { ...base(entry), api: "anthropic-messages", provider: "neon-anthropic" };
}

interface ResponsesModelInput extends NeonModelInput {
	thinkingLevelMap: ThinkingLevelMap;
}

function mResponses(entry: ResponsesModelInput): Model<ResponsesApi> {
	return {
		...base(entry),
		api: "openai-responses",
		provider: "neon-responses",
		thinkingLevelMap: entry.thinkingLevelMap,
	};
}

export const NEON_MODELS: Model<"openai-completions">[] = [
${chat.map(entrySource).join("\n")}
];

export interface NeonModelCapabilities {
	/** Upstream marks the model as rejecting the temperature sampling parameter. */
	temperature: boolean;
	/** Upstream marks the model as supporting function tools. */
	toolCall: boolean;
}

/** Per-model gateway contract from the upstream catalog, keyed by model id. */
export const MODEL_CAPABILITIES: Record<string, NeonModelCapabilities> = {
${capEntries}
};

const MODEL_IDS = new Set(NEON_MODELS.map((model) => canonicalModelId(model.id)));

export function canonicalModelId(id: string): string {
	const lower = id.toLowerCase();
	return lower.startsWith("databricks-") ? lower.slice("databricks-".length) : lower;
}

export function isKnownNeonModel(id: string): boolean {
	return MODEL_IDS.has(canonicalModelId(id));
}

/**
 * Canonical model ids exposed on the \`/anthropic/v1/messages\` endpoint.
 * Hardcoded in scripts/update-models.ts and reconciled with the upstream
 * docs page. Update the set there when a new Claude id is added.
 */
export const ANTHROPIC_MODEL_IDS: ReadonlySet<string> = new Set([
${anthropicIds.map((id) => `\t${JSON.stringify(id)},`).join("\n")}
]);

/**
 * Anthropic Messages catalog derived from \`NEON_MODELS\` so the two
 * providers share pricing, context windows, and capability metadata.
 * Each entry points at the \`anthropic-messages\` api and the
 * \`neon-anthropic\` provider so pi routes it to the right \`streamSimple\`.
 */
export const ANTHROPIC_MODELS: Model<AnthropicApi>[] = [
${anthropicEntries.map(entrySourceAnthropic).join("\n")}
];

/**
 * Responses-endpoint catalog for the \`/openai/v1/responses\` endpoint,
 * exposed on the \`neon-responses\` provider. Hardcoded in
 * scripts/update-models.ts: gpt-5-3-codex and gpt-5-5-pro are Responses-only,
 * while gpt-6-1-sol and gpt-6-astra keep their chat catalog entries for
 * text-only use. Reconciled with the upstream reasoning_options at
 * generation time. thinkingLevelMap maps pi thinking levels onto upstream
 * effort values, clamping when a level is unsupported so the gateway never
 * sees a rejected effort (e.g. "none" for gpt-5-5-pro).
 */
export const RESPONSES_MODELS: Model<ResponsesApi>[] = [
${responses
	.map(({ spec, thinkingLevelMap }) =>
		entrySourceResponses(spec as NeonModelInput, thinkingLevelMap).replace(/^\tm\(\{/u, "\tmResponses({"),
	)
	.join("\n")}
];

export interface NeonDecisionModel {
	id: string;
	name: string;
	/** USD per million input tokens; decision models have no output charge. */
	inputCost: number;
}

export const DECISION_MODELS: NeonDecisionModel[] = [
${decisions}
];
`;
}

async function main(): Promise<void> {
	const response = await fetch(MODELS_URL, {
		headers: { "User-Agent": "pi-provider-neon-ai-gateway-update-models" },
	});
	if (!response.ok) throw new Error(`Failed to fetch ${MODELS_URL}: ${response.status}`);
	const payload = (await response.json()) as {
		neon?: { models?: Record<string, UpstreamModel> | UpstreamModel[] };
	};
	const raw = payload.neon?.models;
	const models: UpstreamModel[] = Array.isArray(raw)
		? raw
		: raw
			? Object.entries(raw).map(([id, model]) => ({ id, ...(model as object) }))
			: [];
	const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "models.ts");
	writeFileSync(outPath, buildModelsSource(models));
	const chatCount = models.filter((model) => isChatModel(model) && isReleased(model)).length;
	console.log(`Wrote ${outPath} with ${chatCount} chat models (from ${models.length} upstream entries).`);
}

const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	await main();
}
