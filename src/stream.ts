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
 * - Flattens typed content-block arrays (gpt-oss harmony, claude-opus-5-5
 *   reasoning blocks) into the `content` + `reasoning_content` shape that
 *   pi-ai's openai-completions parser expects, so reasoning shows up in
 *   pi's thinking block.
 * - Preserves Gemini tool signatures through pi's replay metadata and
 *   corrects tool-call finish reasons.
 * - Wraps Neon's flat error responses in the nested `{ error: { message } }`
 *   shape expected by pi's overflow detector and error handling.
 */

import {
	anthropicMessagesApi,
	createAssistantMessageEventStream,
	normalizeContext,
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
import {
	NEON_AI_GATEWAY_BASE_URL_ENV,
	resolveNeonAnthropicBaseUrl,
	resolveNeonBaseUrl,
} from "./config.js";
import { canonicalModelId, MODEL_CAPABILITIES } from "./models.js";

type NeonApi = "openai-completions";

// Native Messages thinking modes from Neon's Anthropic endpoint contract.
const CLAUDE_THINKING_MODES: Record<string, "adaptive" | "always-adaptive" | "between-tools"> = {
	"claude-opus-4-7": "adaptive",
	"claude-opus-4-8": "adaptive",
	"claude-opus-5": "adaptive",
	"claude-opus-5-5": "always-adaptive",
	"claude-sonnet-5": "adaptive",
	"claude-sonnet-5-5": "between-tools",
	// The native endpoint rejects budget thinking despite Haiku 5.5's catalog metadata.
	"claude-haiku-5-5": "adaptive",
	"claude-fable-5": "always-adaptive",
	"claude-fable-5-1": "always-adaptive",
};

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

function replayGeminiSignatures(messages: unknown): unknown {
	if (!Array.isArray(messages)) return messages;
	return messages.map((message) => {
		if (
			!isRecord(message) || message.role !== "assistant" ||
			!Array.isArray(message.reasoning_details) || !Array.isArray(message.tool_calls)
		) return message;
		const signatures = message.reasoning_details.filter((detail): detail is Record<string, unknown> =>
			isRecord(detail) && detail.type === "reasoning.encrypted" && detail.format === "neon-gemini" &&
			typeof detail.id === "string" && typeof detail.data === "string" && detail.data.length > 0,
		);
		if (signatures.length === 0) return message;
		const result: Record<string, unknown> = { ...message, tool_calls: message.tool_calls.map((tool) => {
			if (!isRecord(tool)) return tool;
			const signature = signatures.find((detail) => detail.id === tool.id);
			return signature ? { ...tool, thoughtSignature: signature.data } : tool;
		}) };
		const remaining = message.reasoning_details.filter((detail) => !signatures.includes(detail));
		if (remaining.length > 0) result.reasoning_details = remaining;
		else delete result.reasoning_details;
		return result;
	});
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
	} else if (/^gemini-3-/u.test(id)) {
		// The gateway forwards stream_options into Gemini's generation_config,
		// which rejects it. Omitting the usage option keeps streaming enabled.
		// Sampling support comes from the metadata layer above.
		removeKeys(payload, ["frequency_penalty", "presence_penalty", "stream_options"]);
		if (payload.messages !== undefined) payload.messages = replayGeminiSignatures(payload.messages);
	} else if (id.includes("llama")) {
		removeKeys(payload, ["frequency_penalty", "presence_penalty", "seed"]);
	} else if (id.includes("gpt-oss")) {
		removeKeys(payload, ["frequency_penalty", "presence_penalty", "seed", "stop"]);
	} else if (id.includes("qwen") || id.includes("gemma")) {
		removeKeys(payload, ["frequency_penalty", "presence_penalty", "seed"]);
	} else if (id.includes("glm") || id.includes("inkling") || id.includes("kimi")) {
		removeKeys(payload, ["frequency_penalty", "presence_penalty"]);
	} else if (id === "gpt-5-6-luna" || id === "gpt-6-luna") {
		// The gateway rejects function tools unless reasoning_effort is
		// explicitly "none" in chat completions. Omitting the field leaves
		// the model's default effort, which is rejected too, so set it.
		// Live GPT-6 Luna tool checks confirm this despite the catalog omitting "none".
		if (payload.tools !== undefined) payload.reasoning_effort = "none";
	} else {
		// Unknown models keep sampling fields until the upstream contract is known.
	}
	return payload;
}

