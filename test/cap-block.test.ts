import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setAgentDir, unsetAgentDir } from "./helpers/agent-dir.js";
import { readCapBlockEnabled, registerNeonCapBlockCommand, registerNeonCapBlockGuard } from "../src/cap-block.js";

function writeAuth(tempDir: string, extra: Record<string, unknown> = {}) {
	writeFileSync(join(tempDir, "auth.json"), JSON.stringify({ other: { key: "keep" }, neon: { type: "api_key", key: "nt_live", managementKey: "napi_test", orgId: "org-test", env: { X: "keep" }, ...extra } }));
}

describe("cap block setting", () => {
	let tempDir: string;
	beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "pi-neon-cap-block-")); setAgentDir(tempDir); });
	afterEach(() => { unsetAgentDir(); rmSync(tempDir, { recursive: true, force: true }); });

	it("defaults disabled", () => { writeAuth(tempDir); expect(readCapBlockEnabled()).toBe(false); });

	it("on persists true without dropping fields", async () => {
		writeAuth(tempDir);
		const notifications: string[] = [];
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		const pi = { registerCommand: vi.fn((_name: string, opts: any) => { handler = opts.handler; }) };
		registerNeonCapBlockCommand(pi as never);
		await handler!("on", { ui: { notify: (message: string) => notifications.push(message) } });
		const parsed = JSON.parse(readFileSync(join(tempDir, "auth.json"), "utf8"));
		expect(parsed.other.key).toBe("keep");
		expect(parsed.neon.managementKey).toBe("napi_test");
		expect(parsed.neon.orgId).toBe("org-test");
		expect(parsed.neon.env.X).toBe("keep");
		expect(parsed.neon.capBlockEnabled).toBe(true);
		expect(notifications[0]).toContain("enabled");
	});

	it("off persists false and status reports state", async () => {
		writeAuth(tempDir, { capBlockEnabled: true });
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		const notify = vi.fn();
		const pi = { registerCommand: vi.fn((_name: string, opts: any) => { handler = opts.handler; }) };
		registerNeonCapBlockCommand(pi as never);
		await handler!("off", { ui: { notify } });
		expect(readCapBlockEnabled()).toBe(false);
		await handler!("status", { ui: { notify } });
		expect(notify.mock.calls.at(-1)?.[0]).toContain("disabled");
	});
});

