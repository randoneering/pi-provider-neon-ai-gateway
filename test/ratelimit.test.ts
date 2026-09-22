import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	formatNeonRateLimitState,
	getNeonRateLimitState,
	registerNeonRateLimitHook,
	resetNeonRateLimitState,
} from "../src/ratelimit.js";

function setup() {
	let responseHandler: ((event: unknown) => void) | undefined;
	let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const pi = {
		on(_name: string, handler: (event: unknown) => void) {
			responseHandler = handler;
		},
		registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commandHandler = options.handler;
		},
	};
	registerNeonRateLimitHook(pi as never);
	return { responseHandler: responseHandler!, commandHandler: commandHandler! };
}

const neonEvent = (headers: Record<string, string>, provider = "neon") => ({
	provider,
	headers,
	status: 429,
});

describe("Neon rate-limit capture", () => {
	beforeEach(() => resetNeonRateLimitState());

	it("captures headers from a Neon response", () => {
		const { responseHandler } = setup();
		responseHandler(neonEvent({ "Retry-After": "47", "X-Ratelimit-Remaining-Tokens": "1000" }));
		const state = getNeonRateLimitState();
		expect(state.values["Retry-After"]).toBe("47");
		expect(state.values["X-Ratelimit-Remaining-Tokens"]).toBe("1000");
		expect(state.capturedAt).toBeTypeOf("number");
	});

	it("ignores responses from non-Neon providers", () => {
		const { responseHandler } = setup();
		responseHandler(neonEvent({ "Retry-After": "47" }, "openai"));
		expect(getNeonRateLimitState().capturedAt).toBeUndefined();
	});

	it("handles missing headers gracefully", () => {
		const { responseHandler } = setup();
		expect(() => responseHandler(neonEvent({}))).not.toThrow();
		expect(getNeonRateLimitState().capturedAt).toBeUndefined();
	});

	it("shows the empty-state message without requiring a management key", async () => {
		const { commandHandler } = setup();
		const notify = vi.fn();
		await commandHandler("", { ui: { notify } });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("No rate-limit headers observed yet"), "info");
	});

	it("lists captured headers", async () => {
		const { responseHandler, commandHandler } = setup();
		responseHandler(neonEvent({
			"X-Ratelimit-Limit-Requests": "100",
			"X-Ratelimit-Remaining-Requests": "80",
			"X-Ratelimit-Limit-Tokens": "200000",
		}));
		const notify = vi.fn();
		await commandHandler("", { ui: { notify } });
		const text = notify.mock.calls[0]![0] as string;
		expect(text).toContain("X-Ratelimit-Limit-Requests: 100");
		expect(text).toContain("X-Ratelimit-Remaining-Requests: 80");
		expect(text).toContain("X-Ratelimit-Limit-Tokens: 200000");
		expect(text).toContain("Observed:");
	});

	it("formats reset values and Retry-After", () => {
		const current = {
			values: {
				"Retry-After": "47",
				"X-Ratelimit-Reset-Requests": "90",
				"X-Ratelimit-Reset-Tokens": "12",
			},
			capturedAt: Date.now(),
		};
		const text = formatNeonRateLimitState(current);
		expect(text).toContain("Retry-After: retry in 47s");
		expect(text).toContain("X-Ratelimit-Reset-Requests: in 1m");
		expect(text).toContain("X-Ratelimit-Reset-Tokens: in 12s");
	});

	it("uses the latest value when multiple responses arrive", () => {
		const { responseHandler } = setup();
		responseHandler(neonEvent({ "X-Ratelimit-Remaining-Tokens": "1000" }));
		responseHandler(neonEvent({ "X-Ratelimit-Remaining-Tokens": "250" }));
		expect(getNeonRateLimitState().values["X-Ratelimit-Remaining-Tokens"]).toBe("250");
	});
});
