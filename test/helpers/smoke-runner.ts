import { Type } from "@earendil-works/pi-ai/compat";
import type {
	Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream,
	Context, Model, SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { ANTHROPIC_MODELS, canonicalModelId, NEON_MODELS } from "../../src/models.js";
import { streamNeon, streamNeonAnthropic } from "../../src/stream.js";

export type SmokeProvider = "neon" | "neon-anthropic";

export interface SmokeOptions {
	modelId: string;
	provider?: SmokeProvider;
	thinking: boolean;
	tools: boolean;
}

const SMOKE_TEXT = "smoke test ok";

export function parseSmokeArgs(args: string[]): SmokeOptions {
	const options: SmokeOptions = { modelId: "gpt-5-mini", thinking: false, tools: false };
	let hasModel = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--thinking") options.thinking = true;
		else if (arg === "--tools") options.tools = true;
		else if (arg === "--provider" || arg.startsWith("--provider=")) {
			if (options.provider) throw new Error("Specify --provider only once");
			const value = arg === "--provider" ? args[++i] : arg.slice("--provider=".length);
			if (value !== "neon" && value !== "neon-anthropic") {
				throw new Error("--provider requires neon or neon-anthropic");
			}
			options.provider = value;
		} else if (arg.startsWith("--")) {
			throw new Error(`Unknown smoke option: ${arg}`);
		} else {
			if (hasModel) throw new Error("Specify only one smoke model");
			options.modelId = arg;
			hasModel = true;
		}
	}
	return options;
}

export function selectSmokeModel(options: SmokeOptions): Model<Api> {
	const id = canonicalModelId(options.modelId);
	const chat = NEON_MODELS.find((entry) => entry.id === id);
	if (!chat) throw new Error(`Unknown model: ${options.modelId}`);
	const anthropic = ANTHROPIC_MODELS.find((entry) => entry.id === id);
	const provider = options.provider ?? (anthropic ? "neon-anthropic" : "neon");
	if (provider === "neon") return chat;
	if (!anthropic) throw new Error(`Model ${id} is not available on neon-anthropic`);
	return anthropic;
}

async function consumeSmokeStream(
	stream: AssistantMessageEventStream,
	onEvent?: (event: AssistantMessageEvent) => void,
): Promise<AssistantMessage> {
	let result: AssistantMessage | undefined;
	for await (const event of stream) {
		if (event.type === "error") throw new Error(event.error.errorMessage ?? "Smoke stream failed");
		onEvent?.(event);
		if (event.type === "done") result = event.message;
	}
	if (!result) throw new Error("Smoke stream ended without a completion event");
	if (result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === "length") {
		throw new Error(`Smoke response stopped with ${result.stopReason}: ${result.errorMessage ?? "no complete reply"}`);
	}
	return result;
}

export async function runSmoke(
	options: SmokeOptions,
	streamOptions: SimpleStreamOptions,
	onEvent?: (event: AssistantMessageEvent) => void,
): Promise<AssistantMessage[]> {
	const model = selectSmokeModel(options);
	const startStream = model.api === "anthropic-messages" ? streamNeonAnthropic : streamNeon;
	const requestOptions: SimpleStreamOptions = {
		...streamOptions,
		maxTokens: streamOptions.maxTokens ?? (options.thinking ? 4096 : 512),
		reasoning: options.thinking ? "low" : streamOptions.reasoning,
	};
	const context: Context = {
		messages: [{
			role: "user",
			content: options.tools
				? `Call smoke_echo exactly once with message "${SMOKE_TEXT}". After reading its result, reply with exactly: ${SMOKE_TEXT}`
				: `Reply with exactly: ${SMOKE_TEXT}`,
			timestamp: Date.now(),
		}],
	};
	if (options.tools) {
		context.tools = [{
			name: "smoke_echo",
			description: "Return the supplied smoke test message unchanged. No side effects.",
			parameters: Type.Object({ message: Type.String() }, { additionalProperties: false }),
		}];
	}

	const first = await consumeSmokeStream(startStream(model, context, requestOptions), onEvent);
	const results = [first];
	const calls = first.content.filter((part) => part.type === "toolCall");
	if (options.tools) {
		if (calls.length !== 1 || first.stopReason !== "toolUse") {
			throw new Error("Expected exactly one tool call before the final reply");
		}
		const call = calls[0]!;
		if (call.name !== "smoke_echo" || !call.id || call.arguments.message !== SMOKE_TEXT) {
			throw new Error("Unexpected tool name or arguments; only smoke_echo with the smoke message is allowed");
		}
		// Replay the assistant block intact so provider signatures survive the round trip.
		context.messages.push(first, {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: SMOKE_TEXT }],
			isError: false,
			timestamp: Date.now(),
		});
		results.push(await consumeSmokeStream(startStream(model, context, requestOptions), onEvent));
	} else if (calls.length > 0) {
		throw new Error("Unexpected tool call without --tools");
	}

	const final = results[results.length - 1]!;
	const text = final.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
	if (final.stopReason !== "stop" || text !== SMOKE_TEXT || final.content.some((part) => part.type === "toolCall")) {
		throw new Error(`Expected reply "${SMOKE_TEXT}" with a normal stop; received ${JSON.stringify(text)} (${final.stopReason})`);
	}
	return results;
}
