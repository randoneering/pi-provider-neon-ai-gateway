import { describe, expect, it } from "vitest";
import type { FetchFunction, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
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

describe("smoke runner through real extension adapters", () => {
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
