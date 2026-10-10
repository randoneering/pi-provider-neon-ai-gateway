import { describe, expect, it } from "vitest";
import { enrichRateLimitMessage, extractArrayContent, isArrayContentModel, transformNeonPayload } from "../src/stream.js";
import { canonicalModelId, MODEL_CAPABILITIES, NEON_MODELS } from "../src/models.js";

function withBase(payload: Record<string, unknown>): Record<string, unknown> {
	return { model: "test", messages: [], ...payload };
}

describe("transformNeonPayload", () => {
	it("returns non-record values unchanged", () => {
		expect(transformNeonPayload("hello", "gpt-5")).toBe("hello");
		expect(transformNeonPayload(null, "gpt-5")).toBe(null);
		expect(transformNeonPayload(undefined, "gpt-5")).toBe(undefined);
	});

	it("strips $schema from tool definitions", () => {
		const result = transformNeonPayload(
			withBase({
				tools: [
					{
						type: "function",
						function: {
							name: "foo",
							parameters: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
						},
					},
				],
			}),
			"gpt-5",
		) as Record<string, unknown>;
		const tools = result.tools as Array<Record<string, unknown>>;
		const toolEntry = tools[0];
		if (!toolEntry) throw new Error("expected one tool entry");
		const params = (toolEntry.function as Record<string, unknown>).parameters as Record<string, unknown>;
		expect(params.$schema).toBeUndefined();
		expect(params.type).toBe("object");
	});

	it("strips $schema from response_format", () => {
		const result = transformNeonPayload(
			withBase({
				response_format: {
					type: "json_schema",
					json_schema: { $schema: "http://x", name: "x", schema: { type: "object" } },
				},
			}),
			"gpt-5",
		) as Record<string, unknown>;
		const responseFormat = result.response_format as Record<string, unknown>;
		const jsonSchema = responseFormat.json_schema as Record<string, unknown>;
		expect(jsonSchema.$schema).toBeUndefined();
		expect(jsonSchema.name).toBe("x");
	});

	it("removes unsupported OpenAI fields", () => {
		const result = transformNeonPayload(
			withBase({ store: true, prompt_cache_key: "x", prompt_cache_retention: "long" }),
			"gpt-5",
		) as Record<string, unknown>;
		expect(result.store).toBeUndefined();
		expect(result.prompt_cache_key).toBeUndefined();
		expect(result.prompt_cache_retention).toBeUndefined();
	});

	it("strips databricks- prefix when matching model id patterns", () => {
		expect(transformNeonPayload(withBase({}), "databricks-gpt-oss-120b")).toBeDefined();
		expect(transformNeonPayload(withBase({}), "DATABRICKS-GPT-OSS-120B")).toBeDefined();
	});

	describe("Claude family", () => {
		it("removes sampling fields for Claude 4.7+", () => {
			const result = transformNeonPayload(
				withBase({
					frequency_penalty: 0.5,
					presence_penalty: 0.5,
					seed: 42,
					reasoning_effort: "high",
					temperature: 0.7,
					top_p: 0.9,
				}),
				"claude-sonnet-4-7",
			) as Record<string, unknown>;
			expect(result.frequency_penalty).toBeUndefined();
			expect(result.presence_penalty).toBeUndefined();
			expect(result.seed).toBeUndefined();
			expect(result.reasoning_effort).toBeUndefined();
			expect(result.temperature).toBeUndefined();
			expect(result.top_p).toBeUndefined();
		});

		it("keeps sampling fields for Claude 4.0-4.6", () => {
			const result = transformNeonPayload(
				withBase({ temperature: 0.7, top_p: 0.9 }),
				"claude-sonnet-4-6",
			) as Record<string, unknown>;
			expect(result.temperature).toBe(0.7);
			expect(result.top_p).toBeUndefined();
		});

		it("removes sampling fields for Claude 3.x (regex doesn't match the legacy id shape)", () => {
			const result = transformNeonPayload(
				withBase({ temperature: 0.7, top_p: 0.9 }),
				"claude-3-5-sonnet",
			) as Record<string, unknown>;
			expect(result.temperature).toBeUndefined();
			expect(result.top_p).toBeUndefined();
		});
	});

	describe("Luna family", () => {
		it("forces reasoning_effort none for gpt-5-6-luna when tools are present", () => {
			const result = transformNeonPayload(
				withBase({
					reasoning_effort: "high",
					tools: [{ type: "function", function: { name: "ls", parameters: {} } }],
				}),
				"gpt-5-6-luna",
			) as Record<string, unknown>;
			expect(result.reasoning_effort).toBe("none");
			expect(result.tools).toBeDefined();
		});

		it("forces reasoning_effort none for gpt-5-6-luna with tools even when omitted", () => {
			const result = transformNeonPayload(
				withBase({
					tools: [{ type: "function", function: { name: "ls", parameters: {} } }],
				}),
				"gpt-5-6-luna",
			) as Record<string, unknown>;
			expect(result.reasoning_effort).toBe("none");
		});

		it("keeps reasoning_effort for gpt-5-6-luna without tools", () => {
			const result = transformNeonPayload(
				withBase({ reasoning_effort: "high" }),
				"gpt-5-6-luna",
			) as Record<string, unknown>;
			expect(result.reasoning_effort).toBe("high");
		});
	});

	describe("upstream metadata layer", () => {
		it("strips temperature and top_p when upstream marks temperature unsupported", () => {
			for (const id of ["gpt-5", "gpt-5-6-luna", "gpt-6-astra"]) {
				const result = transformNeonPayload(
					withBase({ temperature: 0.7, top_p: 0.9 }),
					id,
				) as Record<string, unknown>;
				expect(result.temperature, id).toBeUndefined();
				expect(result.top_p, id).toBeUndefined();
			}
		});

		it("keeps temperature when upstream allows it", () => {
			const result = transformNeonPayload(
				withBase({ temperature: 0.7 }),
				"gemini-3-1-flash-lite",
			) as Record<string, unknown>;
			expect(result.temperature).toBe(0.7);
		});

		it("covers every catalog id with capability metadata", () => {
			for (const model of NEON_MODELS) {
				expect(MODEL_CAPABILITIES[canonicalModelId(model.id)], model.id).toBeDefined();
			}
		});
	});

	describe("Gemini family", () => {
		it("removes all sampling params for gemini-3-6-flash", () => {
			const result = transformNeonPayload(
				withBase({
					frequency_penalty: 0.5,
					presence_penalty: 0.5,
					temperature: 0.7,
					top_p: 0.9,
				}),
				"gemini-3-6-flash",
			) as Record<string, unknown>;
			expect(result.frequency_penalty).toBeUndefined();
			expect(result.presence_penalty).toBeUndefined();
			expect(result.temperature).toBeUndefined();
			expect(result.top_p).toBeUndefined();
		});

		it("removes only penalty params for gemini-3-5-flash-lite", () => {
			const result = transformNeonPayload(
				withBase({
					frequency_penalty: 0.5,
					presence_penalty: 0.5,
					temperature: 0.7,
					top_p: 0.9,
				}),
				"gemini-3-5-flash-lite",
			) as Record<string, unknown>;
			expect(result.frequency_penalty).toBeUndefined();
			expect(result.presence_penalty).toBeUndefined();
			expect(result.temperature).toBe(0.7);
			expect(result.top_p).toBe(0.9);
		});
	});

	describe("GPT-OSS family", () => {
		it("removes sampling, seed, and stop", () => {
			const result = transformNeonPayload(
				withBase({
					frequency_penalty: 0.5,
					presence_penalty: 0.5,
					seed: 42,
					stop: ["foo"],
				}),
				"gpt-oss-120b",
			) as Record<string, unknown>;
			expect(result.frequency_penalty).toBeUndefined();
			expect(result.presence_penalty).toBeUndefined();
			expect(result.seed).toBeUndefined();
			expect(result.stop).toBeUndefined();
		});
	});

	describe("Llama family", () => {
		it("removes penalties and seed", () => {
			const result = transformNeonPayload(
				withBase({ frequency_penalty: 0.5, presence_penalty: 0.5, seed: 42 }),
				"llama-4-maverick",
			) as Record<string, unknown>;
			expect(result.frequency_penalty).toBeUndefined();
			expect(result.presence_penalty).toBeUndefined();
			expect(result.seed).toBeUndefined();
		});
	});

	describe("Qwen and Gemma family", () => {
		it("removes penalties and seed for qwen", () => {
			const result = transformNeonPayload(
				withBase({ frequency_penalty: 0.5, presence_penalty: 0.5, seed: 42 }),
				"qwen3-next-80b-a3b-instruct",
			) as Record<string, unknown>;
			expect(result.frequency_penalty).toBeUndefined();
			expect(result.presence_penalty).toBeUndefined();
			expect(result.seed).toBeUndefined();
		});

		it("removes penalties and seed for gemma", () => {
			const result = transformNeonPayload(
				withBase({ frequency_penalty: 0.5, presence_penalty: 0.5, seed: 42 }),
				"gemma-3-12b",
			) as Record<string, unknown>;
			expect(result.frequency_penalty).toBeUndefined();
			expect(result.presence_penalty).toBeUndefined();
			expect(result.seed).toBeUndefined();
		});
	});

	describe("GLM, Inkling, Kimi family", () => {
		it("removes penalties for glm", () => {
			const result = transformNeonPayload(
				withBase({ frequency_penalty: 0.5, presence_penalty: 0.5 }),
				"glm-5-2",
			) as Record<string, unknown>;
			expect(result.frequency_penalty).toBeUndefined();
			expect(result.presence_penalty).toBeUndefined();
		});

		it("removes penalties for inkling", () => {
			const result = transformNeonPayload(
				withBase({ frequency_penalty: 0.5, presence_penalty: 0.5 }),
				"inkling",
			) as Record<string, unknown>;
			expect(result.frequency_penalty).toBeUndefined();
			expect(result.presence_penalty).toBeUndefined();
		});

		it("removes penalties for kimi", () => {
			const result = transformNeonPayload(
				withBase({ frequency_penalty: 0.5, presence_penalty: 0.5 }),
				"kimi-k3",
			) as Record<string, unknown>;
			expect(result.frequency_penalty).toBeUndefined();
			expect(result.presence_penalty).toBeUndefined();
		});
	});

	it("does not mutate the input payload", () => {
		const original = withBase({ temperature: 0.7, frequency_penalty: 0.5 });
		const snapshot = JSON.stringify(original);
		transformNeonPayload(original, "claude-sonnet-4-7");
		expect(JSON.stringify(original)).toBe(snapshot);
	});
});

