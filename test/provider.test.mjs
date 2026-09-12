import assert from "node:assert/strict";
import test from "node:test";

import registerCommandCode, {
	fetchProviderModelsWithTimeout,
	formatReport,
	parseCredits,
	parseProviderModels,
	parseSubscription,
} from "../index.ts";

let provider;
let commands;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
	if (String(input).includes("/provider/v1/models")) {
		return new Response(
			JSON.stringify({
				data: [
					{ id: "claude-sonnet-5", name: "Claude Sonnet 5", context_length: 1_000_000 },
					{ id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro (latest)", context_length: 1_000_000 },
					{ id: "moonshotai/Kimi-K3", name: "Kimi K3", context_length: 1_000_000 },
				],
			}),
			{ status: 200 },
		);
	}
	return realFetch(input, init);
};
await registerCommandCode({
	registerProvider(name, config) {
		assert.equal(name, "commandcode");
		provider = config;
	},
	registerCommand(name, config) {
		commands ??= new Map();
		commands.set(name, config);
	},
});

function terminalResponse() {
	return new Response('{"type":"finish","finishReason":"stop","totalUsage":{"totalTokens":0}}\n', {
		status: 200,
		headers: { "content-type": "application/x-ndjson" },
	});
}

async function drain(stream) {
	let terminal;
	for await (const event of stream) terminal = event;
	return terminal;
}

test("registers a self-contained Command Code provider", () => {
	assert.equal(provider.api, "commandcode-generate");
	assert.equal(provider.streamSimple instanceof Function, true);
	assert.ok(provider.models.some((model) => model.id === "deepseek/deepseek-v4-pro"));
});

test("registers the Command Code usage command in the same extension", () => {
	assert.equal(commands.get("cc-usage")?.handler instanceof Function, true);
});

test("parses provider models from Command Code's public catalog shape", () => {
	const models = parseProviderModels({
		data: [
			{
				id: "claude-sonnet-5",
				name: "Claude Sonnet 5",
				context_length: 1_000_000,
			},
			{
				id: "deepseek/deepseek-v4-flash-vision-exp",
				name: "DeepSeek V4 Flash Vision (exp)",
				context_length: 1_000_000,
			},
			{
				id: "bad-model",
				name: "Bad",
				context_length: "unknown",
			},
		],
	});

	assert.deepEqual(
		models.map((model) => [model.id, model.reasoning, model.input]),
		[
			["claude-sonnet-5", true, ["text"]],
			["deepseek/deepseek-v4-flash-vision-exp", true, ["text", "image"]],
		],
	);
	assert.ok(models.some((model) => model.id === "claude-sonnet-5"));
});

test("refreshes provider models from Command Code's public catalog", async (t) => {
	t.mock.method(globalThis, "fetch", async () => {
		return new Response(
			JSON.stringify({
				data: [
					{
						id: "xai/grok-4.6",
						name: "Grok 4.6",
						context_length: 500_000,
					},
				],
			}),
			{ status: 200 },
		);
	});

	const refreshed = await provider.refreshModels({
		allowNetwork: true,
		signal: new AbortController().signal,
	});

	assert.deepEqual(
		refreshed.map((model) => model.id),
		["xai/grok-4.6"],
	);
});

test("times out startup model catalog fetches", async (t) => {
	t.mock.method(globalThis, "fetch", async (_input, init) => {
		return new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
		});
	});

	await assert.rejects(() => fetchProviderModelsWithTimeout(10), /timed out/);
});

test("forwards supported DeepSeek effort levels to alpha/generate", async (t) => {
	const model = provider.models.find((entry) => entry.id === "deepseek/deepseek-v4-pro");
	assert.ok(model);
	const bodies = [];
	t.mock.method(globalThis, "fetch", async (_input, init) => {
		bodies.push(JSON.parse(init.body));
		return terminalResponse();
	});

	for (const reasoning of ["high", "max"]) {
		const terminal = await drain(
			provider.streamSimple(
				model,
				{ systemPrompt: "", messages: [], tools: [] },
				{ apiKey: "user_test", reasoning },
			),
		);
		assert.equal(terminal?.type, "done");
	}

	assert.deepEqual(
		bodies.map((body) => body.params.reasoning_effort),
		["high", "max"],
	);
});

test("omits unsupported efforts and leaves unrelated models unchanged", async (t) => {
	const deepSeek = provider.models.find((entry) => entry.id === "deepseek/deepseek-v4-pro");
	const kimi = provider.models.find((entry) => entry.id === "moonshotai/Kimi-K3");
	assert.ok(deepSeek);
	assert.ok(kimi);
	const bodies = [];
	t.mock.method(globalThis, "fetch", async (_input, init) => {
		bodies.push(JSON.parse(init.body));
		return terminalResponse();
	});

	await drain(
		provider.streamSimple(
			deepSeek,
			{ systemPrompt: "", messages: [], tools: [] },
			{ apiKey: "user_test", reasoning: "low" },
		),
	);
	await drain(
		provider.streamSimple(
			kimi,
			{ systemPrompt: "", messages: [], tools: [] },
			{ apiKey: "user_test", reasoning: "high" },
		),
	);

	assert.equal(bodies.length, 2);
	for (const body of bodies) assert.equal(Object.hasOwn(body.params, "reasoning_effort"), false);
});

test("resolves Pi's literal Command Code environment-key references", async (t) => {
	const previous = process.env.COMMANDCODE_API_KEY;
	process.env.COMMANDCODE_API_KEY = "user_env_test";
	t.after(() => {
		if (previous === undefined) delete process.env.COMMANDCODE_API_KEY;
		else process.env.COMMANDCODE_API_KEY = previous;
	});

	const model = provider.models.find((entry) => entry.id === "deepseek/deepseek-v4-pro");
	assert.ok(model);
	const authorizationHeaders = [];
	t.mock.method(globalThis, "fetch", async (_input, init) => {
		authorizationHeaders.push(init.headers.Authorization);
		return terminalResponse();
	});

	for (const apiKey of ["COMMANDCODE_API_KEY", "$COMMANDCODE_API_KEY"]) {
		await drain(
			provider.streamSimple(
				model,
				{ systemPrompt: "", messages: [], tools: [] },
				{ apiKey },
			),
		);
	}

	assert.deepEqual(authorizationHeaders, ["Bearer user_env_test", "Bearer user_env_test"]);
});

test("formats GOAT usage reports", () => {
	const credits = parseCredits({
		credits: { monthlyCredits: 62.5, purchasedCredits: 1, freeCredits: 0, belowThreshold: false },
		windowLimits: {
			limited: true,
			fiveHour: { used: 1, cap: 10, exceeded: false, resetAt: Date.UTC(2026, 8, 12, 7, 0) },
			weekly: { used: 4, cap: 40, exceeded: false, resetAt: Date.UTC(2026, 8, 15, 7, 0) },
		},
	});
	const subscription = parseSubscription({
		data: {
			planId: "individual-goat",
			status: "active",
			currentPeriodEnd: "2026-09-30T00:00:00.000Z",
		},
	});

	assert.ok(credits);
	assert.ok(subscription);
	const report = formatReport(credits, subscription, undefined);
	assert.match(report, /Command Code  individual-goat/);
	assert.match(report, /Month\s+\$62\.50 \/ \$70 left/);
	assert.match(report, /Extra\s+\$1\.00 purchased/);
});
