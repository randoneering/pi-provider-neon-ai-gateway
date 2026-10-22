import { describe, expect, it } from "vitest";
import type { AssistantMessage, FetchFunction, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { streamNeon } from "../src/stream.js";
import { parseSmokeArgs, runSmoke, selectSmokeModel } from "./helpers/smoke-runner.js";

const OK = "smoke test ok";

function chatResponse(content: unknown, finishReason = "stop"): Response {
	const delta = typeof content === "string" ? { content } : { tool_calls: content };
	const chunk = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
	return new Response(
		chunk({ id: "chat_test", choices: [{ index: 0, delta, finish_reason: null }] }) +
		chunk({ id: "chat_test", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }) +
		"data: [DONE]\n\n",
		{ headers: { "content-type": "text/event-stream" } },
	);
}

function anthropicResponse(tool = false): Response {
	const events: Record<string, unknown>[] = [
		{ type: "message_start", message: {
			id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-4-6",
			content: [], stop_reason: null, stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 0 },
		} },
		{ type: "content_block_start", index: 0, content_block: tool
			? { type: "tool_use", id: "call_test", name: "smoke_echo", input: {} }
			: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: tool
			? { type: "input_json_delta", partial_json: JSON.stringify({ message: OK }) }
			: { type: "text_delta", text: OK } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
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
			if (!response) throw new Error("Unexpected extra smoke request");
			return response();
		},
	};
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
	const args = JSON.stringify({ message: OK });
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

function streamOptions(fetch: FetchFunction): SimpleStreamOptions {
	return {
		apiKey: "fake-smoke-token",
		env: { NEON_AI_GATEWAY_BASE_URL: "https://gateway.example/v1/" },
		fetch,
	};
}

describe("smoke arguments and routing", () => {
	it("keeps the existing defaults", () => {
		expect(parseSmokeArgs([])).toEqual({ modelId: "gpt-5-mini", thinking: false, tools: false });
		expect(selectSmokeModel(parseSmokeArgs(["claude-sonnet-4-6"])).provider).toBe("neon-anthropic");
	});

	it("accepts an explicit provider before or after the model", () => {
		const expected = { modelId: "claude-sonnet-4-6", provider: "neon" as const, thinking: true, tools: true };
		expect(parseSmokeArgs(["--provider", "neon", "claude-sonnet-4-6", "--thinking", "--tools"])).toEqual(expected);
		expect(parseSmokeArgs(["claude-sonnet-4-6", "--provider=neon", "--tools", "--thinking"])).toEqual(expected);
		expect(selectSmokeModel(expected).api).toBe("openai-completions");
	});

	it.each([
		["--provider"],
		["--provider", "other"],
		["--provider=neon-extra"],
		["--unknown"],
		["gpt-5-mini", "gpt-6-luna"],
		["--provider=neon", "--provider=neon-anthropic"],
	])("rejects invalid arguments before calling a gateway (%j)", (...args) => {
		expect(() => parseSmokeArgs(args)).toThrow();
	});

	it("rejects an incompatible provider/model pair and unknown models", () => {
		expect(() => selectSmokeModel(parseSmokeArgs(["gpt-6-luna", "--provider=neon-anthropic"]))).toThrow(/not available/);
		expect(() => selectSmokeModel(parseSmokeArgs(["not-a-model"]))).toThrow(/Unknown model/);
	});

	it("preserves canonical model-id lookup", () => {
		expect(selectSmokeModel(parseSmokeArgs(["DATABRICKS-GPT-6-LUNA"])).id).toBe("gpt-6-luna");
	});
});

describe("neon-responses routing", () => {
	it("accepts --provider neon-responses", () => {
		const options = parseSmokeArgs(["--provider", "neon-responses", "gpt-5-3-codex"]);
		expect(options.provider).toBe("neon-responses");
		expect(parseSmokeArgs(["gpt-5-3-codex", "--provider=neon-responses"]).provider).toBe("neon-responses");
		expect(selectSmokeModel(options).api).toBe("openai-responses");
	});

	it("routes the responses-only model ids to neon-responses by default", () => {
		for (const id of ["gpt-5-3-codex", "gpt-5-5-pro"]) {
			const model = selectSmokeModel(parseSmokeArgs([id]));
			expect(model.provider, id).toBe("neon-responses");
			expect(model.api, id).toBe("openai-responses");
		}
	});

	it("keeps the chat and Anthropic defaults for other models", () => {
		expect(selectSmokeModel(parseSmokeArgs(["gpt-5-mini"])).provider).toBe("neon");
		expect(selectSmokeModel(parseSmokeArgs(["claude-sonnet-4-6"])).provider).toBe("neon-anthropic");
	});

	it("rejects responses-only models on the chat and Anthropic providers", () => {
		expect(() => selectSmokeModel(parseSmokeArgs(["gpt-5-3-codex", "--provider=neon"]))).toThrow(/not available/);
		expect(() => selectSmokeModel(parseSmokeArgs(["gpt-5-5-pro", "--provider=neon-anthropic"]))).toThrow(/not available/);
	});

	it("rejects chat-only models on the neon-responses provider", () => {
		expect(() => selectSmokeModel(parseSmokeArgs(["gpt-5-mini", "--provider=neon-responses"]))).toThrow(/not available/);
	});

	it("keeps the Responses-capable chat models on the chat provider by default", () => {
		for (const id of ["gpt-6-1-sol", "gpt-6-astra"]) {
			const model = selectSmokeModel(parseSmokeArgs([id]));
			expect(model.provider, id).toBe("neon");
			expect(model.api, id).toBe("openai-completions");
		}
	});

	it("accepts --provider neon-responses for the Responses-capable chat models", () => {
		for (const id of ["gpt-6-1-sol", "gpt-6-astra"]) {
			const model = selectSmokeModel(parseSmokeArgs([id, "--provider=neon-responses"]));
			expect(model.provider, id).toBe("neon-responses");
			expect(model.api, id).toBe("openai-responses");
		}
	});
});

describe("smoke runner through real extension adapters", () => {
	it("keeps Gemini streaming but removes stream_options before the request reaches fetch", async () => {
		const { fetch, requests } = captureFetch([() => chatResponse(OK)]);
		await runSmoke(parseSmokeArgs(["gemini-3-8-flash", "--provider=neon"]), streamOptions(fetch));
		expect(requests[0]?.body.stream).toBe(true);
		expect(requests[0]?.body).not.toHaveProperty("stream_options");
	});

	it("normalizes Gemini's stop after tool calls and resets state for the next request", async () => {
		const { fetch, requests } = captureFetch([
			() => chatResponse([{ index: 0, id: "call_test", type: "function", function: {
				name: "smoke_echo", arguments: JSON.stringify({ message: OK }),
			} }], "stop"),
			() => chatResponse(OK),
		]);
		const result = await runSmoke(parseSmokeArgs(["gemini-3-8-flash", "--tools"]), streamOptions(fetch));
		expect(result.map((message) => message.stopReason)).toEqual(["toolUse", "stop"]);
		expect(requests).toHaveLength(2);
	});

	it("preserves Gemini thought signatures through assistant history and tool replay", async () => {
		const { fetch, requests } = captureFetch([
			() => chatResponse([{ index: 0, id: "call_test", type: "function", thoughtSignature: "fake-opaque-signature", function: {
				name: "smoke_echo", arguments: JSON.stringify({ message: OK }),
			} }], "stop"),
			() => chatResponse(OK),
		]);
		const result = await runSmoke(parseSmokeArgs(["gemini-3-8-flash", "--tools"]), streamOptions(fetch));
		expect(JSON.stringify(result[0])).toContain("fake-opaque-signature");
		expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "assistant", tool_calls: expect.arrayContaining([
				expect.objectContaining({ id: "call_test", thoughtSignature: "fake-opaque-signature" }),
			]) }),
		]));
		for (const message of requests[1]?.body.messages as Record<string, unknown>[]) {
			expect(message).not.toHaveProperty("reasoning_details");
		}

		const saved = JSON.parse(JSON.stringify(result[0])) as AssistantMessage;
		const replay = captureFetch([() => chatResponse(OK)]);
		await streamNeon(selectSmokeModel(parseSmokeArgs(["gemini-3-8-flash"])), {
			messages: [
				{ role: "user", content: "Echo a message", timestamp: 0 },
				saved,
				{ role: "toolResult", toolCallId: "call_test", toolName: "smoke_echo", content: [{ type: "text", text: OK }], isError: false, timestamp: 1 },
			],
		}, streamOptions(replay.fetch)).result();
		const replayedAssistant = (replay.requests[0]?.body.messages as Record<string, unknown>[]).find((message) => message.role === "assistant");
		const originalAssistant = (requests[1]?.body.messages as Record<string, unknown>[]).find((message) => message.role === "assistant");
		expect(replayedAssistant).toEqual(originalAssistant);
	});

	it("preserves a later signature delta across fragmented UTF-8 and CRLF frames", async () => {
		const signature = "fake-opaque-雪";
		const deltas = [
			{ tool_calls: [{ index: 0, id: "call_test", type: "function", function: { name: "smoke_echo", arguments: JSON.stringify({ message: OK }) } }] },
			{ tool_calls: [{ index: 0, thoughtSignature: signature }] },
			{},
		];
		const bytes = new TextEncoder().encode(deltas.map((delta, index) =>
			`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: index === 2 ? "stop" : null }] })}\r\n\r\n`,
		).join("") + "data: [DONE]\r\n\r\n");
		const { fetch, requests } = captureFetch([
			() => new Response(new ReadableStream<Uint8Array>({ start(controller) {
				for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
				controller.close();
			} }), { headers: { "content-type": "text/event-stream" } }),
			() => chatResponse(OK),
		]);
		await runSmoke(parseSmokeArgs(["gemini-3-8-flash", "--tools"]), streamOptions(fetch));
		expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
			expect.objectContaining({ tool_calls: expect.arrayContaining([
				expect.objectContaining({ id: "call_test", thoughtSignature: signature }),
			]) }),
		]));
	});

	it("does not rewrite a non-Gemini tool stop or hide a truncated Gemini tool call", async () => {
		for (const [id, finish, expected] of [
			["gpt-6-sol", "stop", /tool call/],
			["gemini-3-8-flash", "length", /length/],
		] as const) {
			const { fetch } = captureFetch([() => chatResponse([{ index: 0, id: "call_test", type: "function", function: {
				name: "smoke_echo", arguments: JSON.stringify({ message: OK }),
			} }], finish)]);
			await expect(runSmoke(parseSmokeArgs([id, "--tools"]), streamOptions(fetch))).rejects.toThrow(expected);
		}
	});

	it("uses the chat adapter and stored URL normalization for explicit Claude chat", async () => {
		const { fetch, requests } = captureFetch([() => chatResponse(OK)]);
		const results = await runSmoke(parseSmokeArgs(["claude-sonnet-4-6", "--provider=neon"]), streamOptions(fetch));
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://gateway.example/v1/chat/completions");
		expect(requests[0]?.body).not.toHaveProperty("store");
		expect(results[0]?.provider).toBe("neon");
	});

	it("uses the Anthropic extension adapter rather than calling pi-ai directly", async () => {
		const { fetch, requests } = captureFetch([() => anthropicResponse()]);
		const results = await runSmoke(parseSmokeArgs(["claude-sonnet-4-6", "--provider=neon-anthropic"]), streamOptions(fetch));
		const url = new URL(requests[0]!.url);
		expect(url.origin).toBe("https://gateway.example");
		expect(url.pathname).toBe("/anthropic/v1/messages");
		expect(results[0]?.provider).toBe("neon-anthropic");
	});

	it("round-trips a GPT-6 Luna tool call with the gateway-required effort override", async () => {
		const { fetch, requests } = captureFetch([
			() => chatResponse([{ index: 0, id: "call_test", type: "function", function: {
				name: "smoke_echo", arguments: JSON.stringify({ message: OK }),
			} }], "tool_calls"),
			() => chatResponse(OK),
		]);
		const results = await runSmoke(parseSmokeArgs(["gpt-6-luna", "--tools", "--thinking"]), streamOptions(fetch));
		expect(results).toHaveLength(2);
		expect(requests).toHaveLength(2);
		expect(requests[0]?.body.reasoning_effort).toBe("none");
		expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "tool", tool_call_id: "call_test", content: OK }),
		]));
	});

	it("round-trips Anthropic tool-use content through the extension adapter", async () => {
		const { fetch, requests } = captureFetch([() => anthropicResponse(true), () => anthropicResponse()]);
		await runSmoke(parseSmokeArgs(["claude-sonnet-4-6", "--tools"]), streamOptions(fetch));
		expect(requests).toHaveLength(2);
		expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "user", content: expect.arrayContaining([
				expect.objectContaining({ type: "tool_result", tool_use_id: "call_test" }),
			]) }),
		]));
	});

	it("fails when tool mode returns plain text instead of a tool call", async () => {
		const { fetch, requests } = captureFetch([() => chatResponse(OK)]);
		await expect(runSmoke(parseSmokeArgs(["gpt-6-luna", "--tools"]), streamOptions(fetch))).rejects.toThrow(/tool call/);
		expect(requests).toHaveLength(1);
	});

	it("rejects unexpected tool names and wrong arguments without executing anything", async () => {
		for (const tool of [
			{ name: "shell", arguments: JSON.stringify({ message: OK }) },
			{ name: "smoke_echo", arguments: JSON.stringify({ message: "wrong" }) },
		]) {
			const { fetch, requests } = captureFetch([() => chatResponse([
				{ index: 0, id: "call_test", type: "function", function: tool },
			], "tool_calls")]);
			await expect(runSmoke(parseSmokeArgs(["gpt-6-luna", "--tools"]), streamOptions(fetch))).rejects.toThrow(/Unexpected tool/);
			expect(requests).toHaveLength(1);
		}
	});

	it.each(["", "unexpected reply"])("rejects empty or wrong final text (%j)", async (text) => {
		const { fetch } = captureFetch([() => chatResponse(text)]);
		await expect(runSmoke(parseSmokeArgs([]), streamOptions(fetch))).rejects.toThrow(/Expected reply/);
	});

	it("rejects a truncated response even if its text looks correct", async () => {
		const { fetch } = captureFetch([() => chatResponse(OK, "length")]);
		await expect(runSmoke(parseSmokeArgs([]), streamOptions(fetch))).rejects.toThrow(/length/);
	});

	it("rejects an unexpected tool call in the plain-text check", async () => {
		const { fetch } = captureFetch([() => anthropicResponse(true)]);
		await expect(runSmoke(parseSmokeArgs(["claude-sonnet-4-6"]), streamOptions(fetch))).rejects.toThrow(/Unexpected tool call/);
	});

	it("round-trips a codex tool call through the responses adapter with store disabled", async () => {
		const { fetch, requests } = captureFetch([
			() => responsesToolCallResponse(),
			() => responsesTextResponse(OK),
		]);
		const results = await runSmoke(parseSmokeArgs(["gpt-5-3-codex", "--tools", "--thinking"]), streamOptions(fetch));
		expect(results.map((message) => message.stopReason)).toEqual(["toolUse", "stop"]);
		expect(requests).toHaveLength(2);
		expect(requests[0]?.url).toBe("https://gateway.example/openai/v1/responses");
		expect(requests[0]?.body.model).toBe("gpt-5-3-codex");
		expect(requests[0]?.body.store).toBe(false);
		expect((requests[0]?.body.reasoning as Record<string, unknown>).effort).toBe("low");
		const input = requests[1]?.body.input as Record<string, unknown>[];
		expect(input).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "function_call_output" }),
		]));
	});

	it("round-trips plain text through the responses adapter without corrupting the SSE body", async () => {
		const { fetch, requests } = captureFetch([() => responsesTextResponse(OK)]);
		const results = await runSmoke(parseSmokeArgs(["gpt-5-5-pro"]), streamOptions(fetch));
		expect(requests[0]?.url).toBe("https://gateway.example/openai/v1/responses");
		expect(requests[0]?.body.store).toBe(false);
		const text = results[0]?.content.filter((part) => part.type === "text").map((part) => part.text).join("");
		expect(text).toBe(OK);
	});

	it("reports gateway errors instead of accepting partial output", async () => {
		const { fetch } = captureFetch([() => new Response(JSON.stringify({
			error_code: "BAD_REQUEST", message: "fake gateway rejection",
		}), { status: 400, headers: { "content-type": "application/json" } })]);
		await expect(runSmoke(parseSmokeArgs([]), streamOptions(fetch))).rejects.toThrow(/fake gateway rejection/);
	});

	it("stops after two requests if the model asks to call the tool again", async () => {
		const { fetch, requests } = captureFetch([() => anthropicResponse(true), () => anthropicResponse(true)]);
		await expect(runSmoke(parseSmokeArgs(["claude-sonnet-4-6", "--tools"]), streamOptions(fetch))).rejects.toThrow(/Expected reply/);
		expect(requests).toHaveLength(2);
	});
});
