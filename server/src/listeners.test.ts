import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ClientMessage } from "./line.ts";
import { Listeners, maskHeaderValue } from "./listeners.ts";
import { Organizer } from "./organizer.ts";

const amy = "u" + "a".repeat(32);
const bob = "u" + "b".repeat(32);
const me = "u" + "f".repeat(32);
const team = "c" + "c".repeat(32);
const family = "c" + "d".repeat(32);
const ward = "r" + "e".repeat(32);
const doctorsId = "11111111-1111-4111-8111-111111111111";
const friendsId = "22222222-2222-4222-8222-222222222222";

interface Call {
	url: string;
	headers: Record<string, string>;
	body: { text: string; listener: string; chat_id: string; message: { from_name: string; text: string } };
}

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "line-listeners-"));
	const path = join(dir, "listeners.json");
	const calls: Call[] = [];
	let status = 200;
	const fetchImpl = async (url: string, init: RequestInit) => {
		calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
		return new Response("{}", { status });
	};
	let id = 0;
	const msg = (over: Partial<ClientMessage> = {}): ClientMessage => ({
		id: String(++id), chat_id: team, from_id: amy, from_name: "Amy", mine: false,
		time_ms: Date.now(), delivered: "0", kind: "text", text: "lunch at noon?", ...over,
	});
	const organizer = new Organizer(join(dir, "organizer.json"));
	return {
		dir, path, calls, msg, organizer,
		make: () => new Listeners(path, organizer, fetchImpl),
		failWith: (s: number) => { status = s; },
	};
}

test("a message someone else sends in a listened-to chat is posted to the webhook", async () => {
	const { make, calls, msg } = setup();
	const listeners = make();
	listeners.set({ name: "monitor", url: "https://bots.example/hook", headers: { authorization: "Bearer t" }, chats: [team, amy] });

	await listeners.onMessage(msg());
	await listeners.onMessage(msg({ mine: true, from_id: me, text: "my reply" }));
	await listeners.onMessage(msg({ chat_id: family }));

	assert.equal(calls.length, 1);
	const [call] = calls;
	assert.equal(call.url, "https://bots.example/hook");
	assert.equal(call.headers.authorization, "Bearer t");
	assert.equal(call.body.listener, "monitor");
	assert.equal(call.body.chat_id, team);
	assert.equal(call.body.message.text, "lunch at noon?");
	assert.match(call.body.text, /from Amy: lunch at noon\?/);
});

test("every listener for the chat gets the message", async () => {
	const { make, calls, msg } = setup();
	const listeners = make();
	listeners.set({ name: "a", url: "https://a.example/hook", headers: {}, chats: [team] });
	listeners.set({ name: "b", url: "https://b.example/hook", headers: {}, chats: [team, bob] });

	await listeners.onMessage(msg());
	assert.deepEqual(calls.map((c) => c.url).sort(), ["https://a.example/hook", "https://b.example/hook"]);
});

test("listeners are kept across restarts, replaced by name and removed", () => {
	const { make, path } = setup();
	make().set({ name: "monitor", url: "https://bots.example/hook", headers: {}, chats: [team] });
	assert.equal(statSync(path).mode & 0o777, 0o600);

	const reloaded = make();
	reloaded.set({ name: "monitor", url: "https://bots.example/hook", headers: {}, chats: [family] });
	assert.deepEqual(make().list().map((l) => [l.name, l.chats]), [["monitor", [family]]]);

	reloaded.remove("monitor");
	assert.deepEqual(make().list(), []);
	assert.throws(() => reloaded.remove("monitor"), /No listener named "monitor"/);
});

test("a failing webhook is logged and does not throw", async () => {
	const { make, calls, msg, failWith } = setup();
	const listeners = make();
	listeners.set({ name: "monitor", url: "https://bots.example/hook", headers: {}, chats: [team] });
	failWith(500);
	await listeners.onMessage(msg());
	assert.equal(calls.length, 1);
});

