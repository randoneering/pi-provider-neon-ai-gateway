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

describe("/neon-balance command output", () => {
	let tempDir: string;
	let originalFetch: typeof globalThis.fetch;
	let fetchCalls: { url: string; init?: RequestInit }[];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-neon-cmd-"));
		setAgentDir(tempDir);
		originalFetch = globalThis.fetch;
		fetchCalls = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			fetchCalls.push({ url, init });
			if (url.includes("/aigw_credits/balance")) {
				return new Response(JSON.stringify({ message: "not found" }), {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ spending_limit_cents: 5000 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof globalThis.fetch;
	});

	afterEach(() => {
		unsetAgentDir();
		rmSync(tempDir, { recursive: true, force: true });
		globalThis.fetch = originalFetch;
	});

	it("renders the honest wording with cap, headroom, and explicit 'no balance' line", async () => {
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

		// One local Neon session so we exercise the full line set.
		const sessionsDir = join(tempDir, "sessions", "proj-a");
		mkdirSync(sessionsDir, { recursive: true });
		const sample = JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "neon",
				model: "gpt-5-mini",
				timestamp: Date.UTC(2026, 8, 1),
				usage: {
					input: 100,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 150,
					cost: { input: 0.1, output: 0.13, cacheRead: 0, cacheWrite: 0, total: 0.23 },
				},
				stopReason: "stop",
			},
		});
		writeFileSync(join(sessionsDir, "s1.jsonl"), sample);

		const notifications: { message: string; level: string }[] = [];
		const fakePi = {
			registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
				void _name;
				this._handler = options.handler;
			},
			_handler: undefined as ((args: string, ctx: unknown) => Promise<void>) | undefined,
		};
		const fakeCtx = {
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
		};

		accountModule.registerNeonAccountCommands(fakePi as never);
		expect(fakePi._handler).toBeTypeOf("function");
		await fakePi._handler!("", fakeCtx);

		expect(notifications).toHaveLength(1);
		const text = notifications[0]!.message;
		expect(text).toContain("Neon account balance:");
		expect(text).toMatch(/Spending cap:\s+\$50\.00/);
		expect(text).toMatch(/Local spend:\s+\$0\.23/);
		expect(text).toMatch(/Headroom:\s+\$49\.77/);
		expect(text).toContain("(binding limit − local spend, this machine only)");
		expect(text).toMatch(/Balance:\s+\(no balance\)/);
		expect(text).toMatch(/Note:\s+Local spend ignores other machines/);
		// Negative regression: we must NOT claim we know the real balance.
		expect(text).not.toMatch(/Remaining:\s+\$/);
		expect(text).not.toMatch(/^  Balance:\s+\$/m);
		expect(fetchCalls).toHaveLength(2);
		expect(fetchCalls.some((call) => call.url.includes("/organizations/org-test-1/billing/spending_limit"))).toBe(true);
		expect(fetchCalls.some((call) => call.url.includes("/organizations/org-test-1/billing/aigw_credits/balance"))).toBe(true);
	});

	it("renders '(none configured)' when spending_limit_cents is null", async () => {
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

		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ spending_limit_cents: null }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		const notifications: { message: string; level: string }[] = [];
		const fakePi = {
			_handler: undefined as ((args: string, ctx: unknown) => Promise<void>) | undefined,
			registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
				void _name;
				this._handler = options.handler;
			},
		};
		const fakeCtx = {
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
		};

		accountModule.registerNeonAccountCommands(fakePi as never);
		await fakePi._handler!("", fakeCtx);

		expect(notifications).toHaveLength(1);
		const text = notifications[0]!.message;
		expect(text).toMatch(/Spending cap:\s+\(none configured\)/);
		expect(text).not.toMatch(/Headroom:\s+\$/);
		expect(text).toMatch(/Balance:\s+\(no balance\)/);
	});

	it("renders the real AI Gateway credit balance", async () => {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(authPath, JSON.stringify({ neon: { type: "api_key", key: "nt_live_test", managementKey: "napi_test", orgId: "org-test-1" } }));
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			const body = url.includes("aigw_credits")
				? { balance_cents: 7777, as_of: "2026-09-22T23:11:27Z" }
				: { spending_limit_cents: 10000 };
			return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
		}) as typeof globalThis.fetch;
		const notifications: { message: string; level: string }[] = [];
		const fakePi = { _handler: undefined as ((args: string, ctx: unknown) => Promise<void>) | undefined, registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) { this._handler = options.handler; } };
		const fakeCtx = { ui: { notify(message: string, level: string) { notifications.push({ message, level }); } } };
		accountModule.registerNeonAccountCommands(fakePi as never);
		await fakePi._handler!("", fakeCtx);
		const text = notifications[0]!.message;
		expect(text).toContain("Balance:       $77.77 (as of 2026-09-22 23:11 UTC)");
	});
});

