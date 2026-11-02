import { afterEach, describe, expect, it, vi } from "vitest";
import { embeddingUsage, requestNeonEmbedding } from "../src/embeddings.js";

const credential = { key: "test-token", env: { NEON_AI_GATEWAY_BASE_URL: "https://example.test" } };
const response = {
	object: "list", model: "qwen3-embedding-0-6b-112025",
	data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
	usage: { prompt_tokens: 100, total_tokens: 100 },
};

afterEach(() => vi.unstubAllGlobals());

describe("requestNeonEmbedding", () => {
	it("sends text to the embeddings endpoint with float encoding", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
		vi.stubGlobal("fetch", fetchMock);
		const result = await requestNeonEmbedding({ input: "hello" }, { credential, processEnv: {} });
		expect(result).toEqual(response);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://example.test/v1/embeddings");
		expect(JSON.parse(init.body)).toEqual({ model: "qwen3-embedding-0-6b", input: "hello", encoding_format: "float" });
		expect(init.redirect).toBe("error");
	});

	it.each([{ input: [] }, { input: Array(151).fill("x") }, { input: [""] }, { input: "hi", model: "unknown" }])(
		"rejects invalid inputs before sending requests: %o", async (args) => {
			const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
			await expect(requestNeonEmbedding(args, { credential, processEnv: {} })).rejects.toThrow();
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("sends batches and calculates the selected model cost", async () => {
		const batch = { ...response, data: [...response.data, { object: "embedding", index: 1, embedding: [0.3, 0.4] }] };
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(batch)));
		vi.stubGlobal("fetch", fetchMock);
		const result = await requestNeonEmbedding({ input: ["a", "b"], model: "bge-large-en" }, { credential, processEnv: {} });
		expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ input: ["a", "b"], model: "bge-large-en" });
		expect(embeddingUsage(result, "bge-large-en").cost.total).toBeCloseTo(0.00001);
	});

	it("reports gateway failures without exposing response content", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("sensitive response", { status: 429 })));
		await expect(requestNeonEmbedding({ input: "hi" }, { credential, processEnv: {} })).rejects.toThrow(/HTTP 429/);
	});

	it("rejects shell-expression tokens", async () => {
		const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
		await expect(requestNeonEmbedding({ input: "hi" }, { credential: { ...credential, key: "$TOKEN" }, processEnv: {} })).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects malformed response vectors", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...response, data: [] }))));
		await expect(requestNeonEmbedding({ input: "hi" }, { credential, processEnv: {} })).rejects.toThrow(/invalid/i);
	});

	it("reports model-specific input cost", () => {
		expect(embeddingUsage(response, "qwen3-embedding-0-6b").cost.total).toBeCloseTo(0.000002);
	});
});
