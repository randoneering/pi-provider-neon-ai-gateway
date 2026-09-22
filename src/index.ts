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
 * `/neon-balance` (see `./account.ts`) is optional and reads a separate
 * Neon management API key (napi_...) to display the org spending cap and
 * this machine's local session spend.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerNeonAccountCommands } from "./account.js";
import { registerNeonAuthCommands } from "./auth.js";
import { NEON_AI_GATEWAY_BASE_URL_ENV, NEON_AI_GATEWAY_TOKEN_ENV } from "./config.js";
import { NEON_MODELS } from "./models.js";
import { streamNeon } from "./stream.js";

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

	registerNeonAuthCommands(pi);
	registerNeonAccountCommands(pi);
}
