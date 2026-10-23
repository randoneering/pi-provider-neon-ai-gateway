import { describe, expect, it } from "vitest";
import { buildModelsSource, isChatModel, toNeonModelInput, type UpstreamModel } from "../scripts/update-models.js";

const fixture: UpstreamModel = {
	id: "gpt-5-6-luna",
	name: "GPT-5.6 Luna",
	family: "gpt-5",
	reasoning: true,
	tool_call: true,
	temperature: false,
	modalities: { input: ["text", "image", "pdf"] },
	limit: { context: 1050000, output: 128000 },
	cost: { input: 0.2, output: 1.2 },
};

describe("isChatModel", () => {
	it("excludes explicit non-chat types independently of family", () => {
		expect(isChatModel({ id: "typesafeai-jev-1-14-0", type: "decision" })).toBe(false);
		expect(isChatModel({ id: "bge-large-en", type: "embedding" })).toBe(false);
		expect(isChatModel({ id: "future-image-model", type: "image" })).toBe(false);
		expect(isChatModel({ id: "future-chat-model", type: "chat" })).toBe(true);
	});

	it("excludes embedding families", () => {
		expect(isChatModel({ id: "gte-large-en", family: "text-embedding" })).toBe(false);
		expect(isChatModel({ id: "qwen3-embedding-0-6b", family: "text-embedding" })).toBe(false);
	});

	it("keeps chat families", () => {
		expect(isChatModel(fixture)).toBe(true);
		expect(isChatModel({ id: "gpt-5" })).toBe(true);
	});
});

describe("toNeonModelInput", () => {
	it("intersects upstream modalities with what pi-ai supports", () => {
		const mapped = toNeonModelInput(fixture);
		expect(mapped.input).toEqual(["text", "image"]);
	});

	it("defaults cache costs to zero and carries limits and prices", () => {
		const mapped = toNeonModelInput(fixture);
		expect(mapped.context).toBe(1050000);
		expect(mapped.output).toBe(128000);
		expect(mapped.reasoning).toBe(true);
		expect(mapped.cost).toEqual({ input: 0.2, output: 1.2, cacheRead: 0, cacheWrite: 0 });
	});

	it("falls back to text-only input and zero cost when upstream omits fields", () => {
		const mapped = toNeonModelInput({ id: "mystery-model" });
		expect(mapped.input).toEqual(["text"]);
		expect(mapped.cost.input).toBe(0);
		expect(mapped.reasoning).toBe(false);
	});
});

const cacheFixture: UpstreamModel = {
	id: "cache-model",
	name: "Cache Model",
	family: "gpt-5",
	temperature: false,
	tool_call: true,
	limit: { context: 400000, output: 128000 },
	cost: { input: 1.25, output: 10, cache_read: 0.125, cache_write: 1.25 },
};

describe("toNeonModelInput", () => {
	it("maps upstream cache_read/cache_write onto cacheRead/cacheWrite", () => {
		const mapped = toNeonModelInput(cacheFixture);
		expect(mapped.cost).toEqual({ input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 });
	});

	it("defaults cacheRead/cacheWrite to zero when upstream omits them", () => {
		const mapped = toNeonModelInput({ id: "no-cache", cost: { input: 1, output: 2 } });
		expect(mapped.cost).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
	});
});

