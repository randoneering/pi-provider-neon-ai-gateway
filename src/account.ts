/**
 * Neon management API integration: /neon-balance.
 *
 * The Neon AI Gateway token has `ai_gateway:invoke` scope only. It cannot
 * query the management API. To read the org spending limit we ask the
 * user for a separate Neon management API key (`napi_...`), stored on the
 * existing `neon` auth.json entry under `managementKey`.
 *
 * This module does three things:
 *
 *   1. Aggregate this machine's local Neon spend from session JSONL files.
 *   2. Hit the public Neon management API to resolve the org id (cached
 *      back to auth.json) and the configured spending cap.
 *   3. Render the /neon-balance notification combining the two.
 *
 * No real money data is ever sent through the gateway token path.
 */

import { opendir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	NEON_AI_GATEWAY_BASE_URL_ENV,
	NEON_API_BASE_URL,
	resolveNeonManagementKey,
} from "./config.js";
import { readAuthFile, writeAuthFile } from "./auth.js";

const PROVIDER_ID = "neon";
const MANAGEMENT_API_TIMEOUT_MS = 10_000;

export interface LocalSpend {
	totalCost: number;
	sessionCount: number;
	firstTimestamp: number | undefined;
}

export interface StoredNeonCredential {
	managementKey: string | undefined;
	orgId: string | undefined;
	gatewayBaseUrl: string | undefined;
}

/**
 * Walk ~/.pi/agent/sessions/ recursively and sum the `usage.cost.total` of
 * every assistant message whose provider is the Neon AI Gateway. Skips
 * aborted messages (zero cost) and malformed JSONL lines.
 *
 * Exported for direct testing. Returns zeros when the sessions dir does
 * not exist (first run).
 */
export async function aggregateLocalSpend(agentDir: string): Promise<LocalSpend> {
	const root = join(agentDir, "sessions");
	const files = await collectJsonlFiles(root);
	let totalCost = 0;
	let sessionCount = 0;
	let firstTimestamp: number | undefined;
	const seenFiles = new Set<string>();

	for (const file of files) {
		seenFiles.add(file);
		let content: string;
		try {
			content = await readFile(file, "utf-8");
		} catch {
			continue;
		}
		const lines = content.split("\n");
		let fileContributed = false;
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				continue;
			}
			const usage = extractNeonCost(parsed);
			if (usage === undefined) continue;
			totalCost += usage.cost;
			fileContributed = true;
			if (usage.timestamp !== undefined) {
				if (firstTimestamp === undefined || usage.timestamp < firstTimestamp) {
					firstTimestamp = usage.timestamp;
				}
			}
		}
		if (fileContributed) sessionCount += 1;
	}

	return { totalCost, sessionCount, firstTimestamp };
}

async function collectJsonlFiles(root: string): Promise<string[]> {
	const results: string[] = [];
	let dir;
	try {
		dir = await opendir(root);
	} catch {
		return results;
	}
	for await (const entry of dir) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) {
			const nested = await collectJsonlFiles(full);
			results.push(...nested);
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			results.push(full);
		}
	}
	return results;
}

interface NeonCostSample {
	cost: number;
	timestamp: number | undefined;
}

