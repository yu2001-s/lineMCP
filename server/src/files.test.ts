import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Archive } from "./archive.ts";
import { LineService } from "./line.ts";
import { AtomicFileStorage } from "./storage.ts";

const me = "u" + "0".repeat(32);
const amy = "u" + "a".repeat(32);
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** An end-to-end encrypted message as LINE sends it: the file name is only inside the chunks. */
const encrypted = (id: string, contentType: string, meta: Record<string, string> = {}) => ({
	id,
	from: amy,
	to: me,
	toType: "USER",
	contentType,
	contentMetadata: { e2eeVersion: "2", SID: "emf", OID: `oid-${id}`, ...meta },
	chunks: ["salt", "payload", "sign", "1", "2"],
	createdTime: String(Date.UTC(2026, 9, 27, 3, Number(id))),
	deliveredTime: String(Date.UTC(2026, 9, 27, 3, Number(id))),
});

function fakeLine() {
	const line = new LineService(new AtomicFileStorage(join(mkdtempSync(join(tmpdir(), "line-mcp-")), "storage.json")));
	line.status = "ready";
	const base = line.base as unknown as Record<string, Record<string, unknown>>;
	base.talk.getRecentMessagesV2 = async () => [
		encrypted("1", "FILE", { FILE_SIZE: "215113" }),
		encrypted("2", "IMAGE"),
		encrypted("3", "FILE"),
	];
	base.talk.getContactsV2 = async () => ({ contacts: { [amy]: { contact: { displayName: "Amy" } } } });
	base.e2ee.decryptE2EEMessage = async (m: unknown) => m;
	base.e2ee.decryptE2EEDataMessage = async (m: { id: string }) => {
		if (m.id === "3") throw new Error("no key");
		return { keyMaterial: "secret", fileName: m.id === "1" ? "活動預算.xlsx" : "undefined.jpg" };
	};
	base.obs.downloadMediaByE2EE = async (m: { id: string }) =>
		m.id === "1"
			? new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "活動預算.xlsx")
			: new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "undefined");
	return line;
}

test("an encrypted file is listed by its name and size", async () => {
	const line = fakeLine();
	const { messages } = await line.readMessages({ chatId: amy, limit: 30 });
	assert.deepEqual(messages.map((m) => m.text), ["[file: 活動預算.xlsx, 215 KB]", "[image]", "[file: unnamed]"]);
	assert.equal(messages[0].from, "Amy");

	const { messages: archived } = await line.collectMessages(amy, 0);
	assert.equal(archived[0].data.media?.file_name, "活動預算.xlsx", "the desktop app gets the name too");
	assert.equal(archived[2].decryptFailed, false, "a name that won't decrypt does not mark the message undecryptable");
});

test("encrypted downloads come with a real media type", async () => {
	const line = fakeLine();
	await line.readMessages({ chatId: amy, limit: 30 });
	const sheet = await line.downloadMedia(amy, "1");
	assert.equal(sheet.name, "活動預算.xlsx");
	assert.equal(sheet.type, XLSX);
	const photo = await line.downloadMedia(amy, "2");
	assert.equal(photo.name, "2");
	assert.equal(photo.type, "image/jpeg");
});

test("the archive sync names files it saved as unnamed", async () => {
	const archive = new Archive(join(mkdtempSync(join(tmpdir(), "line-archive-")), "a.db"));
	const { messages } = await fakeLine().collectMessages(amy, 0);
	const unnamed = messages.map((m) => m.id === "1" ? { ...m, text: "[file: unnamed]", data: { ...m.data, media: {} } } : m);
	archive.save(amy, "Amy", unnamed, "manual");
	assert.equal(archive.read(amy, { limit: 10 }).messages[0].text, "[file: unnamed]");
	archive.save(amy, "Amy", messages, "manual");
	const [file, , stillUnnamed] = archive.read(amy, { limit: 10 }).messages;
	assert.equal(file.text, "[file: 活動預算.xlsx, 215 KB]");
	assert.equal(stillUnnamed.text, "[file: unnamed]");
	assert.equal(archive.search("預算", { limit: 10 }).length, 1);
});