test("a listener stored before tags could be listened to loads and keeps working", async () => {
	const { make, path, calls, msg } = setup();
	const stored = JSON.stringify({ listeners: [{ name: "monitor", url: "https://bots.example/hook", headers: {}, chats: [team] }] });
	writeFileSync(path, stored);
	const listeners = make();
	await listeners.onMessage(msg());
	await listeners.onMessage(msg({ chat_id: family }));
	assert.deepEqual(calls.map((c) => c.body.chat_id), [team]);
	assert.equal(readFileSync(path, "utf-8"), stored);
});

test("a listener on a betterLINE folder listens to the tag the folder became", async () => {
	const { dir, path, calls, msg } = setup();
	writeFileSync(join(dir, "organizer.json"), JSON.stringify({
		folders: [{ id: doctorsId, name: "Doctors", chat_ids: [team] }, { id: friendsId, name: "Friends", chat_ids: [] }],
		hidden: [],
	}));
	writeFileSync(path, JSON.stringify({ listeners: [
		{ name: "monitor", url: "https://bots.example/hook", headers: { authorization: "Bearer x" }, chats: [], folders: [doctorsId, "33333333-3333-4333-8333-333333333333"] },
		{ name: "plain", url: "https://bots.example/hook", headers: {}, chats: [amy] },
	] }));
	const organizer = new Organizer(join(dir, "organizer.json"));
	const listeners = new Listeners(path, organizer, async (url, init) => {
		calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
		return new Response("{}");
	});
	assert.deepEqual(listeners.list(), [
		{ name: "monitor", url: "https://bots.example/hook", headers: { authorization: "Bearer x" }, chats: [], tags: ["Doctors"] },
		{ name: "plain", url: "https://bots.example/hook", headers: {}, chats: [amy] },
	]);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")).listeners, listeners.list(), "saved, so it happens once");
	await listeners.onMessage(msg());
	assert.deepEqual(calls.map((c) => c.body.listener), ["monitor"]);
});

test("a tag listener follows chats tagged and untagged, renames and hidden chats", async () => {
	const { make, calls, msg, organizer } = setup();
	organizer.addTags([team], ["Doctors"]);
	const listeners = make();
	organizer.onTagRename = (from, to) => listeners.renameTag(from, to);
	listeners.set({ name: "monitor", url: "https://bots.example/hook", headers: {}, chats: [team], tags: ["Doctors"] });

	await listeners.onMessage(msg());
	assert.equal(calls.length, 1, "a chat both listed and tagged is posted once");

	organizer.addTags([family], ["doctors"]);
	organizer.changeTags([{ op: "rename", tags: ["doctors"], to: "醫生" }]);
	assert.deepEqual(listeners.list()[0].tags, ["醫生"]);
	await listeners.onMessage(msg({ chat_id: family }));
	assert.equal(calls.length, 2);

	organizer.removeTags([family], ["醫生"]);
	await listeners.onMessage(msg({ chat_id: family }));
	assert.equal(calls.length, 2, "an untagged chat stops");

	organizer.addTags([ward], ["醫生"]);
	organizer.hide([{ chat_id: ward, name: "Ward" }]);
	await listeners.onMessage(msg({ chat_id: ward }));
	assert.equal(calls.length, 2, "a hidden chat with the tag is not posted");

	organizer.changeTags([{ op: "delete", tags: ["醫生"] }]);
	await listeners.onMessage(msg());
	assert.equal(calls.length, 3, "listed chats keep working after the tag is deleted");
	await listeners.onMessage(msg({ chat_id: amy }));
	assert.equal(calls.length, 3);
});

