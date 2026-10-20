/**
 * Unit tests for the auth.json file format used by /neon-login.
 *
 * auth.ts keeps its read/write helpers private, so these tests re-implement
 * the read step and assert on the JSON on disk. The agent dir is redirected
 * to a temp directory, so the real ~/.pi/agent/auth.json is never touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAgentDir, unsetAgentDir } from "./helpers/agent-dir.js";
import * as authModule from "../src/auth.js";

// Stands in for auth.ts's private readAuthFile, close enough to assert on
// the file contents the login command writes.
function readAuthFileLike(authPath: string): Record<string, unknown> {
	if (!existsSync(authPath)) return {};
	const raw = readFileSync(authPath, "utf-8");
	if (!raw.trim()) return {};
	return JSON.parse(raw) as Record<string, unknown>;
}

describe("validateGatewayToken", () => {
	it("rejects command and environment expressions", () => {
		expect(() => authModule.validateGatewayToken("!echo secret")).toThrow(/literal token/);
		expect(() => authModule.validateGatewayToken("$TOKEN")).toThrow(/literal token/);
	});

	it("accepts a literal gateway token", () => {
		expect(() => authModule.validateGatewayToken("nt_live_example")).not.toThrow();
	});
});

describe("validateManagementKey", () => {
	it("rejects command and environment expressions", () => {
		expect(() => authModule.validateManagementKey("!echo secret")).toThrow(/literal/);
		expect(() => authModule.validateManagementKey("$TOKEN")).toThrow(/literal/);
	});

	it("rejects keys that don't start with napi_", () => {
		expect(() => authModule.validateManagementKey("nt_live_wrong_kind")).toThrow(/napi_/);
		expect(() => authModule.validateManagementKey("plain-string")).toThrow(/napi_/);
	});

	it("accepts a literal napi_ key", () => {
		expect(() => authModule.validateManagementKey("napi_example_123")).not.toThrow();
	});
});

type AuthCommand = Parameters<ExtensionAPI["registerCommand"]>[1];

async function runAuthCommand(name: string, inputs: (string | undefined)[] = []): Promise<string[]> {
	const commands = new Map<string, AuthCommand>();
	authModule.registerNeonAuthCommands({
		registerCommand: (commandName: string, command: AuthCommand): void => {
			commands.set(commandName, command);
		},
	} as unknown as ExtensionAPI);
	const command = commands.get(name);
	if (!command) throw new Error(`Auth command not registered: ${name}`);
	const notifications: string[] = [];
	await command.handler("", { ui: {
		input: async (): Promise<string | undefined> => inputs.shift(),
		notify: (message: string): void => { notifications.push(message); },
	} } as unknown as Parameters<AuthCommand["handler"]>[1]);
	return notifications;
}

describe("auth file shape", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-neon-auth-"));
		setAgentDir(tempDir);
		vi.stubEnv("NEON_AI_GATEWAY_TOKEN", "");
		vi.stubEnv("NEON_AI_GATEWAY_BASE_URL", "");
		vi.stubEnv("NEON_API_KEY", "");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		unsetAgentDir();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns an empty object when auth.json is absent", () => {
		const authPath = join(tempDir, "auth.json");
		expect(readAuthFileLike(authPath)).toEqual({});
	});

	it("returns an empty object when auth.json is empty", () => {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(authPath, "");
		expect(readAuthFileLike(authPath)).toEqual({});
	});

	it("parses a valid auth.json", () => {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-x" } }));
		expect(readAuthFileLike(authPath)).toEqual({ anthropic: { type: "api_key", key: "sk-ant-x" } });
	});

	it("writes a valid neon credential with env override", () => {
		const authPath = join(tempDir, "auth.json");
		const data: Record<string, unknown> = {
			anthropic: { type: "api_key", key: "sk-ant-x" },
			neon: {
				type: "api_key",
				key: "npat-test",
				env: { NEON_AI_GATEWAY_BASE_URL: "https://br-x.ai.neon.tech" },
			},
		};
		writeFileSync(authPath, JSON.stringify(data, null, 2));
		const parsed = readAuthFileLike(authPath);
		const neon = parsed.neon as Record<string, unknown>;
		expect(neon.type).toBe("api_key");
		expect(neon.key).toBe("npat-test");
		expect(neon.env).toEqual({ NEON_AI_GATEWAY_BASE_URL: "https://br-x.ai.neon.tech" });
	});

	it("preserves managementKey and orgId on the neon entry", () => {
		const authPath = join(tempDir, "auth.json");
		const data: Record<string, unknown> = {
			neon: {
				type: "api_key",
				key: "nt_live_test",
				env: { NEON_AI_GATEWAY_BASE_URL: "https://br-x.ai.neon.tech" },
				managementKey: "napi_test",
				orgId: "org-test-1",
			},
		};
		writeFileSync(authPath, JSON.stringify(data, null, 2));
		const parsed = readAuthFileLike(authPath);
		const neon = parsed.neon as Record<string, unknown>;
		expect(neon.managementKey).toBe("napi_test");
		expect(neon.orgId).toBe("org-test-1");
	});

	it("round-trips an entry without managementKey (backwards compat)", () => {
		const authPath = join(tempDir, "auth.json");
		const data: Record<string, unknown> = {
			neon: {
				type: "api_key",
				key: "nt_live_test",
				env: { NEON_AI_GATEWAY_BASE_URL: "https://br-x.ai.neon.tech" },
			},
		};
		writeFileSync(authPath, JSON.stringify(data, null, 2));
		const parsed = readAuthFileLike(authPath);
		const neon = parsed.neon as Record<string, unknown>;
		expect(neon.managementKey).toBeUndefined();
		expect(neon.orgId).toBeUndefined();
	});

	it("login stores a credential for both registered Neon providers and preserves unrelated settings", async () => {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(authPath, JSON.stringify({
			anthropic: { type: "api_key", key: "fake-unrelated-token" },
			neon: { type: "api_key", key: "fake-old-token", managementKey: "napi_fake", orgId: "org-fake", capBlockEnabled: true, env: { KEEP: "value" } },
			"neon-anthropic": { type: "api_key", key: "fake-old-anthropic-token", env: { KEEP_ANTHROPIC: "value" } },
			"neon-responses": { type: "api_key", key: "fake-old-responses-token", env: { KEEP_RESPONSES: "value" } },
		}));
		await runAuthCommand("neon-login", ["fake-new-token", "https://br-new.ai.neon.tech/v1/", ""]);
		const saved = readAuthFileLike(authPath);
		expect(saved.anthropic).toEqual({ type: "api_key", key: "fake-unrelated-token" });
		for (const provider of ["neon", "neon-anthropic", "neon-responses"]) {
			const credential = saved[provider] as Record<string, unknown>;
			expect(credential.type).toBe("api_key");
			expect(credential.key).toBe("fake-new-token");
			expect((credential.env as Record<string, unknown>).NEON_AI_GATEWAY_BASE_URL).toBe("https://br-new.ai.neon.tech");
		}
		const neon = saved.neon as Record<string, unknown>;
		expect(neon.managementKey).toBe("napi_fake");
		expect(neon.orgId).toBe("org-fake");
		expect(neon.capBlockEnabled).toBe(true);
		expect((neon.env as Record<string, unknown>).KEEP).toBe("value");
		expect(((saved["neon-anthropic"] as Record<string, unknown>).env as Record<string, unknown>).KEEP_ANTHROPIC).toBe("value");
		expect(((saved["neon-responses"] as Record<string, unknown>).env as Record<string, unknown>).KEEP_RESPONSES).toBe("value");
	});

	it.each(["neon", "neon-anthropic", "neon-responses", "all"])("logout removes %s credentials and preserves unrelated providers", async (provider) => {
		const authPath = join(tempDir, "auth.json");
		const unrelated = { type: "api_key", key: "fake-unrelated-token" };
		const data: Record<string, unknown> = { anthropic: unrelated };
		if (provider === "neon" || provider === "all") data.neon = { type: "api_key", key: "fake-token" };
		if (provider === "neon-anthropic" || provider === "all") data["neon-anthropic"] = { type: "api_key", key: "fake-token" };
		if (provider === "neon-responses" || provider === "all") data["neon-responses"] = { type: "api_key", key: "fake-token" };
		writeFileSync(authPath, JSON.stringify(data));
		await runAuthCommand("neon-logout");
		expect(readAuthFileLike(authPath)).toEqual({ anthropic: unrelated });
	});

	it.each([
		[undefined],
		["fake-token", undefined],
		["!echo fake-token"],
		["$FAKE_TOKEN"],
		["fake-token", "not a URL"],
	])("cancelled or invalid login leaves both stored credentials unchanged (%j)", async (...inputs) => {
		const authPath = join(tempDir, "auth.json");
		const prior = JSON.stringify({
			neon: { type: "api_key", key: "fake-old-token" },
			"neon-anthropic": { type: "api_key", key: "fake-old-anthropic-token" },
		});
		writeFileSync(authPath, prior);
		await runAuthCommand("neon-login", inputs);
		expect(readFileSync(authPath, "utf8")).toBe(prior);
	});

	it("status distinguishes legacy Neon-only auth from Anthropic auth", async () => {
		writeFileSync(join(tempDir, "auth.json"), JSON.stringify({
			neon: { type: "api_key", key: "fake-token", env: { NEON_AI_GATEWAY_BASE_URL: "https://stored.example" } },
		}));
		const text = (await runAuthCommand("neon-status")).join("\n");
		expect(text).toContain("neon: configured");
		expect(text).toContain("neon-anthropic: missing");
		expect(text).toContain("neon-responses: missing");
		expect(text).toContain("/neon-login");
	});

	it("status uses an Anthropic-only stored credential without exposing its token", async () => {
		writeFileSync(join(tempDir, "auth.json"), JSON.stringify({
			"neon-anthropic": { type: "api_key", key: "fake-anthropic-token", env: { NEON_AI_GATEWAY_BASE_URL: "https://stored.example" } },
		}));
		const text = (await runAuthCommand("neon-status")).join("\n");
		expect(text).toContain("neon: missing");
		expect(text).toContain("neon-anthropic: configured");
		expect(text).toContain("https://stored.example");
		expect(text).not.toContain("fake-anthropic-token");
	});

	it("status reports all providers configured from the process environment", async () => {
		vi.stubEnv("NEON_AI_GATEWAY_TOKEN", "fake-process-token");
		vi.stubEnv("NEON_AI_GATEWAY_BASE_URL", "https://process.example");
		const text = (await runAuthCommand("neon-status")).join("\n");
		expect(text).toContain("neon: configured");
		expect(text).toContain("neon-anthropic: configured");
		expect(text).toContain("neon-responses: configured");
		expect(text).toContain("https://process.example");
		expect(text).not.toContain("fake-process-token");
	});

	it("module exports registerNeonAuthCommands", () => {
		expect(typeof authModule.registerNeonAuthCommands).toBe("function");
	});
});
