import { describe, expect, it, vi } from "vitest";
import {
	findNeonModel,
	formatModelCost,
	formatNeonModelCatalog,
	registerNeonModelCostCommand,
} from "../src/model-cost.js";

describe("formatModelCost", () => {
	it("formats input, output, and zero cache pricing", () => {
		expect(
			formatModelCost({ cost: { input: 0.25, output: 1.5, cacheRead: 0, cacheWrite: 0 } }),
		).toBe("$0.25 / 1M in, $1.50 / 1M out, —");
	});

	it("formats non-zero cache pricing", () => {
		expect(
			formatModelCost({ cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } }),
		).toBe("$1.00 / 1M in, $2.00 / 1M out, $0.10 / 1M cache read");
	});

	it("formats zero-cost models", () => {
		expect(
			formatModelCost({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		).toBe("$0.00 / 1M in, $0.00 / 1M out, —");
	});
});

describe("findNeonModel", () => {
	it("finds a model by id", () => {
		expect(findNeonModel("gpt-5-mini")?.id).toBe("gpt-5-mini");
	});

	it("accepts a neon/qualified id", () => {
		expect(findNeonModel("neon/gpt-5-mini")?.id).toBe("gpt-5-mini");
	});

	it("matches ids case-insensitively", () => {
		expect(findNeonModel("GPT-5-MINI")?.id).toBe("gpt-5-mini");
	});

	it("returns undefined for unknown models", () => {
		expect(findNeonModel("not-a-neon-model")).toBeUndefined();
	});
});

describe("formatNeonModelCatalog", () => {
	it("lists every Neon model with pricing", () => {
		const catalog = formatNeonModelCatalog();
		expect(catalog).toContain("Neon models:");
		expect(catalog).toContain("gpt-5-mini");
		expect(catalog).toContain("$0.25 / 1M");
		expect(catalog.split("\n").filter((line) => line.startsWith("  ")).length).toBeGreaterThanOrEqual(34);
	});
});

describe("registerNeonModelCostCommand", () => {
	it("registers /neon-models and renders the catalog", async () => {
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		const pi = {
			registerCommand: vi.fn((_name: string, options: { handler: typeof handler }) => {
				handler = options.handler;
			}),
		};
		const notify = vi.fn();
		registerNeonModelCostCommand(pi as never);
		expect(pi.registerCommand).toHaveBeenCalledWith("neon-models", expect.any(Object));
		await handler!("", { ui: { notify } });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Neon models:"), "info");
		expect(notify.mock.calls[0]?.[0]).toContain("glm-5-3-flash");
	});
});