describe("cap block guard", () => {
	let tempDir: string;
	beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "pi-neon-cap-guard-")); setAgentDir(tempDir); });
	afterEach(() => { unsetAgentDir(); rmSync(tempDir, { recursive: true, force: true }); });

	function setup(enabled = true) { writeAuth(tempDir, { capBlockEnabled: enabled }); }
	function register() {
		let handler: ((event: any, ctx: any) => Promise<any>) | undefined;
		const pi = { on: vi.fn((_name: string, callback: typeof handler) => { handler = callback; }) };
		registerNeonCapBlockGuard(pi as never);
		return handler!;
	}

	it("disabled guard does not fetch or block", async () => {
		setup(false); globalThis.fetch = vi.fn() as typeof fetch;
		expect(await register()({}, { ui: { notify: vi.fn() } })).toBeUndefined();
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("enabled below local cap with healthy credit does not block", async () => {
		setup(); globalThis.fetch = vi.fn(async (input) => new Response(JSON.stringify(String(input).includes("spending_limit") ? { spending_limit_cents: 10000 } : { balance_cents: 20000, as_of: "2026-09-22T00:00:00Z" }), { status: 200 })) as typeof fetch;
		expect(await register()({}, { ui: { notify: vi.fn() } })).toBeUndefined();
	});

	it("enabled at local cap blocks with documented message return", async () => {
		setup();
		const sessions = join(tempDir, "sessions");
		writeFileSync(join(tempDir, "sessions.jsonl"), "");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "session.jsonl"), JSON.stringify({ type: "message", message: { provider: "neon", timestamp: Date.now(), usage: { cost: { total: 0.01 } } } }));
		globalThis.fetch = vi.fn(async (input) => new Response(JSON.stringify(String(input).includes("spending_limit") ? { spending_limit_cents: 1 } : { balance_cents: 20000, as_of: "2026-09-22T00:00:00Z" }), { status: 200 })) as typeof fetch;
		const result = await register()({}, { ui: { notify: vi.fn() } });
		expect(result.message.customType).toBe("neon-cap-block");
		expect(result.message.display).toBe(true);
		expect(result.message.content).toContain("/neon-cap-block off");
	});

	it("blocks when recorded embedding spend reaches the local cap", async () => {
		setup();
		const sessions = join(tempDir, "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "session.jsonl"), JSON.stringify({ type: "message", message: {
			role: "toolResult", toolName: "neon_embed", isError: false, timestamp: Date.now(), usage: { cost: { total: 0.02 } },
		} }));
		globalThis.fetch = vi.fn(async (input) => new Response(JSON.stringify(String(input).includes("spending_limit") ? { spending_limit_cents: 2 } : { balance_cents: 20000, as_of: "2026-09-22T00:00:00Z" }), { status: 200 })) as typeof fetch;
		const result = await register()({}, { ui: { notify: vi.fn() } });
		expect(result.message.content).toContain("local spend $0.02");
	});

	it("blocks when combined Neon and Anthropic spend reaches the local cap once", async () => {
		setup();
		const sessions = join(tempDir, "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "session.jsonl"), [
			JSON.stringify({ type: "message", message: { provider: "neon", timestamp: Date.now(), usage: { cost: { total: 0.01 } } } }),
			JSON.stringify({ type: "message", message: { provider: "neon-anthropic", timestamp: Date.now(), usage: { cost: { total: 0.01 } } } }),
		].join("\n"));
		globalThis.fetch = vi.fn(async (input) => new Response(JSON.stringify(String(input).includes("spending_limit") ? { spending_limit_cents: 2 } : { balance_cents: 20000, as_of: "2026-09-22T00:00:00Z" }), { status: 200 })) as typeof fetch;
		const notifications: string[] = [];
		const result = await register()({}, { ui: { notify: (message: string) => notifications.push(message) } });
		expect(result.message.content).toContain("local spend $0.02");
		expect(notifications).toHaveLength(1);
	});

	it("uses only the spending cap when balance is unavailable", async () => {
		setup();
		const sessions = join(tempDir, "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "session.jsonl"), JSON.stringify({ type: "message", message: { provider: "neon", timestamp: Date.now(), usage: { cost: { total: 0.01 } } } }));
		globalThis.fetch = vi.fn(async (input) => {
			if (String(input).includes("aigw_credits")) return new Response("missing", { status: 404 });
			return new Response(JSON.stringify({ spending_limit_cents: 10000 }), { status: 200 });
		}) as typeof fetch;
		expect(await register()({}, { ui: { notify: vi.fn() } })).toBeUndefined();
	});

	it("uses only the credit balance when cap is unavailable", async () => {
		setup();
		const sessions = join(tempDir, "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "session.jsonl"), JSON.stringify({ type: "message", message: { provider: "neon", timestamp: Date.now(), usage: { cost: { total: 0.01 } } } }));
		globalThis.fetch = vi.fn(async (input) => {
			if (String(input).includes("spending_limit")) return new Response("missing", { status: 404 });
			return new Response(JSON.stringify({ balance_cents: 10000, as_of: "2026-09-22T00:00:00Z" }), { status: 200 });
		}) as typeof fetch;
		expect(await register()({}, { ui: { notify: vi.fn() } })).toBeUndefined();
	});

	it.each([
		{ name: "blocks at 199 cents with zero local spend", capCents: 10000, balanceCents: 199, spend: 0, reason: "credit" },
		{ name: "allows exactly 200 cents", capCents: 10000, balanceCents: 200, spend: 0, reason: null },
		{ name: "allows exactly 200 cents despite higher historical spend", capCents: null, balanceCents: 200, spend: 50, reason: null },
		{ name: "blocks negative current credit", capCents: null, balanceCents: -100, spend: 0, reason: "credit" },
		{ name: "allows high historical spend with healthy balance and no cap", capCents: null, balanceCents: 10000, spend: 500, reason: null },
		{ name: "allows historical spend above healthy balance but below cap", capCents: 100000, balanceCents: 10000, spend: 500, reason: null },
		{ name: "enforces cap with null balance", capCents: 10000, balanceCents: null, spend: 100, reason: "cap" },
		{ name: "enforces zero cap without balance", capCents: 0, balanceCents: null, spend: 0, reason: "cap" },
		{ name: "allows below cap without balance", capCents: 10000, balanceCents: null, spend: 99, reason: null },
		{ name: "enforces low credit without cap", capCents: null, balanceCents: 199, spend: 0, reason: "credit" },
		{ name: "enforces low credit when cap fetch throws", capCents: "offline", balanceCents: 199, spend: 0, reason: "credit" },
		{ name: "enforces low credit when cap endpoint is unavailable", capCents: "unavailable", balanceCents: 199, spend: 0, reason: "credit" },
		{ name: "enforces cap when balance fetch throws", capCents: 10000, balanceCents: "offline", spend: 100, reason: "cap" },
		{ name: "allows healthy balance when cap fetch throws", capCents: "offline", balanceCents: 10000, spend: 500, reason: null },
		{ name: "fails open when both values are null", capCents: null, balanceCents: null, spend: 500, reason: null },
	] as const)("$name", async ({ capCents, balanceCents, spend, reason }) => {
		setup();
		if (spend > 0) {
			const sessions = join(tempDir, "sessions");
			mkdirSync(sessions, { recursive: true });
			writeFileSync(join(sessions, "session.jsonl"), JSON.stringify({
				type: "message", message: { provider: "neon", timestamp: Date.now(), usage: { cost: { total: spend } } },
			}));
		}
		globalThis.fetch = vi.fn(async (input) => {
			if (String(input).includes("spending_limit")) {
				if (capCents === "offline") throw new Error("offline");
				if (capCents === "unavailable") return new Response("unavailable", { status: 503 });
				return new Response(JSON.stringify({ spending_limit_cents: capCents }), { status: 200 });
			}
			if (balanceCents === "offline") throw new Error("offline");
			return new Response(JSON.stringify({ balance_cents: balanceCents, as_of: "2026-09-22T00:00:00Z" }), { status: 200 });
		}) as typeof fetch;
		const notifications: string[] = [];
		const result = await register()({}, { ui: { notify: (message: string) => notifications.push(message) } });
		if (reason === null) {
			expect(result).toBeUndefined();
			expect(notifications).toHaveLength(0);
		} else {
			expect(result?.message.customType).toBe("neon-cap-block");
			expect(result?.message.display).toBe(true);
			expect(result?.message.content).toContain("/neon-cap-block off");
			expect(notifications).toEqual([result.message.content]);
			if (reason === "credit") {
				expect(result.message.content).toContain("below the $2.00 minimum");
				expect(result.message.content).toContain("Add credits");
			} else {
				expect(result.message.content).toContain("local spend");
				expect(result.message.content).toContain("local comparison cap");
			}
		}
	});

	it("fails open when the API cannot verify the limit", async () => {
		setup(); globalThis.fetch = vi.fn(async () => { throw new Error("offline"); }) as typeof fetch;
		expect(await register()({}, { ui: { notify: vi.fn() } })).toBeUndefined();
	});
});
