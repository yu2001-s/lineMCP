import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Archive, ArchiveSync } from "./archive.ts";
import { AUTH_TOKEN_KEY } from "./config.ts";
import { type LineEvent, LineService } from "./line.ts";
import { AtomicFileStorage } from "./storage.ts";

const me = "u" + "0".repeat(32);
const amy = "u" + "a".repeat(32);
const at = (minute: number) => String(Date.UTC(2026, 9, 30, 1, minute));

const text = (id: string, minute: number, body: string | undefined, meta: Record<string, string> = {}) => ({
	id,
	from: amy,
	to: me,
	toType: "USER",
	contentType: "NONE",
	text: body,
	contentMetadata: meta,
	createdTime: at(minute),
	deliveredTime: at(minute),
});

/** History as LINE serves it: an unsent message stays, emptied, and an edited one carries its edit time. */
const history = () => [
	text("1", 37, "週五的會議改到下午"),
	// Unsent: LINE drops the text and the encrypted chunks, and keeps the rest.
	text("2", 38, undefined, { e2eeVersion: "2" }),
	text("3", 39, "1. 週會議程（改）", { UPDATED_TIME: at(45) }),
	text("4", 40, "ok", { UPDATED_TIME: at(40) }),
	{ ...text("5", 41, undefined, { UPDATED_TIME: at(42) }), contentType: "IMAGE" },
];

