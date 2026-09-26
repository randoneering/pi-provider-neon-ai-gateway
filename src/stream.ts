/**
 * Streaming adapter for Neon AI Gateway.
 *
 * Wraps pi-ai's built-in `openAICompletionsApi` with the per-model payload
 * transformations and response normalizations that the Neon gateway needs.
 *
 * - Strips JSON-Schema `$schema` markers and unsupported OpenAI fields
 * - Removes sampling params (frequency_penalty, presence_penalty, seed,
 *   temperature, top_p, ...) per model family, since each upstream rejects
 *   a different set.
 * - Translates GPT-OSS "harmony" content arrays into the flat
 *   `content` + `reasoning_content` shape that the OpenAI Chat Completions
 *   parser expects, so reasoning shows up in pi's thinking block.
 * - Wraps Neon's flat error responses in the nested `{ error: { message } }`
 *   shape expected by pi's overflow detector and error handling.
 */

import {
	createAssistantMessageEventStream,
	openAICompletionsApi,
} from "@earendil-works/pi-ai/compat";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	FetchFunction,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { NEON_AI_GATEWAY_BASE_URL_ENV, resolveNeonBaseUrl } from "./config.js";
import { canonicalModelId, MODEL_CAPABILITIES } from "./models.js";

type NeonApi = "openai-completions";

// ---------------------------------------------------------------------------
// Payload transformations
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripJsonSchemaMarker(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripJsonSchemaMarker);
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key !== "$schema") result[key] = stripJsonSchemaMarker(entry);
	}
	return result;
}

function removeKeys(payload: Record<string, unknown>, keys: readonly string[]): void {
	for (const key of keys) delete payload[key];
}

/**
 * Strip the OpenAI fields a model's upstream rejects, keyed off the model id.
 */
export function transformNeonPayload(value: unknown, modelId: string): unknown {
	if (!isRecord(value)) return value;
	const payload = { ...value };
	if (payload.tools !== undefined) payload.tools = stripJsonSchemaMarker(payload.tools);
	if (payload.response_format !== undefined) payload.response_format = stripJsonSchemaMarker(payload.response_format);
	removeKeys(payload, ["store", "prompt_cache_key", "prompt_cache_retention"]);

	const id = canonicalModelId(modelId);

	// Upstream metadata layer: neon.com/models.json publishes the gateway
	// contract per model. temperature === false means the model rejects
	// temperature/top_p outright (the models.dev convention proxies both
	// sampling knobs with that flag).
	const caps = MODEL_CAPABILITIES[id];
	if (caps?.temperature === false) removeKeys(payload, ["temperature", "top_p"]);

	if (id.includes("claude")) {
		removeKeys(payload, ["frequency_penalty", "presence_penalty", "seed", "reasoning_effort"]);
		const version = /^claude-[a-z]+-(\d+)(?:-(\d+))?$/u.exec(id);
		const acceptsSampling =
			version !== null && (Number(version[1]) < 4 || (Number(version[1]) === 4 && Number(version[2] ?? 0) <= 6));
		if (!acceptsSampling) removeKeys(payload, ["temperature", "top_p"]);
		else if (payload.temperature !== undefined) delete payload.top_p;
	} else if (id === "gemini-3-6-flash") {
		// temperature/top_p come from the metadata layer above; gemini still
		// rejects penalties per observed gateway behavior.
		removeKeys(payload, ["frequency_penalty", "presence_penalty"]);
	} else if (
		id === "gemini-3-1-flash-lite" ||
		id === "gemini-3-1-pro" ||
		id === "gemini-3-5-flash" ||
		id === "gemini-3-5-flash-lite" ||
		id === "gemini-3-flash"
	) {
		removeKeys(payload, ["frequency_penalty", "presence_penalty"]);
	} else if (id.includes("llama")) {
		removeKeys(payload, ["frequency_penalty", "presence_penalty", "seed"]);
	} else if (id.includes("gpt-oss")) {
		removeKeys(payload, ["frequency_penalty", "presence_penalty", "seed", "stop"]);
	} else if (id.includes("qwen") || id.includes("gemma")) {
		removeKeys(payload, ["frequency_penalty", "presence_penalty", "seed"]);
	} else if (id.includes("glm") || id.includes("inkling") || id.includes("kimi")) {
		removeKeys(payload, ["frequency_penalty", "presence_penalty"]);
	} else if (id === "gpt-5-6-luna") {
		// The gateway rejects function tools unless reasoning_effort is
		// explicitly "none" in chat completions. Omitting the field leaves
		// the model's default effort, which is rejected too, so set it.
		if (payload.tools !== undefined) payload.reasoning_effort = "none";
	} else {
		// Unknown models keep sampling fields until the upstream contract is known.
	}
	return payload;
}

