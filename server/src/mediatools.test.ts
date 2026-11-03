import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { FILE_LIMIT, formatSize, isTextFile, mediaType, previewImage, readText, sendKind, TEXT_LIMIT, textFileType } from "./mediatools.ts";
import { Organizer } from "./organizer.ts";

const png = (width: number, height: number) =>
	sharp({ create: { width, height, channels: 3, background: "#06c755" } }).png().toBuffer();

test("a large photo is shrunk to 1568 px on its long edge", async () => {
	const preview = await previewImage(await png(3000, 1000));
	assert.equal(preview.width, 1568);
	assert.equal(preview.height, 523);
	assert.equal(preview.originalWidth, 3000);
	assert.equal(preview.mimeType, "image/jpeg");
	const decoded = await sharp(Buffer.from(preview.base64, "base64")).metadata();
	assert.equal(decoded.format, "jpeg");
});

test("a small photo is not enlarged", async () => {
	const preview = await previewImage(await png(200, 100));
	assert.equal(preview.width, 200);
	assert.equal(preview.height, 100);
});

test("a sideways phone photo comes back upright", async () => {
	const jpeg = await sharp(await png(200, 100)).withMetadata({ orientation: 6 }).jpeg().toBuffer();
	const preview = await previewImage(jpeg);
	assert.equal(preview.width, 100);
	assert.equal(preview.height, 200);
	assert.equal(preview.originalWidth, 100);
});

test("text files are recognised by type or name", () => {
	assert.equal(textFileType("會議紀錄.MD"), "text/markdown");
	assert.equal(textFileType("報表.pdf"), undefined);
	assert.ok(isTextFile("application/octet-stream", "data.csv"));
	assert.ok(isTextFile("text/plain; charset=utf-8", "noname"));
	assert.ok(!isTextFile("image/png", "photo.png"));
});