test("the MCP tools set, list and remove listeners, and refuse hidden chats", async () => {
	const { dir, make } = setup();
	const { buildMcpServer } = await import("./mcp.ts");
	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

	const organizer = new Organizer(join(dir, "organizer.json"));
	organizer.replace({ hidden: [{ chat_id: bob, name: "Bob" }] });
	const listeners = new Listeners(join(dir, "listeners.json"), organizer, async () => new Response("{}"));
	const line = { chatNames: async (ids: string[]) => new Map(ids.map((id) => [id, `name of ${id.slice(0, 3)}`])) };
	const server = buildMcpServer(line as never, {} as never, {} as never, organizer, listeners, {} as never);
	const client = new Client({ name: "test", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args });
		const text = (result.content as { text: string }[])[0].text;
		return { error: result.isError === true, text, json: () => JSON.parse(text) };
	};

	const set = await call("line_listen_set", { name: "monitor", url: "https://bots.example/hook", chats: [team, team, amy] });
	assert.equal(set.error, false, set.text);
	assert.deepEqual(set.json().chats, [team, amy]);
	assert.match((await call("line_listen_set", { name: "x", url: "https://bots.example/hook", chats: [bob] })).text, /hid this chat/);

	const list = (await call("line_listen_list")).json();
	assert.deepEqual(list.map((l: { name: string; chats: { name: string }[] }) => [l.name, l.chats.map((c) => c.name)]), [
		["monitor", ["name of ccc", "name of uaa"]],
	]);

	assert.equal((await call("line_listen_remove", { name: "monitor" })).error, false);
	assert.deepEqual(listeners.list(), []);
	await client.close();
});

test("line_listen_set takes tags by name, and line_listen_list shows their chats now", async () => {
	const { path, calls, msg, organizer } = setup();
	const { buildMcpServer } = await import("./mcp.ts");
	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
	organizer.addTags([team, bob], ["Doctors"]);
	organizer.addTags([amy], ["Friends"]);
	organizer.replace({ hidden: [{ chat_id: bob, name: "Bob" }] });
	const listeners = new Listeners(path, organizer, async (url, init) => {
		calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
		return new Response("{}");
	});
	organizer.onTagRename = (from, to) => listeners.renameTag(from, to);
	const line = { chatNames: async (ids: string[]) => new Map(ids.map((id) => [id, `name of ${id.slice(0, 3)}`])) };
	const server = buildMcpServer(line as never, {} as never, {} as never, organizer, listeners, {} as never);
	const client = new Client({ name: "test", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args });
		const text = (result.content as { text: string }[])[0].text;
		return { error: result.isError === true, text, json: () => JSON.parse(text) };
	};
	const url = "https://bots.example/hook";

	const none = await call("line_listen_set", { name: "x", url });
	assert.equal(none.error, true);
	assert.match(none.text, /chats, tags or both/);
	const unknown = await call("line_listen_set", { name: "x", url, tags: ["Nurses"] });
	assert.equal(unknown.error, true);
	assert.match(unknown.text, /No tag named "Nurses".*Doctors, Friends/);

	const set = await call("line_listen_set", { name: "doctors", url, tags: ["doctors", "Doctors"] });
	assert.equal(set.error, false, set.text);
	assert.deepEqual(set.json().chats, []);
	assert.deepEqual(set.json().tags, [{ tag: "Doctors", chat_ids: [team] }]);
	assert.deepEqual(listeners.list()[0].tags, ["Doctors"]);

	await listeners.onMessage(msg());
	assert.equal(calls.length, 1);

	assert.equal((await call("line_tag_add", { chat_ids: [family], tags: ["doctors"] })).error, false);
	assert.equal((await call("line_tag_rename", { tag: "Doctors", to: "醫生" })).error, false);
	await listeners.onMessage(msg({ chat_id: family }));
	assert.equal(calls.length, 2);

	const list = (await call("line_listen_list")).json();
	assert.deepEqual(list[0].tags, [{ tag: "醫生", chat_ids: [team, family].sort() }]);

	assert.equal((await call("line_tag_delete", { tag: "醫生" })).error, false);
	const after = (await call("line_listen_list")).json();
	assert.deepEqual(after[0].tags, [{ tag: "醫生", chat_ids: [], note: "No chat has this tag now." }]);
	await client.close();
});

