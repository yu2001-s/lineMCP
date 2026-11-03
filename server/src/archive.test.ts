import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Archive, skipReason } from "./archive.ts";

const chat = "c" + "1".repeat(32);
const base = Date.UTC(2026, 9, 1);
const amy = "u" + "2".repeat(32);
const msg = (i: number, text: string, decryptFailed = false, mediaRef?: string) => ({
	id: String(1000 + i),
	createdMs: base + i * 60_000,
	fromId: amy,
	fromName: "Amy",
	text,
	decryptFailed,
	mediaRef,
	data: {
		id: String(1000 + i),
		chat_id: chat,
		from_id: amy,
		from_name: "Amy",
		mine: false,
		time_ms: base + i * 60_000,
		delivered: String(base + i * 60_000),
		kind: "text" as const,
		text,
		...(decryptFailed ? { decrypt_failed: true } : {}),
	},
});
const newArchive = () => new Archive(join(mkdtempSync(join(tmpdir(), "line-archive-")), "a.db"));

test("save dedupes by message id and repairs failed decryptions", () => {
	const a = newArchive();
	assert.equal(a.save(chat, "Family", [msg(1, "hello"), msg(2, "[undecryptable]", true)], "manual"), 2);
	assert.equal(a.save(chat, "Family", [msg(1, "changed"), msg(2, "decrypted now"), msg(3, "new")], "manual"), 1);
	const texts = a.read(chat, { limit: 10 }).messages.map((m) => m.text);
	assert.deepEqual(texts, ["hello", "decrypted now", "new"]);
	assert.equal(a.newestMs(chat), base + 3 * 60_000);
});

test("search matches CJK substrings and treats wildcards literally", () => {
	const a = newArchive();
	a.save(chat, "Family", [msg(1, "明天開會"), msg(2, "100% sure_thing")], "manual");
	assert.equal(a.search("開會", { limit: 10 }).length, 1);
	assert.equal(a.search("%", { limit: 10 }).length, 1);
	assert.equal(a.search("_", { limit: 10 }).length, 1);
	assert.equal(a.search("SURE", { limit: 10 }).length, 1);
	assert.equal(a.search("開會", { chatId: "c" + "9".repeat(32), limit: 10 }).length, 0);
	assert.equal(a.search("開會", { limit: 10, exclude: [chat] }).length, 0);
	assert.equal(a.search("開會", { limit: 10, exclude: ["c" + "9".repeat(32)] }).length, 1);
	assert.equal(a.search("開會", { limit: 10, only: [chat] }).length, 1);
	assert.equal(a.search("開會", { limit: 10, only: ["c" + "9".repeat(32)] }).length, 0);
	assert.equal(a.search("開會", { limit: 10, only: [] }).length, 0);
});

test("search matches Simplified and Traditional Chinese both ways", () => {
	const a = newArchive();
	a.save(chat, "Family", [msg(1, "明天開會"), msg(2, "晚上吃鸡肉")], "manual");
	assert.deepEqual(a.search("开会", { limit: 10 }).map((m) => m.text), ["明天開會"]);
	assert.deepEqual(a.search("雞肉", { limit: 10 }).map((m) => m.text), ["晚上吃鸡肉"]);
});

test("repaired decryptions become searchable", () => {
	const a = newArchive();
	a.save(chat, "Family", [msg(1, "[undecryptable]", true)], "manual");
	a.save(chat, "Family", [msg(1, "明天開會")], "manual");
	assert.equal(a.search("开会", { limit: 10 }).length, 1);
});

test("opening an archive with stale search text rebuilds it", () => {
	const path = join(mkdtempSync(join(tmpdir(), "line-archive-")), "a.db");
	new Archive(path).save(chat, "Family", [msg(1, "明天開會")], "manual");
	const raw = new DatabaseSync(path);
	raw.exec("UPDATE messages SET search_text = ''; DELETE FROM meta WHERE key = 'search_fold'");
	raw.close();
	assert.equal(new Archive(path).search("开会", { limit: 10 }).length, 1);
});

test("read pages backwards in chronological order", () => {
	const a = newArchive();
	a.save(chat, "Family", [1, 2, 3, 4].map((i) => msg(i, `m${i}`)), "manual");
	const latest = a.read(chat, { limit: 2 });
	assert.deepEqual(latest.messages.map((m) => m.text), ["m3", "m4"]);
	const older = a.read(chat, { limit: 2, beforeMs: Number(latest.older_cursor) });
	assert.deepEqual(older.messages.map((m) => m.text), ["m1", "m2"]);
});

