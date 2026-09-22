import { describe, expect, it } from "vitest";
import {
	NEON_API_BASE_URL,
	NEON_API_KEY_ENV,
	NEON_AI_GATEWAY_BASE_URL_ENV,
	NEON_AI_GATEWAY_TOKEN_ENV,
	normalizeNeonBaseUrl,
	resolveNeonManagementKey,
} from "../src/config.js";

describe("config constants", () => {
	it("uses stable env var names", () => {
		expect(NEON_AI_GATEWAY_TOKEN_ENV).toBe("NEON_AI_GATEWAY_TOKEN");
		expect(NEON_AI_GATEWAY_BASE_URL_ENV).toBe("NEON_AI_GATEWAY_BASE_URL");
		expect(NEON_API_KEY_ENV).toBe("NEON_API_KEY");
	});

	it("points at the public Neon management API", () => {
		expect(NEON_API_BASE_URL).toBe("https://console.neon.tech/api/v2");
	});
});

describe("resolveNeonManagementKey", () => {
	it("returns undefined when neither source is set", () => {
		expect(resolveNeonManagementKey({})).toBeUndefined();
	});

	it("prefers stored over process env", () => {
		expect(
			resolveNeonManagementKey({
				processEnv: { NEON_API_KEY: "napi_process" },
				storedManagementKey: "napi_stored",
			}),
		).toBe("napi_stored");
	});

	it("falls back to process env when stored is missing", () => {
		expect(
			resolveNeonManagementKey({
				processEnv: { NEON_API_KEY: "napi_process" },
			}),
		).toBe("napi_process");
	});

	it("treats empty stored as missing", () => {
		expect(
			resolveNeonManagementKey({
				processEnv: { NEON_API_KEY: "napi_process" },
				storedManagementKey: "",
			}),
		).toBe("napi_process");
	});

	it("returns undefined for whitespace-only stored value", () => {
		expect(resolveNeonManagementKey({ storedManagementKey: "   " })).toBeUndefined();
	});
});

describe("normalizeNeonBaseUrl", () => {
	it("trims whitespace", () => {
		expect(normalizeNeonBaseUrl("  https://br-x.ai.neon.tech  ")).toBe("https://br-x.ai.neon.tech");
	});

	it("strips trailing slash", () => {
		expect(normalizeNeonBaseUrl("https://br-x.ai.neon.tech/")).toBe("https://br-x.ai.neon.tech");
	});

	it("strips trailing /v1", () => {
		expect(normalizeNeonBaseUrl("https://br-x.ai.neon.tech/v1")).toBe("https://br-x.ai.neon.tech");
	});

	it("strips trailing /v1/", () => {
		expect(normalizeNeonBaseUrl("https://br-x.ai.neon.tech/v1/")).toBe("https://br-x.ai.neon.tech");
	});

	it("preserves subpaths", () => {
		expect(normalizeNeonBaseUrl("https://br-x.ai.neon.tech/api")).toBe("https://br-x.ai.neon.tech/api");
	});

	it("accepts http", () => {
		expect(normalizeNeonBaseUrl("http://localhost:8080")).toBe("http://localhost:8080");
	});

	it("rejects non-http schemes", () => {
		expect(() => normalizeNeonBaseUrl("ftp://br-x.ai.neon.tech")).toThrow(/http or https/);
		expect(() => normalizeNeonBaseUrl("javascript:alert(1)")).toThrow(/http or https/);
	});

	it("rejects embedded credentials", () => {
		expect(() => normalizeNeonBaseUrl("https://user:pass@br-x.ai.neon.tech")).toThrow(/credentials/);
	});

	it("rejects query strings", () => {
		expect(() => normalizeNeonBaseUrl("https://br-x.ai.neon.tech?token=abc")).toThrow(/query or fragment/);
	});

	it("rejects fragments", () => {
		expect(() => normalizeNeonBaseUrl("https://br-x.ai.neon.tech#frag")).toThrow(/query or fragment/);
	});

	it("rejects invalid URLs", () => {
		expect(() => normalizeNeonBaseUrl("not a url")).toThrow();
	});

	it("handles real Neon format", () => {
		expect(normalizeNeonBaseUrl("https://br-example-api.ai.c-2.us-east-2.aws.neon.tech")).toBe(
			"https://br-example-api.ai.c-2.us-east-2.aws.neon.tech",
		);
	});
});

describe("resolveNeonBaseUrl", () => {
	it("prefers credential env over process env", async () => {
		const { resolveNeonBaseUrl } = await import("../src/config.js");
		const result = resolveNeonBaseUrl({
			processEnv: { NEON_AI_GATEWAY_BASE_URL: "https://from-process.ai.neon.tech" },
			credentialEnv: { NEON_AI_GATEWAY_BASE_URL: "https://from-cred.ai.neon.tech" },
		});
		expect(result).toBe("https://from-cred.ai.neon.tech/v1");
	});

	it("falls back to process env", async () => {
		const { resolveNeonBaseUrl } = await import("../src/config.js");
		const result = resolveNeonBaseUrl({
			processEnv: { NEON_AI_GATEWAY_BASE_URL: "https://from-process.ai.neon.tech" },
		});
		expect(result).toBe("https://from-process.ai.neon.tech/v1");
	});

	it("uses process env when credential env is empty", async () => {
		const { resolveNeonBaseUrl } = await import("../src/config.js");
		expect(resolveNeonBaseUrl({
			processEnv: { NEON_AI_GATEWAY_BASE_URL: "https://from-process.ai.neon.tech" },
			credentialEnv: { NEON_AI_GATEWAY_BASE_URL: "" },
		})).toBe("https://from-process.ai.neon.tech/v1");
	});

	it("uses credential env when process env is empty", async () => {
		const { resolveNeonBaseUrl } = await import("../src/config.js");
		expect(resolveNeonBaseUrl({
			processEnv: { NEON_AI_GATEWAY_BASE_URL: "" },
			credentialEnv: { NEON_AI_GATEWAY_BASE_URL: "https://from-cred.ai.neon.tech" },
		})).toBe("https://from-cred.ai.neon.tech/v1");
	});

	it("returns undefined when both sources are empty", async () => {
		const { resolveNeonBaseUrl } = await import("../src/config.js");
		expect(resolveNeonBaseUrl({
			processEnv: { NEON_AI_GATEWAY_BASE_URL: "" },
			credentialEnv: { NEON_AI_GATEWAY_BASE_URL: "" },
		})).toBeUndefined();
	});

	it("returns undefined when no source provides a value", async () => {
		const { resolveNeonBaseUrl } = await import("../src/config.js");
		const result = resolveNeonBaseUrl({ processEnv: {} });
		expect(result).toBeUndefined();
	});

	it("normalizes the resolved URL", async () => {
		const { resolveNeonBaseUrl } = await import("../src/config.js");
		const result = resolveNeonBaseUrl({
			processEnv: { NEON_AI_GATEWAY_BASE_URL: "https://from-process.ai.neon.tech/v1/" },
		});
		expect(result).toBe("https://from-process.ai.neon.tech/v1");
	});
});
