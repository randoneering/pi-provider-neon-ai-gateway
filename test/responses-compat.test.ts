/**
 * Offline unit tests for streamNeonResponses, the adapter behind the
 * neon-responses provider (/openai/v1/responses endpoint).
 *
 * Everything runs against a fake fetch, so no gateway credentials are
 * needed and no live requests are made.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	FetchFunction,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { RESPONSES_MODELS } from "../src/models.js";
import { makeNeonFetch, streamNeonResponses } from "../src/stream.js";

const TEXT = "smoke test ok";
const codex = RESPONSES_MODELS.find((model) => model.id === "gpt-5-3-codex");
const pro = RESPONSES_MODELS.find((model) => model.id === "gpt-5-5-pro");
if (!codex || !pro) throw new Error("RESPONSES_MODELS must contain gpt-5-3-codex and gpt-5-5-pro");

function userContext(prompt = "hi"): Parameters<typeof streamNeonResponses>[1] {
	return { messages: [{ role: "user", content: prompt, timestamp: 0 }] };
}

function responsesTextResponse(text: string): Response {
	const events: Record<string, unknown>[] = [
		{ type: "response.created", response: { id: "resp_test" } },
		{ type: "response.output_item.added", output_index: 0, item: {
			type: "message", role: "assistant", id: "msg_test", status: "in_progress", content: [],
		} },
		{ type: "response.output_text.delta", item_id: "msg_test", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_item.done", output_index: 0, item: {
			type: "message", role: "assistant", id: "msg_test", status: "completed",
			content: [{ type: "output_text", text, annotations: [] }],
		} },
		{ type: "response.completed", response: {
			id: "resp_test", status: "completed",
			usage: {
				input_tokens: 5, output_tokens: 3, total_tokens: 8,
				input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
			},
		} },
	];
	return new Response(
		events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

function responsesToolCallResponse(): Response {
	const args = JSON.stringify({ message: TEXT });
	const events: Record<string, unknown>[] = [
		{ type: "response.created", response: { id: "resp_test" } },
		{ type: "response.output_item.added", output_index: 0, item: {
			type: "function_call", id: "fc_test", call_id: "call_test", name: "smoke_echo", arguments: "", status: "in_progress",
		} },
		{ type: "response.function_call_arguments.delta", item_id: "fc_test", output_index: 0, delta: args },
		{ type: "response.function_call_arguments.done", item_id: "fc_test", output_index: 0, arguments: args },
		{ type: "response.output_item.done", output_index: 0, item: {
			type: "function_call", id: "fc_test", call_id: "call_test", name: "smoke_echo", arguments: args, status: "completed",
		} },
		{ type: "response.completed", response: {
			id: "resp_test", status: "completed",
			usage: {
				input_tokens: 5, output_tokens: 3, total_tokens: 8,
				input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
			},
		} },
	];
	return new Response(
		events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

interface CapturedRequest {
	url: string;
	body: Record<string, unknown>;
}

function captureFetch(responses: (() => Response)[]): { fetch: FetchFunction; requests: CapturedRequest[] } {
	const requests: CapturedRequest[] = [];
	return {
		requests,
		fetch: async (input, init): Promise<Response> => {
			const request = new Request(input, init);
			requests.push({ url: request.url, body: await request.json() as Record<string, unknown> });
			const response = responses[requests.length - 1];
			if (!response) throw new Error("Unexpected extra responses request");
			return response();
		},
	};
}

function optionsWith(fetch: FetchFunction, extra: Partial<SimpleStreamOptions> = {}): SimpleStreamOptions {
	return {
		apiKey: "fake-token",
		env: { NEON_AI_GATEWAY_BASE_URL: "https://gateway.example/v1/" },
		fetch,
		...extra,
	};
}

async function collect(stream: AssistantMessageEventStream): Promise<{
	events: AssistantMessageEvent[];
	done?: AssistantMessage;
	error?: AssistantMessage;
}> {
	const events: AssistantMessageEvent[] = [];
	let done: AssistantMessage | undefined;
	let error: AssistantMessage | undefined;
	for await (const event of stream) {
		events.push(event);
		if (event.type === "done") done = event.message;
		if (event.type === "error") error = event.error;
	}
	return { events, done, error };
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("streamNeonResponses", () => {
	it("rejects a model whose api is not openai-responses", () => {
		const chatModel = { ...codex, api: "openai-completions", provider: "neon" };
		expect(() => streamNeonResponses(chatModel as never, userContext())).toThrow(/expects openai-responses/);
	});

	it("returns the missing base URL error stream without calling fetch", async () => {
		vi.stubEnv("NEON_AI_GATEWAY_BASE_URL", "");
		const fetch = vi.fn<FetchFunction>();
		const { error } = await collect(streamNeonResponses(codex, userContext(), {
			apiKey: "fake-token",
			fetch: fetch as unknown as FetchFunction,
		}));
		expect(fetch).not.toHaveBeenCalled();
		expect(error?.stopReason).toBe("error");
		expect(error?.errorMessage).toMatch(/base URL not configured/);
	});

	it("sends the request to the resolved /openai/v1/responses endpoint with store disabled", async () => {
		const { fetch, requests } = captureFetch([() => responsesTextResponse(TEXT)]);
		const { done } = await collect(streamNeonResponses(codex, userContext(), optionsWith(fetch, { reasoning: "low" })));
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://gateway.example/openai/v1/responses");
		expect(requests[0]?.body.model).toBe("gpt-5-3-codex");
		expect(requests[0]?.body.store).toBe(false);
		const reasoning = requests[0]?.body.reasoning as Record<string, unknown>;
		expect(reasoning?.effort).toBe("low");
		// The SSE body passes through the error-normalizing wrapper untouched.
		expect(done?.content.filter((part) => part.type === "text").map((part) => part.text).join("")).toBe(TEXT);
	});

	it("maps thinking levels through the model's thinkingLevelMap", async () => {
		const { fetch, requests } = captureFetch([() => responsesTextResponse(TEXT)]);
		await collect(streamNeonResponses(pro, userContext(), optionsWith(fetch, { reasoning: "low" })));
		const reasoning = requests[0]?.body.reasoning as Record<string, unknown>;
		// gpt-5-5-pro clamps "low" up to "medium" so the gateway never sees a rejected effort.
		expect(reasoning?.effort).toBe("medium");
	});

	it("surfaces a 400 flat gateway error body as a stream error", async () => {
		const { fetch } = captureFetch([() => new Response(JSON.stringify({
			error_code: "BAD_REQUEST", message: "fake gateway rejection",
		}), { status: 400, headers: { "content-type": "application/json" } })]);
		const { done, error } = await collect(streamNeonResponses(codex, userContext(), optionsWith(fetch)));
		expect(done).toBeUndefined();
		expect(error?.stopReason).toBe("error");
		expect(error?.errorMessage).toContain("fake gateway rejection");
	});

	it("chains the caller's onPayload hook and applies its override", async () => {
		const seen: unknown[] = [];
		const { fetch, requests } = captureFetch([() => responsesTextResponse(TEXT)]);
		await collect(streamNeonResponses(codex, userContext(), optionsWith(fetch, {
			onPayload: async (payload) => {
				seen.push(payload);
				return { ...(payload as Record<string, unknown>), reasoning: { effort: "low", summary: "detailed" } };
			},
		})));
		expect(seen).toHaveLength(1);
		expect((seen[0] as Record<string, unknown>).store).toBe(false);
		expect((seen[0] as Record<string, unknown>).model).toBe("gpt-5-3-codex");
		const reasoning = requests[0]?.body.reasoning as Record<string, unknown>;
		expect(reasoning?.summary).toBe("detailed");
	});

	it("keeps the provider payload when onPayload returns undefined", async () => {
		const seen: unknown[] = [];
		const { fetch, requests } = captureFetch([() => responsesTextResponse(TEXT)]);
		await collect(streamNeonResponses(codex, userContext(), optionsWith(fetch, {
			onPayload: async (payload) => {
				seen.push(payload);
				return undefined;
			},
		})));
		expect(seen).toHaveLength(1);
		expect(requests[0]?.body.store).toBe(false);
		const reasoning = requests[0]?.body.reasoning as Record<string, unknown>;
		// Without a requested thinking level the adapter sends the model's off-effort.
		expect(reasoning).toEqual({ effort: "none" });
	});
});

describe("makeNeonFetch for the responses endpoint", () => {
	it("rewrites a flat gateway error body into the nested error envelope", async () => {
		const fetch = makeNeonFetch(async () => new Response(JSON.stringify({
			error_code: "UPSTREAM_TIMEOUT", message: "upstream timed out",
		}), { status: 504, headers: { "content-type": "application/json" } }), false);
		const response = await fetch("https://gateway.example/openai/v1/responses", { method: "POST" });
		expect(response.status).toBe(504);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toEqual({
			error: { message: "upstream timed out", type: "UPSTREAM_TIMEOUT", code: "UPSTREAM_TIMEOUT" },
		});
	});

	it("returns an ok responses SSE response untouched", async () => {
		const original = responsesTextResponse(TEXT);
		const fetch = makeNeonFetch(async () => original, false);
		const response = await fetch("https://gateway.example/openai/v1/responses", { method: "POST" });
		expect(response).toBe(original);
	});

	it("falls back to globalThis.fetch when no base fetch is provided", async () => {
		const fetch = makeNeonFetch(undefined, false);
		expect(typeof fetch).toBe("function");
	});
});
