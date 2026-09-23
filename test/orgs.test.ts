import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setAgentDir, unsetAgentDir } from "./helpers/agent-dir.js";
import {
	listOrganizations,
	registerNeonOrgCommand,
	resolveActiveOrg,
	setActiveOrg,
} from "../src/orgs.js";

type Notification = { message: string; level: string };

const organizations = [
	{ id: "org-alpha", name: "Alpha", plan: "launch" },
	{ id: "org-beta", name: "Beta", plan: "scale" },
	{ id: "org-same-a", name: "Shared", plan: "free" },
	{ id: "org-same-b", name: "Shared", plan: "scale" },
];

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("organization helpers", () => {
	let originalFetch: typeof fetch;
	let tempDir: string;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
		tempDir = mkdtempSync(join(tmpdir(), "pi-neon-orgs-"));
		setAgentDir(tempDir);
		writeFileSync(join(tempDir, "auth.json"), JSON.stringify({ neon: {
			type: "api_key", key: "nt_test", managementKey: "napi_test", orgId: "org-alpha",
			env: { NEON_AI_GATEWAY_BASE_URL: "https://br-test.neon.tech" }, extra: "preserve",
		} }));
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		unsetAgentDir();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("listOrganizations returns all parsed orgs", async () => {
		globalThis.fetch = (async () => response({ organizations })) as typeof fetch;
		expect(await listOrganizations("napi_test")).toEqual(organizations);
	});
	it("listOrganizations returns empty array when empty", async () => {
		globalThis.fetch = (async () => response({ organizations: [] })) as typeof fetch;
		expect(await listOrganizations("napi_test")).toEqual([]);
	});
	it("listOrganizations surfaces API error", async () => {
		globalThis.fetch = (async () => response({ message: "forbidden" }, 403)) as typeof fetch;
		await expect(listOrganizations("napi_test")).rejects.toThrow("status 403");
	});
	it("setActiveOrg preserves other auth fields", async () => {
		await setActiveOrg("org-beta");
		const parsed = JSON.parse(readFileSync(join(tempDir, "auth.json"), "utf8"));
		expect(parsed.neon.orgId).toBe("org-beta");
		expect(parsed.neon.managementKey).toBe("napi_test");
		expect(parsed.neon.env).toEqual({ NEON_AI_GATEWAY_BASE_URL: "https://br-test.neon.tech" });
		expect(parsed.neon.extra).toBe("preserve");
	});
	it("resolveActiveOrg uses persisted org without fetching", async () => {
		let calls = 0;
		globalThis.fetch = (async () => { calls++; return response({ organizations }); }) as typeof fetch;
		expect(await resolveActiveOrg({ storedOrgId: "org-beta", apiKey: "napi_test" })).toEqual({
			orgId: "org-beta", orgDisplay: "org-beta", wasAutoDiscovered: false,
		});
		expect(calls).toBe(0);
	});
	it("resolveActiveOrg auto-discovers and persists first org", async () => {
		writeFileSync(join(tempDir, "auth.json"), JSON.stringify({ neon: { managementKey: "napi_test" } }));
		globalThis.fetch = (async () => response({ organizations })) as typeof fetch;
		const result = await resolveActiveOrg({ storedOrgId: undefined, apiKey: "napi_test" });
		expect(result.orgId).toBe("org-alpha");
		expect(result.wasAutoDiscovered).toBe(true);
		const parsed = JSON.parse(readFileSync(join(tempDir, "auth.json"), "utf8"));
		expect(parsed.neon.orgId).toBe("org-alpha");
	});
});

describe("/neon-org command", () => {
	let originalFetch: typeof fetch;
	let tempDir: string;
	let notifications: Notification[];
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
		tempDir = mkdtempSync(join(tmpdir(), "pi-neon-org-command-"));
		setAgentDir(tempDir);
		writeFileSync(join(tempDir, "auth.json"), JSON.stringify({ neon: { managementKey: "napi_test", orgId: "org-alpha" } }));
		notifications = [];
		handler = undefined;
		const pi = { registerCommand(_name: string, options: { handler: typeof handler }) { handler = options.handler; } };
		registerNeonOrgCommand(pi as never);
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		unsetAgentDir();
		rmSync(tempDir, { recursive: true, force: true });
	});
	const ctx = () => ({ ui: { notify: (message: string, level: string) => notifications.push({ message, level }) } });

	it("shows the persisted active org", async () => {
		await handler!("", ctx());
		expect(notifications[0]?.message).toContain("org-alpha");
	});
	it("shows no active org when not persisted", async () => {
		writeFileSync(join(tempDir, "auth.json"), JSON.stringify({ neon: { managementKey: "napi_test" } }));
		await handler!("", ctx());
		expect(notifications[0]?.message.toLowerCase()).toContain("no active org");
	});
	it("lists all orgs with index, id, name, plan, and active marker", async () => {
		globalThis.fetch = (async () => response({ organizations })) as typeof fetch;
		await handler!("list", ctx());
		expect(notifications[0]?.message).toContain("* 1. Alpha (org-alpha) [launch]");
		expect(notifications[0]?.message).toContain("  2. Beta (org-beta) [scale]");
	});
	it("requires a management key for list", async () => {
		writeFileSync(join(tempDir, "auth.json"), JSON.stringify({ neon: {} }));
		await handler!("list", ctx());
		expect(notifications[0]?.message).toContain("no management key");
	});
	it("uses an exact id", async () => {
		globalThis.fetch = (async () => response({ organizations })) as typeof fetch;
		await handler!("use org-beta", ctx());
		const parsed = JSON.parse(readFileSync(join(tempDir, "auth.json"), "utf8"));
		expect(parsed.neon.orgId).toBe("org-beta");
	});
	it("uses a case-insensitive name", async () => {
		globalThis.fetch = (async () => response({ organizations })) as typeof fetch;
		await handler!("use beta", ctx());
		const parsed = JSON.parse(readFileSync(join(tempDir, "auth.json"), "utf8"));
		expect(parsed.neon.orgId).toBe("org-beta");
	});
	it("reports ambiguous matches", async () => {
		globalThis.fetch = (async () => response({ organizations })) as typeof fetch;
		await handler!("use shared", ctx());
		expect(notifications[0]?.message).toContain("Multiple");
	});
	it("reports unknown matches", async () => {
		globalThis.fetch = (async () => response({ organizations })) as typeof fetch;
		await handler!("use missing", ctx());
		expect(notifications[0]?.message).toContain("No Neon organization matched");
	});
});
