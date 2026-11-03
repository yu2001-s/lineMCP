import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mediaType } from "./mediatools.ts";

/**
 * 2 GiB. Written with `**`: `2 << 30` overflows JavaScript's 32-bit shift to a
 * negative number, which made every write evict the whole cache.
 */
export const MEDIA_CACHE_BYTES = 2 * 1024 ** 3;

export interface CachedMedia {
	data: Uint8Array;
	type: string;
	name: string;
	/** LINE's kind and voice/video length, for forwarding; absent in older entries. */
	kind?: "image" | "video" | "audio" | "file";
	durationMs?: number;
}

export function readCache(dir: string, id: string): CachedMedia | undefined {
	try {
		const meta = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf-8"));
		const data = readFileSync(join(dir, id));
		// Entries written before downloads were typed say application/octet-stream.
		return { ...meta, data, type: mediaType(meta.name ?? "", data, meta.type) };
	} catch {
		return undefined;
	}
}

/** Decrypted media stays on the encrypted disk, owner-only, capped by evicting the oldest. */
export function writeCache(dir: string, id: string, media: CachedMedia, limit = MEDIA_CACHE_BYTES) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, id), media.data, { mode: 0o600 });
	const { type, name, kind, durationMs } = media;
	writeFileSync(join(dir, `${id}.json`), JSON.stringify({ type, name, kind, durationMs }), { mode: 0o600 });
	const files = readdirSync(dir)
		.filter((f) => !f.endsWith(".json"))
		.map((f) => {
			const { size, mtimeMs } = statSync(join(dir, f));
			return { f, size, mtimeMs };
		})
		.sort((a, b) => a.mtimeMs - b.mtimeMs);
	let total = files.reduce((n, x) => n + x.size, 0);
	for (const x of files) {
		if (total <= limit) break;
		unlinkSync(join(dir, x.f));
		try {
			unlinkSync(join(dir, `${x.f}.json`));
		} catch { /* already gone */ }
		total -= x.size;
	}
}
