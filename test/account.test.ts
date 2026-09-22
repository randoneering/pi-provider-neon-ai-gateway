/**
 * Unit tests for src/account.ts.
 *
 * Covers the pure helpers (aggregator, parsers, formatters) and the
 * network-response parsers. Network calls themselves only run from the
 * /neon-balance command handler and are exercised by test/smoke-balance.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as accountModule from "../src/account.js";
import { setAgentDir, unsetAgentDir } from "./helpers/agent-dir.js";

const sampleUsage = (cost: number) => ({
	role: "assistant",
	content: [],
	api: "openai-completions",
	provider: "neon",
	model: "gpt-5-mini",
	usage: {
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 150,
		cost: {
			input: cost / 3,
			output: (cost * 2) / 3,
			cacheRead: 0,
			cacheWrite: 0,
			total: cost,
		},
	},
	stopReason: "stop",
	timestamp: 1,
	responseId: "x",
});

const sampleMessageLine = (cost: number) =>
	JSON.stringify({ type: "message", message: sampleUsage(cost) });

describe("aggregateLocalSpend", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-neon-account-"));
	});
	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("sums cost.total from neon provider messages", async () => {
		const sessionsDir = join(tempDir, "sessions", "proj-a");
		mkdirSync(sessionsDir, { recursive: true });
		const file = join(sessionsDir, "session-1.jsonl");
		writeFileSync(
			file,
			[
				sampleMessageLine(0.01),
				sampleMessageLine(0.02),
				sampleMessageLine(0.005),
			].join("\n"),
		);

		const result = await accountModule.aggregateLocalSpend(tempDir);
		expect(result.totalCost).toBeCloseTo(0.035, 6);
		expect(result.sessionCount).toBe(1);
	});

	it("ignores non-neon providers and aborted messages", async () => {
		const sessionsDir = join(tempDir, "sessions", "proj-a");
		mkdirSync(sessionsDir, { recursive: true });
		const file = join(sessionsDir, "session-1.jsonl");
		const otherProvider = JSON.stringify({
			type: "message",
			message: { ...sampleUsage(1.0), provider: "openai" },
		});
		const aborted = JSON.stringify({
			type: "message",
			message: { ...sampleUsage(0), stopReason: "aborted" },
		});
		writeFileSync(file, [sampleMessageLine(0.01), otherProvider, aborted].join("\n"));

		const result = await accountModule.aggregateLocalSpend(tempDir);
		expect(result.totalCost).toBeCloseTo(0.01, 6);
	});

	it("walks nested session directories", async () => {
		const a = join(tempDir, "sessions", "proj-a");
		const b = join(tempDir, "sessions", "proj-a", "sub");
		mkdirSync(b, { recursive: true });
		writeFileSync(join(a, "s1.jsonl"), sampleMessageLine(0.05) + "\n");
		writeFileSync(join(b, "s2.jsonl"), sampleMessageLine(0.07) + "\n");

		const result = await accountModule.aggregateLocalSpend(tempDir);
		expect(result.totalCost).toBeCloseTo(0.12, 6);
		expect(result.sessionCount).toBe(2);
	});

	it("skips malformed lines without throwing", async () => {
		const sessionsDir = join(tempDir, "sessions", "proj-a");
		mkdirSync(sessionsDir, { recursive: true });
		const file = join(sessionsDir, "session-1.jsonl");
		writeFileSync(
			file,
			[sampleMessageLine(0.02), "this is not json", "{ broken", sampleMessageLine(0.03)].join("\n"),
		);

		const result = await accountModule.aggregateLocalSpend(tempDir);
		expect(result.totalCost).toBeCloseTo(0.05, 6);
	});

	it("returns zeros when no sessions exist", async () => {
		const result = await accountModule.aggregateLocalSpend(tempDir);
		expect(result.totalCost).toBe(0);
		expect(result.sessionCount).toBe(0);
		expect(result.firstTimestamp).toBeUndefined();
	});

	it("captures earliest message timestamp across files", async () => {
		const sessionsDir = join(tempDir, "sessions", "proj-a");
		mkdirSync(sessionsDir, { recursive: true });
		const newer = JSON.stringify({ type: "message", message: { ...sampleUsage(0.01), timestamp: 2000 } });
		const older = JSON.stringify({ type: "message", message: { ...sampleUsage(0.02), timestamp: 1000 } });
		writeFileSync(join(sessionsDir, "s1.jsonl"), [newer, older].join("\n"));

		const result = await accountModule.aggregateLocalSpend(tempDir);
		expect(result.totalCost).toBeCloseTo(0.03, 6);
		expect(result.firstTimestamp).toBe(1000);
	});
});

describe("parseSpendingLimit", () => {
	it("returns null when response is empty", () => {
		expect(accountModule.parseSpendingLimit({})).toBeNull();
	});

	it("returns null when spending_limit_cents is null", () => {
		expect(accountModule.parseSpendingLimit({ spending_limit_cents: null })).toBeNull();
	});

	it("returns the cap in dollars when set", () => {
		expect(accountModule.parseSpendingLimit({ spending_limit_cents: 5000 })).toBe(50);
	});

	it("ignores non-numeric values", () => {
		expect(accountModule.parseSpendingLimit({ spending_limit_cents: "5000" })).toBeNull();
	});
});

describe("parseUserOrganizations", () => {
	it("returns the first org from a valid response", () => {
		const result = accountModule.parseUserOrganizations({
			organizations: [
				{ id: "org-foo", name: "Foo Org", plan: "launch" },
				{ id: "org-bar", name: "Bar Org", plan: "scale" },
			],
		});
		expect(result).toEqual({ id: "org-foo", name: "Foo Org" });
	});

	it("returns undefined when response is empty", () => {
		expect(accountModule.parseUserOrganizations({})).toBeUndefined();
		expect(accountModule.parseUserOrganizations({ organizations: [] })).toBeUndefined();
	});

	it("skips malformed org entries", () => {
		expect(
			accountModule.parseUserOrganizations({
				organizations: [{ id: "x" }, { id: "org-good", name: "Good" }],
			}),
		).toEqual({ id: "org-good", name: "Good" });
	});
});

describe("formatUsd", () => {
	it("renders zero", () => {
		expect(accountModule.formatUsd(0)).toBe("$0.00");
	});

	it("renders sub-dollar amounts with two decimals", () => {
		expect(accountModule.formatUsd(0.23)).toBe("$0.23");
	});

	it("renders whole-dollar amounts without trailing zeros", () => {
		expect(accountModule.formatUsd(50)).toBe("$50.00");
	});

	it("rounds to two decimals", () => {
		expect(accountModule.formatUsd(0.126)).toBe("$0.13");
		expect(accountModule.formatUsd(1.234)).toBe("$1.23");
	});
});

describe("module surface", () => {
	it("exports registerNeonAccountCommands", () => {
		expect(typeof accountModule.registerNeonAccountCommands).toBe("function");
	});
});

describe("integration with readAuthFile", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-neon-account-int-"));
		setAgentDir(tempDir);
	});
	afterEach(() => {
		unsetAgentDir();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("readStoredNeonCredential returns managementKey when present", async () => {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({
				neon: {
					type: "api_key",
					key: "nt_live_test",
					env: { NEON_AI_GATEWAY_BASE_URL: "https://br-x.ai.neon.tech" },
					managementKey: "napi_test",
					orgId: "org-test-1",
				},
			}),
		);
		const stored = await accountModule.readStoredNeonCredential();
		expect(stored.managementKey).toBe("napi_test");
		expect(stored.orgId).toBe("org-test-1");
		expect(stored.gatewayBaseUrl).toBe("https://br-x.ai.neon.tech");
	});

	it("readStoredNeonCredential returns undefineds when fields absent", async () => {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({
				neon: {
					type: "api_key",
					key: "nt_live_test",
					env: { NEON_AI_GATEWAY_BASE_URL: "https://br-x.ai.neon.tech" },
				},
			}),
		);
		const stored = await accountModule.readStoredNeonCredential();
		expect(stored.managementKey).toBeUndefined();
		expect(stored.orgId).toBeUndefined();
		expect(stored.gatewayBaseUrl).toBe("https://br-x.ai.neon.tech");
	});

	it("readStoredNeonCredential returns empty when auth.json absent", async () => {
		if (existsSync(join(tempDir, "auth.json"))) {
			rmSync(join(tempDir, "auth.json"));
		}
		const stored = await accountModule.readStoredNeonCredential();
		expect(stored.managementKey).toBeUndefined();
		expect(stored.orgId).toBeUndefined();
		expect(stored.gatewayBaseUrl).toBeUndefined();
	});
});
