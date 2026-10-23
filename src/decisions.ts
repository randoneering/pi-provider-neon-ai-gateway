import { Type, type Static, type Usage } from "@earendil-works/pi-ai";
import { validateGatewayToken } from "./auth.js";
import { NEON_AI_GATEWAY_TOKEN_ENV, resolveNeonDecisionBaseUrl } from "./config.js";
import { canonicalModelId, DECISION_MODELS } from "./models.js";

const instructions = Type.String({ minLength: 1 });
const labels = Type.Record(Type.String(), Type.String({ minLength: 1 }));
const question = Type.Union([
	Type.Object({
		type: Type.Literal("noul"), instructions,
		criteria: Type.Optional(Type.Object({ true: Type.Optional(instructions), false: Type.Optional(instructions) }, { additionalProperties: false })),
	}, { additionalProperties: false }),
	Type.Object({ type: Type.Literal("choice"), instructions, criteria: Type.Record(Type.String(), instructions, { minProperties: 2 }) }, { additionalProperties: false }),
	Type.Object({ type: Type.Literal("score"), instructions, criteria: Type.Array(instructions, { minItems: 2 }) }, { additionalProperties: false }),
]);

export const decisionParameters = Type.Object({
	state: Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())], { description: "Text or JSON object to classify, route, or score. Sent to Neon AI Gateway." }),
	questions: Type.Record(Type.String(), question, { minProperties: 1, description: "Named yes/no (noul), choice, or score questions." }),
	model: Type.Optional(Type.String({ description: "typesafeai-jev-1-14-0 (default) or openjev-qwen35-4b" })),
}, { additionalProperties: false });

export type DecisionParameters = Static<typeof decisionParameters>;

const probability = Type.Number({ minimum: 0, maximum: 1 });
const probabilities = Type.Record(Type.String(), probability);
export const decisionOutput = Type.Object({
	model: Type.String({ minLength: 1 }),
	answers: Type.Record(Type.String(), Type.Union([
		Type.Object({ type: Type.Literal("noul"), noul: probability }),
		Type.Object({ type: Type.Literal("choice"), choice: Type.String(), confidence: probability, probabilities }),
		Type.Object({ type: Type.Literal("score"), score: Type.Number({ minimum: 0 }), confidence: probability, probabilities, legend: labels }),
	])),
	usage: Type.Object({ input_tokens: Type.Integer({ minimum: 0 }), output_tokens: Type.Integer({ minimum: 0 }) }),
});
export type DecisionResponse = Static<typeof decisionOutput>;

export interface DecisionCredential {
	key?: string;
	env?: Record<string, string | undefined>;
}

export interface DecisionRequestOptions {
	apiKey?: string;
	credential?: DecisionCredential;
	processEnv?: Record<string, string | undefined>;
	signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isJson(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJson);
	return isRecord(value) && Object.values(value).every(isJson);
}

export function decisionModelId(id = "typesafeai-jev-1-14-0"): string {
	const canonical = canonicalModelId(id);
	if (!DECISION_MODELS.some((entry) => entry.id === canonical)) {
		throw new Error("Unsupported Neon decision model. Use typesafeai-jev-1-14-0 or openjev-qwen35-4b.");
	}
	return canonical;
}

function validateParameters(value: unknown): asserts value is DecisionParameters {
	if (!isRecord(value) || Object.keys(value).some((key) => !["state", "questions", "model"].includes(key))) {
		throw new Error("Neon decision arguments must contain only state, questions, and optional model.");
	}
	if (!(typeof value.state === "string" || isRecord(value.state)) || !isJson(value.state)) {
		throw new Error("Neon decision state must be text or a JSON object with finite numbers.");
	}
	if (value.model !== undefined && typeof value.model !== "string") throw new Error("Neon decision model must be a string.");
	if (!isRecord(value.questions) || Object.keys(value.questions).length === 0) {
		throw new Error("Neon decision questions must contain at least one named question.");
	}
	for (const entry of Object.values(value.questions)) {
		if (!isRecord(entry) || !nonempty(entry.instructions) || Object.keys(entry).some((key) => !["type", "instructions", "criteria"].includes(key))) {
			throw new Error("Each decision question requires nonempty instructions and only type, instructions, and criteria fields.");
		}
		const criteria = entry.criteria;
		if (entry.type === "noul") {
			if (criteria === undefined) continue;
			if (!isRecord(criteria) || Object.entries(criteria).some(([key, label]) => !["true", "false"].includes(key) || !nonempty(label))) {
				throw new Error("A noul question accepts only true and false criteria descriptions.");
			}
		} else if (entry.type === "choice") {
			if (!isRecord(criteria) || Object.keys(criteria).length < 2 || !Object.values(criteria).every(nonempty)) {
				throw new Error("A choice question requires at least two named criteria with descriptions.");
			}
		} else if (entry.type === "score") {
			if (!Array.isArray(criteria) || criteria.length < 2 || !criteria.every(nonempty)) {
				throw new Error("A score question requires at least two criteria descriptions.");
			}
		} else throw new Error("Unsupported decision question type. Use noul, choice, or score.");
	}
}

function isProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function tokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateResponse(value: unknown, params: DecisionParameters): asserts value is DecisionResponse {
	const invalid = (): never => { throw new Error("Neon decision endpoint returned an invalid or missing answer or usage field."); };
	if (!isRecord(value) || !nonempty(value.model) || !isRecord(value.answers) || !isRecord(value.usage)) invalid();
	const data = value as Record<string, unknown>;
	const answers = data.answers as Record<string, unknown>;
	const usage = data.usage as Record<string, unknown>;
	if (!tokenCount(usage.input_tokens) || !tokenCount(usage.output_tokens)) invalid();
	if (Object.keys(answers).length !== Object.keys(params.questions).length) invalid();
	for (const [name, requested] of Object.entries(params.questions)) {
		const answer = answers[name];
		if (!isRecord(answer) || answer.type !== requested.type) invalid();
		const entry = answer as Record<string, unknown>;
		if (requested.type === "noul") {
			if (!isProbability(entry.noul)) invalid();
			continue;
		}
		if (!isProbability(entry.confidence) || !isRecord(entry.probabilities)) invalid();
		const values = entry.probabilities as Record<string, unknown>;
		const keys = requested.type === "choice" ? Object.keys(requested.criteria) : requested.criteria.map((_, index) => String(index));
		if (Object.keys(values).length !== keys.length || !keys.every((key) => isProbability(values[key]))) invalid();
		if (requested.type === "choice") {
			if (typeof entry.choice !== "string" || !Object.hasOwn(requested.criteria, entry.choice)) invalid();
		} else {
			if (typeof entry.score !== "number" || !Number.isFinite(entry.score) || entry.score < 0 || entry.score > requested.criteria.length - 1) invalid();
			if (!isRecord(entry.legend) || keys.some((key, index) => (entry.legend as Record<string, unknown>)[key] !== requested.criteria[index])) invalid();
		}
	}
}

function httpError(status: number): Error {
	const hint = status === 401 ? "Run /neon-login to check the gateway token."
		: status === 403 ? "Check ai_gateway:invoke scope and branch access."
			: status === 429 ? "The gateway is rate limited or out of credits. Check /neon-balance and retry later."
				: status >= 500 ? "The gateway is unavailable. Retry later."
					: "Check the decision model, state, and question criteria.";
	return new Error(`Neon decision request failed (HTTP ${status}). ${hint}`);
}

export async function requestNeonDecision(value: unknown, options: DecisionRequestOptions = {}): Promise<DecisionResponse> {
	validateParameters(value);
	const model = decisionModelId(value.model);
	const env = options.processEnv ?? process.env;
	const token = options.apiKey?.trim() || options.credential?.key?.trim() ||
		options.credential?.env?.[NEON_AI_GATEWAY_TOKEN_ENV]?.trim() || env[NEON_AI_GATEWAY_TOKEN_ENV]?.trim();
	if (!token) throw new Error("Neon decisions need a gateway token. Run /neon-login or set NEON_AI_GATEWAY_TOKEN.");
	validateGatewayToken(token);
	const baseUrl = resolveNeonDecisionBaseUrl({ processEnv: env, credentialEnv: options.credential?.env });
	if (!baseUrl) throw new Error("Neon decisions need a base URL. Run /neon-login or set NEON_AI_GATEWAY_BASE_URL.");
	const body = JSON.stringify({ ...value, model });
	if (Buffer.byteLength(body) > 32 * 1024 * 1024) throw new Error("Neon decision request exceeds the 32 MiB body limit. Reduce state or questions.");
	const timeout = AbortSignal.timeout(30_000);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	let response: Response;
	let payload: unknown;
	try {
		signal.throwIfAborted();
		response = await fetch(`${baseUrl}/systemone`, {
			method: "POST", redirect: "error", signal,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body,
		});
		if (response.ok) {
			try { payload = await response.json(); }
			catch { if (signal.aborted) signal.throwIfAborted(); throw new SyntaxError("Invalid decision JSON"); }
		}
	} catch (error) {
		if (options.signal?.aborted) throw new Error("Neon decision request cancelled.");
		if (timeout.aborted) throw new Error("Neon decision request timed out after 30 seconds.");
		if (error instanceof SyntaxError) throw new Error("Neon decision endpoint returned invalid JSON.");
		throw new Error("Neon decision request failed. Check the gateway URL and network connection.");
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw httpError(response.status);
	}
	validateResponse(payload, value);
	return payload;
}

export function decisionUsage(response: DecisionResponse, modelId?: string): Usage {
	const model = DECISION_MODELS.find((entry) => entry.id === decisionModelId(modelId))!;
	const input = response.usage.input_tokens;
	const output = response.usage.output_tokens;
	const cost = input * model.inputCost / 1_000_000;
	return {
		input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}