function extractNeonCost(value: unknown): NeonCostSample | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type !== "message") return undefined;
	const message = value.message;
	if (!isRecord(message)) return undefined;
	if (message.provider !== "neon") return undefined;
	const usage = message.usage;
	if (!isRecord(usage)) return undefined;
	const cost = usage.cost;
	if (!isRecord(cost)) return undefined;
	const total = cost.total;
	if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return undefined;
	const ts = message.timestamp;
	return { cost: total, timestamp: typeof ts === "number" ? ts : undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Management API helpers
// ---------------------------------------------------------------------------

export function parseSpendingLimit(value: unknown): number | null {
	if (!isRecord(value)) return null;
	const cents = value.spending_limit_cents;
	if (cents === null || cents === undefined) return null;
	if (typeof cents !== "number" || !Number.isFinite(cents)) return null;
	return cents / 100;
}

export interface ParsedOrg {
	id: string;
	name: string;
}

export function parseUserOrganizations(value: unknown): ParsedOrg | undefined {
	if (!isRecord(value)) return undefined;
	const list = value.organizations;
	if (!Array.isArray(list)) return undefined;
	for (const entry of list) {
		if (!isRecord(entry)) continue;
		if (typeof entry.id === "string" && typeof entry.name === "string") {
			return { id: entry.id, name: entry.name };
		}
	}
	return undefined;
}

/**
 * Fetch the user's first organization via the public Neon management API.
 * The endpoint returns a single org when called with an org-/project-scoped
 * key, which is the common case.
 */
export async function fetchCurrentOrg(apiKey: string): Promise<ParsedOrg> {
	const response = await managementApiFetch("/users/me/organizations", apiKey);
	const parsed: unknown = await response.json();
	const org = parseUserOrganizations(parsed);
	if (!org) {
		throw new Error("Neon management API returned no usable organization for this key");
	}
	return org;
}

/**
 * Fetch the configured spending limit for an org. Returns null when no
 * cap is set (`spending_limit_cents: null`).
 */
export async function fetchSpendingLimit(orgId: string, apiKey: string): Promise<number | null> {
	const response = await managementApiFetch(`/organizations/${orgId}/billing/spending_limit`, apiKey);
	const parsed: unknown = await response.json();
	return parseSpendingLimit(parsed);
}

async function managementApiFetch(path: string, apiKey: string): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), MANAGEMENT_API_TIMEOUT_MS);
	try {
		return await fetch(`${NEON_API_BASE_URL}${path}`, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatUsd(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

function formatMonthYear(timestamp: number): string {
	const d = new Date(timestamp);
	const month = d.toLocaleString("en-US", { month: "short", year: "numeric" });
	return month;
}

// ---------------------------------------------------------------------------
// Stored credential accessors
// ---------------------------------------------------------------------------

export async function readStoredNeonCredential(): Promise<StoredNeonCredential> {
	const file = readAuthFile();
	const stored = file[PROVIDER_ID];
	if (!stored || typeof stored !== "object") {
		return { managementKey: undefined, orgId: undefined, gatewayBaseUrl: undefined };
	}
	const obj = stored as Record<string, unknown>;
	const env = obj.env;
	const gatewayBaseUrl =
		env && typeof env === "object"
			? (env as Record<string, string>)[NEON_AI_GATEWAY_BASE_URL_ENV]
			: undefined;
	return {
		managementKey: typeof obj.managementKey === "string" ? obj.managementKey : undefined,
		orgId: typeof obj.orgId === "string" ? obj.orgId : undefined,
		gatewayBaseUrl,
	};
}

async function persistOrgId(orgId: string): Promise<void> {
	const file = readAuthFile();
	const stored = file[PROVIDER_ID];
	if (!stored || typeof stored !== "object") return;
	const obj = stored as Record<string, unknown>;
	obj.orgId = orgId;
	file[PROVIDER_ID] = obj;
	await writeAuthFile(file);
}

// ---------------------------------------------------------------------------
// /neon-balance command
// ---------------------------------------------------------------------------

export function registerNeonSpendingLimitCommand(pi: ExtensionAPI): void {
	pi.registerCommand("neon-spending-limit", {
		description: "Show the Neon organization spending cap",
		handler: async (_args, ctx) => {
			const stored = await readStoredNeonCredential();
			const managementKey = resolveNeonManagementKey({
				processEnv: process.env as Record<string, string | undefined>,
				storedManagementKey: stored.managementKey,
			});

			if (!managementKey) {
				ctx.ui.notify(
					"Neon spending limit unavailable: no management key configured. Re-run /neon-login or export NEON_API_KEY.",
					"warning",
				);
				return;
			}

			try {
				let orgId = stored.orgId;
				let orgDisplay = orgId;
				if (!orgId) {
					const org = await fetchCurrentOrg(managementKey);
					orgId = org.id;
					orgDisplay = `${org.name} (${org.id})`;
					await persistOrgId(org.id);
				}
				const cap = await fetchSpendingLimit(orgId, managementKey);
				const limit = cap === null ? "(none configured)" : formatUsd(cap);
				ctx.ui.notify(
					`Neon spending limit: ${limit}\nOrg: ${orgDisplay ?? orgId}`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Neon spending limit unavailable: ${(error as Error).message}`, "warning");
			}
		},
	});
}

export function registerNeonAccountCommands(pi: ExtensionAPI): void {
	pi.registerCommand("neon-balance", {
		description: "Show org spending cap and this machine's local Neon spend",
		handler: async (_args, ctx) => {
			const stored = await readStoredNeonCredential();
			const managementKey = resolveNeonManagementKey({
				processEnv: process.env as Record<string, string | undefined>,
				storedManagementKey: stored.managementKey,
			});

			if (!managementKey) {
				ctx.ui.notify(
					[
						"Neon balance unavailable: no management key configured.",
						"Re-run /neon-login and paste a Neon management API key (napi_...),",
						"or export NEON_API_KEY before starting pi.",
					].join("\n"),
					"warning",
				);
				return;
			}

			let orgId = stored.orgId;
			let orgDisplay = orgId ?? "(resolving)";
			try {
				if (!orgId) {
					const org = await fetchCurrentOrg(managementKey);
					orgId = org.id;
					orgDisplay = `${org.name} (${org.id})`;
					await persistOrgId(org.id);
				} else {
					orgDisplay = orgId;
				}
				const cap = await fetchSpendingLimit(orgId, managementKey);
				const local = await aggregateLocalSpend(getAgentDir());

				const lines: string[] = ["Neon account balance:"];
				const row = (label: string, value: string) =>
					`  ${label.padEnd(15, " ")}${value}`;
				lines.push(row("Org:", orgDisplay));
				if (cap === null) {
					lines.push(row("Spending cap:", "(none configured)"));
				} else {
					lines.push(row("Spending cap:", formatUsd(cap)));
				}
				if (local.sessionCount === 0) {
					lines.push(row("Local spend:", "$0.00 (no completed Neon sessions on this machine)"));
				} else {
					const since = local.firstTimestamp ? formatMonthYear(local.firstTimestamp) : "unknown";
					lines.push(
						row(
							"Local spend:",
							`${formatUsd(local.totalCost)} across ${local.sessionCount} session${local.sessionCount === 1 ? "" : "s"} (since ${since})`,
						),
					);
					if (cap !== null) {
						const headroom = Math.max(0, cap - local.totalCost);
						lines.push(row("Headroom:", `${formatUsd(headroom)} (cap − local spend, this machine only)`));
					}
				}
				lines.push(row("Balance:", "Not exposed by the Neon API. Visible in the Neon Console."));
				lines.push(row("Note:", "Local spend ignores other machines and any Neon DB charges."));

				ctx.ui.notify(lines.join("\n"), "info");
			} catch (error) {
				const message = (error as Error).message;
				const level = /401|403|unauthor/i.test(message) ? "error" : "warning";
				ctx.ui.notify(
					`Could not reach the Neon management API: ${message}\nIf your management key is wrong, re-run /neon-login.`,
					level,
				);
			}
		},
	});
}
