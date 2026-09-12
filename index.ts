/**
 * Command Code provider extension for pi.
 *
 * Routes pi requests through https://api.commandcode.ai/alpha/generate
 * (the CLI's own endpoint), which every plan permits. The /provider/v1/*
 * OpenAI/Anthropic-compatible endpoints have been flaky/plan-gated for
 * generation, so we stick to the native /alpha/generate envelope the CLI
 * itself uses (GET /provider/v1/models is readable for the roster).
 *
 * Authenticates with COMMANDCODE_API_KEY (a "user_..." token from
 * https://commandcode.ai/settings/billing or `cmd auth status`).
 *
 * Wire shape, sender:
 *   POST /alpha/generate
 *   body: { config, memory: "", taste: null, skills: null,
 *           permissionMode: "standard",
 *           params: { model, system, messages, tools, max_tokens, stream } }
 *
 * Wire shape, receiver (newline-delimited JSON, NOT SSE):
 *   {"type":"start"}
 *   {"type":"start-step",...}
 *   {"type":"reasoning-start","id":"reasoning-0"}
 *   {"type":"reasoning-delta","id":"reasoning-0","text":"..."}
 *   {"type":"reasoning-end","id":"reasoning-0"}
 *   {"type":"text-start","id":"txt-0"}
 *   {"type":"text-delta","id":"txt-0","text":"..."}
 *   {"type":"text-end","id":"txt-0"}
 *   {"type":"tool-input-start","id":"call_...","toolName":"..."}
 *   {"type":"tool-input-delta","id":"call_...","delta":"<json chunk>"}
 *   {"type":"tool-input-end","id":"call_..."}
 *   {"type":"finish-step","finishReason":"stop"|"length"|"tool-calls","usage":{...}}
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Message,
	type Model,
	type SimpleStreamOptions,
	calculateCost,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://api.commandcode.ai";
const ENDPOINT = "/alpha/generate";
const PROVIDER_MODELS_ENDPOINT = "/provider/v1/models";
const STARTUP_MODEL_FETCH_TIMEOUT_MS = 3_000;
const BILLING_TIMEOUT_MS = 10_000;
const RAW_PREVIEW = 280;
// Mirrors the `x-command-code-version` the CLI sends (its package version).
// Keep in step with the installed `command-code` package; stale values risk
// being rejected or flagged by the gateway.
const COMMAND_CODE_VERSION = "0.52.1";

// ---- Models -------------------------------------------------------------
// IDs are the gateway's canonical ids from GET /provider/v1/models
// (publicly readable as of CLI 0.52.x).
//
// The bundled fallback mirrors the public provider catalog so Pi can list
// models even when startup is offline. Refresh it from the endpoint or with
// `cmd --list-models` when Command Code changes the registry.
//
// The Go plan ($1/mo, $10 credits) has usage multipliers on some OSS models
// (e.g. mimo-v2.5 is ~10x, mimo-v2.5-pro ~5x, deepseek-v4-pro ~4x,
// Qwen3.7-Max ~2x) — heavy ones burn credits fast.
//
// maxTokens here is the per-call output cap pi sends as max_tokens; the gateway
// clamps anything larger to the model's true limit.

type CommandCodeThinkingLevel = Exclude<SimpleStreamOptions["reasoning"], undefined> | "max";

type ModelDef = {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<CommandCodeThinkingLevel, string | null>>;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type ProviderModelRow = {
	id?: unknown;
	name?: unknown;
	context_length?: unknown;
};

const IMAGE_MODEL_IDS = new Set([
	"deepseek/deepseek-v4-flash-vision-exp",
	"moonshotai/Kimi-K3",
	"moonshotai/Kimi-K2.7-Code",
	"moonshotai/Kimi-K2.7-Code-Highspeed",
	"moonshotai/Kimi-K2.6",
	"moonshotai/Kimi-K2.5",
	"MiniMaxAI/MiniMax-M3",
	"Qwen/Qwen3.8-27B",
	"stepfun/Step-3.7-Flash",
	"thinkingmachines/inkling",
]);

const REASONING_MODEL_IDS = new Set([
	"claude-sonnet-5",
	"claude-fable-5-1",
	"claude-fable-5",
	"claude-opus-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.3-codex",
	"deepseek/deepseek-v4-pro",
	"deepseek/deepseek-v4-flash",
	"deepseek/deepseek-v4-flash-vision-exp",
	"deepseek/deepseek-v4.1-flash",
	"moonshotai/Kimi-K3",
	"moonshotai/Kimi-K2.7-Code",
	"moonshotai/Kimi-K2.7-Code-Highspeed",
	"z-ai/glm-5.3-flash",
	"zai-org/GLM-5.3",
	"zai-org/GLM-5.2",
	"zai-org/GLM-5.1",
	"zai-org/GLM-5",
	"MiniMaxAI/MiniMax-M3",
	"MiniMaxAI/MiniMax-M2.7",
	"MiniMaxAI/MiniMax-M2.5",
	"xiaomi/mimo-v2.5-pro",
	"xiaomi/mimo-v2.5",
	"Qwen/Qwen3.8-Max-0902",
	"Qwen/Qwen3.8-Max",
	"Qwen/Qwen3.8-27B",
	"Qwen/Qwen3.8-Flash",
	"Qwen/Qwen3.7-Max",
	"Qwen/Qwen3.7-Plus",
	"Qwen/Qwen3.7-Flash",
	"Qwen/Qwen3.6-Plus",
	"stepfun/Step-3.7-Flash",
	"stepfun/Step-3.5-Flash",
	"tencent/hy3-paid",
	"tencent/hy4-preview",
	"nvidia/nemotron-3-ultra-550b-a55b",
	"thinkingmachines/inkling",
	"thinkingmachines/inkling-small",
	"xai/grok-4.5",
	"xai/grok-4.6",
]);

const DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} satisfies NonNullable<ModelDef["thinkingLevelMap"]>;

function modelInput(id: string): ModelDef["input"] {
	return IMAGE_MODEL_IDS.has(id) ? ["text", "image"] : ["text"];
}

function modelThinkingLevelMap(id: string): ModelDef["thinkingLevelMap"] | undefined {
	return id === "deepseek/deepseek-v4-pro" || id === "deepseek/deepseek-v4-flash"
		? DEEPSEEK_V4_THINKING_LEVEL_MAP
		: undefined;
}

export function parseProviderModels(data: unknown): ModelDef[] {
	if (!data || typeof data !== "object") return [];
	const rows = Array.isArray((data as { data?: unknown }).data) ? (data as { data: unknown[] }).data : [];
	const models: ModelDef[] = [];
	for (const row of rows as ProviderModelRow[]) {
		if (!row || typeof row !== "object") continue;
		const id = row.id;
		const name = row.name;
		const contextWindow = row.context_length;
		if (typeof id !== "string" || typeof name !== "string" || typeof contextWindow !== "number") {
			continue;
		}
		models.push({
			id,
			name: `${name} (Command Code)`,
			reasoning: REASONING_MODEL_IDS.has(id),
			thinkingLevelMap: modelThinkingLevelMap(id),
			input: modelInput(id),
			contextWindow,
			maxTokens: Math.min(contextWindow, 131_072),
			cost: ZERO_COST,
		});
	}
	return models;
}

async function fetchProviderModels(signal?: AbortSignal): Promise<ModelDef[]> {
	const response = await fetch(`${BASE_URL}${PROVIDER_MODELS_ENDPOINT}`, {
		headers: { Accept: "application/json" },
		signal,
	});
	if (!response.ok) throw new Error(`Command Code models ${response.status}: ${response.statusText}`);
	const models = parseProviderModels(await response.json());
	if (models.length === 0) throw new Error("Command Code models endpoint returned no usable models");
	return models;
}

export async function fetchProviderModelsWithTimeout(
	timeoutMs = STARTUP_MODEL_FETCH_TIMEOUT_MS,
): Promise<ModelDef[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchProviderModels(controller.signal);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error("Command Code model catalog fetch timed out");
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

const FALLBACK_PROVIDER_MODELS = {
	data: [
		{ id: "claude-sonnet-5", name: "Claude Sonnet 5", context_length: 1000000 },
		{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context_length: 1000000 },
		{ id: "claude-fable-5-1", name: "Claude Fable 5.1", context_length: 1000000 },
		{ id: "claude-fable-5", name: "Claude Fable 5", context_length: 1000000 },
		{ id: "claude-opus-5", name: "Claude Opus 5", context_length: 1000000 },
		{ id: "claude-opus-4-8", name: "Claude Opus 4.8", context_length: 1000000 },
		{ id: "claude-opus-4-7", name: "Claude Opus 4.7", context_length: 1000000 },
		{ id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", context_length: 200000 },
		{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", context_length: 1050000 },
		{ id: "gpt-5.6-terra", name: "GPT-5.6 Terra", context_length: 1050000 },
		{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", context_length: 1050000 },
		{ id: "gpt-5.5", name: "GPT-5.5", context_length: 400000 },
		{ id: "gpt-5.4", name: "GPT-5.4", context_length: 400000 },
		{ id: "gpt-5.3-codex", name: "GPT-5.3 Codex", context_length: 400000 },
		{ id: "gpt-5.4-mini", name: "GPT-5.4 Mini", context_length: 400000 },
		{ id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro (latest)", context_length: 1000000 },
		{ id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (latest)", context_length: 1000000 },
		{ id: "deepseek/deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision (exp)", context_length: 1000000 },
		{ id: "deepseek/deepseek-v4-flash-fast", name: "DeepSeek V4 Flash Fast", context_length: 1000000 },
		{ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context_length: 1000000 },
		{ id: "moonshotai/Kimi-K3", name: "Kimi K3", context_length: 1000000 },
		{ id: "moonshotai/Kimi-K2.7-Code", name: "Kimi K2.7 Code", context_length: 256000 },
		{ id: "moonshotai/Kimi-K2.7-Code-Highspeed", name: "Kimi K2.7 Code HighSpeed", context_length: 262000 },
		{ id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6", context_length: 256000 },
		{ id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5", context_length: 256000 },
		{ id: "z-ai/glm-5.3-flash", name: "GLM-5.3 Flash", context_length: 1048576 },
		{ id: "zai-org/GLM-5.3", name: "GLM-5.3", context_length: 1000000 },
		{ id: "zai-org/GLM-5.2", name: "GLM-5.2", context_length: 1000000 },
		{ id: "zai-org/GLM-5.2-Fast", name: "GLM-5.2 Fast", context_length: 1000000 },
		{ id: "zai-org/GLM-5.1", name: "GLM-5.1", context_length: 200000 },
		{ id: "zai-org/GLM-5", name: "GLM-5", context_length: 200000 },
		{ id: "MiniMaxAI/MiniMax-M3", name: "MiniMax M3", context_length: 1000000 },
		{ id: "MiniMaxAI/MiniMax-M2.7", name: "MiniMax M2.7", context_length: 200000 },
		{ id: "MiniMaxAI/MiniMax-M2.5", name: "MiniMax M2.5", context_length: 200000 },
		{ id: "xiaomi/mimo-v2.5-pro", name: "MiMo V2.5 Pro", context_length: 1000000 },
		{ id: "xiaomi/mimo-v2.5", name: "MiMo V2.5", context_length: 1000000 },
		{ id: "Qwen/Qwen3.8-Max-0902", name: "Qwen 3.8 Max 0902", context_length: 1000000 },
		{ id: "Qwen/Qwen3.8-Max", name: "Qwen 3.8 Max", context_length: 1000000 },
		{ id: "Qwen/Qwen3.8-27B", name: "Qwen 3.8 27B", context_length: 262144 },
		{ id: "Qwen/Qwen3.8-Flash", name: "Qwen 3.8 Flash", context_length: 1000000 },
		{ id: "Qwen/Qwen3.7-Max", name: "Qwen 3.7 Max", context_length: 1000000 },
		{ id: "Qwen/Qwen3.7-Plus", name: "Qwen 3.7 Plus", context_length: 1000000 },
		{ id: "Qwen/Qwen3.7-Flash", name: "Qwen 3.7 Flash", context_length: 1000000 },
		{ id: "Qwen/Qwen3.6-Max-Preview", name: "Qwen 3.6 Max Preview", context_length: 200000 },
		{ id: "Qwen/Qwen3.6-Plus", name: "Qwen 3.6 Plus", context_length: 200000 },
		{ id: "meituan/LongCat-2.0:free", name: "LongCat 2.0", context_length: 1048576 },
		{ id: "stepfun/Step-3.7-Flash", name: "Step 3.7 Flash", context_length: 256000 },
		{ id: "stepfun/Step-3.5-Flash", name: "Step 3.5 Flash", context_length: 1000000 },
		{ id: "tencent/hy3-paid", name: "Tencent Hy3", context_length: 262144 },
		{ id: "tencent/hy4-preview", name: "Tencent Hy4 Preview", context_length: 1048576 },
		{ id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", context_length: 1000000 },
		{ id: "google/gemini-3.7-flash", name: "Gemini 3.7 Flash", context_length: 1048576 },
		{ id: "google/gemini-3.6-flash", name: "Gemini 3.6 Flash", context_length: 1000000 },
		{ id: "google/gemini-3.5-flash", name: "Gemini 3.5 Flash", context_length: 1000000 },
		{ id: "google/gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", context_length: 1000000 },
		{ id: "google/gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", context_length: 1000000 },
		{ id: "sakana/fugu-ultra", name: "Fugu Ultra", context_length: 1000000 },
		{ id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra", context_length: 1000000 },
		{ id: "thinkingmachines/inkling", name: "Inkling", context_length: 256000 },
		{ id: "thinkingmachines/inkling-small", name: "Inkling Small", context_length: 1000000 },
		{ id: "poolside/laguna-s-2.1-free", name: "Laguna S 2.1", context_length: 256000 },
		{ id: "inclusionai/ling-3.0-flash-sante:free", name: "Ling 3.0 Flash Sante", context_length: 262144 },
		{ id: "meta/muse-spark-1.1", name: "Muse Spark 1.1", context_length: 1048576 },
		{ id: "meta/muse-spark-1.2", name: "Muse Spark 1.2", context_length: 1048576 },
		{ id: "meta/muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor", context_length: 1048576 },
		{ id: "meta/muse-spark-1.3", name: "Muse Spark 1.3", context_length: 1048576 },
		{ id: "meta/muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", context_length: 1048576 },
		{ id: "xai/grok-4.5", name: "Grok 4.5", context_length: 500000 },
		{ id: "xai/grok-4.6", name: "Grok 4.6", context_length: 500000 },
	],
};

const MODELS: ModelDef[] = parseProviderModels(FALLBACK_PROVIDER_MODELS);

// ---- Message conversion -------------------------------------------------
//
// The gateway speaks Vercel AI SDK's ModelMessage schema (not Anthropic's
// content-block shape). Verified by reading the CLI bundle's own converter
// and by hitting the gateway with both shapes — the Anthropic shape errors
// with "messages do not match the ModelMessage[] schema."
//
// Shape:
//   user:      { role: "user",      content: [{ type: "text", text }, { type: "image", image, mediaType }] }
//   assistant: { role: "assistant", content: [{ type: "text", text }, { type: "tool-call", toolCallId, toolName, input }] }
//   tool:      { role: "tool",      content: [{ type: "tool-result", toolCallId, toolName, output: { type: "text", value } }] }

type UserContent =
	| { type: "text"; text: string }
	| { type: "image"; image: string; mediaType?: string };

type AssistantContent =
	| { type: "text"; text: string }
	| { type: "tool-call"; toolCallId: string; toolName: string; input: Record<string, unknown> };

type ToolContent = {
	type: "tool-result";
	toolCallId: string;
	toolName: string;
	output: { type: "text"; value: string } | { type: "error-text"; value: string };
};

type CmdMessage =
	| { role: "user"; content: UserContent[] }
	| { role: "assistant"; content: AssistantContent[] }
	| { role: "tool"; content: ToolContent[] };

function stringifyUnknown(value: unknown): string {
	if (value instanceof Error) return value.message || value.stack || "Error";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return "Unknown error (non-serializable)";
	}
}

function parseJsonLine(line: string, lineNumber: number): unknown {
	try {
		return JSON.parse(line);
	} catch (error) {
		const preview = line.length > 240 ? `${line.slice(0, 240)}...` : line;
		throw new Error(
			`Malformed Command Code NDJSON at line ${lineNumber}: ${preview} (${stringifyUnknown(error)})`,
		);
	}
}

function convertMessages(messages: Message[]): CmdMessage[] {
	const out: CmdMessage[] = [];
	// Track tool call names by id so tool-result messages can fill `toolName`
	const toolNameById = new Map<string, string>();

	for (const msg of messages) {
		if (msg.role === "user") {
			const content: UserContent[] = [];
			if (typeof msg.content === "string") {
				content.push({ type: "text", text: msg.content });
			} else {
				for (const block of msg.content) {
					if (block.type === "text") content.push({ type: "text", text: block.text });
					else if (block.type === "image")
						content.push({
							type: "image",
							image: `data:${block.mimeType};base64,${block.data}`,
							mediaType: block.mimeType,
						});
				}
			}
			if (content.length > 0) out.push({ role: "user", content });
		} else if (msg.role === "assistant") {
			const content: AssistantContent[] = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text) content.push({ type: "text", text: block.text });
				} else if (block.type === "toolCall") {
					toolNameById.set(block.id, block.name);
					content.push({
						type: "tool-call",
						toolCallId: block.id,
						toolName: block.name,
						input: block.arguments ?? {},
					});
				}
				// Skip "thinking" — the upstream provider reconstructs its own reasoning
			}
			if (content.length > 0) out.push({ role: "assistant", content });
		} else if (msg.role === "toolResult") {
			const text = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			const block: ToolContent = {
				type: "tool-result",
				toolCallId: msg.toolCallId,
				toolName: toolNameById.get(msg.toolCallId) ?? msg.toolName ?? "unknown",
				output: { type: msg.isError ? "error-text" : "text", value: text },
			};
			// Merge consecutive tool-result messages into one role:"tool" message
			const last = out[out.length - 1];
			if (last && last.role === "tool") {
				last.content.push(block);
			} else {
				out.push({ role: "tool", content: [block] });
			}
		}
	}
	return out;
}

// ---- Static "config" sidecar --------------------------------------------
// The /alpha/generate schema is strict — all of these fields are required.
// We don't actually have a project context inside an extension, so we send
// neutral defaults. The gateway just stuffs them into the system prompt
// preamble; they don't affect routing.

function staticConfig() {
	return {
		workingDir: process.cwd(),
		date: new Date().toISOString().slice(0, 10),
		environment: "production",
		structure: [],
		isGitRepo: false,
		currentBranch: "",
		mainBranch: "",
		gitStatus: "",
		recentCommits: [],
	};
}

// ---- NDJSON line reader -------------------------------------------------

async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let lineNumber = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line) continue;
			lineNumber += 1;
			yield parseJsonLine(line, lineNumber);
		}
	}
	buffer = buffer.trim();
	if (buffer) {
		lineNumber += 1;
		yield parseJsonLine(buffer, lineNumber);
	}
}

type GatewayEvent = Record<string, any>;

function toolEventId(event: GatewayEvent): string | undefined {
	return event.id ?? event.toolCallId;
}

function toolEventName(event: GatewayEvent): string {
	return event.toolName ?? event.name ?? "";
}

function resolveCommandCodeApiKey(apiKey: string | undefined): string | undefined {
	if (!apiKey || apiKey === "COMMANDCODE_API_KEY" || apiKey === "$COMMANDCODE_API_KEY") {
		return process.env.COMMANDCODE_API_KEY;
	}
	return apiKey;
}

// ---- Stream implementation ----------------------------------------------

function streamCommandCode(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKey = resolveCommandCodeApiKey(options?.apiKey);
			if (!apiKey) throw new Error("No Command Code API key. Set COMMANDCODE_API_KEY=user_...");

			stream.push({ type: "start", partial: output });

			const tools = (context.tools ?? []).map((t) => ({
				name: t.name,
				description: t.description,
				input_schema: t.parameters,
			}));
			// The installed host supports "max", while this extension's older peer
			// dependency does not include it in SimpleStreamOptions yet.
			const requestedReasoning = options?.reasoning as CommandCodeThinkingLevel | undefined;
			const thinkingLevelMap = model.thinkingLevelMap as ModelDef["thinkingLevelMap"];
			const mappedReasoningEffort = requestedReasoning
				? thinkingLevelMap?.[requestedReasoning]
				: undefined;

			const body = {
				config: staticConfig(),
				memory: "",
				taste: null,
				skills: null,
				permissionMode: "standard",
				params: {
					model: model.id,
					system: context.systemPrompt ?? "",
					messages: convertMessages(context.messages),
					tools,
					max_tokens: options?.maxTokens ?? model.maxTokens ?? 8192,
					...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
					...(typeof mappedReasoningEffort === "string"
						? { reasoning_effort: mappedReasoningEffort }
						: {}),
					stream: true,
				},
			};

			const response = await fetch(`${BASE_URL}${ENDPOINT}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					Accept: "application/x-ndjson",
					"x-cli-environment": "production",
					"x-command-code-version": COMMAND_CODE_VERSION,
					"x-session-id": options?.sessionId ?? crypto.randomUUID(),
					...(process.env.CMD_ZDR === "1" ? { "x-cmd-zdr": "1" } : {}),
				},
				body: JSON.stringify(body),
				signal: options?.signal,
			});

			if (!response.ok || !response.body) {
				let detail = "";
				try {
					detail = await response.text();
				} catch {}
				throw new Error(`Command Code ${response.status}: ${detail || response.statusText}`);
			}

			// id-keyed maps: gateway gives us "reasoning-0", "txt-0", "call_..." as ids
			const idToIndex = new Map<string, number>();
			const toolJsonByIndex = new Map<number, string>();
			const endedToolCalls = new Set<number>();
			let sawTerminalEvent = false;

			for await (const event of ndjsonLines(response.body)) {
				if (!event || typeof event !== "object") continue;
				const gatewayEvent = event as GatewayEvent;
				const type = gatewayEvent.type;
				if (!type) continue;

				switch (type) {
					case "reasoning-start": {
						output.content.push({ type: "thinking", thinking: "" });
						const idx = output.content.length - 1;
						idToIndex.set(gatewayEvent.id, idx);
						stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
						break;
					}
					case "reasoning-delta": {
						const idx = idToIndex.get(gatewayEvent.id);
						if (idx === undefined) break;
						const block = output.content[idx];
						if (block.type !== "thinking") break;
						const delta = gatewayEvent.text ?? "";
						block.thinking += delta;
						stream.push({ type: "thinking_delta", contentIndex: idx, delta, partial: output });
						break;
					}
					case "reasoning-end": {
						const idx = idToIndex.get(gatewayEvent.id);
						if (idx === undefined) break;
						const block = output.content[idx];
						if (block.type !== "thinking") break;
						stream.push({
							type: "thinking_end",
							contentIndex: idx,
							content: block.thinking,
							partial: output,
						});
						break;
					}
					case "text-start": {
						output.content.push({ type: "text", text: "" });
						const idx = output.content.length - 1;
						idToIndex.set(gatewayEvent.id, idx);
						stream.push({ type: "text_start", contentIndex: idx, partial: output });
						break;
					}
					case "text-delta": {
						const idx = idToIndex.get(gatewayEvent.id);
						if (idx === undefined) break;
						const block = output.content[idx];
						if (block.type !== "text") break;
						const delta = gatewayEvent.text ?? "";
						block.text += delta;
						stream.push({ type: "text_delta", contentIndex: idx, delta, partial: output });
						break;
					}
					case "text-end": {
						const idx = idToIndex.get(gatewayEvent.id);
						if (idx === undefined) break;
						const block = output.content[idx];
						if (block.type !== "text") break;
						stream.push({
							type: "text_end",
							contentIndex: idx,
							content: block.text,
							partial: output,
						});
						break;
					}
					case "tool-input-start": {
						const id = toolEventId(gatewayEvent);
						if (!id) break;
						output.content.push({
							type: "toolCall",
							id,
							name: toolEventName(gatewayEvent),
							arguments: {},
						});
						const idx = output.content.length - 1;
						idToIndex.set(id, idx);
						toolJsonByIndex.set(idx, "");
						stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
						break;
					}
					case "tool-input-delta": {
						const id = toolEventId(gatewayEvent);
						if (!id) break;
						const idx = idToIndex.get(id);
						if (idx === undefined) break;
						const block = output.content[idx];
						if (block.type !== "toolCall") break;
						const delta = gatewayEvent.delta ?? "";
						const acc = (toolJsonByIndex.get(idx) ?? "") + delta;
						toolJsonByIndex.set(idx, acc);
						try {
							block.arguments = JSON.parse(acc);
						} catch {
							// JSON still streaming
						}
						stream.push({ type: "toolcall_delta", contentIndex: idx, delta, partial: output });
						break;
					}
					case "tool-input-end":
					case "tool-call": {
						const id = toolEventId(gatewayEvent);
						if (!id) break;
						let idx = idToIndex.get(id);
						if (idx === undefined) {
							output.content.push({
								type: "toolCall",
								id,
								name: toolEventName(gatewayEvent),
								arguments: {},
							});
							idx = output.content.length - 1;
							idToIndex.set(id, idx);
							stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
						}
						const block = output.content[idx];
						if (block.type !== "toolCall") break;
						// Some streams send full input on "tool-call"; prefer that if present
						const completeInput = gatewayEvent.input ?? gatewayEvent.args;
						if (completeInput && typeof completeInput === "object") {
							block.arguments = completeInput;
						} else {
							const acc = toolJsonByIndex.get(idx) ?? "";
							if (acc) {
								try {
									block.arguments = JSON.parse(acc);
								} catch {}
							}
						}
						if (endedToolCalls.has(idx)) break;
						endedToolCalls.add(idx);
						stream.push({
							type: "toolcall_end",
							contentIndex: idx,
							toolCall: {
								type: "toolCall",
								id: block.id,
								name: block.name,
								arguments: block.arguments,
							},
							partial: output,
						});
						break;
					}
					case "finish-step":
					case "finish": {
						sawTerminalEvent = true;
						const usage = gatewayEvent.usage ?? gatewayEvent.totalUsage;
						if (usage) {
							// The gateway reports inputTokens as the TOTAL input (cached + uncached),
							// matching the Vercel AI SDK convention. Pi's Usage shape expects
							// `input` and `cacheRead` to be disjoint — calculateCost multiplies
							// each separately, so leaving cached tokens inside `input` would
							// double-charge on paid models. Subtract to match the convention
							// used by the built-in Anthropic provider in pi-ai.
							const totalInputTokens = usage.inputTokens ?? usage.input_tokens ?? 0;
							const cacheReadTokens =
								usage.cachedInputTokens ??
								usage.inputTokenDetails?.cacheReadTokens ??
								usage.raw?.prompt_cache_hit_tokens ??
								0;
							output.usage.input = Math.max(0, totalInputTokens - cacheReadTokens);
							output.usage.output = usage.outputTokens ?? usage.output_tokens ?? 0;
							output.usage.cacheRead = cacheReadTokens;
							output.usage.cacheWrite = 0;
							output.usage.totalTokens =
								output.usage.input +
								output.usage.output +
								output.usage.cacheRead +
								output.usage.cacheWrite;
							calculateCost(model, output.usage);
						}
						const reason = gatewayEvent.finishReason ?? gatewayEvent.rawFinishReason;
						const sawToolCall = output.content.some((b) => b.type === "toolCall");
						if (reason === "length") output.stopReason = "length";
						else if (reason === "tool-calls" || reason === "tool_calls" || reason === "tool_use")
							output.stopReason = "toolUse";
						// Some OSS models report finishReason "stop" even when they emitted
						// tool calls; pi must still route those as tool use (mirrors the
						// cliproxy commandcode translator).
						else if (sawToolCall) output.stopReason = "toolUse";
						else output.stopReason = "stop";
						break;
					}
					case "error": {
						throw new Error(
							gatewayEvent.message ??
								(gatewayEvent.error === undefined
									? "Command Code stream error"
									: stringifyUnknown(gatewayEvent.error)),
						);
					}
				}
			}
			if (!sawTerminalEvent) {
				throw new Error("Command Code stream ended before a terminal event");
			}

			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = stringifyUnknown(error);
			if (process.env.DEBUG) {
				console.error("[commandcode] stream error:", error);
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

// ---- /cc-usage -----------------------------------------------------------

type WindowUsage = {
	used: number;
	cap: number;
	exceeded: boolean;
	resetAt: number;
};

type CreditsSnapshot = {
	monthlyCredits: number;
	purchasedCredits: number;
	freeCredits: number;
	belowThreshold: boolean;
	limited: boolean;
	fiveHour?: WindowUsage;
	weekly?: WindowUsage;
};

type SubscriptionSnapshot = {
	planId?: string;
	status?: string;
	currentPeriodEnd?: string;
};

type FetchResult =
	| { ok: true; data: unknown }
	| { ok: false; error: string; status?: number; raw?: string };

const MONTHLY_ALLOWANCE: Record<string, number> = {
	"individual-go": 10,
	"individual-goat": 70,
	"individual-pro": 80,
	"individual-max": 150,
	"individual-max-10x": 150,
	"individual-max-20x": 300,
};

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseWindow(value: unknown): WindowUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const row = value as Record<string, unknown>;
	const used = asFiniteNumber(row.used);
	const cap = asFiniteNumber(row.cap);
	const resetAt = asFiniteNumber(row.resetAt);
	if (used === undefined || cap === undefined || resetAt === undefined) return undefined;
	return { used, cap, exceeded: row.exceeded === true, resetAt };
}

export function parseCredits(data: unknown): CreditsSnapshot | undefined {
	if (!data || typeof data !== "object") return undefined;
	const root = data as Record<string, unknown>;
	if (!root.credits || typeof root.credits !== "object") return undefined;
	const credits = root.credits as Record<string, unknown>;
	const monthlyCredits = asFiniteNumber(credits.monthlyCredits);
	if (monthlyCredits === undefined) return undefined;

	const windows =
		root.windowLimits && typeof root.windowLimits === "object"
			? (root.windowLimits as Record<string, unknown>)
			: undefined;

	return {
		monthlyCredits,
		purchasedCredits: asFiniteNumber(credits.purchasedCredits) ?? 0,
		freeCredits: asFiniteNumber(credits.freeCredits) ?? 0,
		belowThreshold: credits.belowThreshold === true,
		limited: windows?.limited === true,
		fiveHour: windows ? parseWindow(windows.fiveHour) : undefined,
		weekly: windows ? parseWindow(windows.weekly) : undefined,
	};
}

export function parseSubscription(data: unknown): SubscriptionSnapshot | undefined {
	if (!data || typeof data !== "object") return undefined;
	const root = data as Record<string, unknown>;
	if (!root.data || typeof root.data !== "object") return undefined;
	const row = root.data as Record<string, unknown>;
	const planId = typeof row.planId === "string" ? row.planId : undefined;
	const status = typeof row.status === "string" ? row.status : undefined;
	const currentPeriodEnd = typeof row.currentPeriodEnd === "string" ? row.currentPeriodEnd : undefined;
	if (!planId && !status && !currentPeriodEnd) return undefined;
	return { planId, status, currentPeriodEnd };
}

function usd(amount: number, compact = false): string {
	if (compact && Number.isInteger(amount)) return `$${amount}`;
	return `$${amount.toFixed(2)}`;
}

function formatReset(resetAt: number): string {
	return new Date(resetAt).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

function formatCycleEnd(iso: string): string {
	return new Date(iso).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

function formatWindow(label: string, window: WindowUsage): string {
	const reset = formatReset(window.resetAt);
	const suffix = window.exceeded ? "exceeded, reset" : "reset";
	return `${label.padEnd(7)}  ${usd(window.used)} / ${usd(window.cap, true)}    ${suffix} ${reset}`;
}

export function formatReport(
	credits: CreditsSnapshot,
	subscription: SubscriptionSnapshot | undefined,
	subscriptionError: string | undefined,
): string {
	const lines: string[] = [];
	const headerBits = ["Command Code", subscription?.planId];
	if (subscription?.status && subscription.status !== "active") {
		headerBits.push(`(${subscription.status})`);
	}
	lines.push(headerBits.filter(Boolean).join("  "));

	const monthlyCap = subscription?.planId ? MONTHLY_ALLOWANCE[subscription.planId] : undefined;
	const month =
		monthlyCap !== undefined
			? `${usd(credits.monthlyCredits)} / ${usd(monthlyCap, true)} left`
			: `${usd(credits.monthlyCredits)} left`;
	lines.push(`${"Month".padEnd(7)}  ${month}`);

	if (credits.purchasedCredits > 0 || credits.freeCredits > 0) {
		const extras: string[] = [];
		if (credits.purchasedCredits > 0) extras.push(`${usd(credits.purchasedCredits)} purchased`);
		if (credits.freeCredits > 0) extras.push(`${usd(credits.freeCredits)} free`);
		lines.push(`${"Extra".padEnd(7)}  ${extras.join(" + ")}`);
	}

	if (credits.limited) {
		if (credits.fiveHour) lines.push(formatWindow("5-hour", credits.fiveHour));
		if (credits.weekly) lines.push(formatWindow("Week", credits.weekly));
	}

	if (subscription?.currentPeriodEnd) {
		lines.push(`${"Cycle".padEnd(7)}  ends ${formatCycleEnd(subscription.currentPeriodEnd)}`);
	} else if (subscriptionError) {
		lines.push(`${"Cycle".padEnd(7)}  unavailable (${subscriptionError})`);
	}

	return lines.join("\n");
}

function previewRaw(raw: string | undefined): string {
	if (!raw) return "";
	const compact = raw.replace(/\s+/g, " ").trim();
	return compact.length <= RAW_PREVIEW ? compact : `${compact.slice(0, RAW_PREVIEW)}...`;
}

async function getJson(path: string, apiKey: string): Promise<FetchResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), BILLING_TIMEOUT_MS);
	try {
		const response = await fetch(`${BASE_URL}${path}`, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
			signal: controller.signal,
		});
		const raw = await response.text();
		if (response.status === 401) {
			return { ok: false, error: "Unauthorized. Check the Command Code API key.", status: 401, raw };
		}
		if (response.status === 429) {
			return { ok: false, error: "Rate limited. Try again later.", status: 429, raw };
		}
		if (response.status >= 500) {
			return {
				ok: false,
				error: `Command Code billing API unavailable (HTTP ${response.status}).`,
				status: response.status,
				raw,
			};
		}
		if (!response.ok) {
			return {
				ok: false,
				error: `Command Code billing API failed (HTTP ${response.status}).`,
				status: response.status,
				raw,
			};
		}
		try {
			return { ok: true, data: JSON.parse(raw) };
		} catch {
			return { ok: false, error: "Billing API returned non-JSON.", raw };
		}
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			return { ok: false, error: "Command Code billing API timed out." };
		}
		return { ok: false, error: "Command Code billing API request failed." };
	} finally {
		clearTimeout(timer);
	}
}

async function resolveUsageApiKey(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const fromRegistry = await ctx.modelRegistry.getApiKeyForProvider("commandcode");
	if (fromRegistry) return fromRegistry;
	const fromEnv = process.env.COMMANDCODE_API_KEY;
	return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

async function runUsage(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const apiKey = await resolveUsageApiKey(ctx);
	if (!apiKey) {
		ctx.ui.notify(
			"No Command Code API key. Add a commandcode api_key entry to ~/.pi/agent/auth.json, or set COMMANDCODE_API_KEY.",
			"error",
		);
		return;
	}

	const [creditsResult, subscriptionResult] = await Promise.all([
		getJson("/alpha/billing/credits", apiKey),
		getJson("/alpha/billing/subscriptions", apiKey),
	]);

	if (!creditsResult.ok) {
		ctx.ui.notify(creditsResult.error, "error");
		return;
	}

	const credits = parseCredits(creditsResult.data);
	if (!credits) {
		const snippet = previewRaw(JSON.stringify(creditsResult.data));
		ctx.ui.notify(`Billing API changed shape. ${snippet}`.trim(), "error");
		return;
	}

	let subscription: SubscriptionSnapshot | undefined;
	let subscriptionError: string | undefined;
	if (subscriptionResult.ok) {
		subscription = parseSubscription(subscriptionResult.data);
		if (!subscription) subscriptionError = "changed shape";
	} else {
		subscriptionError = subscriptionResult.error;
	}

	const report = formatReport(credits, subscription, subscriptionError);
	const kind = credits.belowThreshold || credits.fiveHour?.exceeded || credits.weekly?.exceeded ? "warning" : "info";
	ctx.ui.notify(report, kind);
}

// ---- Extension entry point ----------------------------------------------

export default async function (pi: ExtensionAPI) {
	let models = MODELS;
	try {
		models = await fetchProviderModelsWithTimeout();
	} catch (error) {
		if (process.env.DEBUG) {
			console.error("[commandcode] model catalog refresh failed:", error);
		}
	}

	pi.registerProvider("commandcode", {
		name: "Command Code",
		baseUrl: BASE_URL,
		apiKey: "COMMANDCODE_API_KEY",
		authHeader: true,
		api: "commandcode-generate",
		streamSimple: streamCommandCode,
		models,
		async refreshModels(context) {
			if (!context.allowNetwork) return MODELS;
			return fetchProviderModels(context.signal);
		},
	});
	pi.registerCommand("cc-usage", {
		description: "Show Command Code plan credits and usage limits",
		handler: runUsage,
	});
}
