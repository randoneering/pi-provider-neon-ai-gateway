import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ANTHROPIC_MODELS, canonicalModelId, NEON_MODELS, RESPONSES_MODELS } from "./models.js";

export type CatalogMode = "preferred" | "all";

function preferencePath(): string {
	return join(getAgentDir(), "neon-catalog.json");
}

export function readCatalogMode(): CatalogMode {
	try {
		const value: unknown = JSON.parse(readFileSync(preferencePath(), "utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value) &&
			(value as Record<string, unknown>).mode === "all" ? "all" : "preferred";
	} catch {
		return "preferred";
	}
}

function writeCatalogMode(mode: CatalogMode): void {
	mkdirSync(getAgentDir(), { recursive: true });
	const target = preferencePath();
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify({ mode })}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, target);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename already consumed the temporary file. */ }
	}
}

export function chatModelsForCatalog(mode: CatalogMode): typeof NEON_MODELS {
	if (mode === "all") return NEON_MODELS;
	const preferred = new Set([...RESPONSES_MODELS, ...ANTHROPIC_MODELS].map((model) => canonicalModelId(model.id)));
	return NEON_MODELS.filter((model) => !preferred.has(canonicalModelId(model.id)));
}

export function registerNeonCatalogCommand(pi: ExtensionAPI, activeMode: CatalogMode): void {
	pi.registerCommand("neon-catalog", {
		description: "Choose preferred or all Neon model endpoints",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "preferred" || action === "all") {
				try { writeCatalogMode(action); }
				catch {
					ctx.ui.notify("Could not save Neon catalog preference. Check permissions on pi's agent directory.", "error");
					return;
				}
			} else if (action !== "status") {
				ctx.ui.notify("Usage: /neon-catalog preferred | all | status", "warning");
				return;
			}
			const selected = readCatalogMode();
			const suffix = selected === activeMode ? "" : ` Active mode is ${activeMode}; run /reload to apply.`;
			ctx.ui.notify(`Neon catalog preference: ${selected}.${suffix}`, "info");
		},
	});
}
