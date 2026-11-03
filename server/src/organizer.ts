import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { foldForSearch } from "./text.ts";

const MID_RE = /^[ucr][0-9a-f]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FOLDERS = 100;
const MAX_CHATS = 5_000;
const MAX_NAME = 200;
const MAX_TAG = 40;
const MAX_TAGS = 500;
const MAX_TAGS_PER_CHAT = 30;
const MAX_TAG_OPS = 200;
/** Agent folder changes kept for replay onto a save from a Mac that was offline. */
const MAX_FOLDER_OPS = 1_000;

/** A sidebar folder in betterLINE (the app calls them 群組). */
export interface Folder {
	id: string;
	name: string;
	chat_ids: string[];
}

export interface HiddenChat {
	chat_id: string;
	/** The chat's name when it was hidden. */
	name: string;
}

/** A chat's tags, sorted. Chats without tags are not listed. */
export interface TaggedChat {
	chat_id: string;
	tags: string[];
}

/**
 * One change to tags. Tags are only ever changed by these, from the desktop
 * app or the MCP tools, so neither side's change overwrites the other's.
 */
export type TagOp =
	| { op: "add" | "remove"; tags: string[]; chat_ids: string[] }
	| { op: "rename"; tags: [string]; to: string }
	| { op: "delete"; tags: [string] };

/**
 * One change an agent made to folders or hidden chats. A desktop save carries
 * its whole copy of both, so these are kept with the revision they made and
 * replayed on top of a save from a Mac that had not seen them yet.
 */
export type FolderOp =
	| { op: "create"; folder_id: string; name: string }
	| { op: "rename"; folder_id: string; name: string }
	| { op: "position"; folder_id: string; index: number }
	| { op: "delete"; folder_id: string }
	/** Into a folder, or out of every folder with `folder_id: null`. */
	| { op: "move"; chat_ids: string[]; folder_id: string | null }
	| { op: "hide"; chats: HiddenChat[] };

type Arrangement = Pick<OrganizerState, "folders" | "hidden">;

export interface OrganizerState {
	folders: Folder[];
	hidden: HiddenChat[];
	tags: TaggedChat[];
	/** Goes up with every change, so a client can tell the newer of two copies. */
	rev: number;
	/** When a desktop client last saved folders and hidden chats; 0 until one has. */
	updated_ms: number;
}

/** Thrown for a body the desktop client should not have sent. */
export class OrganizerInputError extends Error {}

/**
 * The owner's folders, hidden chats and tags. The betterLINE desktop app saves
 * its whole copy of folders and hidden chats; agents change them one FolderOp
 * at a time, and a save from a Mac that had not seen an agent's change yet
 * gets it replayed on top. Tags live here: the desktop app and the MCP tools
 * both change them, one TagOp at a time, and a desktop save of its folders
 * leaves them alone.
 */
export class Organizer {
	readonly #path: string;
	#state: OrganizerState = { folders: [], hidden: [], tags: [], rev: 0, updated_ms: 0 };
	/** Agents' folder changes, oldest first, with the revision each made. */
	#folderOps: { rev: number; op: FolderOp }[] = [];
	#hidden = new Set<string>();
	#folderOf = new Map<string, Folder>();
	#tagsOf = new Map<string, string[]>();
	/** Called after every change, from either side. */
	onChange?: () => void;

	constructor(path: string) {
		this.#path = path;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		try {
			const { folder_ops, ...state } = JSON.parse(readFileSync(path, "utf-8"));
			this.#folderOps = folder_ops ?? [];
			this.#use(state);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}
	}

	state(): OrganizerState {
		return this.#state;
	}

