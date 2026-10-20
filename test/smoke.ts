/**
 * Live gateway checks. Requires NEON_AI_GATEWAY_TOKEN and NEON_AI_GATEWAY_BASE_URL.
 *
 * npm run test:smoke -- gpt-5-mini
 * npm run test:smoke -- claude-sonnet-4-6 --provider neon
 * npm run test:smoke -- claude-sonnet-4-6 --provider neon-anthropic --tools
 * npm run test:smoke -- gpt-6-luna --tools --thinking
 *
 * Without --provider, Claude uses Anthropic Messages and other models use chat.
 * Tool mode runs one local echo tool and verifies the follow-up reply.
 */

import { parseSmokeArgs, runSmoke, selectSmokeModel } from "./helpers/smoke-runner.js";

async function main(): Promise<void> {
	const options = parseSmokeArgs(process.argv.slice(2));
	const model = selectSmokeModel(options);
	const token = process.env.NEON_AI_GATEWAY_TOKEN;
	const baseUrl = process.env.NEON_AI_GATEWAY_BASE_URL;
	if (!token || !baseUrl) {
		console.error("Set NEON_AI_GATEWAY_TOKEN and NEON_AI_GATEWAY_BASE_URL for the smoke test.");
		process.exitCode = 2;
		return;
	}
	console.log(`Model: ${model.id}, provider: ${model.provider}, thinking requested: ${options.thinking}, tools: ${options.tools}`);
	await runSmoke(options, {
		apiKey: token,
		signal: AbortSignal.timeout(90_000),
	}, (event) => {
		if (event.type === "thinking_start") process.stdout.write("[thinking] ");
		else if (event.type === "thinking_delta") process.stdout.write(event.delta);
		else if (event.type === "thinking_end") process.stdout.write(" [/thinking]\n");
		else if (event.type === "text_delta") process.stdout.write(event.delta);
		else if (event.type === "text_end") process.stdout.write("\n");
		else if (event.type === "toolcall_end") console.log(`Tool call: ${event.toolCall.name}`);
		else if (event.type === "done") console.log("Done:", event.reason, JSON.stringify(event.message.usage));
	});
	console.log("Smoke check passed");
}

main().catch((error: unknown) => {
	console.error("Smoke check failed:", error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
