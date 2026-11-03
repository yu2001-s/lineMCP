import { extname } from "node:path";
import sharp from "sharp";

/** Longest edge of a photo handed to Claude: enough to read a screenshot. */
export const PREVIEW_EDGE = 1568;
/** Text returned from a file, in characters. */
export const TEXT_LIMIT = 100_000;
/** Largest file returned whole, in bytes: about 27 MB once base64-encoded. */
export const FILE_LIMIT = 20_000_000;

export interface ImagePreview {
	base64: string;
	mimeType: "image/jpeg";
	width: number;
	height: number;
	originalWidth?: number;
	originalHeight?: number;
}

/** A JPEG of the photo, upright and no larger than PREVIEW_EDGE on either side. */
export async function previewImage(data: Uint8Array): Promise<ImagePreview> {
	const image = sharp(data, { failOn: "none" });
	const meta = await image.metadata();
	const { data: jpeg, info } = await image
		.rotate()
		.resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: "inside", withoutEnlargement: true })
		.flatten({ background: "#ffffff" })
		.jpeg({ quality: 82 })
		.toBuffer({ resolveWithObject: true });
	return {
		base64: jpeg.toString("base64"),
		mimeType: "image/jpeg",
		width: info.width,
		height: info.height,
		originalWidth: meta.autoOrient?.width ?? meta.width,
		originalHeight: meta.autoOrient?.height ?? meta.height,
	};
}

const TEXT_EXTENSIONS: Record<string, string> = {
	".txt": "text/plain",
	".md": "text/markdown",
	".csv": "text/csv",
	".tsv": "text/tab-separated-values",
	".json": "application/json",
	".html": "text/html",
	".xml": "application/xml",
	".yaml": "application/yaml",
	".yml": "application/yaml",
	".log": "text/plain",
	".ics": "text/calendar",
	".vcf": "text/vcard",
	".srt": "application/x-subrip",
};

/** The media type for a text file Claude may send, or undefined for any other kind of name. */
export function textFileType(name: string): string | undefined {
	return TEXT_EXTENSIONS[extname(name).toLowerCase()];
}

/** Photos and videos every LINE client shows inline; anything else goes as a file. */
const INLINE_EXTENSIONS: Record<string, { kind: "image" | "video"; type: string }> = {
	".jpg": { kind: "image", type: "image/jpeg" },
	".jpeg": { kind: "image", type: "image/jpeg" },
	".png": { kind: "image", type: "image/png" },
	".gif": { kind: "image", type: "image/gif" },
	".mp4": { kind: "video", type: "video/mp4" },
	".mov": { kind: "video", type: "video/quicktime" },
	".m4v": { kind: "video", type: "video/x-m4v" },
};

const FILE_TYPES: Record<string, string> = {
	...TEXT_EXTENSIONS,
	...Object.fromEntries(Object.entries(INLINE_EXTENSIONS).map(([ext, { type }]) => [ext, type])),
	".pdf": "application/pdf",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".ppt": "application/vnd.ms-powerpoint",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".odt": "application/vnd.oasis.opendocument.text",
	".ods": "application/vnd.oasis.opendocument.spreadsheet",
	".odp": "application/vnd.oasis.opendocument.presentation",
	".rtf": "application/rtf",
	".zip": "application/zip",
	".rar": "application/vnd.rar",
	".7z": "application/x-7z-compressed",
	".gz": "application/gzip",
	".tar": "application/x-tar",
	".webp": "image/webp",
	".heic": "image/heic",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
};

/** 215097 → "215 KB", as Finder counts. */
export function formatSize(bytes: number): string {
	if (bytes < 1000) return `${bytes} bytes`;
	if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
	return `${Number((bytes / 1_000_000).toFixed(1))} MB`;
}

/** The media type for a file name, or undefined for an extension not listed here. */
export function fileType(name: string): string | undefined {
	return FILE_TYPES[extname(name).toLowerCase()];
}

/** The media type the first bytes of a file show, for files LINE hands over unnamed. */
export function sniffType(data: Uint8Array): string | undefined {
	const ascii = (from: number, to: number) => String.fromCharCode(...data.subarray(from, to));
	if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
	if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
	if (ascii(0, 4) === "GIF8") return "image/gif";
	if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
	if (ascii(0, 5) === "%PDF-") return "application/pdf";
	if (ascii(0, 4) === "PK\x03\x04") return "application/zip";
	if (ascii(4, 8) === "ftyp") {
		const brand = ascii(8, 12);
		if (["heic", "heix", "mif1"].includes(brand)) return "image/heic";
		if (brand === "M4A ") return "audio/mp4";
		if (brand === "qt  ") return "video/quicktime";
		return "video/mp4";
	}
	return undefined;
}

/**
 * The type LINE gave when it is a real one; otherwise from the name, then the
 * content. linejs hands end-to-end encrypted downloads over with no type at all.
 */
export function mediaType(name: string, data: Uint8Array, given = ""): string {
	const bare = given.split(";")[0].trim().toLowerCase();
	if (bare && bare !== "application/octet-stream") return given;
	return fileType(name) ?? sniffType(data) ?? "application/octet-stream";
}

/** How an uploaded file goes out: as a photo or video, or as a file attachment. */
export function sendKind(name: string, asFile: boolean): { kind: "image" | "video" | "file"; type: string } {
	const inline = INLINE_EXTENSIONS[extname(name).toLowerCase()];
	if (inline && !asFile) return inline;
	return { kind: "file", type: fileType(name) ?? "application/octet-stream" };
}

export function isTextFile(type: string, name: string): boolean {
	const bare = type.split(";")[0].trim().toLowerCase();
	return bare.startsWith("text/") || Object.values(TEXT_EXTENSIONS).includes(bare) || textFileType(name) !== undefined;
}

/** The file as UTF-8 text, cut at TEXT_LIMIT; undefined when it is not valid UTF-8. */
export function readText(data: Uint8Array): { text: string; truncated: boolean } | undefined {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(data);
	} catch {
		return undefined;
	}
	return text.length > TEXT_LIMIT
		? { text: text.slice(0, TEXT_LIMIT), truncated: true }
		: { text, truncated: false };
}
