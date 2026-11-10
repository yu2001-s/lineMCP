import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { foldForSearch } from "./text.ts";

const MID_RE = /^[ucr][0-9a-f]{32}$/;
const MAX_CHATS = 5_000;
const MAX_NAME = 200;
const MAX_TAG = 40;
const MAX_TAGS = 500;
const MAX_TAGS_PER_CHAT = 30;
const MAX_TAG_OPS = 200;
/** Agents' hides kept for replay onto a save from a Mac that was offline. */
const MAX_HIDE_OPS = 1_000;

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

export interface OrganizerState {
	hidden: HiddenChat[];
	tags: TaggedChat[];
	/** Goes up with every change, so a client can tell the newer of two copies. */
	rev: number;
	/** When a desktop client last saved hidden chats; 0 until one has. */
	updated_ms: number;
}

/**
 * What organizer.json held before tags replaced folders (betterLINE's 群組):
 * each folder's chats are given a tag named after it when it is loaded.
 */
interface LegacyFolder {
	id: string;
	name: string;
	chat_ids: string[];
}

/** Thrown for a body the desktop client should not have sent. */
export class OrganizerInputError extends Error {}

/**
 * The owner's hidden chats and tags. The betterLINE desktop app saves its
 * whole copy of hidden chats; agents hide chats one at a time, and a save
 * from a Mac that had not seen an agent's hide yet gets it replayed on top.
 * Tags are changed by the desktop app and the MCP tools alike, one TagOp at a
 * time, and a desktop save of hidden chats leaves them alone.
 */
export class Organizer {
	readonly #path: string;
	#state: OrganizerState = { hidden: [], tags: [], rev: 0, updated_ms: 0 };
	/** Agents' hides, oldest first, with the revision each made. */
	#hideOps: { rev: number; chats: HiddenChat[] }[] = [];
	#hidden = new Set<string>();
	#tagsOf = new Map<string, string[]>();
	/**
	 * Folder id → name for folders turned into tags when this file was
	 * loaded, so listeners that followed a folder can follow its tag.
	 */
	readonly migratedFolders = new Map<string, string>();
	/** Called after every change, from either side. */
	onChange?: () => void;
	/** Called for every tag renamed, with its old and new spelling. */
	onTagRename?: (from: string, to: string) => void;

	constructor(path: string) {
		this.#path = path;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		let raw: string;
		try {
			raw = readFileSync(path, "utf-8");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
			return;
		}
		const { hide_ops, folder_ops: _, folders, ...state } = JSON.parse(raw) as OrganizerState & {
			hide_ops?: { rev: number; chats: HiddenChat[] }[];
			folder_ops?: unknown;
			folders?: LegacyFolder[];
		};
		this.#hideOps = hide_ops ?? [];
		this.#use(state);
		if (folders) this.#migrateFolders(folders);
	}

	state(): OrganizerState {
		return this.#state;
	}

