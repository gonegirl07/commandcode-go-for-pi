/**
 * Command Code quota/usage + multi-key failover for omp.
 *
 * Ported from `commandcode-go-for-pi`
 * (https://github.com/gonegirl07/commandcode-go-for-pi, MIT).
 *
 * omp already ships a first-class `commandcode` provider — catalog entry, KDL
 * deployment contract (`providers/commandcode.kdl`), transport routing,
 * per-model effort ladders, and a 68-row pricing table. Registering a provider
 * *with* `models` REPLACES that model list (ModelRegistry filters existing rows
 * for the provider before appending), which is why the pi extension cannot be
 * reused as-is here. So this file registers `usage` and nothing else.
 *
 * Billing endpoints (Go/GOAT plans, verified 2026-09-14):
 *   GET /alpha/billing/credits        -> monthly remaining + rolling windows
 *   GET /alpha/billing/subscriptions  -> plan id and current period
 *
 * Multiple keys live in omp's own credential store (`agent.db`), so they are
 * shared with `/login commandcode` and the auth broker. `/cc-keys` manages
 * them, and an exhausted key is parked until the reset time the billing API
 * reports, which makes omp select the next key. `omp usage` renders the limits
 * below; a compact bar is shown under the editor while a Command Code model is
 * selected.
 *
 * Install: copy this file into omp's extension directory
 * (`$PI_CODING_AGENT_DIR/extensions/`, default `~/.omp/agent/extensions/`).
 * Set `COMMANDCODE_BASE_URL` to point billing at a proxy or a test server.
 */

const BASE_URL = (process.env.COMMANDCODE_BASE_URL ?? "https://api.commandcode.ai").replace(/\/+$/, "");
const PROVIDER = "commandcode";
const REQUEST_TIMEOUT_MS = 10_000;
const WIDGET_ID = "cc-quota";
const REFRESH_MS = 60_000;

/** Documented monthly credit allowance per plan id, in USD. */
const MONTHLY_ALLOWANCE = {
	"individual-go": 10,
	"individual-goat": 70,
	"individual-pro": 80,
	"individual-max": 150,
	"individual-max-10x": 150,
	"individual-max-20x": 300,
};

