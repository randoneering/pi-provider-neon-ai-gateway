import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAgentDir, unsetAgentDir } from "./helpers/agent-dir.js";
import { readDecisionEnabled, registerNeonDecisionTool } from "../src/decision-tool.js";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
const input = { state: "Refund please", questions: { refund: { type: "noul", instructions: "Refund requested?" } } };
const response = { model: "jev-1.14.0", answers: { refund: { type: "noul", noul: 0.98 } }, usage: { input_tokens: 1_000_000, output_tokens: 1 } };

function harness(): { tool: () => Tool; command: (action: string) => Promise<void>; notifications: string[] } {
	let tool: Tool;
	let command: Command;
	const notifications: string[] = [];
	registerNeonDecisionTool({
		registerTool: (value: Tool): void => { tool = value; },
		registerCommand: (name: string, value: Command): void => {
			expect(name).toBe("neon-decide");
			command = value;
		},
	} as unknown as ExtensionAPI);
	return {
		tool: (): Tool => tool,
		command: async (action: string): Promise<void> => command.handler(action, { ui: { notify: (message: string): void => { notifications.push(message); } } } as unknown as Parameters<Command["handler"]>[1]),
		notifications,
	};
}

async function execute(tool: Tool, args: unknown = input): Promise<Awaited<ReturnType<Tool["execute"]>>> {
	return tool.execute("decision-call", args as Parameters<Tool["execute"]>[1], undefined, undefined, {} as Parameters<Tool["execute"]>[4]);
}

describe("optional neon_decide tool", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-neon-decisions-"));
		setAgentDir(dir);
		vi.stubEnv("NEON_AI_GATEWAY_TOKEN", "nt_live_environment");
		vi.stubEnv("NEON_AI_GATEWAY_BASE_URL", "https://environment.example");
		vi.stubGlobal("fetch", vi.fn(async () => Response.json(response)));
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		unsetAgentDir();
		rmSync(dir, { recursive: true, force: true });
	});

	it("defaults to hidden and blocks execution without making paid requests", async () => {
		const app = harness();
		expect(app.tool().name).toBe("neon_decide");
		expect(app.tool().exposure).toBe("hidden");
		expect(readDecisionEnabled()).toBe(false);
		await expect(execute(app.tool())).rejects.toThrow(/disabled.*neon-decide enable/i);
		expect(fetch).not.toHaveBeenCalled();
		await app.command("status");
		expect(app.notifications.join("\n")).toMatch(/disabled/);
	});

	it("persists enable and disable across registrations and changes exposure immediately", async () => {
		const app = harness();
		await app.command("enable");
		expect(app.tool().exposure).toBe("direct");
		expect(JSON.parse(readFileSync(join(dir, "neon-decisions.json"), "utf8"))).toEqual({ enabled: true });
		expect(harness().tool().exposure).toBe("direct");
		await app.command("disable");
		expect(app.tool().exposure).toBe("hidden");
		expect(harness().tool().exposure).toBe("hidden");
		expect(JSON.parse(readFileSync(join(dir, "neon-decisions.json"), "utf8"))).toEqual({ enabled: false });
	});

	it("blocks stale tool references after disabling, including from another session", async () => {
		const app = harness();
		await app.command("enable");
		const stale = app.tool();
		await harness().command("disable");
		await expect(execute(stale)).rejects.toThrow(/disabled/);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("returns structured decisions and input-only usage with stored auth precedence", async () => {
		const app = harness();
		await app.command("enable");
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ neon: { type: "api_key", key: "nt_live_stored", env: { NEON_AI_GATEWAY_BASE_URL: "https://stored.example" } } }));
		const result = await execute(app.tool());
		expect(result.structuredContent).toEqual(response);
		expect(result.details).toEqual(response);
		expect(result.usage?.cost.total).toBe(0.042);
		expect(result.usage?.cost.output).toBe(0);
		expect(result.content).toEqual([{ type: "text", text: JSON.stringify(response) }]);
		const [url, init] = vi.mocked(fetch).mock.calls[0]!;
		expect(url).toBe("https://stored.example/typesafe/v1/systemone");
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer nt_live_stored");
		expect(app.tool().outputSchema).toBeDefined();
	});

	it("uses alternate stored Neon credentials when the main entry is absent", async () => {
		const app = harness();
		await app.command("enable");
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ "neon-anthropic": { key: "nt_live_alternate", env: { NEON_AI_GATEWAY_BASE_URL: "https://alternate.example" } } }));
		await execute(app.tool());
		expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("https://alternate.example/typesafe/v1/systemone");
	});

	it("skips a settings-only primary auth entry when an alternate provider has a token", async () => {
		const app = harness();
		await app.command("enable");
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ neon: { capBlockEnabled: true }, "neon-responses": { key: "nt_live_responses", env: { NEON_AI_GATEWAY_BASE_URL: "https://responses.example" } } }));
		await execute(app.tool());
		const [url, init] = vi.mocked(fetch).mock.calls[0]!;
		expect(url).toBe("https://responses.example/typesafe/v1/systemone");
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer nt_live_responses");
	});

	it.each(["invalid json", "null", '{"enabled":"true"}', '{"enabled":1}'])("fails closed on malformed preferences", async (content) => {
		writeFileSync(join(dir, "neon-decisions.json"), content);
		const app = harness();
		expect(app.tool().exposure).toBe("hidden");
		await expect(execute(app.tool())).rejects.toThrow(/disabled/);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("keeps disabled when a preference cannot be persisted", async () => {
		mkdirSync(join(dir, "neon-decisions.json"));
		const app = harness();
		await app.command("enable");
		expect(app.notifications.join("\n")).toMatch(/could not|cannot|failed/i);
		expect(app.tool().exposure).toBe("hidden");
		expect(readDecisionEnabled()).toBe(false);
	});

	it("reports usage for unknown actions without changing preferences", async () => {
		const app = harness();
		await app.command("on");
		expect(app.notifications.join("\n")).toMatch(/enable.*disable.*status/);
		expect(readDecisionEnabled()).toBe(false);
	});

	it("status does not change an enabled preference", async () => {
		const app = harness();
		await app.command("enable");
		await app.command("");
		await app.command("status");
		expect(readDecisionEnabled()).toBe(true);
		expect(app.notifications.at(-1)).toMatch(/enabled/);
		expect(fetch).not.toHaveBeenCalled();
	});
});
