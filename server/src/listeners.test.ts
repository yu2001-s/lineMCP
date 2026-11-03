import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ClientMessage } from "./line.ts";
import { Listeners } from "./listeners.ts";
import { Organizer } from "./organizer.ts";

const amy = "u" + "a".repeat(32);
const bob = "u" + "b".repeat(32);
const me = "u" + "f".repeat(32);
const team = "c" + "c".repeat(32);
const family = "c" + "d".repeat(32);

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
	return { dir, path, calls, msg, make: () => new Listeners(path, fetchImpl), failWith: (s: number) => { status = s; } };
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

test("the MCP tools set, list and remove listeners, and refuse hidden chats", async () => {
	const { dir, make } = setup();
	const { buildMcpServer } = await import("./mcp.ts");
	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

	const organizer = new Organizer(join(dir, "organizer.json"));
	organizer.replace({ folders: [], hidden: [{ chat_id: bob, name: "Bob" }] });
	const listeners = make();
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
