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

describe("buildModelsSource", () => {
	it("emits a sorted, deterministic module with capabilities and scaffold", () => {
		const a = buildModelsSource([fixture, { id: "gpt-5", name: "GPT-5", temperature: false, tool_call: true }]);
		const b = buildModelsSource([{ id: "gpt-5", name: "GPT-5", temperature: false, tool_call: true }, fixture]);
		expect(a).toBe(b);

		expect(a).toContain('import type { Model } from "@earendil-works/pi-ai";');
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
});
