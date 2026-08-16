import assert from "node:assert/strict";
import test from "node:test";

import registerCommandCode from "../index.ts";

let provider;
registerCommandCode({
	registerProvider(name, config) {
		assert.equal(name, "commandcode");
		provider = config;
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