describe("/neon-spending-limit command output", () => {
	let tempDir: string;
	let originalFetch: typeof globalThis.fetch;
	let notifications: { message: string; level: string }[];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-neon-limit-"));
		setAgentDir(tempDir);
		originalFetch = globalThis.fetch;
		notifications = [];
	});

	afterEach(() => {
		unsetAgentDir();
		rmSync(tempDir, { recursive: true, force: true });
		globalThis.fetch = originalFetch;
		delete process.env.NEON_API_KEY;
	});

	function writeCredential(fields: Record<string, unknown> = {}): void {
		writeFileSync(
			join(tempDir, "auth.json"),
			JSON.stringify({
				neon: {
					type: "api_key",
					key: "nt_live_test",
					env: { NEON_AI_GATEWAY_BASE_URL: "https://br-x.ai.neon.tech" },
					...fields,
				},
			}),
		);
	}

	function registerAndGetHandler(): (args: string, ctx: unknown) => Promise<void> {
		const fakePi = {
			_handler: undefined as ((args: string, ctx: unknown) => Promise<void>) | undefined,
			registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
				this._handler = options.handler;
			},
		};
		accountModule.registerNeonSpendingLimitCommand(fakePi as never);
		expect(fakePi._handler).toBeTypeOf("function");
		return fakePi._handler!;
	}

	function context(): { ui: { notify: (message: string, level: string) => void } } {
		return {
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
			},
			},
		};
	}

	it("renders the configured cap and org on separate lines", async () => {
		writeCredential({ managementKey: "napi_test", orgId: "org-test-1" });
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ spending_limit_cents: 5000 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		await registerAndGetHandler()("", context());

		expect(notifications).toEqual([
			{ message: "Neon spending limit: $50.00\nOrg: org-test-1", level: "info" },
		]);
	});

	it("renders no configured cap", async () => {
		writeCredential({ managementKey: "napi_test", orgId: "org-test-1" });
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ spending_limit_cents: null }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		await registerAndGetHandler()("", context());

		expect(notifications[0]).toEqual({
			message: "Neon spending limit: (none configured)\nOrg: org-test-1",
			level: "info",
		});
	});

	it("warns when the management key is missing", async () => {
		writeCredential({ orgId: "org-test-1" });

		await registerAndGetHandler()("", context());

		expect(notifications).toEqual([
			{
				message: "Neon spending limit unavailable: no management key configured. Re-run /neon-login or export NEON_API_KEY.",
				level: "warning",
			},
		]);
	});

	it("auto-discovers and displays the org name", async () => {
		writeCredential({ managementKey: "napi_test" });
		let call = 0;
		globalThis.fetch = (async () => {
			call += 1;
			const body = call === 1
				? { organizations: [{ id: "org-discovered", name: "My Org" }] }
				: { spending_limit_cents: 1200 };
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof globalThis.fetch;

		await registerAndGetHandler()("", context());

		expect(notifications[0]).toEqual({
			message: "Neon spending limit: $12.00\nOrg: My Org (org-discovered)",
			level: "info",
		});
	});

	it("warns on fetch errors without throwing", async () => {
		writeCredential({ managementKey: "napi_test", orgId: "org-test-1" });
		globalThis.fetch = (async () => {
			throw new Error("management API unavailable");
		}) as typeof globalThis.fetch;

		await expect(registerAndGetHandler()("", context())).resolves.toBeUndefined();
		expect(notifications).toEqual([
			{ message: "Neon spending limit unavailable: management API unavailable", level: "warning" },
		]);
	});
});

