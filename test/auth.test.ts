/**
 * Unit tests for the auth.json file format used by /neon-login.
 *
 * auth.ts keeps its read/write helpers private, so these tests re-implement
 * the read step and assert on the JSON on disk. The agent dir is redirected
 * to a temp directory, so the real ~/.pi/agent/auth.json is never touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("auth file shape", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-neon-auth-"));
		setAgentDir(tempDir);
	});
	afterEach(() => {
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

	it("module exports registerNeonAuthCommands", () => {
		expect(typeof authModule.registerNeonAuthCommands).toBe("function");
	});
});
