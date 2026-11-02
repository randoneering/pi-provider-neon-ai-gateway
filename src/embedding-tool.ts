import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readNeonDecisionCredential } from "./decision-tool.js";
import { embeddingParameters, embeddingUsage, requestNeonEmbedding } from "./embeddings.js";

function preferencePath(): string {
	return join(getAgentDir(), "neon-embeddings.json");
}
export function readEmbeddingEnabled(): boolean {
	try {
		const value: unknown = JSON.parse(readFileSync(preferencePath(), "utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value) && (value as Record<string, unknown>).enabled === true;
	} catch { return false; }
}
function writeEmbeddingEnabled(enabled: boolean): void {
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
export function registerNeonEmbeddingTool(pi: ExtensionAPI): void {
	const register = (): void => {
		const enabled = readEmbeddingEnabled();
		pi.registerTool(defineTool({
			name: "neon_embed",
			label: "Neon embeddings",
			description: "Generate vectors for text using Neon AI Gateway. Input is sent to Neon and billed. Large batches produce large tool results. bge-large-en truncates each input after 512 tokens.",
			parameters: embeddingParameters,
			exposure: enabled ? "direct" : "hidden",
			defaultActive: enabled,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			async execute(_toolCallId, params, signal) {
				if (!readEmbeddingEnabled()) throw new Error("Neon embeddings are disabled. Run /neon-embed enable to use this tool.");
				const result = await requestNeonEmbedding(params, { credential: readNeonDecisionCredential(), signal });
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, usage: embeddingUsage(result, params.model) };
			},
		}));
	};
	register();
	pi.registerCommand("neon-embed", {
		description: "Enable, disable, or show status of the optional Neon embedding tool",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "enable" || action === "disable") {
				try { writeEmbeddingEnabled(action === "enable"); }
				catch { ctx.ui.notify("Could not save Neon embedding preference. Check permissions on pi's agent directory.", "error"); return; }
				register();
			} else if (action !== "status") {
				ctx.ui.notify("Usage: /neon-embed enable | disable | status", "warning"); return;
			}
			ctx.ui.notify(`Neon embeddings are ${readEmbeddingEnabled() ? "enabled" : "disabled"}.`, "info");
		},
	});
}