describe("buildModelsSource", () => {
	it("generates decision metadata without registering decision models as chat", () => {
		const source = buildModelsSource([
			{ id: "typesafeai-jev-1-14-0", name: "Jev 1.14", type: "decision", cost: { input: 0.042 } },
			{ id: "openjev-qwen35-4b", name: "OpenJev (Qwen 3.5 4B)", type: "decision", cost: { input: 0.042 } },
			{ id: "unreleased-decision", type: "decision", released: false },
			{ id: "bge-large-en", type: "embedding" },
		]);
		const chat = source.slice(source.indexOf("export const NEON_MODELS"), source.indexOf("export interface NeonModelCapabilities"));
		expect(chat).not.toContain("typesafeai-jev");
		expect(chat).not.toContain("openjev");
		expect(chat).not.toContain("bge-large-en");
		expect(source).toContain("export const DECISION_MODELS");
		expect(source).toContain('id: "typesafeai-jev-1-14-0", name: "Jev 1.14", inputCost: 0.042');
		expect(source).not.toContain("unreleased-decision");
	});

	it("emits a sorted, deterministic module with capabilities and scaffold", () => {
		const a = buildModelsSource([fixture, { id: "gpt-5", name: "GPT-5", temperature: false, tool_call: true }]);
		const b = buildModelsSource([{ id: "gpt-5", name: "GPT-5", temperature: false, tool_call: true }, fixture]);
		expect(a).toBe(b);

		expect(a).toContain('import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";');
		expect(a).toContain("export const NEON_MODELS");
		expect(a).toContain("export const MODEL_CAPABILITIES");
		expect(a).toContain("export function canonicalModelId");
		expect(a).toContain("export function isKnownNeonModel");

		const gpt5 = a.indexOf('"gpt-5"');
		const luna = a.indexOf('"gpt-5-6-luna"');
		expect(luna).toBeGreaterThan(gpt5);
		expect(a).toContain('"gpt-5": { temperature: false, toolCall: true },');
	});

	it("filters embedding families out of the generated catalog", () => {
		const source = buildModelsSource([fixture, { id: "gte-large-en", family: "text-embedding" }]);
		expect(source).not.toContain("gte-large-en");
		expect(source).toContain("gpt-5-6-luna");
	});

	it("emits upstream cache prices and keeps zeros for models that do not publish them", () => {
		const source = buildModelsSource([cacheFixture, { id: "no-cache-model", name: "No Cache", family: "gpt-5", cost: { input: 1, output: 2 } }]);
		expect(source).toContain(
			'cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },',
		);
		expect(source).toContain("cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },");
	});

	it("excludes unreleased upstream entries from the generated catalog", () => {
		const source = buildModelsSource([
			{ id: "gpt-5-9-mist", name: "GPT-5.9 Mist", family: "gpt-5", released: false, temperature: false, tool_call: true },
			{ id: "gpt-5-8", name: "GPT-5.8", family: "gpt-5", released: true, temperature: false, tool_call: true },
		]);
		expect(source).not.toContain("gpt-5-9-mist");
		expect(source).toContain('id: "gpt-5-8"');
		expect(source).toContain('"gpt-5-8": { temperature: false, toolCall: true },');
	});

	it("keeps entries that omit the released flag for backward compatibility", () => {
		const source = buildModelsSource([{ id: "gpt-5-legacy", name: "GPT-5 Legacy", family: "gpt-5" }]);
		expect(source).toContain('id: "gpt-5-legacy"');
	});

	it("excludes models that require the Responses endpoint", () => {
		const source = buildModelsSource([
			{ id: "gpt-5-3-codex", family: "gpt-5" },
			{ id: "gpt-5-5-pro", family: "gpt-5" },
			{ id: "gpt-5-5", family: "gpt-5" },
		]);
		const neonSection = source.slice(
			source.indexOf("export const NEON_MODELS"),
			source.indexOf("export interface NeonModelCapabilities"),
		);
		expect(neonSection).not.toContain("gpt-5-3-codex");
		expect(neonSection).not.toContain("gpt-5-5-pro");
		expect(neonSection).toContain('id: "gpt-5-5"');
	});
});

const codexFixture: UpstreamModel = {
	id: "gpt-5-3-codex",
	name: "GPT-5.3 Codex",
	family: "gpt-codex",
	released: true,
	reasoning: true,
	reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
	tool_call: true,
	temperature: true,
	modalities: { input: ["text", "image", "pdf"] },
	limit: { context: 400000, output: 128000 },
	cost: { input: 1.75, output: 14, cache_read: 0.175 },
};

const proFixture: UpstreamModel = {
	id: "gpt-5-5-pro",
	name: "GPT-5.5 Pro",
	family: "gpt-pro",
	released: true,
	reasoning: true,
	reasoning_options: [{ type: "effort", values: ["medium", "high", "xhigh"] }],
	tool_call: true,
	temperature: false,
	modalities: { input: ["text", "image", "pdf"] },
	limit: { context: 1050000, output: 128000 },
	cost: { input: 30, output: 180, cache_read: 0.175 },
};

// gpt-6-1-sol and gpt-6-astra keep their chat catalog entries but are also
// live-verified on the Responses endpoint with reasoning low.
const sol61Fixture: UpstreamModel = {
	id: "gpt-6-1-sol",
	name: "GPT-6.1 Sol",
	family: "gpt-sol",
	released: true,
	reasoning: true,
	reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
	tool_call: true,
	temperature: false,
	modalities: { input: ["text", "image", "pdf"] },
	limit: { context: 1050000, output: 128000 },
	cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
};

const astraFixture: UpstreamModel = {
	id: "gpt-6-astra",
	name: "GPT-6 Astra",
	family: "gpt-astra",
	released: true,
	reasoning: true,
	reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
	tool_call: true,
	temperature: false,
	modalities: { input: ["text", "image", "pdf"] },
	limit: { context: 1050000, output: 128000 },
	cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
};

function responsesEntryBlock(source: string, id: string): string {
	const responsesSection = source.slice(source.indexOf("export const RESPONSES_MODELS"));
	const start = responsesSection.indexOf(`id: ${JSON.stringify(id)}`);
	if (start === -1) return "";
	const end = responsesSection.indexOf("\t}),", start);
	return responsesSection.slice(start, end);
}

