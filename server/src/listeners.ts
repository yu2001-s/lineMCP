import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type ClientMessage, errorMessage, formatTime, type LineService } from "./line.ts";

const TIMEOUT_MS = 10_000;

/** POSTs every new message someone else sends in `chats` to `url`. */
export interface Listener {
	name: string;
	url: string;
	headers: Record<string, string>;
	chats: string[];
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Webhooks agents register for the chats they want to hear about. */
export class Listeners {
	readonly #path: string;
	readonly #fetch: Fetch;
	#listeners: Listener[] = [];

	constructor(path: string, fetchImpl: Fetch = fetch) {
		this.#path = path;
		this.#fetch = fetchImpl;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		try {
			this.#listeners = JSON.parse(readFileSync(path, "utf-8")).listeners;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}
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
		await Promise.all(this.#listeners.filter((l) => l.chats.includes(m.chat_id)).map((l) => this.#post(l, m)));
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
