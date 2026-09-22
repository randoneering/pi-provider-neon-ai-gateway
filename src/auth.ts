/**
 * Neon AI Gateway auth commands: /neon-login, /neon-logout, /neon-status.
 *
 * pi's built-in login only handles OAuth providers. Neon auth is a static
 * token plus a branch base URL, so these commands write an api_key
 * credential plus env overrides straight to auth.json, in the shape pi's
 * resolver reads.
 *
 * Env vars work too. Set NEON_AI_GATEWAY_TOKEN and NEON_AI_GATEWAY_BASE_URL
 * before starting pi and skip these commands.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	NEON_AI_GATEWAY_BASE_URL_ENV,
	NEON_AI_GATEWAY_TOKEN_ENV,
	normalizeNeonBaseUrl,
} from "./config.js";

const PROVIDER_ID = "neon";

export function validateGatewayToken(value: string): void {
	if (value.startsWith("!") || value.startsWith("$")) {
		throw new Error("Neon AI Gateway token must be a literal token, not a shell expression");
	}
}

/**
 * Validate a Neon management API key (`napi_...`).
 *
 * Rejects shell-expression prefixes that pi might evaluate and rejects
 * keys that don't start with `napi_` so a pasted gateway token can't
 * accidentally end up sent to the management API.
 */
export function validateManagementKey(value: string): void {
	if (value.startsWith("!") || value.startsWith("$")) {
		throw new Error("Neon management key must be a literal token, not a shell expression");
	}
	if (!value.startsWith("napi_")) {
		throw new Error("Neon management key must start with napi_");
	}
}

export interface AuthFileShape {
	[key: string]: unknown;
}

function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

export function readAuthFile(): AuthFileShape {
	const path = getAuthPath();
	if (!existsSync(path)) return {};
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (error) {
		throw new Error(`Failed to read ${path}: ${(error as Error).message}`);
	}
	if (!raw.trim()) return {};
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("auth.json root must be an object");
		}
		return parsed as AuthFileShape;
	} catch (error) {
		throw new Error(`Failed to parse ${path}: ${(error as Error).message}`);
	}
}

export async function writeAuthFile(data: AuthFileShape): Promise<void> {
	const path = getAuthPath();
	await mkdir(dirname(path), { recursive: true });
	const json = `${JSON.stringify(data, null, 2)}\n`;
	writeFileSync(path, json, { encoding: "utf-8", mode: 0o600 });
	await chmod(path, 0o600).catch(() => undefined);
}

export function registerNeonAuthCommands(pi: ExtensionAPI): void {
	pi.registerCommand("neon-login", {
		description: "Configure Neon AI Gateway token and branch base URL",
		handler: async (_args, ctx) => {
			const token = await ctx.ui.input("Enter Neon AI Gateway token");
			if (!token) {
				ctx.ui.notify("Neon login cancelled: no token provided", "warning");
				return;
			}
			try {
				validateGatewayToken(token);
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
				return;
			}
			const baseUrlInput = await ctx.ui.input(
				"Enter Neon AI Gateway base URL",
				"https://br-example-api.ai.c-2.us-east-2.aws.neon.tech",
			);
			if (!baseUrlInput) {
				ctx.ui.notify("Neon login cancelled: no base URL provided", "warning");
				return;
			}
			let baseUrl: string;
			try {
				baseUrl = normalizeNeonBaseUrl(baseUrlInput);
			} catch (error) {
				ctx.ui.notify(`Invalid base URL: ${(error as Error).message}`, "error");
				return;
			}

			const file = readAuthFile();
			const existing = file[PROVIDER_ID];
			const credential: Record<string, unknown> = {
				type: "api_key",
				key: token,
				env: { [NEON_AI_GATEWAY_BASE_URL_ENV]: baseUrl },
			};
			if (typeof existing === "object" && existing !== null) {
				const prior = existing as Record<string, unknown>;
				const priorEnv = prior.env;
				if (priorEnv && typeof priorEnv === "object") {
					credential.env = { ...(priorEnv as Record<string, string>), [NEON_AI_GATEWAY_BASE_URL_ENV]: baseUrl };
				}
				if (typeof prior.managementKey === "string") {
					credential.managementKey = prior.managementKey;
				}
				if (typeof prior.orgId === "string") {
					credential.orgId = prior.orgId;
				}
			}

			const managementKeyInput = await ctx.ui.input(
				"Neon management API key (optional, enables /neon-balance; format: napi_...)",
			);
			if (managementKeyInput) {
				try {
					validateManagementKey(managementKeyInput);
					credential.managementKey = managementKeyInput;
				} catch (error) {
					ctx.ui.notify(
						`Skipped management key: ${(error as Error).message}. Gateway credential saved.`,
						"warning",
					);
				}
			}

			file[PROVIDER_ID] = credential;
			await writeAuthFile(file);

			ctx.ui.notify(
				`Neon AI Gateway configured. Base URL: ${baseUrl}. Use /reload to pick up the credential.`,
				"info",
			);
		},
	});

	pi.registerCommand("neon-logout", {
		description: "Remove the stored Neon AI Gateway credential",
		handler: async (_args, ctx) => {
			const file = readAuthFile();
			if (!(PROVIDER_ID in file)) {
				ctx.ui.notify("No Neon AI Gateway credential stored.", "info");
				return;
			}
			delete file[PROVIDER_ID];
			await writeAuthFile(file);
			ctx.ui.notify("Neon AI Gateway credential removed. Use /reload to pick up the change.", "info");
		},
	});

	pi.registerCommand("neon-status", {
		description: "Show the resolved Neon AI Gateway base URL and credential status",
		handler: async (_args, ctx) => {
			const file = readAuthFile();
			const stored = file[PROVIDER_ID];
			const storedObj = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : undefined;
			const storedEnv =
				storedObj?.env && typeof storedObj.env === "object"
					? (storedObj.env as Record<string, string>)
					: undefined;
			const storedBaseUrl = storedEnv?.[NEON_AI_GATEWAY_BASE_URL_ENV];
			const fromEnv = process.env[NEON_AI_GATEWAY_BASE_URL_ENV];
			const hasToken =
				!!process.env[NEON_AI_GATEWAY_TOKEN_ENV] || !!storedObj?.key;
			const resolvedBaseUrl = storedBaseUrl ?? fromEnv;
			const hasManagementKey =
				!!process.env.NEON_API_KEY ||
				!!(storedObj && typeof storedObj.managementKey === "string");
			const storedOrgId =
				storedObj && typeof storedObj.orgId === "string" ? storedObj.orgId : undefined;
			ctx.ui.notify(
				[
					`Neon AI Gateway status:`,
					`  Token: ${hasToken ? "configured" : "missing"}`,
					`  Base URL: ${resolvedBaseUrl ?? "(not set)"}`,
					`  Source: ${storedBaseUrl ? "auth.json" : fromEnv ? "environment" : "(none)"}`,
					`  Management key: ${hasManagementKey ? "configured" : "(not set; /neon-balance disabled)"}`,
					`  Org id: ${storedOrgId ?? "(auto-discover on first /neon-balance)"}`,
				].join("\n"),
				hasToken && resolvedBaseUrl ? "info" : "warning",
			);
		},
	});
}