describe("/neon-spending-limit set/clear", () => {
	let tempDir: string;
	let originalFetch: typeof globalThis.fetch;
	let notifications: { message: string; level: string }[];
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-neon-limit-mutate-"));
		setAgentDir(tempDir);
		originalFetch = globalThis.fetch;
		notifications = [];
		writeFileSync(join(tempDir, "auth.json"), JSON.stringify({ neon: { type: "api_key", key: "nt_live_test", managementKey: "napi_test", orgId: "org-test-1" } }));
	});
	afterEach(() => { unsetAgentDir(); rmSync(tempDir, { recursive: true, force: true }); globalThis.fetch = originalFetch; });
	function handler(): (args: string, ctx: unknown) => Promise<void> {
		const pi = { _handler: undefined as ((args: string, ctx: unknown) => Promise<void>) | undefined, registerCommand(_n: string, o: { handler: (a: string, c: unknown) => Promise<void> }) { this._handler = o.handler; } };
		accountModule.registerNeonSpendingLimitCommand(pi as never);
		return pi._handler!;
	}
	const ctx = () => ({ ui: { notify: (message: string, level: string) => notifications.push({ message, level }) } });
	it("sets the cap with a PUT body, treating input as dollars", async () => {
		let request: RequestInit | undefined;
		globalThis.fetch = (async (_url, init) => { request = init; return new Response(JSON.stringify({ spending_limit_cents: 5000 }), { status: 200 }); }) as typeof fetch;
		await handler()("set 50", ctx());
		expect(request?.method).toBe("PUT");
		expect(JSON.parse(String(request?.body))).toEqual({ spending_limit_cents: 5000 });
		expect(notifications[0]?.message).toContain("$50.00");
	});
	it("converts fractional dollar input to cents", async () => {
		let request: RequestInit | undefined;
		globalThis.fetch = (async (_url, init) => { request = init; return new Response(JSON.stringify({ spending_limit_cents: 4999 }), { status: 200 }); }) as typeof fetch;
		await handler()("set 49.99", ctx());
		expect(JSON.parse(String(request?.body))).toEqual({ spending_limit_cents: 4999 });
		expect(notifications[0]?.message).toContain("$49.99");
	});
	it("rejects invalid amounts without calling the API", async () => {
		let calls = 0;
		globalThis.fetch = (async () => { calls++; return new Response(); }) as typeof fetch;
		for (const value of ["0", "0.00", "-100", "-1.50", "notanumber", "50.123", "1e2"]) { await handler()(`set ${value}`, ctx()); }
		expect(calls).toBe(0);
		expect(notifications.every(n => n.message.startsWith("Invalid amount."))).toBe(true);
	});
	it("deletes the cap", async () => {
		let request: RequestInit | undefined;
		globalThis.fetch = (async (_url, init) => { request = init; return new Response(null, { status: 204 }); }) as typeof fetch;
		await handler()("clear", ctx());
		expect(request?.method).toBe("DELETE");
		expect(notifications[0]?.message).toBe("Neon spending limit cleared.");
	});
	it("renders the admin-key error for 403", async () => {
		globalThis.fetch = (async () => new Response(JSON.stringify({ message: "forbidden" }), { status: 403 })) as typeof fetch;
		await handler()("set 50", ctx());
		expect(notifications[0]?.level).toBe("error");
		expect(notifications[0]?.message).toContain("organization admin API key");
		expect(notifications[0]?.message).toContain("auth.json");
	});
	it("shows help for an unknown subcommand", async () => {
		let calls = 0;
		globalThis.fetch = (async () => { calls++; return new Response(); }) as typeof fetch;
		await handler()("foo", ctx());
		expect(calls).toBe(0);
		expect(notifications[0]?.message).toContain("Usage:");
	});
	it("shows the missing-key warning", async () => {
		writeFileSync(join(tempDir, "auth.json"), JSON.stringify({ neon: { type: "api_key", orgId: "org-test-1" } }));
		await handler()("clear", ctx());
		expect(notifications[0]?.message).toContain("no management key configured");
	});
});
