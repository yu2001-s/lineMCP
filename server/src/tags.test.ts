import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Organizer, OrganizerInputError } from "./organizer.ts";

const amy = "u" + "a".repeat(32);
const bob = "u" + "b".repeat(32);
const cat = "u" + "d".repeat(32);
const team = "c" + "c".repeat(32);
const path = () => join(mkdtempSync(join(tmpdir(), "line-tags-")), "organizer.json");

test("a chat can have several tags, kept across restarts", () => {
	const file = path();
	const o = new Organizer(file);
	o.addTags([amy, team], ["讀書會", " 羽球 "]);
	o.addTags([bob], ["同事"]);
	assert.deepEqual(o.tagsOf(amy), ["羽球", "讀書會"].sort((a, b) => a.localeCompare(b)));
	assert.deepEqual(o.tagsOf(cat), []);
	const reloaded = new Organizer(file);
	assert.deepEqual(reloaded.tagsOf(team), o.tagsOf(amy));
	assert.deepEqual(
		reloaded.tagList().map((t) => [t.name, t.chat_ids]),
		[["羽球", [team, amy]], ["讀書會", [team, amy]], ["同事", [bob]]].sort((a, b) => (a[0] as string).localeCompare(b[0] as string)),
	);
});

test("names differing only in case or Chinese script are the same tag, spelled as it first was", () => {
	const o = new Organizer(path());
	o.addTags([amy], ["讀書會", "Book Club"]);
	o.addTags([bob], ["读书会", "book  club"]);
	assert.deepEqual(o.tagsOf(bob), o.tagsOf(amy));
	assert.equal(o.tagNamed("读书会"), "讀書會");
	assert.equal(o.tagNamed("BOOK CLUB"), "Book Club");
	assert.equal(o.tagNamed("Book"), undefined);
	o.removeTags([amy, bob], ["book club"]);
	assert.deepEqual(o.tagsOf(bob), ["讀書會"]);
	o.addTags([amy], ["讀書會", "读书会"]);
	assert.deepEqual(o.tagsOf(amy), ["讀書會"], "the same tag twice in one add is added once");
});

test("removing a chat's last tag drops it, and a tag no chat has disappears", () => {
	const o = new Organizer(path());
	o.addTags([amy, bob], ["讀書會"]);
	o.removeTags([amy], ["讀書會", "同事"]);
	assert.deepEqual(o.state().tags, [{ chat_id: bob, tags: ["讀書會"] }]);
	o.removeTags([bob], ["讀書會"]);
	assert.deepEqual(o.state().tags, []);
	assert.deepEqual(o.tagList(), []);
});

test("rename respells a tag or merges it into another; delete takes it off every chat", () => {
	const o = new Organizer(path());
	o.addTags([amy, bob], ["book club"]);
	o.addTags([bob, cat], ["讀書會"]);
	o.changeTags([{ op: "rename", tags: ["BOOK CLUB"], to: "Book Club" }]);
	assert.deepEqual(o.tagsOf(amy), ["Book Club"]);
	o.changeTags([{ op: "rename", tags: ["book club"], to: "读书会" }]);
	assert.deepEqual([o.tagsOf(amy), o.tagsOf(bob), o.tagsOf(cat)], [["讀書會"], ["讀書會"], ["讀書會"]]);
	o.changeTags([{ op: "rename", tags: ["nobody has this"], to: "x" }]);
	assert.deepEqual(o.tagList().map((t) => t.name), ["讀書會"]);
	o.changeTags([{ op: "delete", tags: ["读书会"] }]);
	assert.deepEqual(o.state().tags, []);
});

test("a desktop save of hidden chats leaves tags an agent just added", () => {
	const o = new Organizer(path());
	const events: number[] = [];
	o.onChange = () => events.push(o.state().rev);
	o.replace({ hidden: [] });
	// An agent tags a chat; the desktop then saves its (tag-less) copy.
	o.addTags([amy, bob], ["讀書會"]);
	o.replace({ hidden: [{ chat_id: cat, name: "Cat" }], tags: [] });
	assert.deepEqual(o.tagsOf(bob), ["讀書會"]);
	assert.ok(o.isHidden(cat));
	assert.deepEqual(events, [1, 2, 3], "every change, from either side, bumps rev and notifies");
});

