import assert from "node:assert/strict";
import test from "node:test";

import registerCommandCode, {
	fetchProviderModelsWithTimeout,
	formatQuotaBar,
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
	on() {},
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

function goatCredits(overrides = {}) {
	return parseCredits({
		credits: {
			monthlyCredits: 62.3,
			purchasedCredits: 0,
			freeCredits: 0,
			belowThreshold: false,
			...overrides.credits,
		},
		windowLimits: {
			limited: true,
			fiveHour: { used: 1.8, cap: 10, exceeded: false, resetAt: Date.UTC(2026, 8, 12, 7, 0) },
			weekly: { used: 3.2, cap: 40, exceeded: false, resetAt: Date.UTC(2026, 8, 15, 7, 0) },
			...overrides.windowLimits,
		},
	});
}

test("formats a compact 5h/weekly/monthly quota bar with percentages", () => {
	const credits = goatCredits();
	const subscription = parseSubscription({
		data: { planId: "individual-goat", status: "active" },
	});

	assert.ok(credits);
	assert.equal(
		formatQuotaBar(credits, subscription),
		"5h ▓▓░░░░░░░░ 18%   Wk ▓░░░░░░░░░  8%   Mo ▓░░░░░░░░░ 11%",
	);
});

test("omits 5-hour and weekly segments when the plan is not window-limited", () => {
	const credits = parseCredits({
		credits: { monthlyCredits: 9, purchasedCredits: 0, freeCredits: 0, belowThreshold: false },
		windowLimits: { limited: false },
	});
	const subscription = parseSubscription({
		data: { planId: "individual-go", status: "active" },
	});

	assert.ok(credits);
	assert.equal(formatQuotaBar(credits, subscription), "Mo ▓░░░░░░░░░ 10%");
});

test("omits the monthly segment when the plan cap is unknown", () => {
	const credits = parseCredits({
		credits: { monthlyCredits: 62.3, purchasedCredits: 0, freeCredits: 0, belowThreshold: false },
		windowLimits: {
			limited: true,
			fiveHour: { used: 1, cap: 10, exceeded: false, resetAt: Date.UTC(2026, 8, 12, 7, 0) },
			weekly: { used: 4, cap: 40, exceeded: false, resetAt: Date.UTC(2026, 8, 15, 7, 0) },
		},
	});

	assert.ok(credits);
	assert.equal(formatQuotaBar(credits, undefined), "5h ▓░░░░░░░░░ 10%   Wk ▓░░░░░░░░░ 10%");
});

test("clamps an exhausted window to a full 100% bar", () => {
	const credits = parseCredits({
		credits: { monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0, belowThreshold: true },
		windowLimits: {
			limited: true,
			fiveHour: { used: 12, cap: 10, exceeded: true, resetAt: Date.UTC(2026, 8, 12, 7, 0) },
		},
	});
	const subscription = parseSubscription({
		data: { planId: "individual-go", status: "active" },
	});

	assert.ok(credits);
	assert.equal(formatQuotaBar(credits, subscription), "5h ▓▓▓▓▓▓▓▓▓▓ 100%   Mo ▓▓▓▓▓▓▓▓▓▓ 100%");
});

test("colors quota segments by usage threshold", () => {
	const credits = parseCredits({
		credits: { monthlyCredits: 7, purchasedCredits: 0, freeCredits: 0, belowThreshold: false },
		windowLimits: {
			limited: true,
			fiveHour: { used: 8, cap: 10, exceeded: false, resetAt: Date.UTC(2026, 8, 12, 7, 0) },
			weekly: { used: 36, cap: 40, exceeded: false, resetAt: Date.UTC(2026, 8, 15, 7, 0) },
		},
	});
	const subscription = parseSubscription({
		data: { planId: "individual-go", status: "active" },
	});
	const painted = [];
	const color = (kind, text) => {
		painted.push([kind, text]);
		return text;
	};

	assert.ok(credits);
	formatQuotaBar(credits, subscription, color);
	assert.deepEqual(
		painted.map(([kind]) => kind),
		["warning", "error", "success"],
	);
});

function jsonResponse(data) {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function billingFetch() {
	return async (input) => {
		const url = String(input);
		if (url.includes("/alpha/billing/credits")) {
			return jsonResponse({
				credits: { monthlyCredits: 62.3, purchasedCredits: 0, freeCredits: 0, belowThreshold: false },
				windowLimits: {
					limited: true,
					fiveHour: { used: 1.8, cap: 10, exceeded: false, resetAt: Date.UTC(2026, 8, 12, 7, 0) },
					weekly: { used: 3.2, cap: 40, exceeded: false, resetAt: Date.UTC(2026, 8, 15, 7, 0) },
				},
			});
		}
		if (url.includes("/alpha/billing/subscriptions")) {
			return jsonResponse({
				data: {
					planId: "individual-goat",
					status: "active",
					currentPeriodEnd: "2026-09-30T00:00:00.000Z",
				},
			});
		}
		if (url.includes("/provider/v1/models")) {
			return jsonResponse({ data: [] });
		}
		return new Response("no", { status: 404 });
	};
}

async function bootQuotaExtension() {
	const handlers = new Map();
	await registerCommandCode({
		registerProvider() {},
		registerCommand() {},
		on(name, handler) {
			handlers.set(name, handler);
		},
	});
	return handlers;
}

function makeQuotaCtx({ provider = "commandcode", apiKey = "user_test" } = {}) {
	const widgets = [];
	return {
		widgets,
		ctx: {
			hasUI: true,
			mode: "tui",
			model: { provider, id: "deepseek/deepseek-v4-pro" },
			modelRegistry: {
				async getApiKeyForProvider(name) {
					if (name !== "commandcode") return undefined;
					return apiKey || undefined;
				},
			},
			ui: {
				theme: { fg(_kind, text) { return text; } },
				setWidget(id, content, opts) {
					widgets.push({ id, content, opts });
				},
			},
		},
	};
}

test("shows the quota bar below the editor for Command Code models", async (t) => {
	const handlers = await bootQuotaExtension();
	t.mock.method(globalThis, "fetch", billingFetch());
	const { ctx, widgets } = makeQuotaCtx();
	t.after(async () => {
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	await handlers.get("session_start")({}, ctx);

	const last = widgets.at(-1);
	assert.equal(last?.id, "cc-quota");
	assert.deepEqual(last?.opts, { placement: "belowEditor" });
	assert.equal(last?.content[0], "5h ▓▓░░░░░░░░ 18%   Wk ▓░░░░░░░░░  8%   Mo ▓░░░░░░░░░ 11%");
});

test("hides the quota bar when leaving Command Code models", async (t) => {
	const handlers = await bootQuotaExtension();
	t.mock.method(globalThis, "fetch", billingFetch());
	const { ctx, widgets } = makeQuotaCtx();
	t.after(async () => {
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	await handlers.get("session_start")({}, ctx);
	const other = { ...ctx, model: { provider: "openai", id: "gpt-5.4" } };
	await handlers.get("model_select")({ model: other.model }, other);

	const last = widgets.at(-1);
	assert.equal(last?.id, "cc-quota");
	assert.equal(last?.content, undefined);
});

test("does not show a quota bar without a Command Code key", async (t) => {
	const previous = process.env.COMMANDCODE_API_KEY;
	delete process.env.COMMANDCODE_API_KEY;
	t.after(() => {
		if (previous === undefined) delete process.env.COMMANDCODE_API_KEY;
		else process.env.COMMANDCODE_API_KEY = previous;
	});

	const handlers = await bootQuotaExtension();
	t.mock.method(globalThis, "fetch", billingFetch());
	const { ctx, widgets } = makeQuotaCtx({ apiKey: "" });
	t.after(async () => {
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	await handlers.get("session_start")({}, ctx);

	assert.equal(widgets.length, 0);
});

test("keeps the last quota bar when the credits fetch later fails", async (t) => {
	const handlers = await bootQuotaExtension();
	let creditsOk = true;
	t.mock.method(globalThis, "fetch", async (input) => {
		const url = String(input);
		if (url.includes("/alpha/billing/credits") && !creditsOk) {
			return new Response("no", { status: 500 });
		}
		return billingFetch()(input);
	});
	const { ctx, widgets } = makeQuotaCtx();
	t.after(async () => {
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	await handlers.get("session_start")({}, ctx);
	const shown = widgets.at(-1)?.content?.[0];
	assert.equal(shown, "5h ▓▓░░░░░░░░ 18%   Wk ▓░░░░░░░░░  8%   Mo ▓░░░░░░░░░ 11%");

	creditsOk = false;
	await handlers.get("agent_settled")({}, ctx);
	assert.equal(widgets.at(-1)?.content?.[0], shown);
	assert.equal(widgets.length, 1);
});

test("keeps the monthly segment when the subscription fetch later fails", async (t) => {
	const handlers = await bootQuotaExtension();
	let subscriptionsOk = true;
	t.mock.method(globalThis, "fetch", async (input) => {
		const url = String(input);
		if (url.includes("/alpha/billing/subscriptions") && !subscriptionsOk) {
			return new Response("no", { status: 500 });
		}
		return billingFetch()(input);
	});
	const { ctx, widgets } = makeQuotaCtx();
	t.after(async () => {
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	await handlers.get("session_start")({}, ctx);
	assert.match(widgets.at(-1)?.content?.[0] ?? "", /Mo /);

	subscriptionsOk = false;
	await handlers.get("agent_settled")({}, ctx);
	assert.match(widgets.at(-1)?.content?.[0] ?? "", /Mo /);
});

test("does not hide a monthly-only bar when the subscription fetch later fails", async (t) => {
	const handlers = await bootQuotaExtension();
	let subscriptionsOk = true;
	t.mock.method(globalThis, "fetch", async (input) => {
		const url = String(input);
		if (url.includes("/alpha/billing/credits")) {
			return jsonResponse({
				credits: { monthlyCredits: 9, purchasedCredits: 0, freeCredits: 0, belowThreshold: false },
				windowLimits: { limited: false },
			});
		}
		if (url.includes("/alpha/billing/subscriptions")) {
			if (!subscriptionsOk) return new Response("no", { status: 500 });
			return jsonResponse({ data: { planId: "individual-go", status: "active" } });
		}
		return jsonResponse({ data: [] });
	});
	const { ctx, widgets } = makeQuotaCtx();
	t.after(async () => {
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	await handlers.get("session_start")({}, ctx);
	assert.equal(widgets.at(-1)?.content?.[0], "Mo ▓░░░░░░░░░ 10%");

	subscriptionsOk = false;
	await handlers.get("agent_settled")({}, ctx);
	assert.equal(widgets.at(-1)?.content?.[0], "Mo ▓░░░░░░░░░ 10%");
});
