import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

export const MAX_UPLOAD_BYTES = 100 << 20;
const UPLOAD_TTL_MS = 60 * 60_000;
export const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{32}$/;

/** Carries the HTTP status the uploader should get. */
export class UploadError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

interface Upload {
	fileName: string;
	expires: number;
	size?: number;
}

/**
 * Files an agent sends on LINE that it cannot pass as text: line_create_upload
 * makes a one-time URL, the agent PUTs the file there through the Worker, and
 * line_send_file sends it by upload_id. An upload is kept, owner-only, for an
 * hour so one file can go to several chats. A restart forgets them all.
 */
export class Uploads {
	readonly #dir: string;
	readonly #maxBytes: number;
	#uploads = new Map<string, Upload>();

	constructor(dir: string, maxBytes = MAX_UPLOAD_BYTES) {
		this.#dir = dir;
		this.#maxBytes = maxBytes;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true });
	}

	create(fileName: string, now = Date.now()): { id: string; expires: number } {
		this.#sweep(now);
		const id = randomBytes(24).toString("base64url");
		const expires = now + UPLOAD_TTL_MS;
		this.#uploads.set(id, { fileName, expires });
		return { id, expires };
	}

	/** Stores the file PUT to an upload's URL. Each URL takes one file. */
	async receive(id: string, body: AsyncIterable<Uint8Array>): Promise<{ file_name: string; size: number }> {
		this.#sweep();
		const upload = this.#uploads.get(id);
		if (!upload) throw new UploadError(404, "Unknown or expired upload URL; make a new one with line_create_upload.");
		if (upload.size !== undefined) throw new UploadError(409, "A file was already uploaded to this URL.");
		const path = join(this.#dir, id);
		const fd = openSync(path, "wx", 0o600);
		let size = 0;
		try {
			for await (const chunk of body) {
				size += chunk.length;
				if (size > this.#maxBytes) throw new UploadError(413, `The file is larger than ${this.#maxBytes >> 20} MB.`);
				writeSync(fd, chunk);
			}
		} catch (e) {
			closeSync(fd);
			rmSync(path, { force: true });
			throw e;
		}
		closeSync(fd);
		if (size === 0) {
			rmSync(path, { force: true });
			throw new UploadError(400, "The upload was empty.");
		}
		upload.size = size;
		return { file_name: upload.fileName, size };
	}

	/** An uploaded file, for sending. */
	read(id: string): { fileName: string; data: Buffer } {
		this.#sweep();
		const upload = this.#uploads.get(id);
		if (!upload) throw new Error("Unknown or expired upload_id; make a new upload with line_create_upload.");
		if (upload.size === undefined) {
			throw new Error("Nothing has been uploaded to this upload_id yet: PUT the file to its url first.");
		}
		return { fileName: upload.fileName, data: readFileSync(join(this.#dir, id)) };
	}

	#sweep(now = Date.now()) {
		for (const [id, upload] of this.#uploads) {
			if (upload.expires > now) continue;
			this.#uploads.delete(id);
			rmSync(join(this.#dir, id), { force: true });
		}
	}
}
