import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Archive, ArchiveSync } from "./archive.ts";
import { config } from "./config.ts";
import { readCache, writeCache } from "./mediacache.ts";
import { type Organizer, OrganizerInputError } from "./organizer.ts";
import {
	errorMessage,
	type LineEvent,
	type LineService,
	type MediaKind,
	REACTIONS,
	type ReactionName,
} from "./line.ts";

const MAX_JSON_BYTES = 1 << 20;
const MAX_UPLOAD_BYTES = 100 << 20;
const HEARTBEAT_MS = 25_000;
const MEDIA_KINDS = new Set<MediaKind>(["image", "video", "audio", "file"]);

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/**
 * API for the betterLINE desktop app. Reachable only on the Tailscale address,
 * and every request must carry the client key.
 */
export function startClientApi(line: LineService, archive: Archive, sync: ArchiveSync, organizer: Organizer) {
	const expectedKey = Buffer.from(config.clientKey);
	const cacheDir = config.mediaCacheDir;
	mkdirSync(cacheDir, { recursive: true, mode: 0o700 });

	const routes: [string, RegExp, (req: IncomingMessage, url: URL, m: RegExpExecArray, res: ServerResponse) => Promise<unknown>][] = [
		["GET", /^\/api\/me$/, async () => ({ ...line.me, status: line.status })],
		["GET", /^\/api\/chats$/, async (_req, url) => ({
			chats: await line.clientChats(url.searchParams.get("unread_only") === "1"),
		})],
		["GET", /^\/api\/contacts$/, async (_req, url) => ({
			contacts: await line.clientContacts(url.searchParams.get("q")?.trim() ?? ""),
		})],
		["GET", /^\/api\/chats\/([ucr][0-9a-f]{32})\/messages$/, async (_req, url, m) => {
			const chatId = m[1];
			const limit = clamp(Number(url.searchParams.get("limit") ?? 50), 1, 200);
			const before = url.searchParams.get("before") ?? undefined;
			// Cursors: "l:<delivered>_<id>" pages LINE's 14 days, "a:<ms>" pages the archive.
			if (before?.startsWith("a:")) {
				const page = archive.readClient(chatId, { beforeMs: Number(before.slice(2)), limit });
				return { messages: page.messages, older_cursor: page.older_cursor && `a:${page.older_cursor}` };
			}
			const page = await line.clientMessages(chatId, limit, before?.replace(/^l:/, ""));
			if (page.older_cursor) return { messages: page.messages, older_cursor: `l:${page.older_cursor}` };
			// LINE has nothing older; an archived chat continues from the local copy.
			const oldest = page.messages[0]?.time_ms;
			const archived = archive.isArchived(chatId) && oldest !== undefined;
			return { messages: page.messages, older_cursor: archived ? `a:${oldest}` : undefined };
		}],
		["POST", /^\/api\/chats\/([ucr][0-9a-f]{32})\/messages$/, async (req, _url, m) => {
			const body = await readJson(req) as { text?: string; reply_to?: string };
			if (!body.text?.trim()) throw new HttpError(400, "text is required");
			const sent = await line.sendMessage({
				chatId: m[1],
				text: body.text,
				replyTo: body.reply_to,
				agent: false,
			});
			return { message_id: sent.message_id };
		}],
		["POST", /^\/api\/chats\/([ucr][0-9a-f]{32})\/sticker$/, async (req, _url, m) => {
			const body = await readJson(req) as { package_id?: string; sticker_id?: string; version?: string };
			if (!body.package_id || !body.sticker_id) throw new HttpError(400, "package_id and sticker_id are required");
			return await line.sendSticker(m[1], {
				packageId: body.package_id,
				stickerId: body.sticker_id,
				version: body.version ?? "1",
			});
		}],
		["POST", /^\/api\/chats\/([ucr][0-9a-f]{32})\/media$/, async (req, url, m) => {
			const kind = url.searchParams.get("kind") as MediaKind;
			if (!MEDIA_KINDS.has(kind)) throw new HttpError(400, "kind must be image, video, audio or file");
			const fileName = url.searchParams.get("name") || `upload.${kind === "image" ? "jpg" : "bin"}`;
			const bytes = await readBody(req, MAX_UPLOAD_BYTES);
			const duration = Number(url.searchParams.get("duration_ms"));
			return await line.sendMedia(m[1], {
				data: new Blob([new Uint8Array(bytes)], { type: req.headers["content-type"] ?? "application/octet-stream" }),
				kind,
				fileName,
				durationMs: Number.isFinite(duration) && duration > 0 ? duration : undefined,
			});
		}],
		["GET", /^\/api\/chats\/([ucr][0-9a-f]{32})\/reads$/, async (_req, _url, m) => ({
			readers: await line.readMarkers(m[1]),
		})],
		["POST", /^\/api\/chats\/([ucr][0-9a-f]{32})\/read$/, async (req, _url, m) => {
			const body = await readJson(req) as { message_id?: string };
			if (!body.message_id) throw new HttpError(400, "message_id is required");
			await line.markRead(m[1], body.message_id);
			return {};
		}],
		["POST", /^\/api\/messages\/(\d+)\/unsend$/, async (_req, _url, m) => {
			await line.unsend(m[1]);
			return {};
		}],
		["POST", /^\/api\/messages\/(\d+)\/react$/, async (req, _url, m) => {
			const body = await readJson(req) as { type?: string };
			const type = body.type as ReactionName;
			if (type !== "UNDO" && !REACTIONS.includes(type as typeof REACTIONS[number])) {
				throw new HttpError(400, `type must be one of ${REACTIONS.join(", ")} or UNDO`);
			}
			await line.react(m[1], type);
			return {};
		}],
		["GET", /^\/api\/media\/(\d+)$/, async (_req, url, m, res) => {
			const messageId = m[1];
			const chatId = url.searchParams.get("chat") ?? "";
			const delivered = url.searchParams.get("delivered") ?? "0";
			const cached = readCache(cacheDir, messageId);
			const media = cached ?? await line.downloadMedia(chatId, messageId, delivered, archive.mediaRef(messageId));
			if (!cached) writeCache(cacheDir, messageId, media);
			res.writeHead(200, {
				"content-type": media.type,
				"content-length": media.data.length,
				"content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(media.name)}`,
				"cache-control": "private, max-age=31536000, immutable",
			});
			res.end(media.data);
			return RESPONDED;
		}],
		["GET", /^\/api\/search$/, async (_req, url) => {
			const q = url.searchParams.get("q")?.trim();
			if (!q) throw new HttpError(400, "q is required");
			return {
				results: archive.searchClient(q, {
					chatId: url.searchParams.get("chat_id") ?? undefined,
					limit: clamp(Number(url.searchParams.get("limit") ?? 50), 1, 200),
				}),
			};
		}],
		["GET", /^\/api\/archive$/, async () => ({ rules: archive.policy(), chats: archive.chats() })],
		["POST", /^\/api\/archive\/sync$/, async () => ({ results: await sync.syncAll() })],
		["GET", /^\/api\/organizer$/, async () => forOlderApps(organizer.state())],
		["PUT", /^\/api\/organizer$/, async (req) => {
			const body = await readJson(req) as { base_rev?: unknown };
			const baseRev = typeof body.base_rev === "number" ? body.base_rev : undefined;
			return forOlderApps(organizerInput(() => organizer.replace(body, baseRev)));
		}],
		["POST", /^\/api\/organizer\/tags$/, async (req) => {
			const body = await readJson(req) as { ops?: unknown };
			return forOlderApps(organizerInput(() => organizer.changeTags(body.ops)));
		}],
	];

	const server = createServer(async (req, res) => {
		try {
			if (!authorized(req, expectedKey)) throw new HttpError(401, "unauthorized");
			const url = new URL(req.url ?? "/", "http://localhost");
			if (req.method === "GET" && url.pathname === "/api/events") return streamEvents(line, req, res);
			for (const [method, pattern, handler] of routes) {
				const match = pattern.exec(url.pathname);
				if (!match || method !== req.method) continue;
				const result = await handler(req, url, match, res);
				if (result !== RESPONDED) json(res, 200, result);
				return;
			}
			throw new HttpError(404, "not found");
		} catch (e) {
			const status = e instanceof HttpError ? e.status : 502;
			if (!(e instanceof HttpError)) console.error("[client-api]", req.method, req.url?.split("?")[0], errorMessage(e));
			if (!res.headersSent) json(res, status, { error: errorMessage(e) });
			else res.end();
		}
	});
	server.requestTimeout = 0; // the event stream stays open
	const listen = () =>
		server.listen(config.clientPort, config.clientHost, () => {
			console.log(`[client-api] listening on http://${config.clientHost}:${config.clientPort}`);
		});
	// At boot the Tailscale address may not exist yet.
	server.on("error", (e: NodeJS.ErrnoException) => {
		if (e.code !== "EADDRNOTAVAIL") throw e;
		console.error("[client-api] Tailscale address not up yet; retrying in 10s");
		setTimeout(listen, 10_000);
	});
	listen();
	return server;
}