/** Type guard: narrows to a usable finite number, else `undefined`. */
function finite(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseWindow(value) {
	if (!value || typeof value !== "object") return undefined;
	const used = finite(value.used);
	const cap = finite(value.cap);
	const resetAt = finite(value.resetAt);
	if (used === undefined || cap === undefined || resetAt === undefined) return undefined;
	// `exceeded` is null on the live API, not false — compare strictly.
	return { used, cap, exceeded: value.exceeded === true, resetAt };
}

export function parseCredits(data) {
	if (!data || typeof data !== "object") return undefined;
	if (!data.credits || typeof data.credits !== "object") return undefined;
	const monthlyCredits = finite(data.credits.monthlyCredits);
	if (monthlyCredits === undefined) return undefined;
	const windows =
		data.windowLimits && typeof data.windowLimits === "object" ? data.windowLimits : undefined;
	return {
		monthlyCredits,
		purchasedCredits: finite(data.credits.purchasedCredits) ?? 0,
		freeCredits: finite(data.credits.freeCredits) ?? 0,
		belowThreshold: data.credits.belowThreshold === true,
		limited: windows?.limited === true,
		fiveHour: windows ? parseWindow(windows.fiveHour) : undefined,
		weekly: windows ? parseWindow(windows.weekly) : undefined,
	};
}

export function parseSubscription(data) {
	if (!data || typeof data !== "object") return undefined;
	if (!data.data || typeof data.data !== "object") return undefined;
	const row = data.data;
	const planId = typeof row.planId === "string" ? row.planId : undefined;
	const status = typeof row.status === "string" ? row.status : undefined;
	const currentPeriodEnd =
		typeof row.currentPeriodEnd === "string" ? row.currentPeriodEnd : undefined;
	if (!planId && !status && !currentPeriodEnd) return undefined;
	return { planId, status, currentPeriodEnd };
}

// ---------------------------------------------------------------------------
// Key exhaustion
// ---------------------------------------------------------------------------

/**
 * How long a key stays parked: until the last of its exhausted quota windows
 * resets. `undefined` when the key still has room.
 */
export function exhaustionFrom(credits, subscription, now = Date.now()) {
	const blocked = [];
	const push = (window, reason) => {
		if (!window) return;
		if (!window.exceeded && window.used < window.cap) return;
		if (!(window.resetAt > now)) return;
		blocked.push({ resetAt: window.resetAt, reason });
	};
	push(credits.fiveHour, "5h");
	push(credits.weekly, "weekly");

	if (credits.monthlyCredits + credits.purchasedCredits + credits.freeCredits <= 0) {
		const periodEnd = subscription?.currentPeriodEnd ? Date.parse(subscription.currentPeriodEnd) : Number.NaN;
		blocked.push({
			resetAt: Number.isFinite(periodEnd) && periodEnd > now ? periodEnd : now + 6 * 60 * 60 * 1000,
			reason: "monthly",
		});
	}

	if (blocked.length === 0) return undefined;
	return {
		resetAt: Math.max(...blocked.map((entry) => entry.resetAt)),
		reason: blocked.map((entry) => entry.reason).join("+"),
	};
}

// ---------------------------------------------------------------------------
// UsageReport (what `omp usage` consumes)
// ---------------------------------------------------------------------------

function statusFor(used, limit, exceeded) {
	if (exceeded || used >= limit) return "exhausted";
	return used / limit >= 0.7 ? "warning" : "ok";
}

function windowLimit(id, label, window) {
	return {
		id,
		label,
		scope: { provider: PROVIDER, windowId: id },
		window: { id, label, resetsAt: window.resetAt, resetLabel: "resets" },
		amount: { used: window.used, limit: window.cap, unit: "usd" },
		status: statusFor(window.used, window.cap, window.exceeded),
	};
}

export function toUsageReport(credits, subscription, now) {
	const limits = [];

	if (credits.limited && credits.fiveHour) {
		limits.push(windowLimit("commandcode:usd:5h", "5 Hour", credits.fiveHour));
	}
	if (credits.limited && credits.weekly) {
		limits.push(windowLimit("commandcode:usd:7d", "Weekly", credits.weekly));
	}

	// The API reports monthly REMAINING credit, not the cap. Only attach a limit
	// when the plan id maps to a documented allowance; otherwise report remaining
	// spend without inventing a denominator.
	const allowance = subscription?.planId ? MONTHLY_ALLOWANCE[subscription.planId] : undefined;
	const monthNotes =
		allowance === undefined
			? ["Plan allowance not published for this plan; showing remaining credit."]
			: [subscription.planId];
	if (allowance === undefined) {
		limits.push({
			id: "commandcode:usd:month",
			label: "Monthly credits",
			scope: { provider: PROVIDER },
			amount: { remaining: credits.monthlyCredits, unit: "usd" },
			notes: monthNotes,
		});
	} else {
		const used = Math.max(0, allowance - credits.monthlyCredits);
		limits.push({
			id: "commandcode:usd:month",
			label: "Monthly credits",
			scope: { provider: PROVIDER, windowId: "commandcode:usd:month" },
			amount: { used, limit: allowance, remaining: credits.monthlyCredits, unit: "usd" },
			status: statusFor(used, allowance, false),
			notes: monthNotes,
		});
	}

	if (credits.purchasedCredits > 0 || credits.freeCredits > 0) {
		const notes = [];
		if (credits.purchasedCredits > 0) notes.push(`$${credits.purchasedCredits.toFixed(2)} purchased`);
		if (credits.freeCredits > 0) notes.push(`$${credits.freeCredits.toFixed(2)} free`);
		limits.push({
			id: "commandcode:usd:extra",
			label: "Extra credit",
			scope: { provider: PROVIDER },
			amount: { remaining: credits.purchasedCredits + credits.freeCredits, unit: "usd" },
			notes,
		});
	}

	const notes = [];
	if (subscription?.status && subscription.status !== "active") {
		notes.push(`Subscription status: ${subscription.status}`);
	}
	if (subscription?.currentPeriodEnd) {
		notes.push(`Cycle ends ${new Date(subscription.currentPeriodEnd).toDateString()}`);
	}
	if (credits.belowThreshold) notes.push("Credit balance is below the account threshold.");

	return { provider: PROVIDER, fetchedAt: now, limits, notes, raw: { credits, subscription } };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function getJson(path, apiKey, signal) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await fetch(`${BASE_URL}${path}`, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			signal: controller.signal,
		});
		if (!response.ok) return { ok: false, status: response.status };
		return { ok: true, data: await response.json() };
	} catch {
		return { ok: false };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/** Single fetch path shared by the usage provider, the bar, /cc-usage and /cc-keys. */
async function loadUsage(apiKey, signal) {
	const [creditsResult, subscriptionResult] = await Promise.all([
		getJson("/alpha/billing/credits", apiKey, signal),
		getJson("/alpha/billing/subscriptions", apiKey, signal),
	]);
	if (!creditsResult.ok) return { error: `credits endpoint returned ${creditsResult.status ?? "no response"}` };
	const credits = parseCredits(creditsResult.data);
	if (!credits) return { error: "credits response changed shape" };
	const subscription = subscriptionResult.ok ? parseSubscription(subscriptionResult.data) : undefined;
	return { credits, subscription, report: toUsageReport(credits, subscription, Date.now()) };
}

// ---------------------------------------------------------------------------
// Key pool (omp credential store)
// ---------------------------------------------------------------------------

function mask(key) {
	return key.length <= 14 ? key : `${key.slice(0, 8)}…${key.slice(-4)}`;
}

function formatReset(ms) {
	return new Date(ms).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

/** omp's auth storage, when this build exposes one to extensions. */
function authStore(ctx) {
	const storage = ctx?.modelRegistry?.authStorage;
	return storage && typeof storage.listStoredCredentials === "function" ? storage : undefined;
}

function storedKeys(ctx) {
	const storage = authStore(ctx);
	if (!storage) return [];
	return storage
		.listStoredCredentials(PROVIDER)
		.filter((row) => row?.credential?.type === "api_key" && typeof row.credential.key === "string")
		.map((row) => ({ id: row.id, key: row.credential.key }));
}

function sessionIdOf(ctx) {
	try {
		return ctx?.sessionManager?.getSessionId?.();
	} catch {
		return undefined;
	}
}

async function activeKey(ctx) {
	const storage = authStore(ctx);
	if (!storage) return undefined;
	try {
		return await storage.getApiKey(PROVIDER, sessionIdOf(ctx), {});
	} catch {
		return undefined;
	}
}

/** Park one key until `resetAt` so omp selects a sibling for later requests. */
async function parkKey(ctx, key, resetAt, reason, log) {
	const storage = authStore(ctx);
	if (!storage || typeof storage.markUsageLimitReached !== "function") return false;
	try {
		const result = await storage.markUsageLimitReached(PROVIDER, sessionIdOf(ctx), {
			apiKey: key,
			retryAfterMs: Math.max(60_000, resetAt - Date.now()),
			providerTimed: true,
		});
		log?.(`parked ${mask(key)} (${reason}) until ${formatReset(resetAt)}: ${JSON.stringify(result)}`);
		return true;
	} catch (error) {
		log?.(`park ${mask(key)} failed: ${String(error)}`);
		return false;
	}
}

/**
 * Walks the stored keys in omp's selection order, parking every key whose
 * 5-hour, weekly, or monthly quota is spent. Returns the key omp would use
 * next, or `undefined` when nothing is left.
 */
async function ensureUsableKey(ctx, log) {
	const storage = authStore(ctx);
	if (!storage) return { active: undefined, parked: [], total: 0 };

	const seen = new Set();
	const parked = [];
	for (let attempt = 0; attempt <= storedKeys(ctx).length; attempt++) {
		const active = await activeKey(ctx);
		if (!active || seen.has(active)) break;
		seen.add(active);

		const usage = await loadUsage(active);
		const exhaustion = usage.credits ? exhaustionFrom(usage.credits, usage.subscription) : undefined;
		if (!exhaustion) {
			return {
				active,
				usage,
				parked,
				total: storedKeys(ctx).length,
			};
		}
		await parkKey(ctx, active, exhaustion.resetAt, exhaustion.reason, log);
		parked.push({ key: active, ...exhaustion });
	}

	return { active: await activeKey(ctx), parked, total: storedKeys(ctx).length };
}

// ---------------------------------------------------------------------------
// Quota bar + /cc-usage report
// ---------------------------------------------------------------------------

const BAR_WIDTH = 10;
const BAR_LABELS = { "commandcode:usd:5h": "5h", "commandcode:usd:7d": "Wk" };

export function formatBarSegment(label, used, limit, exhausted, paint) {
	if (!(limit > 0)) return undefined;
	const ratio = Math.min(1, Math.max(0, used / limit));
	const filled = Math.round(ratio * BAR_WIDTH);
	const bar = "▓".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
	const body = `${bar} ${String(Math.round(ratio * 100)).padStart(2)}%`;
	const kind = exhausted || ratio >= 0.9 ? "error" : ratio >= 0.7 ? "warning" : "success";
	return `${label} ${paint ? paint(kind, body) : body}`;
}

export function formatQuotaBar(report, paint) {
	const segments = [];
	for (const limit of report.limits) {
		const segment = formatBarSegment(
			BAR_LABELS[limit.id] ?? "Mo",
			limit.amount.used ?? 0,
			limit.amount.limit ?? 0,
			limit.status === "exhausted",
			paint,
		);
		if (segment) segments.push(segment);
	}
	return segments.join("   ");
}

export function formatReport(report) {
	const lines = ["Command Code"];
	for (const limit of report.limits) {
		const { used, limit: cap, remaining } = limit.amount;
		if (cap === undefined) {
			lines.push(`${limit.label.padEnd(16)}  $${(remaining ?? 0).toFixed(2)} left`);
			continue;
		}
		const reset = limit.window?.resetsAt
			? `    ${limit.status === "exhausted" ? "exceeded, reset" : "reset"} ${new Date(
					limit.window.resetsAt,
				).toLocaleString("en-US", {
					month: "short",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit",
					hour12: false,
				})}`
			: "";
		const cap$ = Number.isInteger(cap) ? `$${cap}` : `$${cap.toFixed(2)}`;
		lines.push(`${limit.label.padEnd(16)}  $${(used ?? 0).toFixed(2)} / ${cap$}${reset}`);
	}
	for (const note of report.notes ?? []) lines.push(note);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi) {
	let timer;
	let widgetCtx;
	let visible = false;
	let generation = 0;
	let lastCheck = { key: undefined, at: 0 };

	const paint = (kind, text) => (widgetCtx?.ui?.theme?.fg ? widgetCtx.ui.theme.fg(kind, text) : text);
	const debug = (message) => pi.logger?.debug?.(`commandcode keys: ${message}`);

	/** Index of `key` in the stored pool (1-based), for the `#n/m` label. */
	function keyIndex(ctx, key) {
		if (!key) return undefined;
		const keys = storedKeys(ctx);
		if (keys.length < 2) return undefined;
		const index = keys.findIndex((entry) => entry.key === key);
		return index === -1 ? undefined : { index: index + 1, total: keys.length };
	}

	/**
	 * Parks keys whose quota is spent so the next request picks one that has
	 * room. Cheap when the pool has a single key or was just checked, so it can
	 * run before every provider request.
	 */
	async function enforceQuota(ctx, { force = false } = {}) {
		if (storedKeys(ctx).length === 0) return undefined;
		const active = await activeKey(ctx);
		if (!active) return undefined;
		if (!force && active === lastCheck.key && Date.now() - lastCheck.at < REFRESH_MS) return undefined;
		lastCheck = { key: active, at: Date.now() };
		return ensureUsableKey(ctx, debug);
	}

	async function refresh(ctx) {
		if (ctx) widgetCtx = ctx;
		if (!widgetCtx?.hasUI) return;
		if (widgetCtx.model?.provider !== PROVIDER) {
			generation += 1;
			if (visible) {
				widgetCtx.ui.setWidget(WIDGET_ID, undefined);
				visible = false;
			}
			return;
		}
		const mine = ++generation;

		// Park every key whose quota is spent before drawing, so the bar shows the
		// key omp will actually use next.
		const { active, usage, parked, total } = (await enforceQuota(widgetCtx, { force: true })) ??
			(await ensureUsableKey(widgetCtx, debug));
		if (mine !== generation) return;

		if (!active && parked.length > 0) {
			const next = parked.reduce((earliest, entry) => (entry.resetAt < earliest.resetAt ? entry : earliest));
			const reasons = [...new Set(parked.map((entry) => entry.reason))].join(", ");
			widgetCtx.ui.setWidget(
				WIDGET_ID,
				[`All ${total} Command Code keys are quota-limited · ${reasons}; next reset ${formatReset(next.resetAt)}`],
				{ placement: "belowEditor" },
			);
			visible = true;
			return;
		}

		const resolved = usage?.report ? usage : active ? await loadUsage(active) : undefined;
		if (!resolved?.report || mine !== generation) return;
		const line = formatQuotaBar(resolved.report, paint);
		if (!line || !widgetCtx.hasUI) return;
		const position = keyIndex(widgetCtx, active);
		widgetCtx.ui.setWidget(WIDGET_ID, [position ? `#${position.index}/${position.total} ${line}` : line], {
			placement: "belowEditor",
		});
		visible = true;
	}

	pi.registerProvider(PROVIDER, {
		// No `models`, no `streamSimple`, no `baseUrl`: the bundled provider keeps
		// its catalog, KDL pricing, and routing; this only attaches usage.
		usage: {
			id: PROVIDER,
			validatesCredentials: true,
			async fetchUsage(params, ctx) {
				const apiKey = params.credential?.apiKey ?? params.credential?.accessToken;
				if (!apiKey) return null;
				const { report, error } = await loadUsage(apiKey, params.signal);
				if (!report) ctx?.logger?.warn?.(`commandcode usage: ${error}`);
				return report ?? null;
			},
		},
	});

	pi.registerCommand("cc-usage", {
		description: "Show Command Code plan credits and usage limits",
		async handler(_args, ctx) {
			const { active, parked, total } = await ensureUsableKey(ctx, debug);
			const apiKey = active ?? (await activeKey(ctx));
			if (!apiKey) {
				ctx.ui.notify(
					"No Command Code credential. Run /login commandcode, or set COMMAND_CODE_API_KEY.",
					"error",
				);
				return;
			}
			const { report, error } = await loadUsage(apiKey);
			if (!report) {
				ctx.ui.notify(`Command Code billing request failed: ${error}.`, "error");
				return;
			}
			const position = keyIndex(ctx, apiKey);
			const lines = [formatReport(report)];
			if (position) lines.push(`Key               #${position.index}/${position.total}  ${mask(apiKey)}`);
			if (parked.length > 0) {
				lines.push(
					`Parked            ${parked.map((entry) => `${mask(entry.key)} (${entry.reason}, reset ${formatReset(entry.resetAt)})`).join(", ")}`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("cc-keys", {
		description: "List, add, or remove Command Code API keys used for quota failover",
		async handler(args, ctx) {
			const storage = authStore(ctx);
			if (!storage) {
				ctx.ui.notify("This omp build does not expose credential storage to extensions.", "error");
				return;
			}
			const [subcommand, ...rest] = String(args ?? "").trim().split(/\s+/);
			const keys = storedKeys(ctx);
			const active = await activeKey(ctx);

			if (subcommand === "add") {
				const key = rest.join("").trim();
				if (!key) {
					ctx.ui.notify("Usage: /cc-keys add user_...", "error");
					return;
				}
				if (keys.some((entry) => entry.key === key)) {
					ctx.ui.notify(`Key ${mask(key)} is already stored.`, "info");
					return;
				}
				await storage.set(PROVIDER, [
					...storage.listStoredCredentials(PROVIDER).map((row) => row.credential),
					{ type: "api_key", key, source: "login" },
				]);
				await storage.reload?.();
				ctx.ui.notify(`Added Command Code key ${mask(key)}.`, "info");
				return;
			}

			if (subcommand === "remove") {
				const target = rest[0] ?? "";
				const index = /^\d+$/.test(target) ? Number(target) : Number.NaN;
				const entry = keys[index - 1];
				if (!entry) {
					ctx.ui.notify(`Usage: /cc-keys remove <1-${keys.length}>`, "error");
					return;
				}
				await storage.removeCredential(PROVIDER, entry.id);
				await storage.reload?.();
				ctx.ui.notify(`Removed Command Code key ${mask(entry.key)}.`, "info");
				return;
			}

			const lines = [`Command Code keys  ${keys.length}${keys.length ? `  (active: #${keys.findIndex((entry) => entry.key === active) + 1 || "-"})` : ""}`];
			keys.forEach((entry, index) => {
				const state = entry.key === active ? "in use" : "ready";
				lines.push(
					`${entry.key === active ? "→" : " "} ${index + 1}  ${mask(entry.key).padEnd(20)} ${state}`,
				);
			});
			const envKey = process.env.COMMAND_CODE_API_KEY || process.env.COMMANDCODE_API_KEY;
			if (keys.length === 0 && envKey) {
				lines.push("Only the environment key is configured; /cc-keys needs stored keys.");
			}
			lines.push("Add: /cc-keys add user_...   Remove: /cc-keys remove <n>");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// Park spent keys before omp resolves the credential for a turn or request.
	pi.on("before_agent_start", async (_event, ctx) => {
		await enforceQuota(ctx);
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		if (ctx?.model?.provider !== PROVIDER) return;
		await enforceQuota(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		clearInterval(timer);
		await enforceQuota(ctx, { force: true });
		const tick = () => void refresh();
		timer = typeof ctx?.setInterval === "function" ? ctx.setInterval(tick, REFRESH_MS) : setInterval(tick, REFRESH_MS);
		timer?.unref?.();
		await refresh(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await refresh(ctx);
	});

	// A quota rejection that still reached the gateway: park that key so the next
	// request (and any retry that re-resolves credentials) uses a sibling.
	pi.on("auto_retry_start", async (event, ctx) => {
		widgetCtx = ctx ?? widgetCtx;
		const message = String(event?.errorMessage ?? "");
		if (!/quota|credit|insufficient|exceed|balance|limit/i.test(message)) return;
		const key = await activeKey(ctx);
		if (!key) return;
		const usage = await loadUsage(key);
		const exhaustion = usage.credits
			? exhaustionFrom(usage.credits, usage.subscription)
			: { resetAt: Date.now() + 60_000, reason: "rate limited" };
		await parkKey(ctx, key, exhaustion.resetAt, exhaustion.reason, debug);
	});

	pi.on("session_shutdown", () => {
		const clear = widgetCtx?.clearTimer;
		if (timer) {
			if (typeof clear === "function") clear.call(widgetCtx, timer);
			else clearInterval(timer);
		}
		timer = undefined;
		widgetCtx = undefined;
		visible = false;
		lastCheck = { key: undefined, at: 0 };
		generation += 1;
	});
}