test("renaming a tag reports its old and new spelling", () => {
	const o = new Organizer(path());
	const renames: string[][] = [];
	o.onTagRename = (from, to) => renames.push([from, to]);
	o.addTags([amy], ["Work"]);
	o.addTags([bob], ["Office"]);
	o.changeTags([{ op: "rename", tags: ["work"], to: "office" }, { op: "rename", tags: ["nobody"], to: "x" }]);
	assert.deepEqual(renames, [["Work", "Office"]]);
	assert.deepEqual(o.tagsOf(amy), ["Office"]);
});

test("ops from a desktop that was offline apply on top of what agents did meanwhile", () => {
	const o = new Organizer(path());
	o.addTags([amy], ["讀書會"]);
	// Meanwhile, an agent tags bob and removes amy's tag.
	o.addTags([bob], ["同事"]);
	o.removeTags([amy], ["讀書會"]);
	// The desktop comes back with what it did offline: amy gets 羽球, cat gets 讀書會.
	o.changeTags([
		{ op: "add", tags: ["羽球"], chat_ids: [amy] },
		{ op: "add", tags: ["讀書會"], chat_ids: [cat] },
	]);
	assert.deepEqual([o.tagsOf(amy), o.tagsOf(bob), o.tagsOf(cat)], [["羽球"], ["同事"], ["讀書會"]]);
	// Sending the same ops again (a lost response) changes nothing.
	const before = o.state().tags;
	o.changeTags([{ op: "add", tags: ["羽球"], chat_ids: [amy] }, { op: "add", tags: ["讀書會"], chat_ids: [cat] }]);
	assert.deepEqual(o.state().tags, before);
});

test("bad tag changes are rejected and change nothing", () => {
	const o = new Organizer(path());
	o.addTags([amy], ["讀書會"]);
	const rev = o.state().rev;
	for (const ops of [
		undefined,
		[],
		[{ op: "tag", tags: ["x"], chat_ids: [amy] }],
		[{ op: "add", tags: [], chat_ids: [amy] }],
		[{ op: "add", tags: ["   "], chat_ids: [amy] }],
		[{ op: "add", tags: ["x".repeat(41)], chat_ids: [amy] }],
		[{ op: "add", tags: ["a\u0000b"], chat_ids: [amy] }],
		[{ op: "add", tags: ["x"], chat_ids: ["../etc"] }],
		[{ op: "add", tags: ["x"] }],
		[{ op: "rename", tags: ["讀書會", "同事"], to: "x" }],
		[{ op: "rename", tags: ["讀書會"] }],
		// The first op is fine; the second fails, so neither applies.
		[{ op: "add", tags: ["ok"], chat_ids: [bob] }, { op: "add", tags: Array.from({ length: 30 }, (_, i) => `t${i}`), chat_ids: [bob] }],
	]) {
		assert.throws(() => o.changeTags(ops), OrganizerInputError, JSON.stringify(ops));
	}
	assert.deepEqual(o.state().tags, [{ chat_id: amy, tags: ["讀書會"] }]);
	assert.equal(o.state().rev, rev);
	const many = Array.from({ length: 30 }, (_, i) => `t${i}`);
	o.addTags([bob], many);
	assert.throws(() => o.addTags([bob], ["one more"]), /at most 30 tags/);
	o.addTags([cat], ["a\n  b"]);
	assert.deepEqual(o.tagsOf(cat), ["a b"], "line breaks and runs of spaces become one space");
});

test("a file saved before tags existed loads with none", () => {
	const file = path();
	writeFileSync(file, JSON.stringify({ hidden: [], updated_ms: 5 }));
	const o = new Organizer(file);
	assert.deepEqual(o.state().tags, []);
	assert.equal(o.state().rev, 0);
	assert.deepEqual(o.tagsOf(amy), []);
	o.addTags([amy], ["讀書會"]);
	const saved = JSON.parse(readFileSync(file, "utf-8"));
	assert.equal(saved.updated_ms, 5, "tag changes do not count as a desktop save");
	assert.equal(saved.rev, 1);
});