// ---------------------------------------------------------------------------
// Response normalization (typed content blocks)
// ---------------------------------------------------------------------------

/**
 * Canonical model ids whose chat-completions responses carry `message.content`
 * as a list of typed content blocks rather than a plain string. The list
 * grows when the upstream docs call out a new model. The `gpt-oss` family
 * is matched by prefix in `isArrayContentModel` because all its members
 * use harmony.
 */
const ARRAY_CONTENT_MODEL_IDS = new Set(["claude-opus-5-5"]);

/**
 * Whether the given canonical model id returns typed content blocks on
 * `choice.delta.content` instead of a string. Exported so the predicate
 * can be tested without spinning up the full stream.
 */
export function isArrayContentModel(canonicalId: string): boolean {
	return canonicalId.includes("gpt-oss") || ARRAY_CONTENT_MODEL_IDS.has(canonicalId);
}

/**
 * Flatten a model-specific content array into the (text, reasoning) pair
 * that pi-ai's openai-completions parser expects on `choice.delta.content`
 * and `choice.delta.reasoning_content`.
 *
 * Two upstream shapes trigger this:
 *
 * - gpt-oss "harmony" responses use
 *   `{ type: 'text', text }` and
 *   `{ type: 'reasoning', text, summary?, content? }`.
 * - `claude-opus-5-5` returns
 *   `{ type: 'text', text }` and `{ type: 'reasoning', text }` once the
 *   model reasons. A trivial prompt still returns a string from the
 *   upstream and falls through this function unchanged.
 *
 * Returns undefined when the content is not an array of typed blocks so
 * the caller can pass string content through without modification.
 */
