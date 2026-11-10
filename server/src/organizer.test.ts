import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Organizer, OrganizerInputError } from "./organizer.ts";

const amy = "u" + "a".repeat(32);
const bob = "u" + "b".repeat(32);
const team = "c" + "c".repeat(32);
const cat = "u" + "d".repeat(32);
const gym = "11111111-2222-4333-8444-555555555555";
const work = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const family = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const path = () => join(mkdtempSync(join(tmpdir(), "line-organizer-")), "organizer.json");

test("starts empty, then keeps what the client saved across restarts", () => {
	const file = path();
	assert.deepEqual(new Organizer(file).state(), { hidden: [], tags: [], rev: 0, updated_ms: 0 });
	new Organizer(file).replace({ hidden: [{ chat_id: bob, name: "Bob" }] });
	assert.equal(statSync(file).mode & 0o777, 0o600);
	const reloaded = new Organizer(file);
	assert.ok(reloaded.isHidden(bob));
	assert.ok(!reloaded.isHidden(amy));
	assert.ok(reloaded.state().updated_ms > 0);
});

test("folders in a file from before tags become tags, keeping every chat's other tags", () => {
	const file = path();
	writeFileSync(file, JSON.stringify({
		folders: [
			{ id: work, name: "Work", chat_ids: [amy, team] },
			{ id: family, name: " 家人 ", chat_ids: [bob] },
			{ id: gym, name: "Empty", chat_ids: [] },
		],
		hidden: [{ chat_id: cat, name: "Cat" }],
		tags: [{ chat_id: amy, tags: ["讀書會"] }, { chat_id: cat, tags: ["work"] }],
		rev: 14,
		updated_ms: 5,
		folder_ops: [{ rev: 6, op: { op: "move", chat_ids: [amy], folder_id: work } }],
	}));
	const o = new Organizer(file);
	assert.deepEqual(o.state().tags, [
		{ chat_id: amy, tags: ["work", "讀書會"] },
		{ chat_id: bob, tags: ["家人"] },
		{ chat_id: team, tags: ["work"] },
		{ chat_id: cat, tags: ["work"] },
	].sort((a, b) => a.chat_id.localeCompare(b.chat_id)), "an existing tag of the same name is that tag, as spelled");
	assert.ok(o.isHidden(cat));
	assert.ok(o.state().rev > 14);
	assert.deepEqual([...o.migratedFolders], [[work, "Work"], [family, "家人"], [gym, "Empty"]]);
	const stored = JSON.parse(readFileSync(file, "utf-8"));
	assert.equal("folders" in stored, false);
	assert.equal("folder_ops" in stored, false);
	const again = new Organizer(file);
	assert.equal(again.migratedFolders.size, 0, "it happens once");
	assert.deepEqual(again.state(), o.state());
});

test("a chat hidden twice is listed once", () => {
	const o = new Organizer(path());
	const saved = o.replace({ hidden: [{ chat_id: bob, name: "Bob" }, { chat_id: bob, name: "Bob again" }] });
	assert.equal(saved.hidden.length, 1);
});

test("an older app's folders are ignored; bad bodies are rejected and change nothing", () => {
	const o = new Organizer(path());
	const saved = o.replace({ folders: [{ id: work, name: "Work", chat_ids: [amy] }], hidden: [{ chat_id: bob, name: "Bob" }] });
	assert.deepEqual(Object.keys(saved).sort(), ["hidden", "rev", "tags", "updated_ms"]);
	assert.deepEqual(saved.tags, []);
	for (const body of [null, { folders: [] }, { hidden: [{ chat_id: 5 }] }, { hidden: [{ chat_id: "../etc" }] }]) {
		assert.throws(() => o.replace(body), OrganizerInputError);
	}
	assert.ok(o.isHidden(bob));
});

test("a save from a Mac that had not seen an agent's hide keeps it", () => {
	const file = path();
	const o = new Organizer(file);
	const synced = o.replace({ hidden: [] });
	o.hide([{ chat_id: cat, name: "Cat" }]);
	// The Mac, offline meanwhile, hid bob.
	const saved = o.replace({ hidden: [{ chat_id: bob, name: "Bob" }] }, synced.rev);
	assert.deepEqual(saved.hidden.map((h) => h.chat_id), [bob, cat]);
	// A Mac that has seen everything saves as it is: the owner's unhide sticks.
	assert.deepEqual(o.replace({ hidden: [{ chat_id: bob, name: "Bob" }] }, saved.rev).hidden.map((h) => h.chat_id), [bob]);
	assert.equal(JSON.parse(readFileSync(file, "utf-8")).hide_ops.length, 1);
	assert.equal("hide_ops" in new Organizer(file).state(), false, "clients never see the log");
});

test("the MCP tools filter by tag and leave hidden chats alone", async () => {
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

	assert.match((await call("line_list_tags")).text, /No chats are tagged yet/);
	assert.equal((await call("line_list_chats", { tags: ["Work"] })).error, true);
	for (const gone of ["line_list_folders", "line_folder_move", "line_folder_edit", "line_folder_delete"]) {
		assert.ok((await client.listTools()).tools.every((t) => t.name !== gone), gone);
	}

	organizer.addTags([amy, bob], ["Work"]);
	organizer.addTags([team, amy], ["家人"]);
	organizer.replace({ hidden: [{ chat_id: bob, name: "Bob" }] });

	const all = (await call("line_list_chats")).json();
	assert.deepEqual(all.map((c: { chat_id: string; tags?: string[] }) => [c.chat_id, c.tags]), [[amy, ["Work", "家人"]], [team, ["家人"]]]);
	assert.equal("folder" in all[0], false);
	const inWork = (await call("line_list_chats", { tags: ["work"], limit: 5 })).json();
	assert.deepEqual(inWork.map((c: { chat_id: string }) => c.chat_id), [amy]);
	const unknown = await call("line_list_chats", { tags: ["Gym"] });
	assert.ok(unknown.error);
	assert.match(unknown.text, /Work, 家人/);

	const tags = (await call("line_list_tags")).json();
	assert.deepEqual(tags.tags[0], { name: "Work", chats: [{ chat_id: amy, name: `name of ${amy.slice(0, 3)}`, type: "user" }] });

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