describe("RESPONSES_MODELS", () => {
	it("exposes exactly the two Responses-only models on the neon-responses provider", () => {
		const source = buildModelsSource([codexFixture, proFixture, fixture]);
		expect(source).toContain("export const RESPONSES_MODELS");
		expect(source).toContain('api: "openai-responses"');
		expect(source).toContain('provider: "neon-responses"');
		expect(responsesEntryBlock(source, "gpt-5-3-codex")).not.toBe("");
		expect(responsesEntryBlock(source, "gpt-5-5-pro")).not.toBe("");
		expect(responsesEntryBlock(source, "gpt-5")).toBe("");
	});

	it("carries upstream pricing and limits for the Responses models", () => {
		const source = buildModelsSource([codexFixture, proFixture]);
		const codex = responsesEntryBlock(source, "gpt-5-3-codex");
		expect(codex).toContain('cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },');
		expect(codex).toContain("context: 400_000,");
		const pro = responsesEntryBlock(source, "gpt-5-5-pro");
		expect(pro).toContain('cost: { input: 30, output: 180, cacheRead: 0.175, cacheWrite: 0 },');
		expect(pro).toContain("context: 1_050_000,");
	});

	it("maps pi thinking levels onto effort values, clamping upward when unsupported", () => {
		const source = buildModelsSource([codexFixture, proFixture]);
		const codex = responsesEntryBlock(source, "gpt-5-3-codex");
		expect(codex).toContain('off: "none",');
		expect(codex).toContain('low: "low",');
		expect(codex).toContain('xhigh: "xhigh",');
		expect(codex).toContain('max: "xhigh",');
		expect(codex).not.toContain('off: "medium"');
		const pro = responsesEntryBlock(source, "gpt-5-5-pro");
		expect(pro).toContain('off: "medium",');
		expect(pro).toContain('low: "medium",');
		expect(pro).toContain('medium: "medium",');
		expect(pro).toContain('high: "high",');
		expect(pro).toContain('xhigh: "xhigh",');
		expect(pro).not.toContain('off: "none"');
	});

	it("keeps Responses temperature metadata consistent with upstream in MODEL_CAPABILITIES", () => {
		const source = buildModelsSource([codexFixture, proFixture]);
		expect(source).toContain('"gpt-5-3-codex": { temperature: true, toolCall: true },');
		expect(source).toContain('"gpt-5-5-pro": { temperature: false, toolCall: true },');
	});

	it("fails loudly when upstream reasoning_options drift from the hardcoded effort values", () => {
		const drifted: UpstreamModel = {
			...codexFixture,
			reasoning_options: [{ type: "effort", values: ["none", "low", "high", "xhigh"] }],
		};
		expect(() => buildModelsSource([drifted, proFixture])).toThrow(/reasoning_options/);
	});

	it("fails loudly when upstream drops the effort options for a Responses model", () => {
		const missing: UpstreamModel = { ...proFixture, reasoning_options: [] };
		expect(() => buildModelsSource([codexFixture, missing])).toThrow(/reasoning_options/);
	});

	it("emits the shared chat models with a clamped thinkingLevelMap", () => {
		const source = buildModelsSource([codexFixture, proFixture, sol61Fixture, astraFixture]);
		for (const [id, cost] of [
			["gpt-6-1-sol", "cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },"],
			["gpt-6-astra", "cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },"],
		] as const) {
			const block = responsesEntryBlock(source, id);
			expect(block, id).not.toBe("");
			expect(block, id).toContain(cost);
			expect(block, id).toContain("context: 1_050_000,");
			expect(block, id).toContain('off: "low",');
			expect(block, id).toContain('minimal: "low",');
			expect(block, id).toContain('low: "low",');
			expect(block, id).toContain('medium: "medium",');
			expect(block, id).toContain('high: "high",');
			expect(block, id).toContain('xhigh: "xhigh",');
			expect(block, id).toContain('max: "max",');
			expect(block, id).not.toContain('off: "none"');
		}
	});

	it("keeps the shared models in the chat catalog while excluding only the Responses-only ids", () => {
		const source = buildModelsSource([codexFixture, proFixture, sol61Fixture, astraFixture]);
		const neonSection = source.slice(
			source.indexOf("export const NEON_MODELS"),
			source.indexOf("export interface NeonModelCapabilities"),
		);
		expect(neonSection).toContain('id: "gpt-6-1-sol"');
		expect(neonSection).toContain('id: "gpt-6-astra"');
		expect(neonSection).not.toContain("gpt-5-3-codex");
		expect(neonSection).not.toContain("gpt-5-5-pro");
	});

	it("emits four RESPONSES_MODELS entries", () => {
		const source = buildModelsSource([codexFixture, proFixture, sol61Fixture, astraFixture]);
		expect((source.match(/mResponses\(\{/gu) ?? []).length).toBe(4);
	});

	it("fails loudly when the shared models' upstream reasoning_options drift", () => {
		const drifted: UpstreamModel = {
			...sol61Fixture,
			reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh"] }],
		};
		expect(() => buildModelsSource([drifted, astraFixture, codexFixture, proFixture])).toThrow(/reasoning_options/);
	});
});