describe("enrichRateLimitMessage", () => {
	const body = (code = "REQUEST_LIMIT_EXCEEDED") => ({
		error: {
			message: "ai gateway daily token limit exceeded",
			type: code,
			code,
		},
	});

	it("appends a positive Retry-After delay for account quota errors", () => {
		const result = enrichRateLimitMessage(body(), "47") as { error: { message: string } };
		expect(result.error.message).toBe("ai gateway daily token limit exceeded; retry after 47s");
	});

	it("leaves account quota errors unchanged without Retry-After", () => {
		const original = body();
		const result = enrichRateLimitMessage(original, null);
		expect(result).toBe(original);
	});

	it("leaves account quota errors unchanged for malformed Retry-After", () => {
		const original = body();
		expect(enrichRateLimitMessage(original, "not-a-number")).toBe(original);
		expect(enrichRateLimitMessage(original, "0")).toBe(original);
	});

	it("leaves unrelated 429 errors unchanged", () => {
		const original = body("UPSTREAM_RATE_LIMIT");
		expect(enrichRateLimitMessage(original, "47")).toBe(original);
	});

	it("leaves non-error and non-quota bodies unchanged", () => {
		const original = { message: "server error" };
		expect(enrichRateLimitMessage(original, "47")).toBe(original);
		expect(enrichRateLimitMessage({ error: "server error" }, "47")).toEqual({ error: "server error" });
	});
});