	/**
	 * Replaces hidden chats with what the desktop client sent. Tags stay.
	 * `baseRev` is the revision whose agent hides the client's copy already
	 * has; later ones are applied on top. Without it (an older client) the
	 * client's copy wins.
	 */
	replace(input: unknown, baseRev?: number): OrganizerState {
		let hidden = parseOrganizer(input).hidden;
		if (baseRev !== undefined) {
			for (const op of this.#hideOps) if (op.rev > baseRev) hidden = withHidden(hidden, op.chats);
		}
		return this.#save({ ...this.#state, hidden, updated_ms: Date.now() });
	}

	/** Hides chats for an agent. */
	hide(chats: HiddenChat[]): OrganizerState {
		const hidden = withHidden(this.#state.hidden, chats);
		if (hidden.length > MAX_CHATS) throw new OrganizerInputError(`at most ${MAX_CHATS} hidden chats`);
		this.#hideOps = [...this.#hideOps, { rev: this.#state.rev + 1, chats }].slice(-MAX_HIDE_OPS);
		return this.#save({ ...this.#state, hidden });
	}

	/** Applies tag changes in order, all or none. */
	changeTags(input: unknown): OrganizerState {
		const ops = parseTagOps(input);
		const tags = new Map(this.#tagsOf);
		const renames: [string, string][] = [];
		for (const op of ops) {
			const before = op.op === "rename" ? spellingOf(tags, op.tags[0]) : undefined;
			applyTagOp(tags, op);
			if (op.op === "rename" && before) renames.push([before, spellingOf(tags, op.to) ?? op.to]);
		}
		const names = new Set([...tags.values()].flat());
		if (names.size > MAX_TAGS) throw new OrganizerInputError(`at most ${MAX_TAGS} different tags`);
		if (tags.size > MAX_CHATS) throw new OrganizerInputError(`at most ${MAX_CHATS} tagged chats`);
		const list = [...tags].map(([chat_id, chatTags]) => ({ chat_id, tags: chatTags }));
		const saved = this.#save({ ...this.#state, tags: list.sort((a, b) => a.chat_id.localeCompare(b.chat_id)) });
		for (const [from, to] of renames) this.onTagRename?.(from, to);
		return saved;
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

	/** Gives each folder's chats a tag named after the folder, keeping their other tags. */
	#migrateFolders(folders: LegacyFolder[]) {
		const ops: TagOp[] = [];
		for (const f of folders) {
			let name: string;
			try {
				name = tagName(f.name);
			} catch {
				name = tagName([...f.name.trim()].slice(0, MAX_TAG).join(""));
			}
			this.migratedFolders.set(f.id, name);
			const chats = f.chat_ids.filter((id) => MID_RE.test(id));
			if (chats.length) ops.push({ op: "add", tags: [name], chat_ids: chats });
		}
		if (ops.length) this.changeTags(ops);
		else this.#save(this.#state);
		console.log(`[organizer] turned ${folders.length} folder(s) into tags: ${[...this.migratedFolders.values()].join(", ")}`);
	}

	#save(state: OrganizerState): OrganizerState {
		state = { ...state, rev: this.#state.rev + 1 };
		const tmp = `${this.#path}.tmp`;
		writeFileSync(tmp, JSON.stringify({ ...state, hide_ops: this.#hideOps }), { mode: 0o600 });
		renameSync(tmp, this.#path);
		this.#use(state);
		this.onChange?.();
		return state;
	}

	#use(state: OrganizerState) {
		// Files written before tags existed have neither tags nor rev.
		this.#state = { hidden: state.hidden ?? [], tags: state.tags ?? [], rev: state.rev ?? 0, updated_ms: state.updated_ms ?? 0 };
		this.#hidden = new Set(this.#state.hidden.map((h) => h.chat_id));
		this.#tagsOf = new Map(this.#state.tags.map((t) => [t.chat_id, t.tags]));
	}
}

function withHidden(hidden: HiddenChat[], chats: HiddenChat[]): HiddenChat[] {
	const ids = new Set(hidden.map((h) => h.chat_id));
	return [...hidden, ...chats.filter((c) => !ids.has(c.chat_id) && ids.add(c.chat_id))];
}

/** How `name` is spelled among the tags, if some chat has it. */
function spellingOf(tags: Map<string, string[]>, name: string): string | undefined {
	const fold = foldForSearch(name);
	for (const list of tags.values()) {
		const found = list.find((t) => foldForSearch(t) === fold);
		if (found) return found;
	}
	return undefined;
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
 * Validates a client body: the hidden chats. A `folders` field, sent by
 * betterLINE builds from before tags replaced folders, is ignored.
 */
export function parseOrganizer(input: unknown): Pick<OrganizerState, "hidden"> {
	const body = input as { hidden?: unknown } | null;
	if (!body || !Array.isArray(body.hidden)) throw new OrganizerInputError("hidden must be an array");
	if (body.hidden.length > MAX_CHATS) throw new OrganizerInputError(`at most ${MAX_CHATS} chats`);
	const hiddenIds = new Set<string>();
	const hidden = body.hidden.flatMap((raw): HiddenChat[] => {
		const h = raw as Partial<HiddenChat> | null;
		if (typeof h?.chat_id !== "string" || !MID_RE.test(h.chat_id)) throw new OrganizerInputError("invalid hidden chat id");
		if (hiddenIds.has(h.chat_id)) return [];
		hiddenIds.add(h.chat_id);
		return [{ chat_id: h.chat_id, name: typeof h.name === "string" ? h.name.slice(0, MAX_NAME) : "" }];
	});
	return { hidden };
}