test("a file's type comes from LINE, then its name, then its first bytes", async () => {
	const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
	const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
	assert.equal(mediaType("活動預算.xlsx", zip), xlsx);
	assert.equal(mediaType("活動預算.XLSX", zip, "application/octet-stream"), xlsx);
	assert.equal(mediaType("637900000000000001", zip), "application/zip");
	assert.equal(mediaType("637900000000000001", new Uint8Array(await png(4, 4)).subarray(0, 16)), "image/png");
	const jpeg = await sharp(await png(4, 4)).jpeg().toBuffer();
	assert.equal(mediaType("637900000000000001", jpeg), "image/jpeg");
	assert.equal(mediaType("報價單", new TextEncoder().encode("%PDF-1.7\n")), "application/pdf");
	assert.equal(mediaType("clip", new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypM4A ")])), "audio/mp4");
	assert.equal(mediaType("S__1.jpg", jpeg, "image/png"), "image/png", "LINE's own type wins");
	assert.equal(mediaType("data.bin", new Uint8Array([1, 2, 3])), "application/octet-stream");
	assert.equal(mediaType("", new Uint8Array()), "application/octet-stream");
	assert.deepEqual(sendKind("報告.docx", false), { kind: "file", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
	assert.deepEqual(sendKind("x.pdf", false), { kind: "file", type: "application/pdf" });
	assert.deepEqual(sendKind("photo.JPG", true), { kind: "file", type: "image/jpeg" });
});

test("sizes read as Finder shows them", () => {
	assert.equal(formatSize(512), "512 bytes");
	assert.equal(formatSize(215_097), "215 KB");
	assert.equal(formatSize(FILE_LIMIT), "20 MB");
	assert.equal(formatSize(45_230_000), "45.2 MB");
});

test("text is read as UTF-8 and cut at the limit", () => {
	assert.deepEqual(readText(new TextEncoder().encode("你好")), { text: "你好", truncated: false });
	assert.equal(readText(new Uint8Array([0xff, 0xfe, 0x00])), undefined);
	const long = readText(new TextEncoder().encode("a".repeat(TEXT_LIMIT + 5)));
	assert.equal(long?.text.length, TEXT_LIMIT);
	assert.equal(long?.truncated, true);
});

test("the MCP tools open, forward and send media", async () => {
	process.env.LINE_MCP_STATE_DIR = mkdtempSync(join(tmpdir(), "line-mcp-"));
	const { buildMcpServer } = await import("./mcp.ts");
	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

	const photo = new Uint8Array(await png(2000, 500));
	const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
	const sheet = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode("預算")]);
	const sends: { chatId: string; kind: string; fileName: string; agent?: boolean; type: string }[] = [];
	const line = {
		downloadMedia: async (_chat: string, id: string) => {
			if (id === "1") return { data: photo, type: "image/png", name: "S__1.png", kind: "image" };
			if (id === "2") return { data: new TextEncoder().encode("a,b\n1,2"), type: "application/octet-stream", name: "t.csv", kind: "file" };
			if (id === "4") return { data: sheet, type: XLSX, name: "活動預算.xlsx", kind: "file" };
			if (id === "5") return { data: new Uint8Array(25_000_000), type: "video/mp4", name: "long.mp4", kind: "video" };
			if (id === "6") return { data: new Uint8Array([0xff, 0xd8, 0xff, 0x00]), type: "image/jpeg", name: "broken.jpg", kind: "image" };
			throw new Error("Message not found");
		},
		sendMedia: async (chatId: string, file: { data: Blob; kind: string; fileName: string; agent?: boolean }) => {
			sends.push({ chatId, kind: file.kind, fileName: file.fileName, agent: file.agent, type: file.data.type });
			return { message_id: "99" };
		},
	};
	const archive = { mediaRef: () => undefined };
	const organizer = new Organizer(join(process.env.LINE_MCP_STATE_DIR, "organizer.json"));
	const server = buildMcpServer(line as never, archive as never, {} as never, organizer, {} as never, {} as never);
	const client = new Client({ name: "test", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const chat = "u" + "a".repeat(32);
	const other = "c" + "b".repeat(32);

	const opened = await client.callTool({ name: "line_get_media", arguments: { chat_id: chat, message_id: "1" } });
	const content = opened.content as { type: string; text?: string; mimeType?: string }[];
	assert.equal(content[1].type, "image");
	assert.equal(content[1].mimeType, "image/jpeg");
	assert.match(content[0].text!, /"shown_as":"1568×392 JPEG"/);

	const csv = await client.callTool({ name: "line_get_media", arguments: { chat_id: chat, message_id: "2" } });
	assert.equal((csv.content as { text: string }[])[1].text, "a,b\n1,2");

	type Content = { type: string; text?: string; resource?: { uri: string; mimeType?: string; blob?: string } }[];
	const xlsx = (await client.callTool({ name: "line_get_media", arguments: { chat_id: chat, message_id: "4" } })).content as Content;
	assert.equal(JSON.parse(xlsx[0].text!).file_name, "活動預算.xlsx");
	assert.equal(xlsx[1].type, "resource");
	assert.equal(xlsx[1].resource!.mimeType, XLSX);
	assert.equal(xlsx[1].resource!.uri, `line://messages/4/${encodeURIComponent("活動預算.xlsx")}`);
	assert.deepEqual(new Uint8Array(Buffer.from(xlsx[1].resource!.blob!, "base64")), sheet);

	const tooBig = await client.callTool({ name: "line_get_media", arguments: { chat_id: chat, message_id: "5" } });
	assert.equal(tooBig.isError, true);
	assert.match((tooBig.content as Content)[0].text!, /^long\.mp4 is 25 MB; line_get_media returns files up to 20 MB\./);

	const broken = (await client.callTool({ name: "line_get_media", arguments: { chat_id: chat, message_id: "6" } })).content as Content;
	assert.match(JSON.parse(broken[0].text!).note, /could not be decoded/);
	assert.equal(broken[1].resource!.mimeType, "image/jpeg");

	const missing = await client.callTool({ name: "line_get_media", arguments: { chat_id: chat, message_id: "3" } });
	assert.equal(missing.isError, true);

	await client.callTool({ name: "line_forward_media", arguments: { from_chat_id: chat, message_id: "1", to_chat_id: other } });
	assert.deepEqual(sends.at(-1), { chatId: other, kind: "image", fileName: "S__1.png", agent: true, type: "image/png" });

	const rejected = await client.callTool({ name: "line_send_file", arguments: { chat_id: other, file_name: "x.pdf", content: "hi" } });
	assert.equal(rejected.isError, true);
	await client.callTool({ name: "line_send_file", arguments: { chat_id: other, file_name: "清單.md", content: "# 清單" } });
	assert.deepEqual(sends.at(-1), { chatId: other, kind: "file", fileName: "清單.md", agent: true, type: "text/markdown; charset=utf-8" });
	await client.close();
});
