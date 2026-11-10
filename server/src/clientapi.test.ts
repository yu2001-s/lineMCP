import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Organizer } from "./organizer.ts";

const key = "k".repeat(32);
process.env.LINE_MCP_STATE_DIR = mkdtempSync(join(tmpdir(), "line-client-"));
process.env.LINE_CLIENT_HOST = "127.0.0.1";
process.env.LINE_CLIENT_PORT = "0";
process.env.LINE_CLIENT_KEY = key;

const amy = "u" + "a".repeat(32);
const work = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

test("the desktop changes tags with ops, and its saves of hidden chats keep them", async () => {
	const { startClientApi } = await import("./clientapi.ts");
	const organizer = new Organizer(join(process.env.LINE_MCP_STATE_DIR!, "organizer.json"));
	const server = startClientApi({} as never, {} as never, {} as never, organizer);
	await new Promise((resolve) => server.once("listening", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const send = async (method: string, path: string, body?: unknown) => {
		const res = await fetch(base + path, {
			method,
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: res.status, body: await res.json() };
	};
	try {
		const tagged = await send("POST", "/api/organizer/tags", {
			ops: [{ id: "0B9E1C55-3A1D-4C1E-9F57-2B6D4E1A8C3F", op: "add", tags: ["讀書會"], chat_ids: [amy] }, { op: "rename", tags: ["讀書會"], to: "讀書會幹部" }],
		});
		assert.equal(tagged.status, 200);
		assert.deepEqual(tagged.body.tags, [{ chat_id: amy, tags: ["讀書會幹部"] }]);
		assert.equal(tagged.body.rev, 1);

		// An app from before tags replaced folders still sends folders; they are ignored.
		const saved = await send("PUT", "/api/organizer", { folders: [{ id: work, name: "Work", chat_ids: [amy] }], hidden: [], base_rev: 1 });
		assert.deepEqual(saved.body.tags, [{ chat_id: amy, tags: ["讀書會幹部"] }]);
		assert.deepEqual(saved.body.folders, [], "an empty list, so such an app drops its folders");
		assert.equal(saved.body.rev, 2);
		assert.deepEqual((await send("GET", "/api/organizer")).body, saved.body);

		const bad = await send("POST", "/api/organizer/tags", { ops: [{ op: "add", tags: [""], chat_ids: [amy] }] });
		assert.equal(bad.status, 400);
		assert.match(bad.body.error, /a tag must be/);
		assert.equal((await send("POST", "/api/organizer/tags", {})).status, 400);
	} finally {
		server.close();
	}
});