test("remove keeps messages unless asked to delete them", () => {
	const a = newArchive();
	a.save(chat, "Family", [msg(1, "keep me")], "manual");
	assert.deepEqual(a.remove(chat, false), { removed: true, deletedMessages: 0 });
	assert.equal(a.isArchived(chat), false);
	assert.equal(a.search("keep", { limit: 10 }).length, 1);
	assert.deepEqual(a.remove(chat, true), { removed: false, deletedMessages: 1 });
	assert.equal(a.search("keep", { limit: 10 }).length, 0);
});

test("removing a chat excludes it from the rules until it is added by hand", () => {
	const a = newArchive();
	a.save(chat, "Family", [msg(1, "hi")], "auto");
	a.remove(chat, false);
	assert.equal(a.isExcluded(chat), true);
	a.save(chat, "Family", [], "manual");
	assert.equal(a.isExcluded(chat), false);
	assert.equal(a.chats()[0].mode, "manual");
	a.save(chat, "Family", [], "auto");
	assert.equal(a.chats()[0].mode, "manual", "a rule sync never downgrades a manual add");
});

test("rules skip official accounts and large groups", () => {
	const policy = new Archive(join(mkdtempSync(join(tmpdir(), "line-archive-")), "a.db")).policy();
	assert.deepEqual(policy, { auto: false, maxGroupMembers: 10, skipOfficialAccounts: true });
	const facts = { id: chat, name: "x", lastMessageMs: 0 };
	assert.equal(skipReason({ ...facts, type: "user", official: false }, policy), undefined);
	assert.equal(skipReason({ ...facts, type: "user", official: true }, policy), "official account");
	assert.equal(skipReason({ ...facts, type: "user" }, policy), "account type unknown");
	assert.equal(skipReason({ ...facts, type: "group", members: 10 }, policy), undefined);
	assert.equal(skipReason({ ...facts, type: "room", members: 11 }, policy), "11 members");
	assert.equal(skipReason({ ...facts, type: "group" }, policy), "member count unknown");
});

test("reconcile drops messages LINE no longer serves inside the window", () => {
	const a = newArchive();
	a.save(chat, "Family", [1, 2, 3, 4].map((i) => msg(i, `m${i}`)), "manual");
	// LINE serves 2..4 but 3 was unsent; 1 is older than the window and stays.
	assert.equal(a.reconcile(chat, base + 2 * 60_000, new Set(["1002", "1004"])), 1);
	assert.deepEqual(a.read(chat, { limit: 10 }).messages.map((m) => m.text), ["m1", "m2", "m4"]);
	a.deleteMessage("1002");
	assert.deepEqual(a.read(chat, { limit: 10 }).messages.map((m) => m.text), ["m1", "m4"]);
});

test("readClient returns stored client data and keeps the first media ref", () => {
	const a = newArchive();
	a.save(chat, "Family", [msg(1, "[image]", false, "ref-a")], "manual");
	a.save(chat, "Family", [msg(1, "[image]", false, "ref-b")], "manual");
	assert.equal(a.mediaRef("1001"), "ref-a");
	const page = a.readClient(chat, { limit: 10 });
	assert.equal(page.messages[0].kind, "text");
	assert.equal(page.messages[0].from_id, amy);
	assert.equal(a.searchClient("image", { limit: 10 })[0].chat_name, "Family");
});

test("readClient rebuilds rows archived before client data existed", () => {
	const dir = mkdtempSync(join(tmpdir(), "line-archive-"));
	const a = new Archive(join(dir, "a.db"));
	a.save(chat, "Family", [msg(1, "old row")], "manual");
	const db = new DatabaseSync(join(dir, "a.db"));
	db.exec("UPDATE messages SET data = NULL");
	db.close();
	const [m] = a.readClient(chat, { limit: 10 }).messages;
	assert.equal(m.text, "old row");
	assert.equal(m.kind, "text");
	a.save(chat, "Family", [msg(1, "old row")], "manual");
	assert.equal(a.readClient(chat, { limit: 10 }).messages[0].delivered, String(base + 60_000), "backfilled");
});