	/**
	 * Replaces folders and hidden chats with what the desktop client sent. Tags
	 * stay. `baseRev` is the revision whose agent changes the client's copy
	 * already has; later ones are applied on top. Without it (an older client)
	 * the client's copy wins.
	 */
	replace(input: unknown, baseRev?: number): OrganizerState {
		let next = parseOrganizer(input);
		if (baseRev !== undefined) {
			const aliases = new Map<string, string>();
			for (const { rev, op } of this.#folderOps) if (rev > baseRev) next = applyFolderOp(next, op, aliases);
		}
		return this.#save({ ...this.#state, ...next, updated_ms: Date.now() });
	}

	/** Applies an agent's folder changes in order, all or none. */
	changeFolders(ops: FolderOp[]): OrganizerState {
		let next: Arrangement = this.#state;
		for (const op of ops) next = applyFolderOp(next, op);
		if (next.folders.length > MAX_FOLDERS) throw new OrganizerInputError(`at most ${MAX_FOLDERS} folders`);
		const rev = this.#state.rev + 1;
		this.#folderOps = [...this.#folderOps, ...ops.map((op) => ({ rev, op }))].slice(-MAX_FOLDER_OPS);
		return this.#save({ ...this.#state, ...next });
	}

	/** Applies tag changes in order, all or none. */
	changeTags(input: unknown): OrganizerState {
		const ops = parseTagOps(input);
		const tags = new Map(this.#tagsOf);
		for (const op of ops) applyTagOp(tags, op);
		const names = new Set([...tags.values()].flat());
		if (names.size > MAX_TAGS) throw new OrganizerInputError(`at most ${MAX_TAGS} different tags`);
		if (tags.size > MAX_CHATS) throw new OrganizerInputError(`at most ${MAX_CHATS} tagged chats`);
		const list = [...tags].map(([chat_id, chatTags]) => ({ chat_id, tags: chatTags }));
		return this.#save({ ...this.#state, tags: list.sort((a, b) => a.chat_id.localeCompare(b.chat_id)) });
	}

	addTags(chatIds: string[], tags: string[]): OrganizerState {
		return this.changeTags([{ op: "add", chat_ids: chatIds, tags }]);
	}

	removeTags(chatIds: string[], tags: string[]): OrganizerState {
		return this.changeTags([{ op: "remove", chat_ids: chatIds, tags }]);
	}

	isHidden(chatId: string): boolean {
		return this.#hidden.has(chatId);
	}

	folderOf(chatId: string): Folder | undefined {
		return this.#folderOf.get(chatId);
	}

	/** By name, ignoring case, width and Traditional/Simplified Chinese. */
	folderNamed(name: string): Folder | undefined {
		const wanted = foldForSearch(name.trim());
		return this.#state.folders.find((f) => foldForSearch(f.name) === wanted);
	}

	tagsOf(chatId: string): string[] {
		return this.#tagsOf.get(chatId) ?? [];
	}

	/** Every tag with the chats that have it, by name. */
	tagList(): { name: string; chat_ids: string[] }[] {
		const chatsOf = new Map<string, string[]>();
		for (const { chat_id, tags } of this.#state.tags) {
			for (const tag of tags) {
				const chats = chatsOf.get(tag);
				if (chats) chats.push(chat_id);
				else chatsOf.set(tag, [chat_id]);
			}
		}
		return [...chatsOf].map(([name, chat_ids]) => ({ name, chat_ids })).sort((a, b) => a.name.localeCompare(b.name));
	}

	/** The existing tag spelled like `name`, ignoring case, width and Traditional/Simplified Chinese. */
	tagNamed(name: string): string | undefined {
		const wanted = foldForSearch(name.trim().replace(/\s+/g, " "));
		return this.tagList().find((t) => foldForSearch(t.name) === wanted)?.name;
	}

	#save(state: OrganizerState): OrganizerState {
		state = { ...state, rev: this.#state.rev + 1 };
		const tmp = `${this.#path}.tmp`;
		writeFileSync(tmp, JSON.stringify({ ...state, folder_ops: this.#folderOps }), { mode: 0o600 });
		renameSync(tmp, this.#path);
		this.#use(state);
		this.onChange?.();
		return state;
	}

	#use(state: OrganizerState) {
		// Files written before tags existed have neither tags nor rev.
		this.#state = { ...state, tags: state.tags ?? [], rev: state.rev ?? 0 };
		this.#hidden = new Set(state.hidden.map((h) => h.chat_id));
		this.#folderOf = new Map(state.folders.flatMap((f) => f.chat_ids.map((id) => [id, f] as const)));
		this.#tagsOf = new Map(this.#state.tags.map((t) => [t.chat_id, t.tags]));
	}
}

/** A tag name as typed: trimmed, with runs of spaces and line breaks made one space. */
export function tagName(raw: unknown): string {
	const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
	if (!name || [...name].length > MAX_TAG || /\p{Cc}/u.test(name)) {
		throw new OrganizerInputError(`a tag must be 1–${MAX_TAG} characters`);
	}
	return name;
}

/** Validates tag changes from a client or tool. */
export function parseTagOps(input: unknown): TagOp[] {
	if (!Array.isArray(input) || input.length === 0 || input.length > MAX_TAG_OPS) {
		throw new OrganizerInputError(`ops must be a list of 1–${MAX_TAG_OPS} changes`);
	}
	return input.map((raw): TagOp => {
		const o = raw as { op?: unknown; tags?: unknown; chat_ids?: unknown; to?: unknown } | null;
		if (!Array.isArray(o?.tags) || o.tags.length === 0 || o.tags.length > MAX_TAGS_PER_CHAT) {
			throw new OrganizerInputError(`tags must be a list of 1–${MAX_TAGS_PER_CHAT} names`);
		}
		const tags = o.tags.map(tagName);
		switch (o.op) {
			case "add":
			case "remove": {
				if (!Array.isArray(o.chat_ids) || o.chat_ids.length === 0 || o.chat_ids.length > MAX_CHATS) {
					throw new OrganizerInputError(`chat_ids must be a list of 1–${MAX_CHATS} chats`);
				}
				for (const id of o.chat_ids) {
					if (typeof id !== "string" || !MID_RE.test(id)) throw new OrganizerInputError(`invalid chat id ${String(id)}`);
				}
				return { op: o.op, tags, chat_ids: o.chat_ids as string[] };
			}
			case "rename":
				if (tags.length !== 1) throw new OrganizerInputError("rename takes one tag");
				return { op: "rename", tags: [tags[0]], to: tagName(o.to) };
			case "delete":
				if (tags.length !== 1) throw new OrganizerInputError("delete takes one tag");
				return { op: "delete", tags: [tags[0]] };
			default:
				throw new OrganizerInputError("op must be add, remove, rename or delete");
		}
	});
}

/**
 * Applies one change to chat → tags. Names that differ only in case, width or
 * Traditional/Simplified Chinese are the same tag, spelled as it first was.
 */
export function applyTagOp(tags: Map<string, string[]>, op: TagOp) {
	const spelling = new Map([...tags.values()].flat().map((t) => [foldForSearch(t), t]));
	const spelled = (name: string) => {
		const fold = foldForSearch(name);
		if (!spelling.has(fold)) spelling.set(fold, name);
		return spelling.get(fold)!;
	};
	const set = (chatId: string, list: string[]) => {
		const unique = [...new Map(list.map((t) => [foldForSearch(t), t])).values()];
		if (unique.length > MAX_TAGS_PER_CHAT) throw new OrganizerInputError(`a chat can have at most ${MAX_TAGS_PER_CHAT} tags`);
		if (unique.length) tags.set(chatId, unique.sort((a, b) => a.localeCompare(b)));
		else tags.delete(chatId);
	};
	const has = (folds: Set<string>) => (t: string) => folds.has(foldForSearch(t));
	switch (op.op) {
		case "add": {
			const names = op.tags.map(spelled);
			for (const id of op.chat_ids) set(id, [...(tags.get(id) ?? []), ...names]);
			break;
		}
		case "remove": {
			const gone = has(new Set(op.tags.map(foldForSearch)));
			for (const id of op.chat_ids) set(id, (tags.get(id) ?? []).filter((t) => !gone(t)));
			break;
		}
		case "rename": {
			const from = foldForSearch(op.tags[0]);
			// Renaming to another spelling of itself respells it; to another tag, merges into it.
			const to = foldForSearch(op.to) === from ? op.to : spelled(op.to);
			const gone = has(new Set([from]));
			for (const [id, list] of [...tags]) {
				if (list.some(gone)) set(id, [...list.filter((t) => !gone(t)), to]);
			}
			break;
		}
		case "delete": {
			const gone = has(new Set([foldForSearch(op.tags[0])]));
			for (const [id, list] of [...tags]) set(id, list.filter((t) => !gone(t)));
			break;
		}
	}
}

/**
 * Applies one agent change to folders and hidden chats. A change to a folder
 * that is gone (a Mac deleted it meanwhile) does nothing. When replaying,
 * `aliases` sends changes to a folder an agent created to the folder of the
 * same name a Mac created meanwhile.
 */
export function applyFolderOp(state: Arrangement, op: FolderOp, aliases = new Map<string, string>()): Arrangement {
	const folders = state.folders.map((f) => ({ ...f, chat_ids: [...f.chat_ids] }));
	const id = (folderId: string) => aliases.get(folderId) ?? folderId;
	const index = (folderId: string) => folders.findIndex((f) => f.id === id(folderId));
	switch (op.op) {
		case "create": {
			if (index(op.folder_id) >= 0) break;
			const same = folders.find((f) => foldForSearch(f.name) === foldForSearch(op.name));
			if (same) aliases.set(op.folder_id, same.id);
			else folders.push({ id: op.folder_id, name: op.name, chat_ids: [] });
			break;
		}
		case "rename": {
			const i = index(op.folder_id);
			if (i >= 0) folders[i].name = op.name;
			break;
		}
		case "position": {
			const i = index(op.folder_id);
			if (i < 0) break;
			const [folder] = folders.splice(i, 1);
			folders.splice(Math.min(op.index, folders.length), 0, folder);
			break;
		}
		case "delete": {
			const i = index(op.folder_id);
			if (i >= 0) folders.splice(i, 1);
			break;
		}
		case "move": {
			const i = op.folder_id === null ? -1 : index(op.folder_id);
			if (op.folder_id !== null && i < 0) break;
			const moving = new Set(op.chat_ids);
			for (const f of folders) f.chat_ids = f.chat_ids.filter((chat) => !moving.has(chat));
			if (i >= 0) folders[i].chat_ids.push(...moving);
			break;
		}
		case "hide": {
			const hidden = new Set(state.hidden.map((h) => h.chat_id));
			return { folders, hidden: [...state.hidden, ...op.chats.filter((c) => !hidden.has(c.chat_id))] };
		}
	}
	return { folders, hidden: state.hidden };
}

/** Validates a client body. A chat listed in two folders stays in the first. */
export function parseOrganizer(input: unknown): Pick<OrganizerState, "folders" | "hidden"> {
	const body = input as { folders?: unknown; hidden?: unknown } | null;
	if (!body || !Array.isArray(body.folders) || !Array.isArray(body.hidden)) {
		throw new OrganizerInputError("folders and hidden must be arrays");
	}
	if (body.folders.length > MAX_FOLDERS) throw new OrganizerInputError(`at most ${MAX_FOLDERS} folders`);
	const seen = new Set<string>();
	const folders = body.folders.map((raw): Folder => {
		const f = raw as Partial<Folder> | null;
		const name = typeof f?.name === "string" ? f.name.trim() : "";
		if (typeof f?.id !== "string" || !UUID_RE.test(f.id)) throw new OrganizerInputError("folder id must be a UUID");
		if (!name || name.length > MAX_NAME) throw new OrganizerInputError("folder name must be 1–200 characters");
		if (!Array.isArray(f.chat_ids)) throw new OrganizerInputError("chat_ids must be an array");
		const chatIds = f.chat_ids.filter((id): id is string => {
			if (typeof id !== "string" || !MID_RE.test(id)) throw new OrganizerInputError(`invalid chat id ${String(id)}`);
			if (seen.has(id)) return false;
			seen.add(id);
			return true;
		});
		return { id: f.id, name, chat_ids: chatIds };
	});
	if (seen.size > MAX_CHATS || body.hidden.length > MAX_CHATS) throw new OrganizerInputError(`at most ${MAX_CHATS} chats`);
	const hiddenIds = new Set<string>();
	const hidden = body.hidden.flatMap((raw): HiddenChat[] => {
		const h = raw as Partial<HiddenChat> | null;
		if (typeof h?.chat_id !== "string" || !MID_RE.test(h.chat_id)) throw new OrganizerInputError("invalid hidden chat id");
		if (hiddenIds.has(h.chat_id)) return [];
		hiddenIds.add(h.chat_id);
		return [{ chat_id: h.chat_id, name: typeof h.name === "string" ? h.name.slice(0, MAX_NAME) : "" }];
	});
	return { folders, hidden };
}
