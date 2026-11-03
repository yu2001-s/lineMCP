import assert from "node:assert/strict";
import { test } from "node:test";
import { latestReads } from "./line.ts";

const me = "u" + "0".repeat(32);
const amy = "u" + "a".repeat(32);
const bob = "u" + "b".repeat(32);

test("each member's newest read message, in any number format", () => {
	const reads = latestReads({
		[amy]: [
			{ startMessageId: 1n, endMessageId: 634800000000000001n, startTime: 0, endTime: 0 },
			{ startMessageId: 1n, endMessageId: 634900000000000002n, startTime: 0, endTime: 0 },
		],
		[bob]: [{ endMessageId: "634800000000000001" }],
		[me]: [{ endMessageId: 634999999999999999n }],
	}, me);
	assert.deepEqual(reads, { [amy]: "634900000000000002", [bob]: "634800000000000001" });
});

test("the undecoded shape LINE actually returns", () => {
	// As logged from the live server: ranges keyed "0", "1", fields by number.
	const reads = latestReads({
		[amy]: {
			0: { 1: 11293873840223, 2: 12100000000001, 3: 1579592196841, 4: 1591525593859 },
			1: { 1: 463100000000000001n, 2: 463100000000000001n, 3: 1688882120796, 4: 1688882120796 },
			2: { 1: 472756522804838852n, 2: 634900000000000001n, 3: 1694616484304, 4: 1791271585586 },
		},
		[bob]: {},
		[me]: { 0: { 1: 1, 2: 634999999999999999n, 3: 1, 4: 1 } },
	}, me);
	assert.deepEqual(reads, { [amy]: "634900000000000001" });
});

test("members with nothing read, or odd entries, are left out", () => {
	assert.deepEqual(latestReads({ [amy]: [], [bob]: [{}], c: { 0: { 2: 0 } }, d: null, e: 5 }), {});
});