async function fakeLine(ops: unknown[] = []) {
	const storage = new AtomicFileStorage(join(mkdtempSync(join(tmpdir(), "line-mcp-")), "storage.json"));
	await storage.set(AUTH_TOKEN_KEY, "token");
	const line = new LineService(storage);
	const base = line.base as unknown as Record<string, unknown>;
	const talk = base.talk as Record<string, unknown>;
	talk.getRecentMessagesV2 = async () => history();
	talk.getContactsV2 = async () => ({ contacts: { [amy]: { contact: { displayName: "小美" } } } });
	(base.e2ee as Record<string, unknown>).decryptE2EEMessage = async (m: unknown) => m;
	(base.loginProcess as Record<string, unknown>).login = async () => {};
	// The stream never ends, so the listen loop simply waits after the last op.
	base.createPolling = () => ({
		listenTalkEvents: () => new ReadableStream({ start: (c) => ops.forEach((op) => c.enqueue(op)) }),
	});
	const events: LineEvent[] = [];
	line.events.on("event", (e) => events.push(e));
	await line.start();
	assert.equal(line.status, "ready");
	return { line, events };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

test("history marks unsent and edited messages", async () => {
	const { line } = await fakeLine();
	const { messages } = await line.readMessages({ chatId: amy, limit: 30 });
	const [plain, unsent, edited, sameMinute, photo] = messages;
	assert.equal(plain.text, "週五的會議改到下午");
	assert.equal(plain.unsent, undefined);
	assert.equal(plain.edited, undefined);
	assert.equal(unsent.text, "[unsent]");
	assert.equal(unsent.unsent, true);
	assert.equal(edited.text, "1. 週會議程（改）");
	assert.equal(edited.edited, true);
	assert.equal(edited.edited_at, "2026-10-30 09:45");
	assert.equal(sameMinute.edited, undefined, "an update time equal to the send time is no edit");
	assert.equal(photo.edited, undefined, "photos carry an update time but cannot be edited");
	assert.equal(photo.unsent, undefined);
});

test("the archive and the desktop app leave unsent messages out", async () => {
	const { line } = await fakeLine();
	const { messages } = await line.collectMessages(amy, 0);
	assert.deepEqual(messages.map((m) => m.id), ["1", "3", "4", "5"]);
	assert.equal(messages[1].data.edited, true);
	assert.equal(messages[1].data.edited_ms, Number(at(45)));

	const client = await line.clientMessages(amy, 5);
	assert.deepEqual(client.messages.map((m) => m.id), ["1", "3", "4", "5"]);
	assert.ok(client.older_cursor, "paging still counts the whole page");

	// A stub archived before this fix is dropped by the next sync.
	const archive = new Archive(join(mkdtempSync(join(tmpdir(), "line-archive-")), "a.db"));
	const sync = new ArchiveSync(line, archive);
	const stub = { ...messages[0], id: "2", text: "", data: { ...messages[0].data, id: "2", text: "" } };
	archive.save(amy, "小美", [...messages, stub], "manual");
	await sync.syncChat(amy);
	assert.deepEqual(archive.read(amy, { limit: 10 }).messages.map((m) => m.id), ["1", "3", "4", "5"]);
});

test("an unsend push marks the message even while LINE still serves its text", async () => {
	const { line } = await fakeLine([{ type: "NOTIFIED_DESTROY_MESSAGE", param1: amy, param2: "1" }]);
	await settled();
	const { messages } = await line.readMessages({ chatId: amy, limit: 30 });
	assert.equal(messages[0].unsent, true);
	assert.equal(messages[0].text, "[unsent]");
});

test("an edit push reaches the desktop app and updates the archive", async () => {
	const archive = new Archive(join(mkdtempSync(join(tmpdir(), "line-archive-")), "a.db"));
	const original = (await (await fakeLine()).line.collectMessages(amy, 0)).messages[0];
	archive.save(amy, "小美", [original], "manual");

	const editedOp = {
		type: "NOTIFIED_EDIT_MESSAGE",
		param1: amy,
		param2: "1",
		message: text("1", 37, "週五的會議改到下午三點", { EDITED: "true", UPDATED_TIME: at(50) }),
	};
	const storage = new AtomicFileStorage(join(mkdtempSync(join(tmpdir(), "line-mcp-")), "storage.json"));
	await storage.set(AUTH_TOKEN_KEY, "token");
	const line = new LineService(storage);
	new ArchiveSync(line, archive);
	const base = line.base as unknown as Record<string, unknown>;
	(base.talk as Record<string, unknown>).getContactsV2 = async () => ({ contacts: {} });
	(base.e2ee as Record<string, unknown>).decryptE2EEMessage = async (m: unknown) => m;
	(base.loginProcess as Record<string, unknown>).login = async () => {};
	base.createPolling = () => ({
		listenTalkEvents: () => new ReadableStream({ start: (c) => c.enqueue(editedOp) }),
	});
	const events: LineEvent[] = [];
	line.events.on("event", (e) => events.push(e));
	await line.start();
	await settled();

	const edit = events.find((e) => e.type === "edit");
	assert.ok(edit && edit.type === "edit");
	assert.equal(edit.chat_id, amy);
	assert.equal(edit.message.text, "週五的會議改到下午三點");
	assert.equal(edit.message.edited, true);
	assert.ok(!events.some((e) => e.type === "message"), "an edit is not a new message, so listeners stay quiet");

	const [saved] = archive.read(amy, { limit: 10 }).messages;
	assert.equal(saved.text, "週五的會議改到下午三點");
	assert.equal(archive.search("下午三點", { limit: 10 }).length, 1);
	assert.equal(archive.readClient(amy, { limit: 10 }).messages[0].edited, true);
});

test("the daily sync takes an edit made while the server was down", () => {
	const archive = new Archive(join(mkdtempSync(join(tmpdir(), "line-archive-")), "a.db"));
	const row = (body: string, edited: boolean) => ({
		id: "9", createdMs: 0, fromId: amy, fromName: "小美", text: body, decryptFailed: false,
		data: {
			id: "9", chat_id: amy, from_id: amy, from_name: "小美", mine: false, time_ms: 0, delivered: "0",
			kind: "text" as const, text: body, ...(edited ? { edited: true as const } : {}),
		},
	});
	archive.save(amy, "小美", [row("draft", false)], "manual");
	archive.save(amy, "小美", [row("ignored", false)], "manual");
	assert.equal(archive.read(amy, { limit: 10 }).messages[0].text, "draft", "an unedited message keeps its saved text");
	archive.save(amy, "小美", [row("final", true)], "manual");
	assert.equal(archive.read(amy, { limit: 10 }).messages[0].text, "final");
});