// ---------------------------------------------------------------------------
// Response normalization (GPT-OSS harmony format)
// ---------------------------------------------------------------------------

function extractHarmonyContent(content: unknown): { text: string; reasoning: string } | undefined {
	if (!Array.isArray(content)) return undefined;
	const text: string[] = [];
	const reasoning: string[] = [];
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") {
			text.push(part.text);
			continue;
		}
		if (part.type !== "reasoning") continue;
		if (typeof part.text === "string") reasoning.push(part.text);
		for (const field of ["summary", "content"]) {
			const entries = part[field];
			if (!Array.isArray(entries)) continue;
			for (const entry of entries) {
				if (isRecord(entry) && typeof entry.text === "string") reasoning.push(entry.text);
			}
		}
	}
	return { text: text.join(""), reasoning: reasoning.join("\n") };
}

function normalizeChunk(value: unknown): { body: unknown; changed: boolean } {
	if (!isRecord(value) || !Array.isArray(value.choices)) return { body: value, changed: false };
	let changed = false;
	for (const choice of value.choices) {
		if (!isRecord(choice) || !isRecord(choice.delta)) continue;
		const extracted = extractHarmonyContent(choice.delta.content);
		if (!extracted) continue;
		changed = true;
		choice.delta.content = extracted.text || undefined;
		if (extracted.reasoning && choice.delta.reasoning_content === undefined && choice.delta.reasoning === undefined) {
			choice.delta.reasoning_content = extracted.reasoning;
		}
	}
	return { body: value, changed };
}

function normalizeEventStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = "";
	const rewriteLine = (line: string): string => {
		const match = /^\s*data:(.*)$/u.exec(line);
		if (!match) return line;
		const payload = (match[1] ?? "").trim();
		if (!payload || payload === "[DONE]") return line;
		try {
			const normalized = normalizeChunk(JSON.parse(payload));
			return normalized.changed ? `data: ${JSON.stringify(normalized.body)}` : line;
		} catch {
			return line;
		}
	};
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) controller.enqueue(encoder.encode(`${rewriteLine(line)}\n`));
			},
			flush(controller) {
				buffer += decoder.decode();
				if (buffer) controller.enqueue(encoder.encode(`${rewriteLine(buffer)}\n`));
			},
		}),
	);
}

function rewrittenHeaders(headers: Headers): Headers {
	const result = new Headers(headers);
	result.delete("content-length");
	result.delete("content-encoding");
	return result;
}

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

function unwrapErrorMessage(message: string): string {
	try {
		const parsed: unknown = JSON.parse(message);
		if (!isRecord(parsed)) return message;
		if (typeof parsed.error === "string") return parsed.error;
		if (isRecord(parsed.error) && typeof parsed.error.message === "string") return parsed.error.message;
		return typeof parsed.message === "string" ? parsed.message : message;
	} catch {
		return message;
	}
}

function normalizeError(value: unknown): unknown | undefined {
	if (!isRecord(value) || isRecord(value.error)) return undefined;
	const rawMessage =
		typeof value.message === "string" ? value.message : typeof value.error === "string" ? value.error : undefined;
	if (!rawMessage) return undefined;
	const code =
		typeof value.error_code === "string" ? value.error_code : typeof value.code === "string" ? value.code : undefined;
	const type = typeof value.type === "string" ? value.type : code;
	const error: Record<string, string> = { message: unwrapErrorMessage(rawMessage) };
	if (type !== undefined) error.type = type;
	if (code !== undefined) error.code = code;
	return { error };
}

/**
 * Add a retry delay to Neon's account-quota error when the gateway supplies
 * a valid positive Retry-After value. Other bodies are returned unchanged.
 */
