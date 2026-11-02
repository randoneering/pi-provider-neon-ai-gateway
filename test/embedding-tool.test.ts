import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAgentDir, unsetAgentDir } from "./helpers/agent-dir.js";
import { registerNeonEmbeddingTool } from "../src/embedding-tool.js";
import registerExtension from "../src/index.js";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
function harness(): { tool: () => Tool; command: (action: string) => Promise<void> } {
	let tool: Tool;
	let command: Command;
	registerNeonEmbeddingTool({
		registerTool: (value: Tool): void => { tool = value; },
		registerCommand: (_name: string, value: Command): void => { command = value; },
	} as unknown as ExtensionAPI);
	return { tool: () => tool, command: async (action) => command.handler(action, { ui: { notify: () => {} } } as unknown as Parameters<Command["handler"]>[1]) };
}
async function execute(tool: Tool): Promise<Awaited<ReturnType<Tool["execute"]>>> {
	return tool.execute("call", { input: "hello" } as Parameters<Tool["execute"]>[1], undefined, undefined, {} as Parameters<Tool["execute"]>[4]);
}
describe("extension registration", () => {
	it("registers the embedding tool and command at startup", () => {
		const registerTool = vi.fn();
		const registerCommand = vi.fn();
		registerExtension({ registerTool, registerCommand, registerProvider: vi.fn(), on: vi.fn() } as unknown as ExtensionAPI);
		expect(registerTool.mock.calls.some(([tool]) => tool.name === "neon_embed")).toBe(true);
		expect(registerCommand.mock.calls.some(([name]) => name === "neon-embed")).toBe(true);
	});
});

describe("optional neon_embed tool", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-neon-embed-")); setAgentDir(dir);
		vi.stubEnv("NEON_AI_GATEWAY_TOKEN", "nt_live_test"); vi.stubEnv("NEON_AI_GATEWAY_BASE_URL", "https://example.test");
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ object: "list", model: "qwen", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 100, total_tokens: 100 } })));
	});
	afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); unsetAgentDir(); rmSync(dir, { recursive: true, force: true }); });
	it("defaults to hidden and refuses calls without sending data", async () => {
		const app = harness(); expect(app.tool().exposure).toBe("hidden");
		await expect(execute(app.tool())).rejects.toThrow(/disabled/i); expect(fetch).not.toHaveBeenCalled();
	});
	it("persists preferences and blocks stale tools after disabling", async () => {
		const app = harness(); await app.command("enable"); expect(app.tool().exposure).toBe("direct");
		expect(JSON.parse(readFileSync(join(dir, "neon-embeddings.json"), "utf8"))).toEqual({ enabled: true });
		const stale = app.tool(); await harness().command("disable"); await expect(execute(stale)).rejects.toThrow(/disabled/i);
	});
	it("returns complete vectors and input-only usage when enabled", async () => {
		const app = harness(); await app.command("enable"); const result = await execute(app.tool());
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("0.1") });
		expect(result.usage?.cost.total).toBeCloseTo(0.000002);
	});
});
