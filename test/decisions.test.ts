import { afterEach, describe, expect, it, vi } from "vitest";
import { decisionUsage, requestNeonDecision, type DecisionResponse } from "../src/decisions.js";

const params = {
	state: "Please refund the duplicate charge.",
	questions: {
		refund: { type: "noul", instructions: "Is a refund requested?" },
		department: { type: "choice", instructions: "Which team?", criteria: { billing: "Payments", support: "Other" } },
		severity: { type: "score", instructions: "How severe?", criteria: ["Cosmetic", "Blocking"] },
	},
};

const reply = {
	model: "jev-1.14.0",
	answers: {
		refund: { type: "noul", noul: 0.98 },
		department: { type: "choice", choice: "billing", confidence: 0.9, probabilities: { billing: 0.9, support: 0.1 } },
		severity: { type: "score", score: 0.8, confidence: 0.8, probabilities: { "0": 0.2, "1": 0.8 }, legend: { "0": "Cosmetic", "1": "Blocking" } },
	},
	usage: { input_tokens: 1_000_000, output_tokens: 61 },
} satisfies DecisionResponse;
const env = { NEON_AI_GATEWAY_TOKEN: "nt_live_example", NEON_AI_GATEWAY_BASE_URL: "https://branch.example" };

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function respond(value: unknown = reply, status = 200): ReturnType<typeof vi.fn<typeof fetch>> {
	const fake = vi.fn<typeof fetch>(async () => Response.json(value, { status }));
	vi.stubGlobal("fetch", fake);
	return fake;
}