test("header values are masked to a scheme, a token prefix and the last 4 characters", () => {
	assert.equal(maskHeaderValue("Bearer crsr_abcdefghijklmnopa1b2"), "Bearer crsr_…a1b2");
	assert.equal(maskHeaderValue("Bearer abcdefghijklmnopa1b2"), "Bearer …a1b2");
	assert.equal(maskHeaderValue("sk-abcdefghijklmnopqrstuvwxyz9876"), "sk-…9876");
	assert.equal(maskHeaderValue("0123456789abcdefWXYZ"), "…WXYZ");
	assert.equal(maskHeaderValue("Bearer t"), "••••");
	assert.equal(maskHeaderValue("Bearer crsr_short"), "••••");
	assert.equal(maskHeaderValue("abcdefghijk"), "••••");
	assert.equal(maskHeaderValue(""), "••••");
});

test("line_listen_set and line_listen_list mask header values, which are still stored and sent in full", async () => {
	const { dir, path, calls, msg } = setup();
	const { buildMcpServer } = await import("./mcp.ts");
	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
	const organizer = new Organizer(join(dir, "organizer.json"));
	const listeners = new Listeners(path, organizer, async (url, init) => {
		calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
		return new Response("{}");
	});
	const line = { chatNames: async (ids: string[]) => new Map(ids.map((id) => [id, "x"])) };
	const server = buildMcpServer(line as never, {} as never, {} as never, organizer, listeners, {} as never);
	const client = new Client({ name: "test", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args });
		const text = (result.content as { text: string }[])[0].text;
		return { error: result.isError === true, text, json: () => JSON.parse(text) };
	};
	const url = "https://bots.example/hook";
	const token = "Bearer crsr_9f8e7d6c5b4a3928a1b2";
	const headers = { authorization: token, "x-key": "short1" };
	const masked = { authorization: "Bearer crsr_…a1b2", "x-key": "••••" };

	const set = await call("line_listen_set", { name: "monitor", url, chats: [team], headers });
	assert.equal(set.error, false, set.text);
	assert.deepEqual(set.json().headers, masked);
	assert.ok(!set.text.includes("9f8e7d6c5b4a3928") && !set.text.includes("short1"), set.text);

	const list = await call("line_listen_list");
	assert.deepEqual(list.json()[0].headers, masked);
	assert.ok(!list.text.includes("9f8e7d6c5b4a3928") && !list.text.includes("short1"), list.text);

	assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")).listeners[0].headers, headers);
	await listeners.onMessage(msg());
	assert.equal(calls.at(-1)!.headers.authorization, token);
	assert.equal(calls.at(-1)!.headers["x-key"], "short1");

	// Replacing without headers keeps them; the response stays masked.
	const replaced = await call("line_listen_set", { name: "monitor", url, chats: [family] });
	assert.equal(replaced.error, false, replaced.text);
	assert.deepEqual(replaced.json().headers, masked);
	assert.deepEqual(new Listeners(path).list()[0], { name: "monitor", url, chats: [family], headers });
	await listeners.onMessage(msg({ chat_id: family }));
	assert.equal(calls.at(-1)!.headers.authorization, token);

	// A new listener without headers gets none, not another listener's.
	assert.deepEqual((await call("line_listen_set", { name: "other", url, chats: [team] })).json().headers, {});

	// headers: {} clears them.
	const cleared = await call("line_listen_set", { name: "monitor", url, chats: [family], headers: {} });
	assert.deepEqual(cleared.json().headers, {});
	assert.deepEqual(new Listeners(path).list().find((l) => l.name === "monitor")!.headers, {});
	await listeners.onMessage(msg({ chat_id: family }));
	assert.equal(calls.at(-1)!.headers.authorization, undefined);
	await client.close();
});
