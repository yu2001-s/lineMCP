import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
	type ArchivableMessage,
	type ChatFacts,
	type ClientMessage,
	errorMessage,
	formatTime,
	type LineService,
} from "./line.ts";
import { foldForSearch, foldVersion } from "./text.ts";

const SYNC_INTERVAL_MS = 24 * 3_600_000;
const SCHEDULER_TICK_MS = 3_600_000;
const BETWEEN_CHATS_MS = 1_000;

/** Which chats get archived automatically. Manual adds and removals always win. */
export interface ArchivePolicy {
	auto: boolean;
	maxGroupMembers: number;
	skipOfficialAccounts: boolean;
}

const DEFAULT_POLICY: ArchivePolicy = {
	auto: false,
	maxGroupMembers: 10,
	skipOfficialAccounts: true,
};

type Mode = "auto" | "manual";

/** Why the rules leave a chat out, or undefined when they archive it. */
export function skipReason(chat: ChatFacts, policy: ArchivePolicy): string | undefined {
	if (chat.type === "user") {
		if (chat.official === undefined) return "account type unknown";
		if (chat.official && policy.skipOfficialAccounts) return "official account";
		return undefined;
	}
	if (chat.members === undefined) return "member count unknown";
	if (chat.members > policy.maxGroupMembers) return `${chat.members} members`;
	return undefined;
}

interface ChatRow {
	chat_id: string;
	name: string;
	mode: Mode;
	added_at: number;
	last_synced_at: number | null;
	last_error: string | null;
	messages: number;
	oldest: number | null;
	newest: number | null;
}

interface MessageRow {
	id: string;
	chat_id: string;
	created_ms: number;
	from_id?: string;
	from_name: string;
	text: string;
	reply_to: string | null;
	chat_name?: string;
	data?: string | null;
}

/**
 * Local copy of the chats the owner chose to keep. LINE only serves the last
 * ~14 days to a secondary device, so anything older exists only here.
 */
export class Archive {
	readonly #db: DatabaseSync;

