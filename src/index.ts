/**
 * Pi extension entry point: register Neon AI Gateway as a model provider.
 *
 * Two ways to authenticate:
 *
 * 1. Env vars: set `NEON_AI_GATEWAY_TOKEN` and `NEON_AI_GATEWAY_BASE_URL`.
 *    pi reads them when it resolves the provider config.
 * 2. Run `/neon-login` (see `./auth.ts`). It writes an api_key credential
 *    plus a base URL override to `auth.json`.
 *
 * Then pick a model with `/model`.
 *
 * `/neon-balance` and `/neon-spending-limit` (see `./account.ts`) and the
 * cap-threshold `before_agent_start` hook (see `./alerts.ts`) read a
 * separate Neon management API key (napi_...) to display the org spending
 * cap, this machine's local session spend, and cap-threshold warnings.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerNeonCapBlockCommand, registerNeonCapBlockGuard } from "./cap-block.js";
import { registerNeonAccountCommands, registerNeonSpendingLimitCommand } from "./account.js";
import { registerNeonAlertHooks } from "./alerts.js";
import { registerNeonAuthCommands } from "./auth.js";
import { NEON_AI_GATEWAY_BASE_URL_ENV, NEON_AI_GATEWAY_TOKEN_ENV } from "./config.js";
import { ANTHROPIC_MODELS, NEON_MODELS, RESPONSES_MODELS } from "./models.js";
import { registerNeonDecisionTool } from "./decision-tool.js";
import { registerNeonModelCostCommand } from "./model-cost.js";
import { registerNeonOrgCommand } from "./orgs.js";
import { registerNeonRateLimitHook } from "./ratelimit.js";
import { streamNeon, streamNeonAnthropic, streamNeonResponses } from "./stream.js";

export default function (pi: ExtensionAPI): void {
	pi.registerProvider("neon", {
		name: "Neon AI Gateway",
		baseUrl: `\${${NEON_AI_GATEWAY_BASE_URL_ENV}}/v1`,
		apiKey: `$${NEON_AI_GATEWAY_TOKEN_ENV}`,
		authHeader: true,
		api: "openai-completions",
		models: NEON_MODELS,
		streamSimple: streamNeon,
	});

	pi.registerProvider("neon-anthropic", {
		name: "Neon AI Gateway (Anthropic)",
		baseUrl: `\${${NEON_AI_GATEWAY_BASE_URL_ENV}}/anthropic`,
		apiKey: `$${NEON_AI_GATEWAY_TOKEN_ENV}`,
		authHeader: true,
		api: "anthropic-messages",
		models: ANTHROPIC_MODELS,
		streamSimple: streamNeonAnthropic,
	});

	pi.registerProvider("neon-responses", {
		name: "Neon AI Gateway (OpenAI Responses)",
		baseUrl: `\${${NEON_AI_GATEWAY_BASE_URL_ENV}}/openai/v1`,
		apiKey: `$${NEON_AI_GATEWAY_TOKEN_ENV}`,
		authHeader: true,
		api: "openai-responses",
		models: RESPONSES_MODELS,
		streamSimple: streamNeonResponses,
	});

	registerNeonAuthCommands(pi);
	registerNeonDecisionTool(pi);
	registerNeonCapBlockCommand(pi);
	registerNeonCapBlockGuard(pi);
	registerNeonAccountCommands(pi);
	registerNeonAlertHooks(pi);
	registerNeonSpendingLimitCommand(pi);
	registerNeonRateLimitHook(pi);
	registerNeonModelCostCommand(pi);
	registerNeonOrgCommand(pi);
}