describe("requestNeonDecision", () => {
	it("posts the documented non-streaming payload with stored credentials and no redirects", async () => {
		const fake = respond();
		const result = await requestNeonDecision(params, {
			processEnv: env,
			credential: { key: "nt_live_stored", env: { NEON_AI_GATEWAY_BASE_URL: "https://stored.example/v1" } },
		});
		expect(result).toEqual(reply);
		expect(fake).toHaveBeenCalledTimes(1);
		const [url, init] = fake.mock.calls[0]!;
		expect(url).toBe("https://stored.example/typesafe/v1/systemone");
		expect(init?.method).toBe("POST");
		expect(init?.redirect).toBe("error");
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer nt_live_stored");
		expect(JSON.parse(String(init?.body))).toEqual({ ...params, model: "typesafeai-jev-1-14-0" });
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it("treats blank stored tokens as missing and prefers stored token environment over process", async () => {
		const fake = respond();
		await requestNeonDecision(params, { processEnv: env, credential: { key: "  ", env: { NEON_AI_GATEWAY_TOKEN: "nt_live_credential_env" } } });
		expect(new Headers(fake.mock.calls[0]![1]?.headers).get("Authorization")).toBe("Bearer nt_live_credential_env");
		await requestNeonDecision(params, { processEnv: env, credential: { key: "", env: { NEON_AI_GATEWAY_TOKEN: " " } } });
		expect(new Headers(fake.mock.calls[1]![1]?.headers).get("Authorization")).toBe("Bearer nt_live_example");
	});

	it("accepts JSON state and canonicalizes the OpenJev model id", async () => {
		const fake = respond({ ...reply, model: "databricks-openjev-qwen35-4b" });
		await requestNeonDecision({ ...params, state: { message: "Refund", tags: [1, true, null] }, model: "DATABRICKS-OPENJEV-QWEN35-4B" }, { processEnv: env });
		expect(JSON.parse(String(fake.mock.calls[0]![1]?.body))).toMatchObject({ model: "openjev-qwen35-4b", state: { message: "Refund", tags: [1, true, null] } });
	});

	it("supports yes/no criteria and literal token overrides", async () => {
		const fake = respond();
		await requestNeonDecision({ ...params, questions: { ...params.questions, refund: { ...params.questions.refund, criteria: { true: "Refund", false: "No refund" } } } }, { processEnv: env, apiKey: "nt_live_override" });
		expect(new Headers(fake.mock.calls[0]![1]?.headers).get("Authorization")).toBe("Bearer nt_live_override");
	});

	it.each([
		{ ...params, model: "jev-latest" },
		{ ...params, state: [] },
		{ ...params, state: { invalid: Number.NaN } },
		{ ...params, questions: {} },
		{ ...params, questions: { bad: { type: "box", instructions: "Boxes?" } } },
		{ ...params, questions: { bad: { type: "noul", instructions: " " } } },
		{ ...params, questions: { bad: { type: "choice", instructions: "Choose", criteria: { only: "One" } } } },
		{ ...params, questions: { bad: { type: "score", instructions: "Rate", criteria: ["One"] } } },
		{ ...params, questions: { bad: { type: "noul", instructions: "Yes?", criteria: { unknown: "bad" } } } },
		{ ...params, stream: true },
	])("rejects invalid decision arguments before network access", async (invalid) => {
		const fake = respond();
		await expect(requestNeonDecision(invalid, { processEnv: env })).rejects.toThrow(/decision|question|state|model|criteria|instructions|stream/i);
		expect(fake).not.toHaveBeenCalled();
	});

	it.each(["!echo secret", "$TOKEN", "  !echo secret", " ${TOKEN}"])("rejects shell-expression credentials", async (token) => {
		const fake = respond();
		await expect(requestNeonDecision(params, { processEnv: { ...env, NEON_AI_GATEWAY_TOKEN: token } })).rejects.toThrow(/literal token/);
		expect(fake).not.toHaveBeenCalled();
	});

	it("requires token and base URL without reading ambient credentials", async () => {
		const fake = respond();
		await expect(requestNeonDecision(params, { processEnv: {} })).rejects.toThrow(/neon-login|NEON_AI_GATEWAY/);
		await expect(requestNeonDecision(params, { processEnv: { NEON_AI_GATEWAY_TOKEN: "nt_example" } })).rejects.toThrow(/base URL|NEON_AI_GATEWAY_BASE_URL/);
		expect(fake).not.toHaveBeenCalled();
	});

	it.each([400, 401, 403, 429, 500, 503])("reports HTTP %s without echoing response bodies or retrying", async (status) => {
		const fake = respond({ error: { message: "nt_live_secret and private state" } }, status);
		let message = "";
		try { await requestNeonDecision(params, { processEnv: env }); } catch (error) { message = (error as Error).message; }
		expect(message).toContain(String(status));
		expect(message).not.toMatch(/nt_live_secret|private state/);
		expect(fake).toHaveBeenCalledTimes(1);
	});

	it.each([
		{},
		{ ...reply, model: "" },
		{ ...reply, answers: {} },
		{ ...reply, answers: { ...reply.answers, refund: { type: "noul", noul: 1.5 } } },
		{ ...reply, answers: { ...reply.answers, refund: { type: "choice", choice: "billing" } } },
		{ ...reply, answers: { ...reply.answers, department: { ...reply.answers.department, choice: "missing" } } },
		{ ...reply, answers: { ...reply.answers, department: { ...reply.answers.department, probabilities: { billing: -1, support: 2 } } } },
		{ ...reply, answers: { ...reply.answers, severity: { ...reply.answers.severity, score: 5 } } },
		{ ...reply, usage: { input_tokens: -1, output_tokens: 0 } },
		{ ...reply, usage: { input_tokens: 1.5, output_tokens: 0 } },
	])("rejects malformed decision replies", async (invalid) => {
		respond(invalid);
		await expect(requestNeonDecision(params, { processEnv: env })).rejects.toThrow(/invalid|missing|malformed/i);
	});

	it("does not expose malformed JSON or network error details", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("nt_live_private")));
		await expect(requestNeonDecision(params, { processEnv: env })).rejects.toThrow(/invalid JSON/i);
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("nt_live_private"); }));
		await expect(requestNeonDecision(params, { processEnv: env })).rejects.toThrow(/^Neon decision request failed\./);
	});

	it("does not send requests that are already cancelled", async () => {
		const fake = respond();
		await expect(requestNeonDecision(params, { processEnv: env, signal: AbortSignal.abort() })).rejects.toThrow(/cancel/i);
		expect(fake).not.toHaveBeenCalled();
	});

	it("times out requests after 30 seconds without exposing network error details", async () => {
		const timeout = new AbortController();
		const timer = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
		vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
			timeout.abort();
			init?.signal?.throwIfAborted();
			return Response.json(reply);
		}));
		await expect(requestNeonDecision(params, { processEnv: env })).rejects.toThrow(/timed out after 30 seconds/);
		expect(timer).toHaveBeenCalledWith(30_000);
	});

	it("propagates cancellation to an in-flight fetch", async () => {
		const controller = new AbortController();
		vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
			controller.abort();
			init?.signal?.throwIfAborted();
			return Response.json(reply);
		}));
		await expect(requestNeonDecision(params, { processEnv: env, signal: controller.signal })).rejects.toThrow(/cancel/i);
	});
});

describe("decisionUsage", () => {
	it("bills only input tokens while preserving output and total token counts", () => {
		expect(decisionUsage(reply, "typesafeai-jev-1-14-0")).toEqual({
			input: 1_000_000, output: 61, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_061,
			cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.042 },
		});
		expect(decisionUsage({ ...reply, usage: { input_tokens: 500_000, output_tokens: 2 } }, "openjev-qwen35-4b").cost.total).toBe(0.021);
	});
});
