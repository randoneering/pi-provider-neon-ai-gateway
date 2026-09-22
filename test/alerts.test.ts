import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerNeonAlertHooks } from "../src/alerts.js";
import { setAgentDir, unsetAgentDir } from "./helpers/agent-dir.js";

function writeSpend(agentDir: string, cost: number): void {
	const dir = join(agentDir, "sessions", "alert-test");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "session.jsonl"),
		JSON.stringify({
			type: "message",
			message: {
				provider: "neon",
				usage: { cost: { total: cost } },
				timestamp: Date.now(),
			},
		}),
	);
}

function writeAuth(agentDir: string, managementKey = "napi_test", orgId = "org-test"): void {
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({ neon: { type: "api_key", key: "nt_live_test", managementKey, orgId } }),
	);
}

type Handler = (event: unknown, ctx: { ui: { notify: (message: string, level: string) => void; setStatus: (key: string, value: string) => void } }) => Promise<unknown>;

function registerHandlers(): { beforeAgentStart: Handler; sessionStart: Handler } {
	let beforeAgentStart: Handler | undefined;
	let sessionStart: Handler | undefined;
	const pi = {
		on(event: string, callback: Handler) {
			if (event === "before_agent_start") beforeAgentStart = callback;
			if (event === "session_start") sessionStart = callback;
		},
	};
	registerNeonAlertHooks(pi as never);
	if (!beforeAgentStart || !sessionStart) throw new Error("alert handlers were not registered");
	return { beforeAgentStart, sessionStart };
}

function registerAndGetHandler(): Handler {
	return registerHandlers().beforeAgentStart;
}

describe("Neon spending cap alerts", () => {
	let agentDir: string;
	let originalFetch: typeof globalThis.fetch;
	let fetchCalls: string[];
	let notifications: string[];
	let statuses: [string, string][];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-neon-alerts-"));
		setAgentDir(agentDir);
		writeAuth(agentDir);
		originalFetch = globalThis.fetch;
		fetchCalls = [];
		notifications = [];
		statuses = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			fetchCalls.push(url);
			return new Response(JSON.stringify({ spending_limit_cents: 10000 }), { status: 200 });
		}) as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		unsetAgentDir();
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function run(handler: Handler): Promise<void> {
		await handler({}, { ui: {
			notify: (message) => notifications.push(message),
			setStatus: (key, value) => statuses.push([key, value]),
		} });
	}

	it("fires each threshold only once per session", async () => {
		writeSpend(agentDir, 8000);
		const handler = registerAndGetHandler();
		await run(handler);
		await run(handler);
		expect(notifications).toHaveLength(3);
		expect(notifications.filter((message) => message.includes("50%+"))).toHaveLength(1);
		expect(notifications.filter((message) => message.includes("80%+"))).toHaveLength(1);
		expect(notifications.filter((message) => message.includes("95%+"))).toHaveLength(1);
	});

	it("fires all crossed thresholds in one turn", async () => {
		writeSpend(agentDir, 9500);
		await run(registerAndGetHandler());
		expect(notifications).toHaveLength(3);
		expect(notifications.map((message) => message.match(/\((\d+)%\+/)?.[1])).toEqual(["50", "80", "95"]);
	});

	it("does not fire when cap is null", async () => {
		globalThis.fetch = (async () => new Response(JSON.stringify({ spending_limit_cents: null }), { status: 200 })) as typeof globalThis.fetch;
		writeSpend(agentDir, 9500);
		await run(registerAndGetHandler());
		expect(notifications).toHaveLength(0);
	});

	it("does not fire when management key is missing", async () => {
		writeAuth(agentDir, "", "org-test");
		writeSpend(agentDir, 9500);
		await run(registerAndGetHandler());
		expect(notifications).toHaveLength(0);
		expect(fetchCalls).toHaveLength(0);
	});

	it("swallows spending-limit fetch errors", async () => {
		globalThis.fetch = (async () => { throw new Error("network failure"); }) as typeof globalThis.fetch;
		writeSpend(agentDir, 9500);
		await expect(run(registerAndGetHandler())).resolves.toBeUndefined();
		expect(notifications).toHaveLength(0);
	});

	it("uses the cap cache within the fifteen-minute window", async () => {
		writeSpend(agentDir, 5000);
		const handler = registerAndGetHandler();
		await run(handler);
		await run(handler);
		expect(fetchCalls).toHaveLength(2);
	});

	it("identifies alerts as local or this-machine spend", async () => {
		writeSpend(agentDir, 8000);
		await run(registerAndGetHandler());
		expect(notifications.every((message) => message.includes("this machine") || message.includes("local spend"))).toBe(true);
	});

	it("publishes cap and local spend percentage", async () => {
		writeSpend(agentDir, 32);
		await run(registerAndGetHandler());
		expect(statuses).toContainEqual(["neon-cap", "$100.00 · 32%"]);
	});

	it("publishes zero percent when local spend is zero", async () => {
		await run(registerAndGetHandler());
		expect(statuses).toContainEqual(["neon-cap", "$100.00 · 0%"]);
	});

	it("publishes no cap when the cap is null", async () => {
		globalThis.fetch = (async () => new Response(JSON.stringify({ spending_limit_cents: null }), { status: 200 })) as typeof fetch;
		await run(registerAndGetHandler());
		expect(statuses).toContainEqual(["neon-cap", "no cap"]);
	});

	it("clamps over-cap local spend to 100 percent", async () => {
		writeSpend(agentDir, 15000);
		await run(registerAndGetHandler());
		expect(statuses).toContainEqual(["neon-cap", "$100.00 · 100%"]);
	});

	it("does not publish status when management key is missing", async () => {
		writeAuth(agentDir, "", "org-test");
		await run(registerAndGetHandler());
		expect(statuses).toHaveLength(0);
	});

	it("does not publish status when cap fetch errors", async () => {
		globalThis.fetch = (async () => { throw new Error("network failure"); }) as typeof fetch;
		await run(registerAndGetHandler());
		expect(statuses).toHaveLength(0);
	});

	it("publishes status from session_start", async () => {
		const handlers = registerHandlers();
		await run(handlers.sessionStart);
		expect(statuses).toContainEqual(["neon-cap", "$100.00 · 0%"]);
	});
});
