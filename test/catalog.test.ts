import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerExtension from "../src/index.js";
import { ANTHROPIC_MODELS, NEON_MODELS, RESPONSES_MODELS } from "../src/models.js";
import { setAgentDir, unsetAgentDir } from "./helpers/agent-dir.js";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Provider = { models: { id: string }[] };
function harness(): { providers: Map<string, Provider>; commands: Map<string, Command>; notifications: string[] } {
	const providers = new Map<string, Provider>();
	const commands = new Map<string, Command>();
	const notifications: string[] = [];
	registerExtension({
		registerProvider: (name: string, config: Provider) => { providers.set(name, config); },
		registerCommand: (name: string, command: Command) => { commands.set(name, command); },
		registerTool: vi.fn(), on: vi.fn(),
	} as unknown as ExtensionAPI);
	return { providers, commands, notifications };
}
async function command(app: ReturnType<typeof harness>, args: string): Promise<void> {
	const handler = app.commands.get("neon-catalog")!;
	await handler.handler(args, { ui: { notify: (message: string) => app.notifications.push(message) } } as unknown as Parameters<Command["handler"]>[1]);
}

describe("preferred Neon model catalog", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pi-neon-catalog-")); setAgentDir(dir); });
	afterEach(() => { unsetAgentDir(); rmSync(dir, { recursive: true, force: true }); });

	it("shows each model once, preferring Responses and native Anthropic", () => {
		const app = harness();
		const chat = app.providers.get("neon")!.models;
		const responses = app.providers.get("neon-responses")!.models;
		const anthropic = app.providers.get("neon-anthropic")!.models;
		expect(responses.map((m) => m.id)).toEqual(RESPONSES_MODELS.map((m) => m.id));
		expect(anthropic.map((m) => m.id)).toEqual(ANTHROPIC_MODELS.map((m) => m.id));
		const all = [...chat, ...responses, ...anthropic].map((m) => m.id);
		expect(new Set(all).size).toBe(all.length);
		expect(chat.some((m) => m.id === "gemini-3-6-flash")).toBe(true);
		expect(chat.some((m) => m.id === "gpt-6-luna")).toBe(true);
		expect(chat.some((m) => m.id === "gpt-5-mini")).toBe(false);
		expect(chat.some((m) => m.id === "claude-sonnet-4-5")).toBe(false);
	});

	it("persists all-endpoints mode and restores the full catalog on reload", async () => {
		const app = harness();
		await command(app, "all");
		expect(app.notifications.join(" ")).toMatch(/reload/i);
		await command(app, "status");
		expect(app.notifications.at(-1)).toMatch(/all.*active mode is preferred.*reload/i);
		expect(JSON.parse(readFileSync(join(dir, "neon-catalog.json"), "utf8"))).toEqual({ mode: "all" });
		const reloaded = harness();
		expect(reloaded.providers.get("neon")!.models.map((m) => m.id)).toEqual(NEON_MODELS.map((m) => m.id));
		await command(reloaded, "preferred");
		expect(harness().providers.get("neon")!.models.some((m) => m.id === "gpt-5-mini")).toBe(false);
	});

	it("defaults to preferred mode for malformed settings and does not write on status", async () => {
		writeFileSync(join(dir, "neon-catalog.json"), "invalid json");
		const app = harness();
		await command(app, "status");
		expect(app.notifications.join(" ")).toMatch(/preferred/i);
		expect(readFileSync(join(dir, "neon-catalog.json"), "utf8")).toBe("invalid json");
	});

	it("keeps active mode and reports an error when saving fails", async () => {
		mkdirSync(join(dir, "neon-catalog.json"));
		const app = harness();
		await command(app, "all");
		expect(app.notifications.join(" ")).toMatch(/could not save/i);
		expect(harness().providers.get("neon")!.models.some((m) => m.id === "gpt-5-mini")).toBe(false);
	});

	it("does not change catalog on an invalid command", async () => {
		const app = harness(); await command(app, "unknown");
		expect(app.notifications.join(" ")).toMatch(/preferred.*all.*status/i);
		expect(harness().providers.get("neon")!.models.some((m) => m.id === "gpt-5-mini")).toBe(false);
	});
});
