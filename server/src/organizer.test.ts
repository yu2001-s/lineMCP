import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Organizer, OrganizerInputError } from "./organizer.ts";

const amy = "u" + "a".repeat(32);
const bob = "u" + "b".repeat(32);
const team = "c" + "c".repeat(32);
const work = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const family = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const path = () => join(mkdtempSync(join(tmpdir(), "line-organizer-")), "organizer.json");

test("starts empty, then keeps what the client saved across restarts", () => {
	const file = path();
	assert.deepEqual(new Organizer(file).state(), { folders: [], hidden: [], tags: [], rev: 0, updated_ms: 0 });
	new Organizer(file).replace({
		folders: [{ id: work, name: " Work ", chat_ids: [amy, team] }],
		hidden: [{ chat_id: bob, name: "Bob" }],
	});
	assert.equal(statSync(file).mode & 0o777, 0o600);
	const reloaded = new Organizer(file);
	assert.equal(reloaded.folderOf(amy)?.name, "Work");
	assert.equal(reloaded.folderOf(bob), undefined);
	assert.ok(reloaded.isHidden(bob));
	assert.ok(!reloaded.isHidden(amy));
	assert.ok(reloaded.state().updated_ms > 0);
});

test("folders are found by name regardless of case and Chinese script", () => {
	const o = new Organizer(path());
	o.replace({ folders: [{ id: work, name: "Work", chat_ids: [] }, { id: family, name: "家人們", chat_ids: [] }], hidden: [] });
	assert.equal(o.folderNamed("work")?.id, work);
	assert.equal(o.folderNamed(" 家人们 ")?.id, family);
	assert.equal(o.folderNamed("Wor"), undefined);
});

test("a chat filed twice stays in the first folder", () => {
	const o = new Organizer(path());
	const saved = o.replace({
		folders: [{ id: work, name: "Work", chat_ids: [amy, amy] }, { id: family, name: "家人", chat_ids: [amy, bob] }],
		hidden: [{ chat_id: bob, name: "Bob" }, { chat_id: bob, name: "Bob again" }],
	});
	assert.deepEqual(saved.folders.map((f) => f.chat_ids), [[amy], [bob]]);
	assert.equal(saved.hidden.length, 1);
});

test("bad bodies are rejected and change nothing", () => {
	const o = new Organizer(path());
	o.replace({ folders: [{ id: work, name: "Work", chat_ids: [amy] }], hidden: [] });
	for (const body of [
		null,
		{ folders: [] },
		{ folders: [{ id: "not-a-uuid", name: "x", chat_ids: [] }], hidden: [] },
		{ folders: [{ id: work, name: "  ", chat_ids: [] }], hidden: [] },
		{ folders: [{ id: work, name: "x", chat_ids: ["../etc"] }], hidden: [] },
		{ folders: [], hidden: [{ chat_id: 5 }] },
	]) {
		assert.throws(() => o.replace(body), OrganizerInputError);
	}
	assert.equal(o.folderOf(amy)?.name, "Work");
});

test("the MCP tools filter by folder and leave hidden chats alone", async () => {
	process.env.LINE_MCP_STATE_DIR = mkdtempSync(join(tmpdir(), "line-mcp-"));
	const { buildMcpServer } = await import("./mcp.ts");
	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

	const recent = [amy, bob, team].map((id) => ({ chat_id: id, name: id.slice(0, 3), type: "user", unread: 0 }));
	const sent: string[] = [];
	const line = {
		listChats: async (opts: { limit: number; include?: (id: string) => boolean }) =>
			recent.filter((c) => opts.include?.(c.chat_id) ?? true).slice(0, opts.limit),
		chatNames: async (ids: string[]) => new Map(ids.map((id) => [id, `name of ${id.slice(0, 3)}`])),
		searchContacts: async () => [{ id: amy, name: "Amy", type: "user" }, { id: bob, name: "Bob", type: "user" }],
		readMessages: async () => ({ messages: [] }),
		sendMessage: async (opts: { chatId: string }) => {
			sent.push(opts.chatId);
			return { message_id: "1" };
		},
	};
	const organizer = new Organizer(join(process.env.LINE_MCP_STATE_DIR, "organizer.json"));
	const server = buildMcpServer(line as never, {} as never, {} as never, organizer, {} as never, {} as never);
	const client = new Client({ name: "test", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args });
		const text = (result.content as { text: string }[])[0].text;
		return { error: result.isError === true, text, json: () => JSON.parse(text) };
	};

	assert.match((await call("line_list_folders")).text, /has no folders yet/);
	assert.equal((await call("line_list_chats", { folder: "Work" })).error, true);

	organizer.replace({
		folders: [{ id: work, name: "Work", chat_ids: [amy, bob] }, { id: family, name: "家人", chat_ids: [team] }],
		hidden: [{ chat_id: bob, name: "Bob" }],
	});

	const all = (await call("line_list_chats")).json();
	assert.deepEqual(all.map((c: { chat_id: string; folder?: string }) => [c.chat_id, c.folder]), [[amy, "Work"], [team, "家人"]]);
	const inWork = (await call("line_list_chats", { folder: "work", limit: 1 })).json();
	assert.deepEqual(inWork.map((c: { chat_id: string }) => c.chat_id), [amy]);
	const unknown = await call("line_list_chats", { folder: "Gym" });
	assert.ok(unknown.error);
	assert.match(unknown.text, /Work, 家人/);

	const folders = (await call("line_list_folders")).json();
	assert.deepEqual(folders.folders[0], { name: "Work", chats: [{ chat_id: amy, name: `name of ${amy.slice(0, 3)}`, type: "user" }] });
	assert.ok(folders.updated);

	assert.deepEqual((await call("line_search_contacts", { query: "b" })).json().map((c: { id: string }) => c.id), [amy]);
	for (const [name, args] of [
		["line_read_messages", { chat_id: bob }],
		["line_send_message", { chat_id: bob, text: "hi" }],
		["line_read_archive", { chat_id: bob }],
		["line_forward_media", { from_chat_id: amy, message_id: "1", to_chat_id: bob }],
	] as const) {
		const refused = await call(name, args);
		assert.ok(refused.error, name);
		assert.match(refused.text, /hid this chat/);
	}
	assert.deepEqual(sent, []);
	assert.equal((await call("line_read_messages", { chat_id: amy })).error, false);
	await client.close();
});
