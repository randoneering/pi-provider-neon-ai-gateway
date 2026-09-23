import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NEON_API_BASE_URL, resolveNeonManagementKey } from "./config.js";
import { readAuthFile, writeAuthFile } from "./auth.js";

const PROVIDER_ID = "neon";

export interface Organization {
	id: string;
	name: string;
	plan?: string;
}

export interface Organization {
	id: string;
	name: string;
	plan?: string;
}

export interface ActiveOrg {
	orgId: string;
	orgDisplay: string;
	wasAutoDiscovered: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOrganizations(value: unknown): Organization[] {
	if (!isRecord(value) || !Array.isArray(value.organizations)) return [];
	return value.organizations.flatMap((entry): Organization[] => {
		if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string") return [];
		return [{ id: entry.id, name: entry.name, plan: typeof entry.plan === "string" ? entry.plan : undefined }];
	});
}

async function managementApiFetch(path: string, apiKey: string): Promise<Response> {
	const response = await fetch(`${NEON_API_BASE_URL}${path}`, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
	});
	if (!response.ok) {
		let detail = "";
		try {
			const body: unknown = await response.clone().json();
			if (isRecord(body) && typeof body.message === "string") detail = `: ${body.message}`;
		} catch { /* preserve status when body is not JSON */ }
		throw new Error(`Neon management API returned status ${response.status}${detail}`);
	}
	return response;
}

export async function listOrganizations(apiKey: string): Promise<Organization[]> {
	const response = await managementApiFetch("/users/me/organizations", apiKey);
	return parseOrganizations(await response.json());
}

export async function setActiveOrg(orgId: string): Promise<void> {
	const file = readAuthFile();
	const stored = file[PROVIDER_ID];
	if (!stored || typeof stored !== "object") throw new Error("No Neon credential is configured");
	const credential = stored as Record<string, unknown>;
	credential.orgId = orgId;
	file[PROVIDER_ID] = credential;
	await writeAuthFile(file);
}

export async function resolveActiveOrg(options: {
	storedOrgId?: string;
	apiKey: string;
}): Promise<ActiveOrg> {
	if (options.storedOrgId) {
		return { orgId: options.storedOrgId, orgDisplay: options.storedOrgId, wasAutoDiscovered: false };
	}
	const organizations = await listOrganizations(options.apiKey);
	const first = organizations[0];
	if (!first) throw new Error("Neon management API returned no organizations for this key");
	await setActiveOrg(first.id);
	return {
		orgId: first.id,
		orgDisplay: `${first.name} (${first.id})`,
		wasAutoDiscovered: true,
	};
}

function formatOrg(org: Organization, index: number, activeId?: string): string {
	const marker = org.id === activeId ? "*" : " ";
	const plan = org.plan ? ` [${org.plan}]` : "";
	return `${marker} ${index + 1}. ${org.name} (${org.id})${plan}`;
}

function readStoredCredential(): { managementKey: string | undefined; orgId: string | undefined } {
	const file = readAuthFile();
	const stored = file[PROVIDER_ID];
	if (!stored || typeof stored !== "object") return { managementKey: undefined, orgId: undefined };
	const obj = stored as Record<string, unknown>;
	return {
		managementKey: typeof obj.managementKey === "string" ? obj.managementKey : undefined,
		orgId: typeof obj.orgId === "string" ? obj.orgId : undefined,
	};
}

export function registerNeonOrgCommand(pi: ExtensionAPI): void {
	pi.registerCommand("neon-org", {
		description: "List or switch the active Neon organization",
		handler: async (args, ctx) => {
			const command = args.trim();
			const stored = readStoredCredential();
			const managementKey = resolveNeonManagementKey({
				processEnv: process.env as Record<string, string | undefined>,
				storedManagementKey: stored.managementKey,
			});

			if (!command) {
				ctx.ui.notify(
					stored.orgId
						? `Active Neon organization: ${stored.orgId}`
						: "No active org. Run /neon-org list to see options.",
					"info",
				);
				return;
			}
			if (!managementKey) {
				ctx.ui.notify("Neon organization unavailable: no management key configured. Re-run /neon-login or export NEON_API_KEY.", "warning");
				return;
			}

			const [subcommand, ...rest] = command.split(/\s+/u);
			try {
				const organizations = await listOrganizations(managementKey);
				if (subcommand === "list") {
					if (organizations.length === 0) {
						ctx.ui.notify("No Neon organizations found for this management key.", "warning");
						return;
					}
					ctx.ui.notify(organizations.map((org, index) => formatOrg(org, index, stored.orgId)).join("\n"), "info");
					return;
				}
				if (subcommand === "use") {
					const query = rest.join(" ").trim().toLowerCase();
					if (!query) {
						ctx.ui.notify("Usage: /neon-org use <id|name>", "warning");
						return;
					}
					const matches = organizations.filter((org) => org.id.toLowerCase() === query || org.name.toLowerCase() === query);
					if (matches.length === 0) {
						ctx.ui.notify(`No Neon organization matched '${rest.join(" ")}'.`, "warning");
						return;
					}
					if (matches.length > 1) {
						ctx.ui.notify(`Multiple Neon organizations matched '${rest.join(" ")}'. Use the exact organization id.`, "warning");
						return;
					}
					await setActiveOrg(matches[0]!.id);
					ctx.ui.notify(`Active Neon organization set to ${matches[0]!.name} (${matches[0]!.id}).`, "info");
					return;
				}
				ctx.ui.notify("Usage: /neon-org [list | use <id|name>]", "warning");
			} catch (error) {
				ctx.ui.notify(`Neon organization unavailable: ${(error as Error).message}`, "warning");
			}
		},
	});
}
