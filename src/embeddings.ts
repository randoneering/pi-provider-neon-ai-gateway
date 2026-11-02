import { Type, type Static, type Usage } from "@earendil-works/pi-ai";
import { validateGatewayToken } from "./auth.js";
import { NEON_AI_GATEWAY_TOKEN_ENV, resolveNeonBaseUrl } from "./config.js";
import { canonicalModelId } from "./models.js";

const MODEL_COSTS: Record<string, number> = {
	"qwen3-embedding-0-6b": 0.02,
	"bge-large-en": 0.1,
	"gte-large-en": 0.13,
};
const DEFAULT_MODEL = "qwen3-embedding-0-6b";

export const embeddingParameters = Type.Object({
	input: Type.Union([Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 150 })]),
	model: Type.Optional(Type.Union([Type.Literal("qwen3-embedding-0-6b"), Type.Literal("bge-large-en"), Type.Literal("gte-large-en")])),
}, { additionalProperties: false });
export type EmbeddingParameters = Static<typeof embeddingParameters>;
export interface EmbeddingResponse {
	object: string;
	model: string;
	data: { object: string; index: number; embedding: number[] }[];
	usage: { prompt_tokens: number; total_tokens: number };
}
interface EmbeddingOptions {
	credential?: { key?: string; env?: Record<string, string | undefined> };
	processEnv?: Record<string, string | undefined>;
	signal?: AbortSignal;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function modelId(model: string | undefined): string {
	const id = canonicalModelId(model ?? DEFAULT_MODEL);
	if (!Object.hasOwn(MODEL_COSTS, id)) throw new Error("Unknown Neon embedding model.");
	return id;
}
function validateParameters(value: unknown): asserts value is EmbeddingParameters {
	if (!isRecord(value) || Object.keys(value).some((key) => !["input", "model"].includes(key))) throw new Error("Invalid Neon embedding arguments.");
	const inputs = typeof value.input === "string" ? [value.input] : value.input;
	if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 150 || inputs.some((item) => typeof item !== "string" || !item.trim())) throw new Error("Neon embeddings require 1 to 150 nonempty strings.");
	if (value.model !== undefined && typeof value.model !== "string") throw new Error("Invalid Neon embedding model.");
	modelId(value.model as string | undefined);
}
function validateResponse(value: unknown, count: number): asserts value is EmbeddingResponse {
	if (!isRecord(value) || typeof value.model !== "string" || value.object !== "list" || !Array.isArray(value.data) || value.data.length !== count || !isRecord(value.usage)) throw new Error("Neon embeddings returned an invalid response.");
	if (!Number.isSafeInteger(value.usage.prompt_tokens) || (value.usage.prompt_tokens as number) < 0 || !Number.isSafeInteger(value.usage.total_tokens) || (value.usage.total_tokens as number) < 0) throw new Error("Neon embeddings returned invalid usage.");
	const indexes = new Set<number>();
	for (const item of value.data) {
		if (!isRecord(item) || item.object !== "embedding" || !Number.isSafeInteger(item.index) || (item.index as number) < 0 || (item.index as number) >= count || !Array.isArray(item.embedding) || !item.embedding.length || item.embedding.some((x: unknown) => typeof x !== "number" || !Number.isFinite(x))) throw new Error("Neon embeddings returned an invalid vector.");
		indexes.add(item.index as number);
	}
	if (indexes.size !== count) throw new Error("Neon embeddings returned duplicate indexes.");
}

export async function requestNeonEmbedding(value: unknown, options: EmbeddingOptions = {}): Promise<EmbeddingResponse> {
	validateParameters(value);
	const env = options.processEnv ?? process.env;
	const token = options.credential?.key?.trim() || options.credential?.env?.[NEON_AI_GATEWAY_TOKEN_ENV]?.trim() || env[NEON_AI_GATEWAY_TOKEN_ENV]?.trim();
	if (!token) throw new Error("Neon embeddings need a gateway token. Run /neon-login or set NEON_AI_GATEWAY_TOKEN.");
	validateGatewayToken(token);
	const baseUrl = resolveNeonBaseUrl({ processEnv: env, credentialEnv: options.credential?.env });
	if (!baseUrl) throw new Error("Neon embeddings need a base URL. Run /neon-login or set NEON_AI_GATEWAY_BASE_URL.");
	const body = JSON.stringify({ model: modelId(value.model), input: value.input, encoding_format: "float" });
	if (Buffer.byteLength(body) > 32 * 1024 * 1024) throw new Error("Neon embedding request exceeds 32 MiB.");
	const timeout = AbortSignal.timeout(30_000);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	let response: Response;
	let result: unknown;
	try {
		signal.throwIfAborted();
		response = await fetch(`${baseUrl}/embeddings`, { method: "POST", redirect: "error", signal, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
		if (response.ok) result = await response.json();
	} catch (error) {
		if (options.signal?.aborted) throw new Error("Neon embedding request cancelled.");
		if (timeout.aborted) throw new Error("Neon embedding request timed out after 30 seconds.");
		if (error instanceof SyntaxError) throw new Error("Neon embedding endpoint returned invalid JSON.");
		throw new Error("Neon embedding request failed. Check the gateway URL and network connection.");
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error(`Neon embedding request failed (HTTP ${response.status}). Check gateway credentials, limits, and input.`);
	}
	validateResponse(result, typeof value.input === "string" ? 1 : value.input.length);
	return result;
}

export function embeddingUsage(response: EmbeddingResponse, model?: string): Usage {
	const input = response.usage.prompt_tokens;
	const cost = input * MODEL_COSTS[modelId(model)]! / 1_000_000;
	return { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}
