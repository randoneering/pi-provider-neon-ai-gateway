/**
 * Static catalog of models served by Neon AI Gateway.
 *
 * Source: https://neon.com/models.json. Update this file when upstream adds
 * or changes models. Costs are USD per million tokens.
 */

import type { Model } from "@earendil-works/pi-ai";

type Api = "openai-completions";

interface NeonModelInput {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	context: number;
	output: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function m(entry: NeonModelInput): Model<Api> {
	return {
		id: entry.id,
		name: entry.name,
		api: "openai-completions",
		provider: "neon",
		baseUrl: "https://placeholder.invalid/v1",
		reasoning: entry.reasoning,
		input: entry.input,
		cost: entry.cost,
		contextWindow: entry.context,
		maxTokens: entry.output,
	};
}

export const NEON_MODELS: Model<"openai-completions">[] = [
	m({
		id: "gemini-3-1-flash-lite",
		name: "Gemini 3.1 Flash Lite Preview",
		reasoning: true,
		input: ["text", "image"],
		context: 1_048_576,
		output: 65_536,
		cost: { input: 0.25, output: 1.5, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gemini-3-1-pro",
		name: "Gemini 3.1 Pro Preview Custom Tools",
		reasoning: true,
		input: ["text", "image"],
		context: 1_048_576,
		output: 65_536,
		cost: { input: 2, output: 12, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gemini-3-5-flash",
		name: "Gemini 3.5 Flash",
		reasoning: true,
		input: ["text", "image"],
		context: 1_048_576,
		output: 65_536,
		cost: { input: 1.5, output: 9, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gemini-3-5-flash-lite",
		name: "Gemini 3.5 Flash Lite",
		reasoning: true,
		input: ["text", "image"],
		context: 1_048_576,
		output: 65_536,
		cost: { input: 0.3, output: 2.5, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gemini-3-6-flash",
		name: "Gemini 3.6 Flash",
		reasoning: true,
		input: ["text", "image"],
		context: 1_048_576,
		output: 65_536,
		cost: { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gemini-3-flash",
		name: "Gemini 3 Flash Preview",
		reasoning: true,
		input: ["text", "image"],
		context: 1_048_576,
		output: 65_536,
		cost: { input: 0.5, output: 3, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gemma-3-12b",
		name: "Gemma 3 12B",
		reasoning: false,
		input: ["text", "image"],
		context: 131_072,
		output: 8192,
		cost: { input: 0.15, output: 0.5, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "glm-5-2",
		name: "GLM-5.2",
		reasoning: true,
		input: ["text"],
		context: 1_000_000,
		output: 65_536,
		cost: { input: 1.4, output: 4.4, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "glm-5-3-flash",
		name: "GLM-5.3 Flash",
		reasoning: true,
		input: ["text", "image"],
		context: 1_048_576,
		output: 131_072,
		cost: { input: 0.15, output: 0.5, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gpt-5",
		name: "GPT-5",
		reasoning: true,
		input: ["text", "image"],
		context: 400_000,
		output: 128_000,
		cost: { input: 1.25, output: 10, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gpt-5-1",
		name: "GPT-5.1",
		reasoning: true,
		input: ["text", "image"],
		context: 400_000,
		output: 128_000,
		cost: { input: 1.25, output: 10, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gpt-5-2",
		name: "GPT-5.2",
		reasoning: true,
		input: ["text", "image"],
		context: 400_000,
		output: 128_000,
		cost: { input: 1.75, output: 14, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gpt-5-3-codex",
		name: "GPT-5.3 Codex",
		reasoning: true,
		input: ["text", "image"],
		context: 400_000,
		output: 128_000,
		cost: { input: 1.75, output: 14, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gpt-5-4",
		name: "GPT-5.4",
		reasoning: true,
		input: ["text", "image"],
		context: 1_050_000,
		output: 128_000,
		cost: { input: 2.5, output: 15, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gpt-5-4-mini",
		name: "GPT-5.4 mini",
		reasoning: true,
		input: ["text", "image"],
		context: 400_000,
		output: 128_000,
		cost: { input: 0.75, output: 4.5, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gpt-5-4-nano",
		name: "GPT-5.4 nano",
		reasoning: true,
		input: ["text", "image"],
		context: 400_000,
		output: 128_000,
		cost: { input: 0.2, output: 1.25, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gpt-5-5",
		name: "GPT-5.5",
		reasoning: true,
		input: ["text", "image"],
		context: 1_050_000,
		output: 128_000,
		cost: { input: 5, output: 30, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gpt-5-5-pro",
		name: "GPT-5.5 Pro",
		reasoning: true,
		input: ["text", "image"],
		context: 1_050_000,
		output: 128_000,
		cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gpt-5-6-luna",
		name: "GPT-5.6 Luna",
		reasoning: true,
		input: ["text", "image"],
		context: 1_050_000,
		output: 128_000,
		cost: { input: 0.2, output: 1.2, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gpt-5-6-sol",
		name: "GPT-5.6 Sol",
		reasoning: true,
		input: ["text", "image"],
		context: 1_050_000,
		output: 128_000,
		cost: { input: 5, output: 30, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gpt-5-6-terra",
		name: "GPT-5.6 Terra",
		reasoning: true,
		input: ["text", "image"],
		context: 1_050_000,
		output: 128_000,
		cost: { input: 2, output: 12, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		reasoning: true,
		input: ["text", "image"],
		context: 400_000,
		output: 128_000,
		cost: { input: 0.25, output: 2, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gpt-5-nano",
		name: "GPT-5 Nano",
		reasoning: true,
		input: ["text", "image"],
		context: 400_000,
		output: 128_000,
		cost: { input: 0.05, output: 0.4, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gpt-6-astra",
		name: "GPT-6 Astra",
		reasoning: true,
		input: ["text", "image"],
		context: 1_050_000,
		output: 128_000,
		cost: { input: 10, output: 50, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gpt-oss-120b",
		name: "GPT OSS 120B",
		reasoning: true,
		input: ["text"],
		context: 131_072,
		output: 25_000,
		cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "gpt-oss-20b",
		name: "GPT OSS 20B",
		reasoning: true,
		input: ["text"],
		context: 131_072,
		output: 25_000,
		cost: { input: 0.07, output: 0.3, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "grok-4-6",
		name: "Grok 4.6",
		reasoning: true,
		input: ["text", "image"],
		context: 500_000,
		output: 524_288,
		cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "inkling",
		name: "Inkling",
		reasoning: true,
		input: ["text", "image"],
		context: 1_048_576,
		output: 65_536,
		cost: { input: 1, output: 4.05, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "kimi-k3",
		name: "Kimi K3",
		reasoning: true,
		input: ["text", "image"],
		context: 1_048_576,
		output: 65_536,
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "llama-4-maverick",
		name: "Llama 4 Maverick 17B Instruct",
		reasoning: false,
		input: ["text", "image"],
		context: 1_000_000,
		output: 8192,
		cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "meta-llama-3-1-8b-instruct",
		name: "Llama 3.1 8B Instruct",
		reasoning: false,
		input: ["text"],
		context: 131_072,
		output: 8192,
		cost: { input: 0.15, output: 0.45, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "meta-llama-3-3-70b-instruct",
		name: "Llama-3.3-70B-Instruct",
		reasoning: false,
		input: ["text"],
		context: 128_000,
		output: 8192,
		cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "qwen3-next-80b-a3b-instruct",
		name: "Qwen3-Next 80B-A3B Instruct",
		reasoning: false,
		input: ["text"],
		context: 131_072,
		output: 10_000,
		cost: { input: 0.15, output: 1.2, cacheRead: 0, cacheWrite: 0 },
	}),
	m({
		id: "qwen35-122b-a10b",
		name: "Qwen3.5 122B-A10B",
		reasoning: true,
		input: ["text"],
		context: 262_144,
		output: 25_000,
		cost: { input: 0.22, output: 2.2, cacheRead: 0, cacheWrite: 0 },
	}),
];

const MODEL_IDS = new Set(NEON_MODELS.map((model) => model.id));

function canonicalModelId(id: string): string {
	const lower = id.toLowerCase();
	return lower.startsWith("databricks-") ? lower.slice("databricks-".length) : lower;
}

export function isKnownNeonModel(id: string): boolean {
	return MODEL_IDS.has(canonicalModelId(id));
}
