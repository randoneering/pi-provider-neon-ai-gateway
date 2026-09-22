import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RATE_LIMIT_HEADERS = [
	"Retry-After",
	"X-Ratelimit-Limit-Requests",
	"X-Ratelimit-Remaining-Requests",
	"X-Ratelimit-Reset-Requests",
	"X-Ratelimit-Limit-Tokens",
	"X-Ratelimit-Remaining-Tokens",
	"X-Ratelimit-Reset-Tokens",
] as const;

export type RateLimitHeader = (typeof RATE_LIMIT_HEADERS)[number];

export interface NeonRateLimitState {
	values: Partial<Record<RateLimitHeader, string>>;
	capturedAt?: number;
}

let state: NeonRateLimitState = { values: {} };

export function resetNeonRateLimitState(): void {
	state = { values: {} };
}

export function getNeonRateLimitState(): NeonRateLimitState {
	return { values: { ...state.values }, capturedAt: state.capturedAt };
}

function isNeonResponse(event: unknown): boolean {
	if (!isRecord(event)) return false;
	if (event.provider === "neon" || event.providerId === "neon") return true;
	const model = event.model;
	return isRecord(model) && (model.provider === "neon" || model.providerId === "neon");
}

function captureHeaders(event: unknown): void {
	if (!isRecord(event) || !isNeonResponse(event)) return;
	const headers = event.headers;
	if (!isRecord(headers)) return;
	const values: Partial<Record<RateLimitHeader, string>> = {};
	for (const name of RATE_LIMIT_HEADERS) {
		const value = headers[name] ?? headers[name.toLowerCase()];
		if (typeof value === "string" && value.length > 0) values[name] = value;
	}
	if (Object.keys(values).length > 0) state = { values, capturedAt: Date.now() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatRelativeTime(timestamp: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h`;
}

function formatReset(name: RateLimitHeader, value: string): string {
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds < 0) return value;
	if (name === "Retry-After") return `retry in ${seconds}s`;
	if (name.includes("-Reset-")) return seconds >= 60 ? `in ${Math.floor(seconds / 60)}m` : `in ${seconds}s`;
	return value;
}

export function formatNeonRateLimitState(current: NeonRateLimitState = state): string {
	const entries = RATE_LIMIT_HEADERS.filter((name) => current.values[name] !== undefined);
	if (entries.length === 0) {
		return "No rate-limit headers observed yet. They appear on 429 responses when the upstream provider (Databricks) rate-limits a request.";
	}
	const lines = ["Neon upstream rate limits:"];
	for (const name of entries) lines.push(`  ${name}: ${formatReset(name, current.values[name]!)}`);
	if (current.capturedAt !== undefined) lines.push(`  Observed: ${formatRelativeTime(current.capturedAt)} ago`);
	return lines.join("\n");
}

export function registerNeonRateLimitHook(pi: ExtensionAPI): void {
	pi.on("after_provider_response", (event) => {
		captureHeaders(event);
	});
	pi.registerCommand("neon-limits", {
		description: "Show the latest Neon upstream rate-limit headers",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatNeonRateLimitState(), "info");
		},
	});
}