describe("extractArrayContent", () => {
	it("returns undefined for non-array content", () => {
		expect(extractArrayContent("plain string")).toBeUndefined();
		expect(extractArrayContent({ type: "text", text: "nope" })).toBeUndefined();
		expect(extractArrayContent(null)).toBeUndefined();
		expect(extractArrayContent(undefined)).toBeUndefined();
	});

	it("flattens a text-only Anthropic-style block", () => {
		expect(
			extractArrayContent([{ type: "text", text: "hello" }]),
		).toEqual({ text: "hello", reasoning: "" });
	});

	it("flattens a reasoning-only block when max_tokens cuts off text", () => {
		expect(
			extractArrayContent([{ type: "reasoning", text: "let me think" }]),
		).toEqual({ text: "", reasoning: "let me think" });
	});

	it("flattens a mixed text and reasoning block in upstream order", () => {
		const blocks = [
			{ type: "reasoning", text: "step one" },
			{ type: "text", text: "answer " },
			{ type: "reasoning", text: "step two" },
			{ type: "text", text: "continues" },
		];
		expect(extractArrayContent(blocks)).toEqual({ text: "answer continues", reasoning: "step one\nstep two" });
	});

	it("skips blocks without a string text field", () => {
		expect(
			extractArrayContent([
				{ type: "text" },
				{ type: "text", text: 42 },
				{ type: "text", text: "kept" },
			]),
		).toEqual({ text: "kept", reasoning: "" });
	});

	it("skips unknown block types without dropping the rest", () => {
		expect(
			extractArrayContent([
				{ type: "tool_use", id: "x" },
				{ type: "text", text: "answer" },
			]),
		).toEqual({ text: "answer", reasoning: "" });
	});

	it("joins gpt-oss harmony summary and content arrays as reasoning", () => {
		const blocks = [
			{ type: "reasoning", text: "top", summary: [{ text: "sum1" }, { text: "sum2" }] },
			{ type: "reasoning", text: "more", content: [{ text: "deep" }] },
			{ type: "text", text: "final" },
		];
		expect(extractArrayContent(blocks)).toEqual({
			text: "final",
			reasoning: "top\nsum1\nsum2\nmore\ndeep",
		});
	});
});

describe("isArrayContentModel", () => {
	it("matches the gpt-oss family by prefix", () => {
		expect(isArrayContentModel("gpt-oss-120b")).toBe(true);
		expect(isArrayContentModel("gpt-oss-20b")).toBe(true);
	});

	it("matches claude-opus-5-5 explicitly", () => {
		expect(isArrayContentModel("claude-opus-5-5")).toBe(true);
	});

	it("leaves other Claude models on the string path", () => {
		expect(isArrayContentModel("claude-opus-5")).toBe(false);
		expect(isArrayContentModel("claude-opus-4-8")).toBe(false);
		expect(isArrayContentModel("claude-sonnet-4-6")).toBe(false);
		expect(isArrayContentModel("claude-fable-5-1")).toBe(false);
	});

	it("returns false for non-array-content models", () => {
		expect(isArrayContentModel("gpt-5")).toBe(false);
		expect(isArrayContentModel("gemini-3-6-flash")).toBe(false);
		expect(isArrayContentModel("llama-4-maverick")).toBe(false);
	});
});