test("the MCP tools list, add, remove and filter by tags, and leave hidden chats alone", async () => {
	process.env.LINE_MCP_STATE_DIR = mkdtempSync(join(tmpdir(), "line-mcp-"));
	const { buildMcpServer } = await import("./mcp.ts");
	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

	const recent = [amy, bob, cat, team].map((id) => ({ chat_id: id, name: id.slice(0, 3), type: "user", unread: 0 }));
	const searched: unknown[] = [];
	const line = {
		listChats: async (opts: { limit: number; include?: (id: string) => boolean }) =>
			recent.filter((c) => opts.include?.(c.chat_id) ?? true).slice(0, opts.limit),
		chatNames: async (ids: string[]) => new Map(ids.map((id) => [id, `name of ${id.slice(0, 3)}`])),
	};
	const archive = {
		search: (_q: string, opts: unknown) => {
			searched.push(opts);
			return [];
		},
	};
	const organizer = new Organizer(join(process.env.LINE_MCP_STATE_DIR, "organizer.json"));
	const server = buildMcpServer(line as never, archive as never, {} as never, organizer, {} as never, {} as never);
	const client = new Client({ name: "test", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args });
		const text = (result.content as { text: string }[])[0].text;
		return { error: result.isError === true, text, json: () => JSON.parse(text) };
	};
	const ids = (list: { chat_id: string }[]) => list.map((c) => c.chat_id);

	const instructions = client.getInstructions() ?? "";
	assert.match(instructions, /line_list_tags/);

	assert.match((await call("line_list_tags")).text, /No chats are tagged yet/);
	assert.match((await call("line_list_chats", { tags: ["讀書會"] })).text, /No chats are tagged yet/);

	const added = (await call("line_tag_add", { chat_ids: [amy, bob, amy], tags: ["讀書會"] })).json();
	assert.deepEqual(added.chats, [
		{ chat_id: amy, name: `name of ${amy.slice(0, 3)}`, tags: ["讀書會"] },
		{ chat_id: bob, name: `name of ${bob.slice(0, 3)}`, tags: ["讀書會"] },
	]);
	await call("line_tag_add", { chat_ids: [bob, cat], tags: ["羽球"] });
	await call("line_tag_add", { chat_ids: [team], tags: ["同事"] });

	// Hiding bob and team: they leave every listing, and a tag only hidden chats have disappears.
	organizer.replace({ folders: [], hidden: [{ chat_id: bob, name: "Bob" }, { chat_id: team, name: "Team" }] });
	const listed = (await call("line_list_tags")).json();
	assert.deepEqual(listed.tags.map((t: { name: string; chats: { chat_id: string }[] }) => [t.name, ids(t.chats)]),
		[["羽球", [cat]], ["讀書會", [amy]]].sort((x, y) => (x[0] as string).localeCompare(y[0] as string)));
	assert.deepEqual(listed.tags[0].chats[0], { chat_id: listed.tags[0].chats[0].chat_id, name: `name of ${listed.tags[0].chats[0].chat_id.slice(0, 3)}`, type: "user" });

	assert.deepEqual(ids((await call("line_list_chats", { tags: ["读书会"] })).json()), [amy]);
	assert.deepEqual(ids((await call("line_list_chats", { tags: ["讀書會", "羽球"] })).json()), [amy, cat]);
	assert.deepEqual(ids((await call("line_list_chats", { tags: ["讀書會", "羽球"], match_all_tags: true })).json()), []);
	const all = (await call("line_list_chats")).json();
	assert.deepEqual(all.map((c: { chat_id: string; tags?: string[] }) => [c.chat_id, c.tags]), [[amy, ["讀書會"]], [cat, ["羽球"]]]);
	const unknown = await call("line_list_chats", { tags: ["同事"] });
	assert.ok(unknown.error, "a tag only hidden chats have is not offered");
	assert.match(unknown.text, /No tag named "同事"/);
	assert.doesNotMatch(unknown.text, /同事\./);

	for (const [name, args] of [
		["line_tag_add", { chat_ids: [amy, bob], tags: ["x"] }],
		["line_tag_remove", { chat_ids: [team], tags: ["同事"] }],
	] as const) {
		const refused = await call(name, args);
		assert.ok(refused.error, name);
		assert.match(refused.text, /hid this chat/);
	}
	assert.deepEqual(organizer.tagsOf(amy), ["讀書會"], "a refused call changes nothing");
	assert.deepEqual(organizer.tagsOf(team), ["同事"]);

	await call("line_search_messages", { query: "會議", tags: ["羽球"] });
	assert.deepEqual(searched.at(-1), { chatId: undefined, limit: 30, only: [cat], exclude: [bob, team] });
	await call("line_search_messages", { query: "會議" });
	assert.equal((searched.at(-1) as { only?: string[] }).only, undefined);

	const removed = (await call("line_tag_remove", { chat_ids: [amy, cat], tags: ["讀書會"] })).json();
	assert.deepEqual(removed.chats.map((c: { tags: string[] }) => c.tags), [[], ["羽球"]]);
	assert.equal((await call("line_tag_add", { chat_ids: [amy], tags: ["x".repeat(41)] })).error, true);
	await client.close();
});
