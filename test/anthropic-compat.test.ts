import { describe, expect, it } from "vitest";
import type { FetchFunction, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { parseSmokeArgs, runSmoke } from "./helpers/smoke-runner.js";

function textResponse(): Response {
	const events: Record<string, unknown>[] = [
		{ type: "message_start", message: {
			id: "msg_compat", type: "message", role: "assistant", model: "claude-test",
			content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
		} },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "smoke test ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

async function captureRequest(modelId: string, thinking: boolean, overrides: SimpleStreamOptions = {}): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	const fetch: FetchFunction = async (input, init): Promise<Response> => {
		body = await new Request(input, init).json() as Record<string, unknown>;
		return textResponse();
	};
	await runSmoke(parseSmokeArgs([modelId, "--provider=neon-anthropic", ...(thinking ? ["--thinking"] : [])]), {
		apiKey: "fake-compat-token",
		env: { NEON_AI_GATEWAY_BASE_URL: "https://gateway.example" },
		fetch,
		...overrides,
	});
	if (!body) throw new Error("Anthropic adapter did not issue a request");
	return body;
}

const adaptiveModels = [
	"claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5",
	"claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5", "claude-fable-5-1",
];

describe("Neon Anthropic thinking compatibility", () => {
	it.each(adaptiveModels)("uses adaptive thinking and requested effort for %s", async (id) => {
		const body = await captureRequest(id, true, { temperature: 0.7 });
		expect(body.thinking).toMatchObject({ type: "adaptive" });
		expect(body.thinking).not.toHaveProperty("budget_tokens");
		expect(body.output_config).toMatchObject({ effort: "low" });
		expect(body).not.toHaveProperty("temperature");
	});

	it.each(["claude-opus-5-5", "claude-fable-5", "claude-fable-5-1"])("uses low adaptive effort when %s cannot disable thinking", async (id) => {
		const body = await captureRequest(id, false, { temperature: 0.7 });
		expect(body.thinking).toMatchObject({ type: "adaptive" });
		expect(body.output_config).toMatchObject({ effort: "low" });
		expect(body).not.toHaveProperty("temperature");
	});

	it("uses between_tools when Sonnet 5.5 thinking is off", async () => {
		const body = await captureRequest("claude-sonnet-5-5", false, { temperature: 0.7 });
		expect(body.thinking).toEqual({ type: "between_tools" });
		expect(body).not.toHaveProperty("output_config");
		expect(body).not.toHaveProperty("temperature");
	});

	it.each(["claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5", "claude-haiku-5-5"])("keeps thinking disabled for %s when the gateway allows it", async (id) => {
		const body = await captureRequest(id, false);
		expect(body.thinking).toEqual({ type: "disabled" });
	});

	it.each(["claude-sonnet-4-6", "claude-haiku-4-5"])("preserves budget-based thinking for %s", async (id) => {
		const body = await captureRequest(id, true);
		const thinking = body.thinking as Record<string, unknown>;
		expect(thinking.type).toBe("enabled");
		expect(thinking.budget_tokens).toBeGreaterThan(0);
		expect(thinking.budget_tokens).toBeLessThan(body.max_tokens as number);
		expect(body).not.toHaveProperty("output_config");
	});

	it("preserves older Claude sampling when thinking is off", async () => {
		const body = await captureRequest("claude-sonnet-4-6", false, { temperature: 0.7 });
		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body.temperature).toBe(0.7);
	});

	it("keeps caller effort choices instead of overwriting them with the mandatory fallback", async () => {
		const body = await captureRequest("claude-opus-5-5", false, { reasoning: "high" });
		expect(body.output_config).toMatchObject({ effort: "high" });
	});

	it("normalizes the payload before the caller hook and keeps undefined hook returns", async () => {
		let observed: unknown;
		const body = await captureRequest("claude-sonnet-5-5", false, {
			onPayload: (payload) => { observed = (payload as Record<string, unknown>).thinking; },
		});
		expect(observed).toEqual({ type: "between_tools" });
		expect(body.thinking).toEqual({ type: "between_tools" });
	});

	it("preserves caller payload replacement", async () => {
		const body = await captureRequest("claude-sonnet-5-5", false, {
			onPayload: (payload) => ({ ...payload as Record<string, unknown>, metadata: { user_id: "fake-user" } }),
		});
		expect(body.thinking).toEqual({ type: "between_tools" });
		expect(body.metadata).toEqual({ user_id: "fake-user" });
	});
});
