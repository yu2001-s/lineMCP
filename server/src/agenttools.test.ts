import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Organizer } from "./organizer.ts";
import { UploadError, Uploads } from "./uploads.ts";

const amy = "u" + "a".repeat(32);
const bob = "u" + "b".repeat(32);
const cat = "u" + "d".repeat(32);
const team = "c" + "c".repeat(32);

async function* chunks(...parts: string[]) {
	for (const part of parts) yield new TextEncoder().encode(part);
}

test("an upload URL takes one file, which stays readable for an hour", async () => {
	const uploads = new Uploads(mkdtempSync(join(tmpdir(), "line-uploads-")), 10);
	const { id } = uploads.create("報價單.pdf");
	assert.throws(() => uploads.read(id), /Nothing has been uploaded/);
	assert.deepEqual(await uploads.receive(id, chunks("%PDF", "-1")), { file_name: "報價單.pdf", size: 6 });
	assert.equal(uploads.read(id).data.toString(), "%PDF-1");
	assert.equal(uploads.read(id).fileName, "報價單.pdf", "the same file can be sent twice");
	await assert.rejects(uploads.receive(id, chunks("x")), (e: UploadError) => e.status === 409);
	await assert.rejects(uploads.receive("x".repeat(32), chunks("x")), (e: UploadError) => e.status === 404);

	const big = uploads.create("big.bin");
	await assert.rejects(uploads.receive(big.id, chunks("123456", "789012")), (e: UploadError) => e.status === 413);
	assert.throws(() => uploads.read(big.id), /Nothing has been uploaded/, "a refused upload can be retried");
	await assert.rejects(uploads.receive(uploads.create("e.txt").id, chunks()), (e: UploadError) => e.status === 400);

	const old = uploads.create("old.jpg", Date.now() - 2 * 3600_000);
	assert.throws(() => uploads.read(old.id), /expired/);
});

