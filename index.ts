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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://api.commandcode.ai";
const ENDPOINT = "/alpha/generate";
// Mirrors the `x-command-code-version` the CLI sends (its package version).
// Keep in step with the installed `command-code` package; stale values risk
// being rejected or flagged by the gateway.
const COMMAND_CODE_VERSION = "0.52.1";

// ---- Models -------------------------------------------------------------
// IDs are the gateway's canonical ids from GET /provider/v1/models
// (readable with a user_... key as of CLI 0.52.x).
//
// Only the open-weight / OSS roster is exposed here. Command Code also serves
// proprietary frontier models (claude-*, gpt-*, google/gemini-*) through the
// same /alpha/generate envelope, but they bill real plan credits and are
// available far more cheaply elsewhere, so they're intentionally omitted.
// To add one, append a ModelDef with the canonical id from the models list.
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

const DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} satisfies NonNullable<ModelDef["thinkingLevelMap"]>;

const MODELS: ModelDef[] = [
	// DeepSeek
	{
		id: "deepseek/deepseek-v4-pro",
		name: "DeepSeek V4 Pro (Command Code)",
		reasoning: true,
		thinkingLevelMap: DEEPSEEK_V4_THINKING_LEVEL_MAP,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131072,
		cost: ZERO_COST,
	},
	{
		id: "deepseek/deepseek-v4-flash",
		name: "DeepSeek V4 Flash (Command Code)",
		reasoning: true,
		thinkingLevelMap: DEEPSEEK_V4_THINKING_LEVEL_MAP,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131072,
		cost: ZERO_COST,
	},
	// Moonshot Kimi
	{
		id: "moonshotai/Kimi-K3",
		name: "Kimi K3 (Command Code)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: ZERO_COST,
	},
	{
		id: "moonshotai/Kimi-K2.7-Code",
		name: "Kimi K2.7 Code (Command Code)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 256000,
		maxTokens: 65536,
		cost: ZERO_COST,
	},
	{
		id: "moonshotai/Kimi-K2.7-Code-Highspeed",
		name: "Kimi K2.7 Code HighSpeed (Command Code)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 262000,
		maxTokens: 65536,
		cost: ZERO_COST,
	},
	{
		id: "moonshotai/Kimi-K2.6",
		name: "Kimi K2.6 (Command Code)",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 256000,
		maxTokens: 65536,
		cost: ZERO_COST,
	},
	{
		id: "moonshotai/Kimi-K2.5",
		name: "Kimi K2.5 (Command Code)",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 256000,
		maxTokens: 65536,
		cost: ZERO_COST,
	},
	// Zhipu GLM
	{
		id: "zai-org/GLM-5.2",
		name: "GLM 5.2 (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131072,
		cost: ZERO_COST,
	},
	{
		id: "zai-org/GLM-5.2-Fast",
		name: "GLM 5.2 Fast (Command Code)",
		reasoning: false,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		cost: ZERO_COST,
	},
	{
		id: "zai-org/GLM-5.1",
		name: "GLM 5.1 (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 200000,
		maxTokens: 32768,
		cost: ZERO_COST,
	},
	{
		id: "zai-org/GLM-5",
		name: "GLM 5 (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 200000,
		maxTokens: 32768,
		cost: ZERO_COST,
	},
	// MiniMax
	{
		id: "MiniMaxAI/MiniMax-M3",
		name: "MiniMax M3 (Command Code)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 131072,
		cost: ZERO_COST,
	},
	{
		id: "MiniMaxAI/MiniMax-M2.7",
		name: "MiniMax M2.7 (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 200000,
		maxTokens: 65536,
		cost: ZERO_COST,
	},
	{
		id: "MiniMaxAI/MiniMax-M2.5",
		name: "MiniMax M2.5 (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 200000,
		maxTokens: 65536,
		cost: ZERO_COST,
	},
	// Xiaomi MiMo
	{
		id: "xiaomi/mimo-v2.5-pro",
		name: "MiMo V2.5 Pro (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131072,
		cost: ZERO_COST,
	},
	{
		id: "xiaomi/mimo-v2.5",
		name: "MiMo V2.5 (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131072,
		cost: ZERO_COST,
	},
	// Qwen
	{
		id: "Qwen/Qwen3.7-Max",
		name: "Qwen 3.7 Max (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131072,
		cost: ZERO_COST,
	},
	{
		id: "Qwen/Qwen3.7-Plus",
		name: "Qwen 3.7 Plus (Command Code)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 131072,
		cost: ZERO_COST,
	},
	{
		id: "Qwen/Qwen3.6-Max-Preview",
		name: "Qwen 3.6 Max Preview (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 200000,
		maxTokens: 32768,
		cost: ZERO_COST,
	},
	{
		id: "Qwen/Qwen3.6-Plus",
		name: "Qwen 3.6 Plus (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 200000,
		maxTokens: 32768,
		cost: ZERO_COST,
	},
	// StepFun
	{
		id: "stepfun/Step-3.7-Flash",
		name: "Step 3.7 Flash (Command Code)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 256000,
		maxTokens: 65536,
		cost: ZERO_COST,
	},
	{
		id: "stepfun/Step-3.5-Flash",
		name: "Step 3.5 Flash (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131072,
		cost: ZERO_COST,
	},
	// Tencent
	{
		id: "tencent/Hy3",
		name: "Tencent Hy3 (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 262_144,
		maxTokens: 65_536,
		cost: ZERO_COST,
	},
	// NVIDIA
	{
		id: "nvidia/nemotron-3-ultra-550b-a55b",
		name: "Nemotron 3 Ultra (Command Code)",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131072,
		cost: ZERO_COST,
	},
	// Thinking Machines
	{
		id: "thinkingmachines/inkling",
		name: "Inkling (Command Code)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 256_000,
		maxTokens: 65_536,
		cost: ZERO_COST,
	},
];

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

// ---- Extension entry point ----------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerProvider("commandcode", {
		name: "Command Code",
		baseUrl: BASE_URL,
		apiKey: "COMMANDCODE_API_KEY",
		authHeader: true,
		api: "commandcode-generate",
		streamSimple: streamCommandCode,
		models: MODELS,
	});
}