const RESPONDED = Symbol("responded");

/**
 * betterLINE builds from before tags replaced folders fail to read an
 * organizer without `folders`; an empty list makes them drop their folders.
 */
function forOlderApps<T extends object>(state: T): T & { folders: [] } {
	return { ...state, folders: [] };
}

function organizerInput<T>(change: () => T): T {
	try {
		return change();
	} catch (e) {
		if (e instanceof OrganizerInputError) throw new HttpError(400, e.message);
		throw e;
	}
}

function streamEvents(line: LineService, req: IncomingMessage, res: ServerResponse) {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-store",
		connection: "keep-alive",
	});
	const send = (event: LineEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
	send({ type: "status", status: line.status });
	line.events.on("event", send);
	const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
	req.on("close", () => {
		clearInterval(heartbeat);
		line.events.off("event", send);
	});
}

function authorized(req: IncomingMessage, expected: Buffer): boolean {
	const header = req.headers.authorization ?? "";
	const given = Buffer.from(header.replace(/^Bearer /, ""));
	return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new HttpError(413, "body too large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const body = await readBody(req, MAX_JSON_BYTES);
	try {
		return JSON.parse(body.toString("utf-8") || "{}");
	} catch {
		throw new HttpError(400, "invalid JSON");
	}
}

function json(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

function clamp(n: number, min: number, max: number) {
	return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : min;
}
