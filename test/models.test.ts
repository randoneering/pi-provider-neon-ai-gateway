import { describe, expect, it } from "vitest";
import { ANTHROPIC_MODELS, canonicalModelId, DECISION_MODELS, MODEL_CAPABILITIES, NEON_MODELS, isKnownNeonModel } from "../src/models.js";

describe("NEON_MODELS", () => {
	it("registers Gemini 4 Argon with its published limits, prices, and sampling support", () => {
		expect(NEON_MODELS.find((model) => model.id === "gemini-4-argon")).toMatchObject({
			name: "Gemini 4 Argon", reasoning: true, input: ["text", "image"],
			contextWindow: 1_048_576, maxTokens: 65_536,
			cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
		});
		expect(MODEL_CAPABILITIES["gemini-4-argon"]).toEqual({ temperature: false, toolCall: true });
	});

	it("does not expose decision models through the chat lookup", () => {
		for (const id of ["typesafeai-jev-1-14-0", "openjev-qwen35-4b"]) {
			expect(isKnownNeonModel(id)).toBe(false);
			expect(isKnownNeonModel(`databricks-${id}`)).toBe(false);
		}
		expect(DECISION_MODELS).toEqual([
			{ id: "openjev-qwen35-4b", name: "OpenJev (Qwen 3.5 4B)", inputCost: 0.042 },
			{ id: "typesafeai-jev-1-14-0", name: "Jev 1.14", inputCost: 0.042 },
		]);
	});

	it("has at least the foundation models shipped at launch", () => {
		expect(NEON_MODELS.length).toBeGreaterThanOrEqual(20);
	});

	it("uses the openai-completions API for every model", () => {
		for (const model of NEON_MODELS) {
			expect(model.api).toBe("openai-completions");
			expect(model.provider).toBe("neon");
		}
	});

	it("exposes positive context windows and max tokens", () => {
		for (const model of NEON_MODELS) {
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(model.maxTokens).toBeGreaterThan(0);
		}
	});

	it("uses non-negative cost values", () => {
		for (const model of NEON_MODELS) {
			expect(model.cost.input).toBeGreaterThanOrEqual(0);
			expect(model.cost.output).toBeGreaterThanOrEqual(0);
			expect(model.cost.cacheRead).toBeGreaterThanOrEqual(0);
			expect(model.cost.cacheWrite).toBeGreaterThanOrEqual(0);
		}
	});

	it("contains the well-known launch models", () => {
		const ids = new Set(NEON_MODELS.map((m) => m.id));
		for (const id of ["gpt-5", "gpt-5-mini", "gemini-3-6-flash", "gpt-oss-120b", "llama-4-maverick", "kimi-k3"]) {
			expect(ids.has(id), `expected ${id} to be present`).toBe(true);
		}
	});

	it("has unique model ids", () => {
		const ids = NEON_MODELS.map((m) => m.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("isKnownNeonModel", () => {
	it("returns true for known ids", () => {
		expect(isKnownNeonModel("gpt-5")).toBe(true);
		expect(isKnownNeonModel("databricks-gpt-5")).toBe(true);
	});

	it("returns false for unknown ids", () => {
		expect(isKnownNeonModel("claude-3-5-sonnet")).toBe(false);
		expect(isKnownNeonModel("")).toBe(false);
	});
});

describe("MODEL_CAPABILITIES", () => {
	it("covers every catalog model", () => {
		for (const model of NEON_MODELS) {
			const caps = MODEL_CAPABILITIES[canonicalModelId(model.id)];
			expect(caps, model.id).toBeDefined();
			expect(typeof caps?.temperature, model.id).toBe("boolean");
			expect(typeof caps?.toolCall, model.id).toBe("boolean");
		}
	});

	it("contains no embedding families", () => {
		for (const model of NEON_MODELS) {
			expect(model.id).not.toMatch(/embedding/i);
		}
	});

	it("marks the temperature-less models the upstream contract names", () => {
		for (const id of [
			"gpt-5",
			"gpt-5-mini",
			"gpt-5-nano",
			"gpt-5-5",
			"gpt-5-6-luna",
			"gpt-5-6-sol",
			"gpt-5-6-terra",
			"gpt-6-astra",
			"gemini-3-6-flash",
			"claude-fable-5",
			"claude-fable-5-1",
			"claude-opus-4-7",
			"claude-opus-4-8",
			"claude-opus-5",
			"claude-opus-5-5",
			"claude-sonnet-5",
		]) {
			expect(MODEL_CAPABILITIES[id]?.temperature, id).toBe(false);
		}
	});
});

describe("ANTHROPIC_MODELS", () => {
	it("covers the upstream Anthropic Messages supported list", () => {
		const expected = [
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
		];
		expect(ANTHROPIC_MODELS.map((m) => m.id).sort()).toEqual([...expected].sort());
	});

	it("uses the anthropic-messages api and neon-anthropic provider", () => {
		for (const model of ANTHROPIC_MODELS) {
			expect(model.api).toBe("anthropic-messages");
			expect(model.provider).toBe("neon-anthropic");
		}
	});

	it("only includes ids that exist in the chat catalog", () => {
		const chatIds = new Set(NEON_MODELS.map((m) => m.id));
		for (const model of ANTHROPIC_MODELS) {
			expect(chatIds.has(model.id), model.id).toBe(true);
		}
	});

	it("preserves pricing, context, and modalities from the chat catalog", () => {
		const byId = new Map(NEON_MODELS.map((m) => [m.id, m]));
		for (const model of ANTHROPIC_MODELS) {
			const source = byId.get(model.id);
			expect(source, model.id).toBeDefined();
			expect(model.contextWindow).toBe(source?.contextWindow);
			expect(model.maxTokens).toBe(source?.maxTokens);
			expect(model.cost).toEqual(source?.cost);
			expect(model.input).toEqual(source?.input);
			expect(model.reasoning).toBe(source?.reasoning);
		}
	});
});