	constructor(path: string) {
		this.#db = new DatabaseSync(path);
		chmodSync(path, 0o600);
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS chats (
				chat_id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				added_at INTEGER NOT NULL,
				last_synced_at INTEGER,
				last_error TEXT
			);
			CREATE TABLE IF NOT EXISTS messages (
				id TEXT PRIMARY KEY,
				chat_id TEXT NOT NULL,
				created_ms INTEGER NOT NULL,
				from_id TEXT NOT NULL,
				from_name TEXT NOT NULL,
				text TEXT NOT NULL,
				reply_to TEXT,
				decrypt_failed INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS messages_by_chat_time ON messages (chat_id, created_ms);
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS excluded (
				chat_id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				excluded_at INTEGER NOT NULL
			);
		`);
		const columns = this.#db.prepare("PRAGMA table_info(chats)").all() as { name: string }[];
		if (!columns.some((c) => c.name === "mode")) {
			this.#db.exec("ALTER TABLE chats ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual'");
		}
		const messageColumns = this.#db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
		if (!messageColumns.some((c) => c.name === "search_text")) {
			this.#db.exec("ALTER TABLE messages ADD COLUMN search_text TEXT NOT NULL DEFAULT ''");
		}
		if (!messageColumns.some((c) => c.name === "data")) {
			this.#db.exec("ALTER TABLE messages ADD COLUMN data TEXT");
			this.#db.exec("ALTER TABLE messages ADD COLUMN media_ref TEXT");
		}
		this.#db.function("fold_for_search", { deterministic: true }, (s) => foldForSearch(String(s)));
		if (this.getMeta("search_fold") !== foldVersion) {
			this.#transaction(() => {
				this.#db.exec("UPDATE messages SET search_text = fold_for_search(text)");
				this.setMeta("search_fold", foldVersion);
			});
		}
	}

	policy(): ArchivePolicy {
		return { ...DEFAULT_POLICY, ...JSON.parse(this.getMeta("policy") ?? "{}") };
	}

	setPolicy(policy: ArchivePolicy) {
		this.setMeta("policy", JSON.stringify(policy));
	}

	/** Chats the owner removed; the rules never add them back. */
	isExcluded(chatId: string): boolean {
		return !!this.#db.prepare("SELECT 1 FROM excluded WHERE chat_id = ?").get(chatId);
	}

	chats(): ChatRow[] {
		return this.#db.prepare(`
			SELECT c.chat_id, c.name, c.mode, c.added_at, c.last_synced_at, c.last_error,
				count(m.id) AS messages, min(m.created_ms) AS oldest, max(m.created_ms) AS newest
			FROM chats c LEFT JOIN messages m ON m.chat_id = c.chat_id
			GROUP BY c.chat_id ORDER BY c.name
		`).all() as unknown as ChatRow[];
	}

	chatName(chatId: string): string | undefined {
		const row = this.#db.prepare("SELECT name FROM chats WHERE chat_id = ?").get(chatId) as
			| { name: string }
			| undefined;
		return row?.name;
	}

	isArchived(chatId: string): boolean {
		return !!this.#db.prepare("SELECT 1 FROM chats WHERE chat_id = ?").get(chatId);
	}

	newestMs(chatId: string): number {
		const row = this.#db.prepare(
			"SELECT max(created_ms) AS newest FROM messages WHERE chat_id = ?",
		).get(chatId) as { newest: number | null };
		return row.newest ?? 0;
	}

	/** Upserts the chat and its messages; returns how many messages were new. */
	save(chatId: string, name: string, messages: ArchivableMessage[], mode: Mode): number {
		const count = this.#db.prepare("SELECT count(*) AS n FROM messages WHERE chat_id = ?");
		// An existing row only takes the new text when it repairs a failed
		// decryption or an unnamed file, or the sender edited the message;
		// rows from before the desktop client also gain data/media_ref.
		const insert = this.#db.prepare(`
			INSERT INTO messages (id, chat_id, created_ms, from_id, from_name, text, reply_to, decrypt_failed, search_text, data, media_ref)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET
				text = CASE WHEN ${REPAIRS} THEN excluded.text ELSE messages.text END,
				search_text = CASE WHEN ${REPAIRS} THEN excluded.search_text ELSE messages.search_text END,
				data = CASE WHEN messages.data IS NULL OR ${REPAIRS} THEN excluded.data ELSE messages.data END,
				media_ref = coalesce(messages.media_ref, excluded.media_ref),
				decrypt_failed = CASE WHEN ${REPAIRS} THEN 0 ELSE messages.decrypt_failed END
		`);
		const before = (count.get(chatId) as { n: number }).n;
		this.#transaction(() => {
			this.#db.prepare(`
				INSERT INTO chats (chat_id, name, mode, added_at, last_synced_at) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT (chat_id) DO UPDATE SET name = excluded.name,
					mode = CASE WHEN excluded.mode = 'manual' THEN 'manual' ELSE chats.mode END,
					last_synced_at = excluded.last_synced_at, last_error = NULL
			`).run(chatId, name, mode, Date.now(), Date.now());
			if (mode === "manual") {
				this.#db.prepare("DELETE FROM excluded WHERE chat_id = ?").run(chatId);
			}
			for (const m of messages) {
				insert.run(
					m.id, chatId, m.createdMs, m.fromId, m.fromName, m.text,
					m.replyTo ?? null, m.decryptFailed ? 1 : 0, foldForSearch(m.text),
					JSON.stringify(m.data), m.mediaRef ?? null,
				);
			}
		});
		return (count.get(chatId) as { n: number }).n - before;
	}

	/**
	 * Drops messages LINE no longer serves inside a window it still covers:
	 * the sender unsent them. Returns how many were removed.
	 */
	reconcile(chatId: string, fromMs: number, served: Set<string>): number {
		const stored = this.#db.prepare(
			"SELECT id FROM messages WHERE chat_id = ? AND created_ms >= ?",
		).all(chatId, fromMs) as { id: string }[];
		const gone = stored.filter((r) => !served.has(r.id));
		const del = this.#db.prepare("DELETE FROM messages WHERE id = ?");
		this.#transaction(() => {
			for (const r of gone) del.run(r.id);
		});
		return gone.length;
	}

	/** The sender unsent it; the archive must not keep it. */
	deleteMessage(messageId: string) {
		this.#db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
	}

	mediaRef(messageId: string): string | undefined {
		const row = this.#db.prepare("SELECT media_ref FROM messages WHERE id = ?").get(messageId) as
			| { media_ref: string | null }
			| undefined;
		return row?.media_ref ?? undefined;
	}

	/** Archived messages as the desktop client renders them, oldest first. */
	readClient(chatId: string, opts: { beforeMs?: number; limit: number }) {
		const rows = this.#db.prepare(`
			SELECT id, chat_id, created_ms, from_id, from_name, text, reply_to, data FROM messages
			WHERE chat_id = ? AND created_ms < ? ORDER BY created_ms DESC LIMIT ?
		`).all(chatId, opts.beforeMs ?? Number.MAX_SAFE_INTEGER, opts.limit) as unknown as MessageRow[];
		rows.reverse();
		return {
			messages: rows.map(clientMessage),
			older_cursor: rows.length === opts.limit ? String(rows[0].created_ms) : undefined,
		};
	}

	searchClient(query: string, opts: { chatId?: string; limit: number }) {
		const rows = this.#db.prepare(`
			SELECT m.id, m.chat_id, m.created_ms, m.from_id, m.from_name, m.text, m.reply_to, m.data, c.name AS chat_name
			FROM messages m LEFT JOIN chats c ON c.chat_id = m.chat_id
			WHERE instr(m.search_text, ?) > 0 AND (? IS NULL OR m.chat_id = ?)
			ORDER BY m.created_ms DESC LIMIT ?
		`).all(foldForSearch(query), opts.chatId ?? null, opts.chatId ?? null, opts.limit) as unknown as MessageRow[];
		return rows.map((r) => ({ ...clientMessage(r), chat_name: r.chat_name }));
	}

	markError(chatId: string, error: string) {
		this.#db.prepare("UPDATE chats SET last_error = ? WHERE chat_id = ?").run(error, chatId);
	}

	remove(chatId: string, deleteMessages: boolean): { removed: boolean; deletedMessages: number } {
		let deleted = 0;
		let removed = false;
		this.#transaction(() => {
			const row = this.#db.prepare("SELECT name FROM chats WHERE chat_id = ?").get(chatId) as
				| { name: string }
				| undefined;
			this.#db.prepare(`
				INSERT INTO excluded (chat_id, name, excluded_at) VALUES (?, ?, ?)
				ON CONFLICT (chat_id) DO NOTHING
			`).run(chatId, row?.name ?? chatId, Date.now());
			removed = this.#db.prepare("DELETE FROM chats WHERE chat_id = ?").run(chatId).changes > 0;
			if (deleteMessages) {
				deleted = Number(
					this.#db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId).changes,
				);
			}
		});
		return { removed, deletedMessages: deleted };
	}

	/** `exclude`: chat ids to leave out (chats the owner hid). */
	/** `only` limits the search to those chats, `exclude` leaves chats out. */
	search(query: string, opts: { chatId?: string; limit: number; only?: string[]; exclude?: string[] }) {
		const only = opts.only ? JSON.stringify(opts.only) : null;
		const rows = this.#db.prepare(`
			SELECT m.id, m.chat_id, m.created_ms, m.from_name, m.text, m.reply_to, c.name AS chat_name
			FROM messages m LEFT JOIN chats c ON c.chat_id = m.chat_id
			WHERE instr(m.search_text, ?) > 0 AND (? IS NULL OR m.chat_id = ?)
				AND (? IS NULL OR m.chat_id IN (SELECT value FROM json_each(?)))
				AND m.chat_id NOT IN (SELECT value FROM json_each(?))
			ORDER BY m.created_ms DESC LIMIT ?
		`).all(
			foldForSearch(query), opts.chatId ?? null, opts.chatId ?? null, only, only, JSON.stringify(opts.exclude ?? []), opts.limit,
		) as unknown as MessageRow[];
		return rows.map((r) => ({ chat_id: r.chat_id, chat_name: r.chat_name, ...formatRow(r) }));
	}

	read(chatId: string, opts: { beforeMs?: number; limit: number }) {
		const rows = this.#db.prepare(`
			SELECT id, chat_id, created_ms, from_name, text, reply_to FROM messages
			WHERE chat_id = ? AND created_ms < ? ORDER BY created_ms DESC LIMIT ?
		`).all(chatId, opts.beforeMs ?? Number.MAX_SAFE_INTEGER, opts.limit) as unknown as MessageRow[];
		rows.reverse();
		return {
			messages: rows.map(formatRow),
			older_cursor: rows.length === opts.limit ? String(rows[0].created_ms) : undefined,
		};
	}

	getMeta(key: string): string | undefined {
		const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
			| { value: string }
			| undefined;
		return row?.value;
	}

	setMeta(key: string, value: string) {
		this.#db.prepare(
			"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
		).run(key, value);
	}

	#transaction(fn: () => void) {
		this.#db.exec("BEGIN");
		try {
			fn();
			this.#db.exec("COMMIT");
		} catch (e) {
			this.#db.exec("ROLLBACK");
			throw e;
		}
	}
}

// Also encrypted files saved before their names were decrypted on read, and
// messages the sender edited after they were saved.
const REPAIRS = "((messages.decrypt_failed = 1 AND excluded.decrypt_failed = 0) OR " +
	"(messages.text LIKE '[file: unnamed%' AND excluded.text NOT LIKE '[file: unnamed%') OR " +
	"(json_extract(excluded.data, '$.edited') = 1 AND excluded.decrypt_failed = 0 AND excluded.text <> messages.text))";

/** Rows archived before the desktop client existed have no data; rebuild a text message. */
function clientMessage(r: MessageRow): ClientMessage {
	if (r.data) return JSON.parse(r.data) as ClientMessage;
	return {
		id: r.id,
		chat_id: r.chat_id,
		from_id: r.from_id ?? "",
		from_name: r.from_name,
		mine: r.from_name === "me",
		time_ms: r.created_ms,
		delivered: String(r.created_ms),
		kind: "text",
		text: r.text,
		...(r.reply_to ? { reply_to: r.reply_to } : {}),
	};
}

function formatRow(r: MessageRow) {
	return {
		id: r.id,
		time: formatTime(r.created_ms),
		from: r.from_name,
		text: r.text,
		...(r.reply_to ? { reply_to: r.reply_to } : {}),
	};
}

export interface SyncResult {
	chat_id: string;
	name?: string;
	new_messages?: number;
	error?: string;
}

/** Pulls new messages for archived chats once a day. */
export class ArchiveSync {
	readonly #line: LineService;
	readonly #archive: Archive;
	#running?: Promise<SyncResult[]>;

	constructor(line: LineService, archive: Archive) {
		this.#line = line;
		this.#archive = archive;
		// Live updates between daily syncs: keep new messages and edits, drop unsent ones.
		line.events.on("event", (event) => {
			try {
				if (event.type === "unsend") {
					archive.deleteMessage(event.message_id);
				} else if ((event.type === "message" || event.type === "edit") && archive.isArchived(event.chat_id)) {
					const m = event.message;
					archive.save(event.chat_id, archive.chatName(event.chat_id) ?? event.chat_id, [{
						id: m.id,
						createdMs: m.time_ms,
						fromId: m.from_id,
						fromName: m.from_name,
						text: m.text,
						replyTo: m.reply_to,
						decryptFailed: !!m.decrypt_failed,
						data: m,
						mediaRef: line.mediaRefFor(m.id),
					}], "auto");
				}
			} catch (e) {
				console.error("[archive] live update failed:", errorMessage(e));
			}
		});
	}

	/**
	 * Re-reads everything LINE still serves for the chat (14 days) so that
	 * messages unsent while this server was offline are dropped too.
	 */
	async syncChat(chatId: string, mode: Mode = "manual"): Promise<SyncResult> {
		const { chatName, messages } = await this.#line.collectMessages(chatId, 0);
		const added = this.#archive.save(chatId, chatName, messages, mode);
		if (messages.length) {
			this.#archive.reconcile(chatId, messages[0].createdMs, new Set(messages.map((m) => m.id)));
		}
		return { chat_id: chatId, name: chatName, new_messages: added };
	}

	/** For every chat active in LINE's 14-day window: archived, would be archived, or skipped and why. */
	async preview() {
		const policy = this.#archive.policy();
		const chats = await this.#line.activeChats();
		return chats.map((c) => {
			const base = {
				chat_id: c.id,
				name: c.name,
				type: c.type,
				...(c.members !== undefined ? { members: c.members } : {}),
				...(c.official ? { official_account: true } : {}),
			};
			if (this.#archive.isArchived(c.id)) return { ...base, status: "archived" };
			if (this.#archive.isExcluded(c.id)) return { ...base, status: "skipped", reason: "removed by you" };
			const reason = skipReason(c, policy);
			return reason
				? { ...base, status: "skipped", reason }
				: { ...base, status: policy.auto ? "will_archive_next_sync" : "matches_rules" };
		});
	}

	/** Concurrent callers share one run. */
	syncAll(): Promise<SyncResult[]> {
		this.#running ??= this.#syncAll().finally(() => {
			this.#running = undefined;
		});
		return this.#running;
	}

	async #syncAll(): Promise<SyncResult[]> {
		const results = await this.#discover();
		const discovered = new Set(results.map((r) => r.chat_id));
		for (const chat of this.#archive.chats()) {
			if (discovered.has(chat.chat_id)) continue;
			try {
				results.push(await this.syncChat(chat.chat_id));
			} catch (e) {
				const error = errorMessage(e);
				this.#archive.markError(chat.chat_id, error);
				results.push({ chat_id: chat.chat_id, name: chat.name, error });
			}
			await new Promise((resolve) => setTimeout(resolve, BETWEEN_CHATS_MS));
		}
		this.#archive.setMeta("last_full_sync", String(Date.now()));
		return results;
	}

	/** Archives chats that newly match the rules (new friends, new small groups). */
	async #discover(): Promise<SyncResult[]> {
		const policy = this.#archive.policy();
		if (!policy.auto) return [];
		const results: SyncResult[] = [];
		for (const chat of await this.#line.activeChats()) {
			if (
				this.#archive.isArchived(chat.id) || this.#archive.isExcluded(chat.id) ||
				skipReason(chat, policy)
			) continue;
			try {
				results.push(await this.syncChat(chat.id, "auto"));
			} catch (e) {
				results.push({ chat_id: chat.id, name: chat.name, error: errorMessage(e) });
			}
			await new Promise((resolve) => setTimeout(resolve, BETWEEN_CHATS_MS));
		}
		return results;
	}

	/**
	 * Checks hourly and syncs when the last full run is over a day old, so a
	 * reboot or a long outage catches up on its own (LINE keeps 14 days).
	 */
	start() {
		const tick = () => {
			if (this.#line.status !== "ready") return;
			const last = Number(this.#archive.getMeta("last_full_sync") ?? 0);
			if (Date.now() - last < SYNC_INTERVAL_MS) return;
			this.syncAll().then(
				(results) => {
					const added = results.reduce((n, r) => n + (r.new_messages ?? 0), 0);
					const failed = results.filter((r) => r.error).length;
					console.log(`[archive] synced ${results.length} chats, ${added} new messages, ${failed} failed`);
				},
				(e) => console.error("[archive] sync failed:", e),
			);
		};
		setTimeout(tick, 60_000);
		setInterval(tick, SCHEDULER_TICK_MS);
	}
}

export function lastSyncLabel(archive: Archive): string | undefined {
	const last = Number(archive.getMeta("last_full_sync") ?? 0);
	return last ? formatTime(last) : undefined;
}
