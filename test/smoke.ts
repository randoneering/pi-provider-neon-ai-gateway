/**
 * Smoke test for the Neon AI Gateway extension.
 *
 * Usage:
 *   NEON_AI_GATEWAY_TOKEN=<token> NEON_AI_GATEWAY_BASE_URL=<base> npm run test:smoke
 *   # or with explicit model:
 *   npm run test:smoke gpt-5-mini
 *   # with thinking:
 *   npm run test:smoke gpt-5-mini --thinking
 *
 * Models in the Anthropic Messages catalog (claude-*) route to the
 * neon-anthropic provider; everything else routes to the chat completions
 * provider.
 *
 * Exits non-zero on any error event or empty response so CI can detect
 * regressions even when run with a valid credential.
 */

import { anthropicMessagesApi, registerApiProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import type { Api, Context, Model } from "@earendil-works/pi-ai/compat";
import { ANTHROPIC_MODELS, isKnownNeonModel, NEON_MODELS } from "../src/models.js";
import { streamNeon } from "../src/stream.js";

function readCredential(): { token: string; baseUrl: string } {
	const token = process.env.NEON_AI_GATEWAY_TOKEN;
	const baseUrl = process.env.NEON_AI_GATEWAY_BASE_URL;
	if (!token || !baseUrl) {
		console.error(
			"NEON_AI_GATEWAY_TOKEN and NEON_AI_GATEWAY_BASE_URL must be set in the environment for the smoke test.",
		);
		process.exit(2);
	}
	return { token, baseUrl };
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const useThinking = args.includes("--thinking");
	const modelId = args.find((arg) => !arg.startsWith("--")) ?? "gpt-5-mini";

	if (!isKnownNeonModel(modelId)) {
		console.error(`Unknown model: ${modelId}`);
		console.error("Chat:", NEON_MODELS.map((m) => m.id).join(", "));
		console.error("Anthropic:", ANTHROPIC_MODELS.map((m) => m.id).join(", "));
		process.exit(2);
	}

	const chatCfg = NEON_MODELS.find((m) => m.id === modelId);
	const anthropicCfg = ANTHROPIC_MODELS.find((m) => m.id === modelId);
	if (!chatCfg) {
		console.error(`Model metadata missing for ${modelId}`);
		process.exit(2);
	}

	const { token, baseUrl } = readCredential();
	const normalizedBase = baseUrl.replace(/\/$/, "");

	let model: Model<Api>;
	let apiLabel: string;

	if (anthropicCfg) {
		model = {
			...chatCfg,
			api: "anthropic-messages" as Api,
			provider: "neon-anthropic",
			baseUrl: `${normalizedBase}/anthropic`,
		};
		apiLabel = "anthropic-messages";
	} else {
		registerApiProvider({
			api: "openai-completions" as Api,
			stream: streamNeon,
			streamSimple: streamNeon,
		});
		model = {
			...chatCfg,
			api: "openai-completions" as Api,
			provider: "neon",
			baseUrl: `${normalizedBase}/v1`,
		};
		apiLabel = "openai-completions";
	}

	const context: Context = {
		messages: [
			{
				role: "user",
				content: "Reply with exactly: smoke test ok",
				timestamp: Date.now(),
			},
		],
	};

	console.log(`Model: ${model.id}, api: ${apiLabel}, baseUrl: ${model.baseUrl}, thinking: ${useThinking}`);

	const streamOptions = {
		apiKey: token,
		maxTokens: 64,
		reasoning: useThinking ? ("low" as const) : undefined,
	};
	const stream =
		apiLabel === "anthropic-messages"
			? anthropicMessagesApi().streamSimple(
					model as Model<"anthropic-messages">,
					context,
					streamOptions,
				)
			: streamSimple(model, context, streamOptions);

	let sawText = false;
	for await (const event of stream) {
		if (event.type === "thinking_start") process.stdout.write("[thinking] ");
		else if (event.type === "thinking_delta") process.stdout.write(event.delta);
		else if (event.type === "thinking_end") process.stdout.write(" [/thinking]\n");
		else if (event.type === "text_start") {
			/* begin text block */
		} else if (event.type === "text_delta") {
			process.stdout.write(event.delta);
			sawText = true;
		} else if (event.type === "text_end") {
			process.stdout.write("\n");
		} else if (event.type === "toolcall_start") {
			console.error("\nUnexpected tool call in smoke test");
			process.exit(1);
		} else if (event.type === "error") {
			console.error("\nError:", event.error.errorMessage);
			process.exit(1);
		} else if (event.type === "done") {
			console.log("\n\nDone:", event.reason, JSON.stringify(event.message.usage));
		}
	}

	if (!sawText) {
		console.error("\nNo text output received");
		process.exit(1);
	}
}

main().catch((error: unknown) => {
	console.error("Smoke test crashed:", error);
	process.exit(1);
});