test("agents can do what the owner does in betterLINE", async () => {
	process.env.LINE_MCP_STATE_DIR = mkdtempSync(join(tmpdir(), "line-mcp-"));
	const { buildMcpServer } = await import("./mcp.ts");
	const { config } = await import("./config.ts");
	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

	const calls: unknown[][] = [];
	const line = {
		chatNames: async (ids: string[]) => new Map(ids.map((id) => [id, `name of ${id.slice(0, 3)}`])),
		sendSticker: async (...args: unknown[]) => (calls.push(["sticker", ...args]), { message_id: "7" }),
		sendMedia: async (chatId: string, file: { data: Blob; kind: string; fileName: string; agent?: boolean }) => {
			calls.push(["media", chatId, file.kind, file.fileName, file.data.type, file.agent, await file.data.text()]);
			return { message_id: "8" };
		},
		react: async (...args: unknown[]) => void calls.push(["react", ...args]),
		unsend: async (...args: unknown[]) => void calls.push(["unsend", ...args]),
		markRead: async (...args: unknown[]) => void calls.push(["read", ...args]),
		newestMessageId: async () => "500",
		readMarkers: async () => ({ [bob]: "490" }),
	};
	const organizer = new Organizer(join(process.env.LINE_MCP_STATE_DIR, "organizer.json"));
	const uploads = new Uploads(join(process.env.LINE_MCP_STATE_DIR, "uploads"));
	const server = buildMcpServer(line as never, {} as never, {} as never, organizer, {} as never, uploads);
	const client = new Client({ name: "test", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args });
		const text = (result.content as { text: string }[])[0].text;
		return { error: result.isError === true, text, json: () => JSON.parse(text) };
	};

	// Tags: rename and delete, like Settings → 聊天室.
	await call("line_tag_add", { chat_ids: [amy, bob], tags: ["讀書會"] });
	await call("line_tag_rename", { tag: "读书会", to: "Book Club" });
	assert.deepEqual(organizer.tagsOf(bob), ["Book Club"]);
	assert.deepEqual((await call("line_tag_delete", { tag: "book club" })).json().tags, []);
	assert.match((await call("line_tag_delete", { tag: "讀書會" })).text, /No chats are tagged yet/);

	// Messages: stickers, reactions, unsend, read state.
	await call("line_send_sticker", { chat_id: amy, package_id: "11537", sticker_id: "52002734" });
	await call("line_react", { chat_id: amy, message_id: "42", reaction: "LOVE" });
	assert.equal((await call("line_react", { chat_id: amy, message_id: "42", reaction: "HEART" })).error, true);
	await call("line_unsend", { chat_id: amy, message_id: "43" });
	assert.deepEqual((await call("line_mark_read", { chat_id: amy })).json(), { chat_id: amy, read_up_to: "500" });
	await call("line_mark_read", { chat_id: team, message_id: "44" });
	assert.deepEqual((await call("line_read_receipts", { chat_id: team })).json().readers, [
		{ id: bob, name: `name of ${bob.slice(0, 3)}`, read_up_to: "490" },
	]);
	assert.deepEqual(calls.splice(0), [
		["sticker", amy, { packageId: "11537", stickerId: "52002734", version: "1", agent: true }],
		["react", "42", "LOVE", amy],
		["unsend", "43", amy],
		["read", amy, "500"],
		["read", team, "44"],
	]);

	// Files: uploaded photos go as photos, anything else as a file.
	const upload = (await call("line_create_upload", { file_name: "photo.JPG" })).json();
	assert.equal(upload.url, `${config.publicUrl}/upload/${upload.upload_id}`);
	assert.match(upload.how, /^curl -sS -T /);
	assert.match((await call("line_send_file", { chat_id: amy, upload_id: upload.upload_id })).text, /Nothing has been uploaded/);
	await uploads.receive(upload.upload_id, chunks("jpeg bytes"));
	await call("line_send_file", { chat_id: amy, upload_id: upload.upload_id });
	await call("line_send_file", { chat_id: team, upload_id: upload.upload_id, as_file: true, file_name: "照片.jpg" });
	const pdf = (await call("line_create_upload", { file_name: "報價單.pdf" })).json();
	await uploads.receive(pdf.upload_id, chunks("%PDF"));
	await call("line_send_file", { chat_id: amy, upload_id: pdf.upload_id });
	await call("line_send_file", { chat_id: amy, file_name: "a.md", content: "# a" });
	assert.match((await call("line_send_file", { chat_id: amy, file_name: "a.md", content: "x", upload_id: pdf.upload_id })).text, /either content or upload_id/);
	assert.match((await call("line_send_file", { chat_id: amy, file_name: "a.pdf", content: "x" })).text, /must end in/);
	assert.deepEqual(calls.splice(0), [
		["media", amy, "image", "photo.JPG", "image/jpeg", true, "jpeg bytes"],
		["media", team, "file", "照片.jpg", "image/jpeg", true, "jpeg bytes"],
		["media", amy, "file", "報價單.pdf", "application/pdf", true, "%PDF"],
		["media", amy, "file", "a.md", "text/markdown; charset=utf-8", true, "# a"],
	]);

	// Hiding: the chat leaves every tool, and the agent cannot bring it back.
	const hidden = (await call("line_hide_chats", { chat_ids: [bob] })).json();
	assert.deepEqual(hidden.hidden, [{ chat_id: bob, name: `name of ${bob.slice(0, 3)}` }]);
	assert.equal(organizer.isHidden(bob), true);
	for (const [name, args] of [
		["line_hide_chats", { chat_ids: [bob] }],
		["line_tag_add", { chat_ids: [bob], tags: ["Work"] }],
		["line_send_sticker", { chat_id: bob, package_id: "1", sticker_id: "2" }],
		["line_react", { chat_id: bob, message_id: "1", reaction: "NICE" }],
		["line_unsend", { chat_id: bob, message_id: "1" }],
		["line_mark_read", { chat_id: bob }],
		["line_read_receipts", { chat_id: bob }],
		["line_send_file", { chat_id: bob, upload_id: pdf.upload_id }],
	] as const) {
		const refused = await call(name, args);
		assert.ok(refused.error, name);
		assert.match(refused.text, /hid this chat/, name);
	}
	assert.deepEqual(calls, []);
	await client.close();
});
