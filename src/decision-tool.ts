import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readAuthFile } from "./auth.js";
import { NEON_AI_GATEWAY_TOKEN_ENV } from "./config.js";
import { decisionOutput, decisionParameters, decisionUsage, requestNeonDecision, type DecisionCredential } from "./decisions.js";

function preferencePath(): string {
	return join(getAgentDir(), "neon-decisions.json");
}

export function readDecisionEnabled(): boolean {
	try {
		const value: unknown = JSON.parse(readFileSync(preferencePath(), "utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value) &&
			(value as Record<string, unknown>).enabled === true;
	} catch {
		// Missing, unreadable, or malformed preferences must never enable paid calls.
		return false;
	}
}

function writeDecisionEnabled(enabled: boolean): void {
	mkdirSync(getAgentDir(), { recursive: true });
	const target = preferencePath();
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify({ enabled })}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, target);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename already consumed the temporary file. */ }
	}
}

export function readNeonDecisionCredential(): DecisionCredential | undefined {
	let file: ReturnType<typeof readAuthFile>;
	try { file = readAuthFile(); }
	catch { throw new Error("Cannot read stored Neon credentials. Check auth.json or run /neon-login."); }
	let fallback: DecisionCredential | undefined;
	for (const provider of ["neon", "neon-anthropic", "neon-responses"]) {
		const value = file[provider];
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const entry = value as Record<string, unknown>;
		const env = typeof entry.env === "object" && entry.env !== null && !Array.isArray(entry.env)
			? Object.fromEntries(Object.entries(entry.env).filter((pair): pair is [string, string] => typeof pair[1] === "string"))
			: undefined;
		const credential = { key: typeof entry.key === "string" ? entry.key : undefined, env };
		if (credential.key?.trim() || env?.[NEON_AI_GATEWAY_TOKEN_ENV]?.trim()) return credential;
		fallback ??= credential;
	}
	return fallback;
}

export function registerNeonDecisionTool(pi: ExtensionAPI): void {
	const register = (): void => {
		const enabled = readDecisionEnabled();
		pi.registerTool(defineTool({
			name: "neon_decide",
			label: "Neon decision",
			description: "Classify, route, or score text or JSON with Jev 1.14 or OpenJev through Neon AI Gateway. Ask named noul (yes/no), choice, or score questions and receive probabilities. Sends the supplied state to Neon and bills input tokens. Does not generate text or execute actions.",
			parameters: decisionParameters,
			outputSchema: decisionOutput,
			exposure: enabled ? "direct" : "hidden",
			defaultActive: enabled,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			async execute(_toolCallId, params, signal) {
				// Hidden declarations alone cannot protect calls queued before disabling.
				if (!readDecisionEnabled()) throw new Error("Neon decisions are disabled. Run /neon-decide enable to use this tool.");
				const result = await requestNeonDecision(params, { credential: readNeonDecisionCredential(), signal });
				const text = JSON.stringify(result);
				return {
					content: [{ type: "text", text: text.length <= 32_000 ? text : `${text.slice(0, 32_000)}\n[Decision result truncated. Ask fewer questions for the full text.]` }],
					details: result,
					structuredContent: result,
					usage: decisionUsage(result, params.model),
				};
			},
		}));
	};
	register();
	pi.registerCommand("neon-decide", {
		description: "Enable, disable, or show status of the optional Neon decision tool",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "enable" || action === "disable") {
				try { writeDecisionEnabled(action === "enable"); }
				catch {
					ctx.ui.notify("Could not save Neon decision preference. Check permissions on pi's agent directory.", "error");
					return;
				}
				register();
			} else if (action !== "status") {
				ctx.ui.notify("Usage: /neon-decide enable | disable | status", "warning");
				return;
			}
			ctx.ui.notify(`Neon decisions are ${readDecisionEnabled() ? "enabled" : "disabled"}. ${readDecisionEnabled() ? "The neon_decide tool is available." : "Run /neon-decide enable to use the tool."}`, "info");
		},
	});
}
