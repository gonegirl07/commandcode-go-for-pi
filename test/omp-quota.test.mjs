import assert from "node:assert/strict";
import test from "node:test";

import { exhaustionFrom, parseCredits, parseSubscription } from "../omp/commandcode-quota.ts";

const HOUR = 60 * 60 * 1000;

function credits({ fiveHour, weekly, monthlyCredits = 62.5, purchasedCredits = 0, freeCredits = 0 }) {
	return parseCredits({
		credits: { monthlyCredits, purchasedCredits, freeCredits, belowThreshold: false },
		windowLimits: { limited: true, fiveHour, weekly },
	});
}

test("parks a key until the last exhausted window resets", () => {
	const now = Date.UTC(2026, 8, 16, 12, 0);
	const snapshot = credits({
		fiveHour: { used: 12, cap: 10, exceeded: true, resetAt: now + HOUR },
		weekly: { used: 40, cap: 40, exceeded: true, resetAt: now + 3 * 24 * HOUR },
	});

	assert.deepEqual(exhaustionFrom(snapshot, undefined, now), {
		resetAt: now + 3 * 24 * HOUR,
		reason: "5h+weekly",
	});
});

test("leaves a key alone while any window still has room", () => {
	const now = Date.UTC(2026, 8, 16, 12, 0);
	const snapshot = credits({
		fiveHour: { used: 9.5, cap: 10, exceeded: false, resetAt: now + HOUR },
		weekly: { used: 4, cap: 40, exceeded: false, resetAt: now + 3 * 24 * HOUR },
	});

	assert.equal(exhaustionFrom(snapshot, undefined, now), undefined);
});

test("parks a spent monthly balance until the subscription period ends", () => {
	const now = Date.UTC(2026, 8, 16, 12, 0);
	const spent = credits({ monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0 });
	const subscription = parseSubscription({
		data: { planId: "individual-goat", status: "active", currentPeriodEnd: "2026-09-30T00:00:00.000Z" },
	});

	assert.deepEqual(exhaustionFrom(spent, subscription, now), {
		resetAt: Date.parse("2026-09-30T00:00:00.000Z"),
		reason: "monthly",
	});
	assert.deepEqual(exhaustionFrom(spent, undefined, now), { resetAt: now + 6 * HOUR, reason: "monthly" });
	assert.equal(
		exhaustionFrom(credits({ monthlyCredits: 0, purchasedCredits: 5 }), subscription, now),
		undefined,
	);
});
