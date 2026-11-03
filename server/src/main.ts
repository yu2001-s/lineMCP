import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.ts";
import { errorMessage, LineService } from "./line.ts";
import { Archive, ArchiveSync } from "./archive.ts";
import { startClientApi } from "./clientapi.ts";
import { Listeners } from "./listeners.ts";
import { buildMcpServer } from "./mcp.ts";
import { Organizer } from "./organizer.ts";
import { acquireSessionLock, AtomicFileStorage } from "./storage.ts";
import { UploadError, Uploads } from "./uploads.ts";

process.umask(0o077);

if (config.backendKey.length < 32) {
	console.error("LINE_MCP_BACKEND_KEY must be set to a random secret of at least 32 characters.");
	process.exit(1);
}
const expectedKey = Buffer.from(config.backendKey);

acquireSessionLock(config.lockPath);
const line = new LineService(new AtomicFileStorage(config.storagePath));
await line.start();
console.log(`[line] session ${line.status}${line.lastError ? `: ${line.lastError}` : ""}`);
const archive = new Archive(config.archivePath);
const archiveSync = new ArchiveSync(line, archive);
archiveSync.start();
const organizer = new Organizer(config.organizerPath);
// Every Mac running betterLINE picks up changes, including tags an agent set.
organizer.onChange = () => line.events.emit("event", { type: "organizer" });
const listeners = new Listeners(config.listenersPath);
listeners.watch(line.events);
const uploads = new Uploads(config.uploadsDir);
if (config.clientHost && config.clientKey.length >= 32) {
	startClientApi(line, archive, archiveSync, organizer);
} else {
	console.log("[client-api] disabled (set LINE_CLIENT_HOST and a 32+ character LINE_CLIENT_KEY)");
}

const MAX_BODY_BYTES = 1 << 20;

const server = createServer(async (req, res) => {
	try {
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		if (path === "/healthz") {
			return json(res, 200, { ok: line.status === "ready", status: line.status });
		}
		if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
		// A file an agent PUT to its line_create_upload URL, forwarded by the Worker.
		const upload = /^\/upload\/([A-Za-z0-9_-]{32})$/.exec(path);
		if (upload) {
			if (req.method !== "PUT") {
				res.setHeader("Allow", "PUT");
				return json(res, 405, { error: "method not allowed" });
			}
			const saved = await uploads.receive(upload[1], req);
			return json(res, 200, { ...saved, upload_id: upload[1], next: "Pass upload_id to line_send_file." });
		}
		if (path !== "/mcp") return json(res, 404, { error: "not found" });
		if (req.method !== "POST") {
			res.setHeader("Allow", "POST");
			return json(res, 405, { error: "method not allowed" });
		}

		const body = await readJson(req);
		// Stateless: a fresh server/transport per request, JSON responses only,
		// so the Worker in front can proxy plain request/response pairs.
		const mcp = buildMcpServer(line, archive, archiveSync, organizer, listeners, uploads);
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		res.on("close", () => {
			transport.close();
			mcp.close();
		});
		await mcp.connect(transport);
		await transport.handleRequest(req, res, body);
	} catch (e) {
		if (e instanceof UploadError) return json(res, e.status, { error: e.message });
		console.error("[http]", e);
		if (!res.headersSent) json(res, 400, { error: errorMessage(e) });
	}
});

server.listen(config.port, config.host, () => {
	console.log(`[http] listening on http://${config.host}:${config.port}/mcp`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		server.close();
		process.exit(0);
	});
}

function authorized(req: IncomingMessage): boolean {
	const given = req.headers["x-line-mcp-key"];
	if (typeof given !== "string") return false;
	const buf = Buffer.from(given);
	return buf.length === expectedKey.length && timingSafeEqual(buf, expectedKey);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new Error("request body too large");
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function json(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}
