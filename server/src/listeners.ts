import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type ClientMessage, errorMessage, formatTime, type LineService } from "./line.ts";
import type { Organizer } from "./organizer.ts";
import { foldForSearch } from "./text.ts";

const TIMEOUT_MS = 10_000;

/** POSTs every new message someone else sends in `chats`, or in a chat with one of `tags`, to `url`. */
export interface Listener {
	name: string;
	url: string;
	headers: Record<string, string>;
	chats: string[];
	/**
	 * Tag names, looked up when a message arrives, so a chat tagged or
	 * untagged later is heard from or not without setting the listener again.
	 * A rename of the tag is followed. Missing in older files.
	 */
	tags?: string[];
}

/**
 * A header value safe to show an agent: a scheme word ("Bearer ") and a short
 * token-type prefix ("crsr_") are kept, the secret shows only its last 4
 * characters, and a secret under 12 characters is hidden entirely.
 */
export function maskHeaderValue(value: string): string {
	const [, scheme = "", rest = value] = value.match(/^([A-Za-z]{2,10} +)(\S.*)$/s) ?? [];
	const [, kind = "", secret = rest] = rest.match(/^([A-Za-z]{2,5}[_-])(.+)$/s) ?? [];
	return secret.length < 12 ? "••••" : `${scheme}${kind}…${secret.slice(-4)}`;
}

/** Header names with their values masked by {@link maskHeaderValue}. */
export function maskHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, maskHeaderValue(v)]));
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Webhooks agents register for the chats they want to hear about. */
export class Listeners {
	readonly #path: string;
	readonly #organizer: Pick<Organizer, "tagsOf" | "isHidden" | "migratedFolders"> | undefined;
	readonly #fetch: Fetch;
	#listeners: Listener[] = [];

	constructor(path: string, organizer?: Pick<Organizer, "tagsOf" | "isHidden" | "migratedFolders">, fetchImpl: Fetch = fetch) {
		this.#path = path;
		this.#organizer = organizer;
		this.#fetch = fetchImpl;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		try {
			this.#listeners = JSON.parse(readFileSync(path, "utf-8")).listeners;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}
		this.#migrateFolders();
	}

	/**
	 * Listeners set before tags replaced betterLINE folders listed folder ids;
	 * each now listens to the tag its folder became.
	 */
	#migrateFolders() {
		const legacy = this.#listeners as (Listener & { folders?: string[] })[];
		if (!legacy.some((l) => l.folders)) return;
		const names = this.#organizer?.migratedFolders ?? new Map<string, string>();
		this.#save(legacy.map(({ folders = [], ...l }) => {
			const tags = [...new Set([...(l.tags ?? []), ...folders.flatMap((id) => names.get(id) ?? [])])];
			const lost = folders.filter((id) => !names.has(id));
			if (lost.length) console.error(`[listeners] "${l.name}": no tag for folder(s) ${lost.join(", ")}`);
			return tags.length ? { ...l, tags } : l;
		}));
	}

	/** Keeps listeners on a tag that was renamed. */
	renameTag(from: string, to: string) {
		const fold = foldForSearch(from);
		if (!this.#listeners.some((l) => l.tags?.some((t) => foldForSearch(t) === fold))) return;
		this.#save(this.#listeners.map((l) => {
			if (!l.tags?.some((t) => foldForSearch(t) === fold)) return l;
			return { ...l, tags: [...new Set(l.tags.map((t) => (foldForSearch(t) === fold ? to : t)))] };
		}));
	}

	watch(events: LineService["events"]) {
		events.on("event", (event) => {
			if (event.type === "message") void this.onMessage(event.message);
		});
	}

	list(): Listener[] {
		return this.#listeners;
	}

	/** Adds the listener, or replaces the one with the same name. */
	set(listener: Listener): Listener {
		this.#save([...this.#listeners.filter((l) => l.name !== listener.name), listener]);
		return listener;
	}

	remove(name: string): Listener {
		const removed = this.#listeners.find((l) => l.name === name);
		if (!removed) throw new Error(`No listener named "${name}".`);
		this.#save(this.#listeners.filter((l) => l !== removed));
		return removed;
	}

	async onMessage(m: ClientMessage) {
		// The owner's own messages include an agent's replies, which would call its webhook again.
		if (m.mine) return;
		await Promise.all(this.#listeners.filter((l) => this.#hears(l, m.chat_id)).map((l) => this.#post(l, m)));
	}

	#hears(l: Listener, chatId: string): boolean {
		if (l.chats.includes(chatId)) return true;
		if (!l.tags?.length || !this.#organizer) return false;
		// Tags are looked up now, not when the listener was set. A chat hidden
		// in betterLINE stays out, as it does from every tool; one listed in
		// `chats` was allowed when it was set and keeps being posted.
		const wanted = new Set(l.tags.map(foldForSearch));
		return this.#organizer.tagsOf(chatId).some((t) => wanted.has(foldForSearch(t))) && !this.#organizer.isHidden(chatId);
	}

	async #post(l: Listener, m: ClientMessage) {
		const message = { id: m.id, from_id: m.from_id, from_name: m.from_name, kind: m.kind, text: m.text, time: formatTime(m.time_ms) };
		try {
			const res = await this.#fetch(l.url, {
				method: "POST",
				headers: { "content-type": "application/json", ...l.headers },
				body: JSON.stringify({
					text: `New LINE message in ${m.chat_id} from ${m.from_name}: ${m.text}`,
					listener: l.name,
					chat_id: m.chat_id,
					message,
				}),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			await res.body?.cancel();
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
		} catch (e) {
			console.error(`[listeners] "${l.name}" failed: ${errorMessage(e)}`);
		}
	}

	#save(listeners: Listener[]) {
		const tmp = `${this.#path}.tmp`;
		writeFileSync(tmp, JSON.stringify({ listeners }), { mode: 0o600 });
		renameSync(tmp, this.#path);
		this.#listeners = listeners;
	}
}
