import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { AUTH_TOKEN_KEY } from "./config.ts";
import { LineService } from "./line.ts";
import { AtomicFileStorage } from "./storage.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a login that fails at boot keeps retrying until it succeeds", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const storage = new AtomicFileStorage(join(mkdtempSync(join(tmpdir(), "line-mcp-")), "storage.json"));
	await storage.set(AUTH_TOKEN_KEY, "token");
	const line = new LineService(storage);

	let attempts = 0;
	line.base.loginProcess.login = mock.fn(async () => {
		attempts++;
		if (attempts < 3) throw new Error("fetch failed");
	}) as unknown as typeof line.base.loginProcess.login;
	// The push stream starts once the session is ready; keep it idle.
	line.base.createPolling = (() => ({
		listenTalkEvents: () => new ReadableStream(),
	})) as unknown as typeof line.base.createPolling;

	await line.start();
	assert.equal(line.status, "error");
	assert.equal(attempts, 1);

	t.mock.timers.tick(30_000);
	await settle();
	assert.equal(line.status, "error");
	assert.equal(attempts, 2);

	t.mock.timers.tick(30_000);
	await settle();
	assert.equal(line.status, "ready");
	assert.equal(attempts, 3);

	t.mock.timers.tick(60_000);
	await settle();
	assert.equal(attempts, 3, "no retries once the session is ready");
	line.status = "logged_out"; // ends the idle push loop
});
