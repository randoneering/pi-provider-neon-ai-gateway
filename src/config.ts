/**
 * Neon AI Gateway configuration constants and helpers.
 *
 * `NEON_AI_GATEWAY_TOKEN` holds the gateway token and
 * `NEON_AI_GATEWAY_BASE_URL` holds the branch endpoint.
 * `NEON_API_KEY` holds a separate Neon management API key used only for
 * /neon-balance lookups against the public console API.
 */

export const NEON_AI_GATEWAY_TOKEN_ENV = "NEON_AI_GATEWAY_TOKEN";
export const NEON_AI_GATEWAY_BASE_URL_ENV = "NEON_AI_GATEWAY_BASE_URL";
export const NEON_API_KEY_ENV = "NEON_API_KEY";

/**
 * Base URL for the public Neon management API. Used by /neon-balance to
 * resolve the org spending limit and (on first run) the user's org id.
 */
export const NEON_API_BASE_URL = "https://console.neon.tech/api/v2";

/**
 * Normalize a user-supplied Neon branch base URL.
 *
 * - Trims whitespace
 * - Rejects non-http(s) schemes, embedded credentials, and query/fragment parts
 * - Strips trailing slashes and any trailing `/v1` segment so callers can
 *   append `/v1` themselves without producing `//v1`
 *
 * Throws on invalid input so bad config fails at login, not on the first request.
 */
export function normalizeNeonBaseUrl(value: string): string {
	const url = new URL(value.trim());
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Neon AI Gateway base URL must use http or https");
	}
	if (url.username || url.password) {
		throw new Error("Neon AI Gateway base URL must not contain credentials");
	}
	if (url.search || url.hash) {
		throw new Error("Neon AI Gateway base URL must not contain a query or fragment");
	}
	url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "") || "/";
	return url.toString().replace(/\/+$/u, "");
}

export interface ResolveOptions {
	processEnv?: Record<string, string | undefined>;
	credentialEnv?: Record<string, string | undefined> | null;
}

/**
 * Resolve the effective Neon base URL, ready for a `/v1` suffix.
 *
 * Checks credentialEnv (stored credential) first, then processEnv (shell).
 * Returns undefined when neither is set.
 */
export function resolveNeonBaseUrl(options: ResolveOptions = {}): string | undefined {
	const fromCredential = options.credentialEnv?.[NEON_AI_GATEWAY_BASE_URL_ENV];
	const fromProcess = options.processEnv?.[NEON_AI_GATEWAY_BASE_URL_ENV];
	const raw = fromCredential || fromProcess;
	if (!raw) return undefined;
	const normalized = normalizeNeonBaseUrl(raw);
	return `${normalized}/v1`;
}

export interface ResolveManagementKeyOptions {
	processEnv?: Record<string, string | undefined>;
	storedManagementKey?: string;
}

/**
 * Resolve the Neon management API key.
 *
 * Precedence: stored credential (from auth.json) over process environment.
 * Whitespace-only and empty values are treated as missing so the caller
 * can fall through to the next source without extra checks.
 */
export function resolveNeonManagementKey(options: ResolveManagementKeyOptions = {}): string | undefined {
	const fromStored = options.storedManagementKey?.trim();
	if (fromStored) return fromStored;
	const fromProcess = options.processEnv?.[NEON_API_KEY_ENV]?.trim();
	return fromProcess || undefined;
}