export function extractArrayContent(content: unknown): { text: string; reasoning: string } | undefined {
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

interface GeminiStreamState {
	toolChoices: Set<number>;
	toolIds: Map<string, string>;
}

function normalizeChunk(value: unknown, gemini?: GeminiStreamState): { body: unknown; changed: boolean } {
	if (!isRecord(value) || !Array.isArray(value.choices)) return { body: value, changed: false };
	let changed = false;
	for (const choice of value.choices) {
		if (!isRecord(choice)) continue;
		if (gemini) {
			const index = typeof choice.index === "number" ? choice.index : 0;
			if (isRecord(choice.delta) && Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length > 0) {
				gemini.toolChoices.add(index);
				for (const [position, tool] of choice.delta.tool_calls.entries()) {
					if (!isRecord(tool)) continue;
					const key = `${index}:${typeof tool.index === "number" ? tool.index : position}`;
					if (typeof tool.id === "string") gemini.toolIds.set(key, tool.id);
					const id = gemini.toolIds.get(key);
					if (!id || typeof tool.thoughtSignature !== "string" || !tool.thoughtSignature) continue;
					// pi persists reasoning_details in thinkingSignature, unlike unknown tool fields.
					const details = Array.isArray(choice.delta.reasoning_details) ? choice.delta.reasoning_details : [];
					choice.delta.reasoning_details = [...details, {
						type: "reasoning.encrypted", format: "neon-gemini", id, data: tool.thoughtSignature,
					}];
					changed = true;
				}
			}
			if (choice.finish_reason === "stop" && gemini.toolChoices.has(index)) {
				choice.finish_reason = "tool_calls";
				changed = true;
			}
		}
		if (!isRecord(choice.delta)) continue;
		const extracted = extractArrayContent(choice.delta.content);
		if (!extracted) continue;
		changed = true;
		choice.delta.content = extracted.text || undefined;
		if (extracted.reasoning && choice.delta.reasoning_content === undefined && choice.delta.reasoning === undefined) {
			choice.delta.reasoning_content = extracted.reasoning;
		}
	}
	return { body: value, changed };
}

function normalizeEventStream(body: ReadableStream<Uint8Array>, isGemini: boolean): ReadableStream<Uint8Array> {
	// Gemini can label a completed tool call as "stop" in a later chunk.
	const gemini = isGemini ? { toolChoices: new Set<number>(), toolIds: new Map<string, string>() } : undefined;
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = "";
	const rewriteLine = (line: string): string => {
		const match = /^\s*data:(.*)\r?$/u.exec(line);
		if (!match) return line;
		const payload = (match[1] ?? "").trim();
		if (!payload || payload === "[DONE]") return line;
		try {
			const normalized = normalizeChunk(JSON.parse(payload), gemini);
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

function makeNeonFetch(baseFetch: FetchFunction | undefined, isArrayContentModel: boolean, isGemini = false): FetchFunction {
	const request = baseFetch ?? globalThis.fetch;
	return async (input, init) => {
		const response = await request(input, init);
		const contentType = response.headers.get("content-type") ?? "";
		if (response.ok && response.body && (isArrayContentModel || isGemini) && contentType.includes("text/event-stream")) {
			return new Response(normalizeEventStream(response.body, isGemini), {
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
	model: Model<Api>,
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
	const transcript = normalizeContext(context);
	let baseUrl: string | undefined;
	try {
		baseUrl = resolveNeonBaseUrl({
			processEnv: process.env as Record<string, string | undefined>,
			credentialEnv: options?.env,
		});
	} catch (error) {
		return missingBaseUrlStream(model, (error as Error).message);
	}
	if (!baseUrl) {
		return missingBaseUrlStream(model);
	}

	const resolvedModel: Model<NeonApi> =
		model.baseUrl === baseUrl ? (model as Model<NeonApi>) : ({ ...model, baseUrl } as Model<NeonApi>);
	const useArrayContent = isArrayContentModel(canonicalModelId(model.id));

	const userOnPayload = options?.onPayload;
	const wrappedOptions: SimpleStreamOptions = {
		...options,
		fetch: makeNeonFetch(options?.fetch, useArrayContent, /^gemini-3-/u.test(canonicalModelId(model.id))),
		onPayload: async (payload, m) => {
			const transformed = transformNeonPayload(payload, m.id);
			if (!userOnPayload) return transformed;
			const result = await userOnPayload(transformed, m);
			return result === undefined ? transformed : result;
		},
	};

	return openAICompletionsApi().streamSimple(resolvedModel, transcript, wrappedOptions);
}

/**
 * Stream adapter for the `/anthropic/v1/messages` endpoint.
 *
 * Keep the SDK's native parsing and cache handling, but configure the
 * thinking modes that the gateway requires for newer Claude models.
 * https://neon.com/docs/ai-gateway/anthropic-messages#extended-thinking
 */
export function streamNeonAnthropic(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	if (model.api !== "anthropic-messages") {
		throw new Error(`streamNeonAnthropic expects anthropic-messages, got ${model.api}`);
	}
	const transcript = normalizeContext(context);
	let baseUrl: string | undefined;
	try {
		baseUrl = resolveNeonAnthropicBaseUrl({
			processEnv: process.env as Record<string, string | undefined>,
			credentialEnv: options?.env,
		});
	} catch (error) {
		return missingBaseUrlStream(model, (error as Error).message);
	}
	if (!baseUrl) {
		return missingBaseUrlStream(model);
	}

	const nativeModel = model as Model<"anthropic-messages">;
	const id = canonicalModelId(model.id);
	const mode = CLAUDE_THINKING_MODES[id];
	const resolvedModel: Model<"anthropic-messages"> = {
		...nativeModel,
		baseUrl,
		compat: {
			...nativeModel.compat,
			...(mode ? { forceAdaptiveThinking: true } : {}),
			...(MODEL_CAPABILITIES[id]?.temperature === false ? { supportsTemperature: false } : {}),
		},
	};
	const wrappedOptions: SimpleStreamOptions = {
		...options,
		// These models cannot disable thinking; use the lowest supported effort.
		reasoning: options?.reasoning ?? (mode === "always-adaptive" ? "low" : undefined),
	};
	if (mode === "between-tools") {
		wrappedOptions.onPayload = async (payload, m) => {
			const transformed = isRecord(payload) && isRecord(payload.thinking) && payload.thinking.type === "disabled"
				? { ...payload, thinking: { type: "between_tools" } }
				: payload;
			const result = await options?.onPayload?.(transformed, m);
			return result === undefined ? transformed : result;
		};
	}

	return anthropicMessagesApi().streamSimple(resolvedModel, transcript, wrappedOptions);
}
