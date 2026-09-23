import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { NEON_MODELS } from "./models.js";

export interface NeonModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

function formatRate(rate: number): string {
	return `$${rate.toFixed(2)} / 1M`;
}

function formatCacheRate(rate: number): string {
	return rate > 0 ? `${formatRate(rate)} cache read` : "—";
}

export function formatModelCost(model: Pick<Model<"openai-completions">, "cost">): string {
	const cost = model.cost;
	return `${formatRate(cost.input)} in, ${formatRate(cost.output)} out, ${formatCacheRate(cost.cacheRead)}`;
}

export function findNeonModel(modelId: string): Model<"openai-completions"> | undefined {
	const normalized = modelId.toLowerCase().replace(/^neon\//, "");
	return NEON_MODELS.find((model) => model.id.toLowerCase() === normalized);
}

export function formatNeonModelCatalog(): string {
	const lines = ["Neon models:", "", "  Use /model to select a model.", ""];
	for (const model of NEON_MODELS) {
		lines.push(`  ${model.id.padEnd(32, " ")} ${formatModelCost(model)}`);
	}
	return lines.join("\n");
}

export function registerNeonModelCostCommand(pi: ExtensionAPI): void {
	pi.registerCommand("neon-models", {
		description: "List Neon models with input and output pricing",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatNeonModelCatalog(), "info");
		},
	});
}