export function enrichRateLimitMessage(body: unknown, retryAfterHeader: string | null | undefined): unknown {
	if (!isRecord(body) || !isRecord(body.error)) return body;
	const error = body.error;
	const code =
		typeof error.code === "string"
			? error.code
			: typeof error.type === "string"
				? error.type
				: undefined;
	if (code !== "REQUEST_LIMIT_EXCEEDED") return body;
	if (!retryAfterHeader || !/^\d+$/u.test(retryAfterHeader)) return body;
	const seconds = Number(retryAfterHeader);
	if (!Number.isSafeInteger(seconds) || seconds <= 0) return body;
	if (typeof error.message !== "string" || error.message.includes("; retry after ")) return body;
	return {
		...body,
		error: {
			...error,
			message: `${error.message}; retry after ${seconds}s`,
		},
	};
}

function makeNeonFetch(baseFetch: FetchFunction | undefined, isHarmonyModel: boolean): FetchFunction {
	const request = baseFetch ?? globalThis.fetch;
	return async (input, init) => {
		const response = await request(input, init);
		const contentType = response.headers.get("content-type") ?? "";
		if (response.ok && response.body && isHarmonyModel && contentType.includes("text/event-stream")) {
			return new Response(normalizeEventStream(response.body), {
				status: response.status,
				statusText: response.statusText,
				headers: rewrittenHeaders(response.headers),
			});
		}
		if (response.ok) return response;
		const canParseJson =
			contentType.includes("application/json") ||
			contentType.includes("+json") ||
			contentType === "";
		if (!canParseJson) {
			const text = await response.clone().text();
			if (!text.trimStart().startsWith("{")) return response;
		}

		let value: unknown;
		try {
			value = await response.clone().json();
		} catch {
			return response;
		}
		let normalized = normalizeError(value);
		if (normalized === undefined) return response;
		if (response.status === 429) {
			normalized = enrichRateLimitMessage(normalized, response.headers.get("retry-after"));
		}
		return new Response(JSON.stringify(normalized), {
			status: response.status,
			statusText: response.statusText,
			headers: rewrittenHeaders(response.headers),
		});
	};
}

// ---------------------------------------------------------------------------
// Error stream factory (used when the base URL is missing)
// ---------------------------------------------------------------------------

function missingBaseUrlStream(
	model: Model<NeonApi>,
	errorMessage?: string,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage:
			errorMessage ??
			`Neon AI Gateway base URL not configured. Set ${NEON_AI_GATEWAY_BASE_URL_ENV} or run /login neon.`,
		timestamp: Date.now(),
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: output });
		stream.push({ type: "error", reason: "error", error: output });
		stream.end();
	});
	return stream;
}

// ---------------------------------------------------------------------------
// Public stream function
// ---------------------------------------------------------------------------

export function streamNeon(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	if (model.api !== "openai-completions") {
		throw new Error(`streamNeon expects openai-completions, got ${model.api}`);
	}
	let baseUrl: string | undefined;
	try {
		baseUrl = resolveNeonBaseUrl({
			processEnv: process.env as Record<string, string | undefined>,
			credentialEnv: options?.env,
		});
	} catch (error) {
		return missingBaseUrlStream(model as Model<NeonApi>, (error as Error).message);
	}
	if (!baseUrl) {
		return missingBaseUrlStream(model as Model<NeonApi>);
	}

	const resolvedModel: Model<NeonApi> =
		model.baseUrl === baseUrl ? (model as Model<NeonApi>) : ({ ...model, baseUrl } as Model<NeonApi>);
	const isHarmonyModel = canonicalModelId(model.id).includes("gpt-oss");

	const userOnPayload = options?.onPayload;
	const wrappedOptions: SimpleStreamOptions = {
		...options,
		fetch: makeNeonFetch(options?.fetch, isHarmonyModel),
		onPayload: async (payload, m) => {
			const transformed = transformNeonPayload(payload, m.id);
			if (!userOnPayload) return transformed;
			const result = await userOnPayload(transformed, m);
			return result === undefined ? transformed : result;
		},
	};

	return openAICompletionsApi().streamSimple(resolvedModel, context, wrappedOptions);
}
