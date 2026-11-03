import { appendFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { BaseClient } from "@jsr/evex__linejs/base";
import { AUTH_TOKEN_KEY, config } from "./config.ts";
import { formatSize, mediaType } from "./mediatools.ts";
import type { AtomicFileStorage } from "./storage.ts";
import { foldForSearch } from "./text.ts";

type RawMessage = Awaited<
	ReturnType<BaseClient["talk"]["getRecentMessagesV2"]>
>[number];

export type LineStatus = "starting" | "ready" | "logged_out" | "error";

export interface Contact {
	id: string;
	name: string;
	type: "user" | "group" | "room";
}

export interface FormattedMessage {
	id: string;
	time: string;
	from: string;
	/** Only on messages from others in groups and rooms, where it tells senders apart. */
	from_id?: string;
	text: string;
	reply_to?: string;
	/** What line_send_sticker needs to send the same sticker. */
	sticker?: { package_id: string; sticker_id: string; version: string };
	reactions?: { type: string; from: string }[];
	/** The sender unsent it; LINE keeps no text for it. */
	unsent?: true;
	/** The sender edited it (a LYP Premium feature); `text` is the edited version. */
	edited?: true;
	edited_at?: string;
}

export interface ArchivableMessage {
	id: string;
	createdMs: number;
	fromId: string;
	fromName: string;
	text: string;
	replyTo?: string;
	decryptFailed: boolean;
	/** Full message for the desktop client. */
	data: ClientMessage;
	/** For media: the still-encrypted message, which holds the key to download it later. */
	mediaRef?: string;
}

export type MessageKind =
	| "text" | "sticker" | "image" | "video" | "audio" | "file" | "location"
	| "contact" | "rich" | "call" | "system" | "other";

/** A message as the desktop client renders it. */
export interface ClientMessage {
	id: string;
	chat_id: string;
	from_id: string;
	from_name: string;
	/** Sender's profile picture, so group members who aren't friends still have one. */
	from_picture?: string;
	mine: boolean;
	time_ms: number;
	/** LINE's delivered time; with the id it locates the message for media downloads and paging. */
	delivered: string;
	kind: MessageKind;
	text: string;
	reply_to?: string;
	sticker?: { package_id: string; sticker_id: string; version: string; animated: boolean; url: string };
	media?: { file_name?: string; size?: number; duration_ms?: number };
	location?: { title?: string; address?: string; latitude?: number; longitude?: number };
	reactions?: { type: string; from_id: string }[];
	decrypt_failed?: boolean;
	edited?: true;
	edited_ms?: number;
}

export interface ClientChat {
	chat_id: string;
	name: string;
	type: Contact["type"];
	picture?: string;
	unread: number;
	muted?: boolean;
	last_message?: ClientMessage;
}

export type LineEvent =
	| { type: "message"; chat_id: string; message: ClientMessage }
	/** The sender edited a message; `message` is the edited version. */
	| { type: "edit"; chat_id: string; message: ClientMessage }
	| { type: "unsend"; chat_id: string; message_id: string }
	| { type: "read"; chat_id: string; reader_id: string; message_id: string }
	| { type: "chat_read"; chat_id: string; message_id: string }
	| { type: "reaction"; chat_id: string; message_id?: string }
	| { type: "chat_update"; chat_id: string }
	/** The desktop app saved new folders or hidden chats. */
	| { type: "organizer" }
	| { type: "status"; status: LineStatus };

export type MediaKind = "image" | "video" | "audio" | "file";

/** A message's photo, video, voice message or file, decrypted. */
export interface MediaFile {
	data: Uint8Array;
	type: string;
	name: string;
	kind: MediaKind;
	durationMs?: number;
}

export const REACTIONS = ["NICE", "LOVE", "FUN", "AMAZING", "SAD", "OMG"] as const;
export type ReactionName = typeof REACTIONS[number] | "UNDO";

export interface ChatFacts {
	id: string;
	name: string;
	type: Contact["type"];
	lastMessageMs: number;
	/** 1:1 chats: a LINE official account (brands, shops, services). */
	official?: boolean;
	/** Groups and rooms: member count. */
	members?: number;
}

interface Cursor {
	deliveredTime: bigint;
	messageId: bigint;
}

const MID_RE = /^[ucr][0-9a-f]{32}$/;
const DIRECTORY_TTL_MS = 10 * 60_000;
const LOOKUP_BATCH = 100;
const MAX_MESSAGE_BOXES = 300;
const COLLECT_PAGE_SIZE = 100;
const COLLECT_MAX_PAGES = 50;
const COLLECT_PAGE_DELAY_MS = 300;
const UNDECRYPTABLE = "[encrypted message that could not be decrypted]";
const RAW_CACHE_SIZE = 5_000;
const LISTEN_RETRY_MS = 5_000;
const START_RETRY_MS = 30_000;
const PROFILE_CDN = "https://profile.line-scdn.net";
const STICKER_CDN = "https://stickershop.line-scdn.net/stickershop/v1/sticker";
const MEDIA_KINDS = new Set(["image", "video", "audio", "file"]);

// Guards against an agent loop hammering the account (and LINE's spam
// detection): at most one send per MIN_GAP and SEND_BURST per SEND_WINDOW.
const SEND_MIN_GAP_MS = 3_000;
const SEND_WINDOW_MS = 10 * 60_000;
const SEND_BURST = Number(process.env.LINE_MCP_MAX_SENDS_PER_10MIN ?? 20);

const CONTENT_TYPES = [
	"NONE", "IMAGE", "VIDEO", "AUDIO", "HTML", "PDF", "CALL", "STICKER",
	"PRESENCE", "GIFT", "GROUPBOARD", "APPLINK", "LINK", "CONTACT", "FILE",
	"LOCATION", "POSTNOTIFICATION", "RICH", "CHATEVENT", "MUSIC", "PAYMENT",
	"EXTIMAGE", "FLEX",
];

/**
 * Creates the linejs client with the two safety rails this project depends on:
 * the session token is persisted whenever LINE rotates it, and the client can
 * never register a fresh E2EE key pair. linejs does that silently when the
 * login keychain cannot be decoded, which replaces the account's key and
 * leaves the primary phone showing "This message can't be displayed".
 */
export function createBaseClient(storage: AtomicFileStorage) {
	const base = new BaseClient({ device: config.device, storage });
	base.e2ee.registerE2EEKeyPair = () => {
		throw new Error(
			"Refusing to register a new E2EE key pair: the login did not transfer the account's existing keys. " +
				"Nothing was changed on the account; retry the QR login.",
		);
	};
	let pending: Promise<void> = Promise.resolve();
	base.on("update:authtoken", (token) => {
		base.authToken = token;
		pending = pending
			.then(() => storage.set(AUTH_TOKEN_KEY, token))
			.catch((e) => console.error("[line] could not persist auth token:", e));
	});
	return { base, tokenSaved: () => pending };
}

export class LineService {
	readonly base: BaseClient;
	status: LineStatus = "starting";
	lastError?: string;
	#storage: AtomicFileStorage;
	#lastStartAttempt = 0;
	#startRetry?: ReturnType<typeof setTimeout>;
	#names = new Map<string, string>();
	#directory?: { at: number; friends: Contact[]; groups: Contact[] };
	#sendTimes: number[] = [];
	#pictures = new Map<string, string>();
	#muted = new Map<string, boolean>();
	/** Recently seen messages, still encrypted where it matters (media keys live in chunks). */
	#raws = new Map<string, RawMessage>();
	/** Messages LINE told us were unsent. History keeps serving them, emptied. */
	#unsent = new Set<string>();
	#listening = false;
	/** Push events for the desktop client and the archive. */
	readonly events = new EventEmitter<{ event: [LineEvent] }>();

	constructor(storage: AtomicFileStorage) {
		this.#storage = storage;
		this.base = createBaseClient(storage).base;
		this.base.on("end", () => {
			this.status = "logged_out";
			this.lastError =
				"LINE signed this device out. Run the QR login again on the server.";
			this.events.emit("event", { type: "status", status: "logged_out" });
		});
	}

	async start(): Promise<void> {
		this.#lastStartAttempt = Date.now();
		const token = await this.#storage.get(AUTH_TOKEN_KEY);
		if (typeof token !== "string" || !token) {
			this.status = "logged_out";
			this.lastError = "Not logged in. Run `npm run login` on the server.";
			return;
		}
		try {
			await this.base.loginProcess.login({ authToken: token });
			this.status = "ready";
			this.lastError = undefined;
			this.events.emit("event", { type: "status", status: "ready" });
			this.#startListening();
		} catch (e) {
			this.status = "error";
			this.lastError = errorMessage(e);
			this.#scheduleStartRetry();
		}
	}

	/**
	 * At boot the service starts before the network is up, so the first login
	 * fails. Retry in the background: the push stream and archive sync only run
	 * once the session is ready, and nothing else would bring them back until a
	 * tool call happened to arrive.
	 */
	#scheduleStartRetry() {
		if (this.#startRetry) return;
		this.#startRetry = setTimeout(async () => {
			this.#startRetry = undefined;
			if (this.status !== "error") return;
			await this.start();
			// start() moves status on; TypeScript still has it narrowed to "error".
			if ((this.status as LineStatus) === "ready") console.log("[line] session ready after retry");
		}, START_RETRY_MS);
	}

	async #ready(): Promise<void> {
		// A transient failure at boot (network, LINE hiccup) should heal itself.
		if (this.status === "error" && Date.now() - this.#lastStartAttempt > 30_000) {
			await this.start();
		}
		if (this.status !== "ready") {
			throw new Error(`LINE session unavailable (${this.status}): ${this.lastError}`);
		}
	}

	get me() {
		const p = this.base.profile;
		return p
			? { id: p.mid, name: p.displayName, status_message: p.statusMessage }
			: undefined;
	}

	/** `include` picks chats before `limit` applies. */
	async listChats(opts: { limit: number; unreadOnly: boolean; include?: (chatId: string) => boolean }) {
		await this.#ready();
		const include = opts.include ?? (() => true);
		const messageBoxes = (await this.#messageBoxes(opts.unreadOnly)).filter((box) => include(box.id)).slice(0, opts.limit);
		const lasts = await Promise.all(
			messageBoxes.map((box) =>
				box.lastMessages?.[0] ? this.#decrypt(box.lastMessages[0]) : undefined
			),
		);
		await this.#resolveNames([
			...messageBoxes.map((box) => box.id),
			...lasts.flatMap((m) => (m ? [m.from] : [])),
		]);
		return messageBoxes.map((box, i) => ({
			chat_id: box.id,
			name: this.#nameOf(box.id),
			type: chatType(box.id),
			unread: Number(box.unreadCount ?? 0),
			last_message: lasts[i] ? this.#format(lasts[i], box.id) : undefined,
		}));
	}

	/**
	 * Every chat with a message in the window LINE still serves, with what the
	 * archive rules need: whether a 1:1 chat is an official account, and how
	 * many members a group has.
	 */
	async activeChats(): Promise<ChatFacts[]> {
		await this.#ready();
		const boxes = await this.#messageBoxes(false);
		const ids = boxes.map((b) => b.id);
		const [official, members] = await Promise.all([
			this.#officialAccounts(ids.filter((id) => id.startsWith("u"))),
			this.#memberCounts(ids.filter((id) => !id.startsWith("u"))),
		]);
		await this.#resolveNames(ids);
		return boxes.map((b) => ({
			id: b.id,
			name: this.#nameOf(b.id),
			type: chatType(b.id),
			lastMessageMs: lastActivity(b),
			official: official.get(b.id),
			members: members.get(b.id),
		}));
	}

	/** Display names for chat ids, including chats with nothing in the last 14 days. */
	async chatNames(ids: string[]): Promise<Map<string, string>> {
		await this.#ready();
		await this.#resolveNames(ids);
		return new Map(ids.map((id) => [id, this.#nameOf(id)]));
	}

	/** Chats active within LINE's 14-day window, most recent first. */
	async #messageBoxes(unreadOnly: boolean) {
		const { messageBoxes } = await this.base.talk.getMessageBoxes({
			messageBoxListRequest: {
				activeOnly: true,
				messageBoxCountLimit: MAX_MESSAGE_BOXES,
				withUnreadCount: true,
				lastMessagesPerMessageBoxCount: 1,
				unreadOnly,
			},
			syncReason: "INTERNAL",
		});
		// LINE orders boxes by chat id, not by activity.
		return messageBoxes.sort((a, b) => lastActivity(b) - lastActivity(a));
	}

	async #officialAccounts(mids: string[]): Promise<Map<string, boolean>> {
		const official = new Map<string, boolean>();
		for (const batch of chunks(mids, LOOKUP_BATCH)) {
			const { responses } = await this.base.relation.getContactsV3({ mids: batch });
			for (const r of responses) {
				if (r.targetProfileDetail?.picturePath) {
					this.#pictures.set(r.targetUserMid, r.targetProfileDetail.picturePath);
				}
				official.set(
					r.targetUserMid,
					r.userType === "BOT" || r.userType === 2 || !!r.friendDetail?.bot,
				);
				this.#names.set(r.targetUserMid, userName(r));
			}
		}
		return official;
	}

	async #isOfficial(mid: string): Promise<boolean> {
		return (await this.#officialAccounts([mid])).get(mid) ?? false;
	}

	async #memberCounts(chatMids: string[]): Promise<Map<string, number>> {
		const counts = new Map<string, number>();
		for (const batch of chunks(chatMids, LOOKUP_BATCH)) {
			const { chats } = await this.base.talk.getChats({ chatMids: batch, withMembers: true });
			for (const chat of chats ?? []) {
				counts.set(chat.chatMid, Object.keys(chat.extra?.groupExtra?.memberMids ?? {}).length);
				if (chat.chatName) this.#names.set(chat.chatMid, chat.chatName);
				if (chat.picturePath) this.#pictures.set(chat.chatMid, chat.picturePath);
				this.#muted.set(chat.chatMid, !!chat.notificationDisabled);
			}
		}
		return counts;
	}

	async readMessages(opts: { chatId: string; limit: number; before?: string }) {
		await this.#ready();
		assertMid(opts.chatId);
		const messages = await this.#fetchPage(
			opts.chatId,
			opts.limit,
			opts.before ? parseCursor(opts.before) : undefined,
		);
		await this.#resolveNames([
			opts.chatId,
			...messages.flatMap((m) => [m.from, ...reactionsOf(m).map((r) => r.from_id)]),
		]);
		const oldest = messages[0];
		return {
			chat_id: opts.chatId,
			chat_name: this.#nameOf(opts.chatId),
			messages: messages.map((m) => this.#format(m, opts.chatId)),
			older_cursor: oldest && messages.length >= opts.limit - 1
				? `${oldest.deliveredTime}_${oldest.id}`
				: undefined,
		};
	}

	/**
	 * Every message LINE still serves for the chat (about 14 days), stopping
	 * once a page reaches `sinceMs`. Used to fill the archive.
	 */
	async collectMessages(chatId: string, sinceMs: number) {
		await this.#ready();
		assertMid(chatId);
		const byId = new Map<string, RawMessage>();
		let cursor: Cursor | undefined;
		for (let page = 0; page < COLLECT_MAX_PAGES; page++) {
			const batch = await this.#fetchPage(chatId, COLLECT_PAGE_SIZE, cursor);
			for (const m of batch) byId.set(String(m.id), m);
			const oldest = batch[0];
			if (
				!oldest || batch.length < COLLECT_PAGE_SIZE - 1 ||
				Number(oldest.createdTime) <= sinceMs
			) break;
			cursor = {
				deliveredTime: BigInt(oldest.deliveredTime),
				messageId: BigInt(oldest.id),
			};
			await sleep(COLLECT_PAGE_DELAY_MS);
		}
		// Unsent messages stay out, so the archive's reconcile drops them too.
		const raws = [...byId.values()].filter((m) => !this.#isUnsent(m)).sort((a, b) =>
			Number(a.createdTime) - Number(b.createdTime)
		);
		await this.#resolveNames([chatId, ...raws.map((m) => m.from)]);
		return {
			chatName: this.#nameOf(chatId),
			messages: raws.map((m): ArchivableMessage => ({
				id: String(m.id),
				createdMs: Number(m.createdTime),
				fromId: m.from,
				fromName: this.#nameOf(m.from),
				text: describe(m),
				replyTo: m.relatedMessageId ? String(m.relatedMessageId) : undefined,
				decryptFailed: m.text === UNDECRYPTABLE,
				data: this.#toClient(m, chatId),
				mediaRef: MEDIA_KINDS.has(kindOf(m)) ? serializeRaw(m) : undefined,
			})),
		};
	}

	/** One page of decrypted messages, oldest first. Never sends read receipts. */
	async #fetchPage(chatId: string, limit: number, cursor?: Cursor) {
		let raws: RawMessage[];
		if (cursor) {
			raws = await this.base.talk.getPreviousMessagesV2WithRequest({
				request: {
					messageBoxId: chatId,
					endMessageId: cursor,
					messagesCount: limit,
				},
				syncReason: "INTERNAL",
			});
			raws = raws.filter((m) => String(m.id) !== String(cursor.messageId));
		} else {
			raws = await this.base.talk.getRecentMessagesV2({
				messageBoxId: chatId,
				messagesCount: limit,
			});
		}
		const messages = await Promise.all(raws.map((m) => this.#decrypt(m)));
		for (const m of messages) this.#remember(m);
		return messages.sort((a, b) => Number(a.createdTime) - Number(b.createdTime));
	}

	// ── Desktop client ──────────────────────────────────────────────────────

	async clientChats(unreadOnly = false): Promise<ClientChat[]> {
		await this.#ready();
		const boxes = await this.#messageBoxes(unreadOnly);
		const lasts = await Promise.all(
			boxes.map((box) => box.lastMessages?.[0] ? this.#decrypt(box.lastMessages[0]) : undefined),
		);
		const ids = boxes.map((b) => b.id);
		await this.#resolveNames([...ids, ...lasts.flatMap((m) => (m ? [m.from] : []))]);
		const unknownGroups = ids.filter((id) => !id.startsWith("u") && !this.#muted.has(id));
		if (unknownGroups.length) await this.#memberCounts(unknownGroups).catch(() => {});
		return boxes.map((box, i) => ({
			chat_id: box.id,
			name: this.#nameOf(box.id),
			type: chatType(box.id),
			picture: this.#pictureOf(box.id),
			unread: Number(box.unreadCount ?? 0),
			muted: this.#muted.get(box.id),
			last_message: lasts[i] ? this.#toClient(lasts[i], box.id) : undefined,
		}));
	}

	/** Newest page when `before` is omitted; `before` is a previous `older_cursor`. */
	async clientMessages(chatId: string, limit: number, before?: string) {
		await this.#ready();
		assertMid(chatId);
		const messages = await this.#fetchPage(chatId, limit, before ? parseCursor(before) : undefined);
		await this.#resolveNames([chatId, ...messages.map((m) => m.from)]);
		const oldest = messages[0];
		return {
			// The app removes a message when it is unsent; reloading must not bring it back empty.
			messages: messages.filter((m) => !this.#isUnsent(m)).map((m) => this.#toClient(m, chatId)),
			older_cursor: oldest && messages.length >= limit - 1
				? `${oldest.deliveredTime}_${oldest.id}`
				: undefined,
		};
	}

	/** `agent` sends (MCP) are rate limited and logged to sent.log, like text. */
	async sendSticker(chatId: string, sticker: { packageId: string; stickerId: string; version: string; agent?: boolean }) {
		await this.#ready();
		assertMid(chatId);
		if (sticker.agent) this.#takeSendSlot();
		// Sticker metadata is public catalogue data; LINE clients send it unencrypted.
		const sent = await this.base.talk.sendMessage({
			to: chatId,
			contentType: "STICKER",
			contentMetadata: { STKID: sticker.stickerId, STKPKGID: sticker.packageId, STKVER: sticker.version },
			e2ee: false,
		});
		const result = { message_id: String(sent.id) };
		if (sticker.agent) await this.#logAgent(chatId, { ...result, sticker: `${sticker.packageId}/${sticker.stickerId}` });
		return result;
	}

	/** `agent` sends (MCP) are rate limited and logged to sent.log, like text. */
	async sendMedia(
		chatId: string,
		file: { data: Blob; kind: MediaKind; fileName: string; durationMs?: number; agent?: boolean },
	) {
		await this.#ready();
		assertMid(chatId);
		if (chatId.startsWith("r")) {
			throw new Error("LINE does not accept encrypted media in legacy multi-person rooms.");
		}
		if (file.agent) this.#takeSendSlot();
		const sent = await this.base.obs.uploadMediaByE2EE({
			data: file.data,
			oType: file.kind,
			to: chatId,
			filename: file.fileName,
			durationMs: file.durationMs,
		});
		const result = { message_id: String(sent.id) };
		if (file.agent) {
			await this.#resolveNames([chatId]);
			appendFileSync(
				config.sendLogPath,
				JSON.stringify({
					...result,
					chat_id: chatId,
					chat_name: this.#nameOf(chatId),
					sent_at: formatTime(Date.now()),
					media: file.kind,
					file_name: file.fileName,
				}) + "\n",
				{ mode: 0o600 },
			);
		}
		return result;
	}

	/** `agentChatId` marks an agent (MCP) call, which is logged to sent.log. */
	async unsend(messageId: string, agentChatId?: string) {
		await this.#ready();
		await this.base.talk.unsendMessage({ messageId });
		if (agentChatId) await this.#logAgent(agentChatId, { unsent: messageId });
	}

	/** `agentChatId` marks an agent (MCP) call, which is rate limited and logged like a send. */
	async react(messageId: string, reaction: ReactionName, agentChatId?: string) {
		await this.#ready();
		if (agentChatId) this.#takeSendSlot();
		await this.base.talk.react({ id: BigInt(messageId), reaction });
		if (agentChatId) await this.#logAgent(agentChatId, { message_id: messageId, reaction });
	}

	/** The id of the newest message in a chat, for marking it read. */
	async newestMessageId(chatId: string): Promise<string | undefined> {
		await this.#ready();
		assertMid(chatId);
		return (await this.#fetchPage(chatId, 1)).at(-1)?.id?.toString();
	}

	async #logAgent(chatId: string, entry: object) {
		await this.#resolveNames([chatId]);
		appendFileSync(
			config.sendLogPath,
			JSON.stringify({ ...entry, chat_id: chatId, chat_name: this.#nameOf(chatId), sent_at: formatTime(Date.now()) }) + "\n",
			{ mode: 0o600 },
		);
	}

	/**
	 * How far each other member has read in a chat: member mid → id of the
	 * newest message they have read. Reading this sends nothing to anyone.
	 */
	async readMarkers(chatId: string): Promise<Record<string, string>> {
		await this.#ready();
		assertMid(chatId);
		const result = await this.base.talk.getMessageReadRange({ chatIds: [chatId], syncReason: "INTERNAL" });
		const entry = (result ?? []).find((r) => r.chatId === chatId) ?? result?.[0];
		return latestReads(entry?.ranges ?? {}, this.base.profile?.mid);
	}

	/** The only place this server sends a read receipt: the owner asked for it. */
	async markRead(chatId: string, lastMessageId: string) {
		await this.#ready();
		assertMid(chatId);
		await this.base.talk.sendChatChecked({
			chatMid: chatId,
			lastMessageId,
			seq: await this.base.getReqseq(),
		});
	}

	/**
	 * Downloads and decrypts a message's media. `rawRef` is the archived encrypted
	 * message for media older than LINE's 14-day window.
	 */
	async downloadMedia(chatId: string, messageId: string, delivered?: string, rawRef?: string): Promise<MediaFile> {
		await this.#ready();
		assertMid(chatId);
		let raw = this.#raws.get(messageId) ?? (rawRef ? reviveRaw(rawRef) : undefined);
		if (!raw && delivered) {
			// The history call is inclusive of its end id, so this returns the message itself.
			const found = await this.base.talk.getPreviousMessagesV2WithRequest({
				request: {
					messageBoxId: chatId,
					endMessageId: { deliveredTime: BigInt(delivered), messageId: BigInt(messageId) },
					messagesCount: 1,
				},
				syncReason: "INTERNAL",
			});
			raw = found.find((m) => String(m.id) === messageId);
		}
		if (!raw) {
			throw new Error(
				delivered
					? "Message not found; LINE no longer serves it."
					: "Message not found. Read the chat first (line_read_messages or line_read_archive), then retry with an id from it.",
			);
		}
		const kind = kindOf(raw);
		if (!MEDIA_KINDS.has(kind)) {
			throw new Error(`Message ${messageId} is ${describe(raw)}, not a photo, video, voice message or file.`);
		}
		const file = raw.chunks?.length
			? await this.base.obs.downloadMediaByE2EE(raw)
			: await this.base.obs.downloadMessageData({ messageId });
		if (!file) throw new Error("Media download failed.");
		const meta = raw.contentMetadata ?? {};
		// linejs sometimes names a download "undefined".
		const usable = (name?: string) => name && !/^(undefined|null)(\.|$)/.test(name) ? name : undefined;
		const data = new Uint8Array(await file.arrayBuffer());
		const name = usable(file.name) ?? usable(meta.FILE_NAME) ?? messageId;
		return {
			data,
			type: mediaType(name, data, file.type),
			name,
			kind: kind as MediaKind,
			durationMs: meta.DURATION ? Number(meta.DURATION) : undefined,
		};
	}

	/** Encrypted original of a recently seen media message, for the archive. */
	mediaRefFor(messageId: string): string | undefined {
		const raw = this.#raws.get(messageId);
		return raw && MEDIA_KINDS.has(kindOf(raw)) ? serializeRaw(raw) : undefined;
	}

	#startListening() {
		if (this.#listening) return;
		this.#listening = true;
		void this.#listenLoop();
	}

	async #listenLoop() {
		while (this.status === "ready") {
			try {
				const reader = this.base.createPolling().listenTalkEvents().getReader();
				while (true) {
					const { value: op, done } = await reader.read();
					if (done) break;
					await this.#handleOp(op).catch((e) => console.error("[push] event failed:", errorMessage(e)));
				}
			} catch (e) {
				console.error("[push] stream ended:", errorMessage(e));
			}
			await sleep(LISTEN_RETRY_MS);
		}
		this.#listening = false;
	}

	async #handleOp(op: PushOperation) {
		const type = String(op.type);
		switch (type) {
			case "RECEIVE_MESSAGE":
			case "SEND_MESSAGE":
			// Someone else edited a message, or the owner did on another device.
			case "NOTIFIED_EDIT_MESSAGE":
			case "EDIT_MESSAGE": {
				if (!op.message) break;
				const m = await this.#decrypt(op.message);
				this.#remember(m);
				const chatId = this.#chatIdOf(m);
				await this.#resolveNames([chatId, m.from]);
				this.events.emit("event", {
					type: type.endsWith("EDIT_MESSAGE") ? "edit" : "message",
					chat_id: chatId,
					message: this.#toClient(m, chatId),
				});
				break;
			}
			case "NOTIFIED_DESTROY_MESSAGE":
			case "DESTROY_MESSAGE":
				this.#raws.delete(op.param2);
				this.#unsent.add(op.param2);
				if (this.#unsent.size > RAW_CACHE_SIZE) this.#unsent.delete(this.#unsent.values().next().value!);
				this.events.emit("event", { type: "unsend", chat_id: op.param1, message_id: op.param2 });
				break;
			case "NOTIFIED_READ_MESSAGE":
				this.events.emit("event", { type: "read", chat_id: op.param1, reader_id: op.param2, message_id: op.param3 });
				break;
			case "SEND_CHAT_CHECKED":
				this.events.emit("event", { type: "chat_read", chat_id: op.param1, message_id: op.param2 });
				break;
			case "NOTIFIED_SEND_REACTION":
			case "SEND_REACTION":
				this.events.emit("event", { type: "reaction", chat_id: op.param1, message_id: reactionMessageId(op.param2) });
				break;
			case "NOTIFIED_UPDATE_CHAT":
			case "UPDATE_CHAT":
				this.#names.delete(op.param1);
				this.events.emit("event", { type: "chat_update", chat_id: op.param1 });
				break;
		}
	}

	#isUnsent(m: RawMessage): boolean {
		return this.#unsent.has(String(m.id)) || isUnsentStub(m);
	}

	#remember(m: RawMessage) {
		this.#raws.delete(String(m.id));
		this.#raws.set(String(m.id), m);
		if (this.#raws.size > RAW_CACHE_SIZE) {
			this.#raws.delete(this.#raws.keys().next().value!);
		}
	}

	/** A 1:1 message's chat is the other person; a group message's chat is its `to`. */
	#chatIdOf(m: RawMessage): string {
		if (m.to.startsWith("u")) return m.from === this.base.profile?.mid ? m.to : m.from;
		return m.to;
	}

	#toClient(m: RawMessage, chatId: string): ClientMessage {
		const meta = m.contentMetadata ?? {};
		const kind = kindOf(m);
		const mine = m.from === this.base.profile?.mid;
		const out: ClientMessage = {
			id: String(m.id),
			chat_id: chatId,
			from_id: m.from,
			from_name: mine ? "me" : this.#nameOf(m.from),
			mine,
			time_ms: Number(m.createdTime),
			delivered: String(m.deliveredTime ?? m.createdTime),
			kind,
			text: kind === "text" ? m.text ?? "" : describe(m),
		};
		if (!mine) {
			const picture = this.#pictureOf(m.from);
			if (picture) out.from_picture = picture;
		}
		if (m.relatedMessageId) out.reply_to = String(m.relatedMessageId);
		if (m.text === UNDECRYPTABLE) out.decrypt_failed = true;
		if (kind === "sticker" && meta.STKID) {
			const animated = meta.STKOPT === "A";
			out.sticker = {
				package_id: meta.STKPKGID,
				sticker_id: meta.STKID,
				version: meta.STKVER ?? "1",
				animated,
				url: `${STICKER_CDN}/${meta.STKID}/android/${animated ? "sticker_animation" : "sticker"}.png`,
			};
		}
		if (MEDIA_KINDS.has(kind)) {
			out.media = {
				...(meta.FILE_NAME ? { file_name: meta.FILE_NAME } : {}),
				...(meta.FILE_SIZE ? { size: Number(meta.FILE_SIZE) } : {}),
				...(meta.DURATION ? { duration_ms: Number(meta.DURATION) } : {}),
			};
		}
		if (kind === "location" && m.location) {
			out.location = {
				title: m.location.title,
				address: m.location.address,
				latitude: m.location.latitude,
				longitude: m.location.longitude,
			};
		}
		const reactions = reactionsOf(m);
		if (reactions.length) out.reactions = reactions;
		if (isEdited(m)) {
			out.edited = true;
			const at = editedMs(m);
			if (at) out.edited_ms = at;
		}
		return out;
	}

	#pictureOf(mid: string): string | undefined {
		const path = this.#pictures.get(mid);
		return path ? `${PROFILE_CDN}${path.startsWith("/") ? "" : "/"}${path}/preview` : undefined;
	}

	/** Friends and groups for the desktop client's address book; an empty query lists them all. */
	async clientContacts(query: string): Promise<(Contact & { picture?: string })[]> {
		const contacts = await this.searchContacts(query);
		return contacts.map((c) => ({ ...c, picture: this.#pictureOf(c.id) }));
	}

	async searchContacts(query: string): Promise<Contact[]> {
		await this.#ready();
		const dir = await this.#loadDirectory();
		const q = foldForSearch(query);
		return [...dir.friends, ...dir.groups].filter((c) =>
			foldForSearch(c.name).includes(q)
		);
	}

	/**
	 * `agent` sends (MCP) are rate limited and logged to sent.log; the owner
	 * typing in the desktop client is neither.
	 */
	async sendMessage(opts: { chatId: string; text: string; replyTo?: string; agent: boolean }) {
		await this.#ready();
		assertMid(opts.chatId);
		if (opts.agent) this.#takeSendSlot();
		const send = (e2ee: boolean) =>
			this.base.talk.sendMessage({ to: opts.chatId, text: opts.text, e2ee, relatedMessageId: opts.replyTo });
		let sent;
		try {
			sent = await send(true);
		} catch (e) {
			// Official accounts have no E2EE keys; every other chat stays encrypted.
			if (!opts.chatId.startsWith("u") || !(await this.#isOfficial(opts.chatId))) throw e;
			sent = await send(false);
		}
		await this.#resolveNames([opts.chatId]);
		const result = {
			message_id: String(sent.id),
			chat_id: opts.chatId,
			chat_name: this.#nameOf(opts.chatId),
			sent_at: formatTime(Date.now()),
		};
		if (opts.agent) {
			appendFileSync(
				config.sendLogPath,
				JSON.stringify({ ...result, text: opts.text }) + "\n",
				{ mode: 0o600 },
			);
		}
		return result;
	}

	#takeSendSlot() {
		const now = Date.now();
		this.#sendTimes = this.#sendTimes.filter((t) => now - t < SEND_WINDOW_MS);
		const last = this.#sendTimes.at(-1);
		if (last !== undefined && now - last < SEND_MIN_GAP_MS) {
			throw new Error("Sending too fast; wait a few seconds and retry.");
		}
		if (this.#sendTimes.length >= SEND_BURST) {
			throw new Error(
				`Send limit reached (${SEND_BURST} messages per 10 minutes). This protects the account from LINE's spam detection.`,
			);
		}
		this.#sendTimes.push(now);
	}

	async #decrypt(raw: RawMessage): Promise<RawMessage> {
		if (!raw.contentMetadata?.e2eeVersion) return raw;
		let m: RawMessage;
		try {
			m = await this.base.e2ee.decryptE2EEMessage(raw);
		} catch {
			return { ...raw, text: UNDECRYPTABLE };
		}
		// An encrypted file's name is in its payload, which linejs only opens to download it.
		if (kindOf(m) === "file" && !m.contentMetadata?.FILE_NAME && m.chunks?.length) {
			try {
				const { fileName } = await this.base.e2ee.decryptE2EEDataMessage(m);
				if (typeof fileName === "string" && fileName) {
					m = { ...m, contentMetadata: { ...m.contentMetadata, FILE_NAME: fileName } };
				}
			} catch { /* the name is cosmetic; the download decrypts on its own */ }
		}
		return m;
	}

	#format(m: RawMessage, chatId: string): FormattedMessage {
		const mine = m.from === this.base.profile?.mid;
		const meta = m.contentMetadata ?? {};
		const reactions = reactionsOf(m).map((r) => ({ type: r.type, from: this.#nameOf(r.from_id) }));
		const unsent = this.#isUnsent(m);
		const editedAt = editedMs(m);
		return {
			id: String(m.id),
			time: formatTime(Number(m.createdTime)),
			from: mine ? "me" : this.#nameOf(m.from),
			// In a 1:1 chat the other person's id is the chat id.
			...(mine || m.from === chatId ? {} : { from_id: m.from }),
			text: unsent ? "[unsent]" : describe(m),
			...(m.relatedMessageId ? { reply_to: String(m.relatedMessageId) } : {}),
			...(kindOf(m) === "sticker" && meta.STKID
				? { sticker: { package_id: meta.STKPKGID, sticker_id: meta.STKID, version: meta.STKVER ?? "1" } }
				: {}),
			...(reactions.length ? { reactions } : {}),
			...(unsent ? { unsent: true } : {}),
			...(!unsent && isEdited(m) ? { edited: true, ...(editedAt ? { edited_at: formatTime(editedAt) } : {}) } : {}),
		};
	}

	#nameOf(mid: string): string {
		if (mid === this.base.profile?.mid) return "me";
		return this.#names.get(mid) ??
			(mid.startsWith("r") ? "(multi-person chat)" : "(unknown)");
	}

	async #loadDirectory() {
		if (this.#directory && Date.now() - this.#directory.at < DIRECTORY_TTL_MS) {
			return this.#directory;
		}
		const [{ userFriendMids }, { memberChatMids }] = await Promise.all([
			this.base.relation.getUserFriendIds({ request: { blockStatus: "ALL" } }),
			this.base.talk.getAllChatMids({
				request: { withMemberChats: true },
				syncReason: "INTERNAL",
			}),
		]);
		const [users, chats] = await Promise.all([
			this.#fetchUserNames(userFriendMids ?? []),
			this.#fetchGroupNames(memberChatMids ?? []),
		]);
		const friends: Contact[] = [...users].map(([id, name]) => ({ id, name, type: "user" }));
		const groups: Contact[] = [...chats].map(([id, name]) => ({ id, name, type: "group" }));
		this.#directory = { at: Date.now(), friends, groups };
		return this.#directory;
	}

	async #resolveNames(mids: string[]) {
		const missing = [...new Set(mids)].filter((mid) =>
			MID_RE.test(mid) && !this.#names.has(mid) &&
			mid !== this.base.profile?.mid
		);
		// Names are cosmetic: a failed lookup must not fail the tool call.
		await Promise.all([
			this.#fetchUserNames(missing.filter((m) => m.startsWith("u"))).catch(() => {}),
			this.#fetchGroupNames(missing.filter((m) => !m.startsWith("u"))).catch(() => {}),
		]);
	}

	// LINE rejects lookups of more than LOOKUP_BATCH ids per call (INVALID_LENGTH).
	async #fetchUserNames(mids: string[]): Promise<Map<string, string>> {
		const names = new Map<string, string>();
		for (const batch of chunks(mids, LOOKUP_BATCH)) {
			const { contacts } = await this.base.talk.getContactsV2({ mids: batch });
			for (const [mid, entry] of Object.entries(contacts ?? {})) {
				names.set(mid, userName(entry));
				if (entry.contact?.picturePath) this.#pictures.set(mid, entry.contact.picturePath);
			}
		}
		for (const [mid, name] of names) this.#names.set(mid, name);
		return names;
	}

	async #fetchGroupNames(mids: string[]): Promise<Map<string, string>> {
		const names = new Map<string, string>();
		for (const batch of chunks(mids, LOOKUP_BATCH)) {
			const { chats } = await this.base.talk.getChats({ chatMids: batch });
			for (const chat of chats ?? []) {
				// Rooms (r…) usually have no name of their own.
				if (chat.chatName) names.set(chat.chatMid, chat.chatName);
				if (chat.picturePath) this.#pictures.set(chat.chatMid, chat.picturePath);
			}
		}
		for (const [mid, name] of names) this.#names.set(mid, name);
		return names;
	}
}

/**
 * From LINE's read ranges (member → ranges of message ids they have read), the
 * newest message id each member has read, leaving out the owner.
 *
 * linejs leaves this struct undecoded: a member's ranges arrive as an object
 * keyed "0", "1", … and each range by field number, "2" being endMessageId.
 */
export function latestReads(ranges: Record<string, unknown>, ownMid?: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [mid, value] of Object.entries(ranges)) {
		if (mid === ownMid || !value || typeof value !== "object") continue;
		const entries = Array.isArray(value) ? value : Object.values(value);
		let newest: bigint | undefined;
		for (const entry of entries) {
			const range = entry as { endMessageId?: unknown; 2?: unknown } | undefined;
			const end = range?.endMessageId ?? range?.[2];
			if (end === undefined || end === null) continue;
			const id = BigInt(String(end));
			if (newest === undefined || id > newest) newest = id;
		}
		if (newest !== undefined && newest > 0n) out[mid] = String(newest);
	}
	return out;
}

function chunks<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

interface NameSources {
	friendDetail?: { user?: { overriddenName?: string } };
	targetProfileDetail?: { profileName?: string };
	contact?: { displayNameOverridden?: string; displayName?: string };
}

/** Handles both getContactsV3 and getContactsV2 shapes; prefers your own nickname for them. */
function userName(raw: unknown): string {
	const r = raw as NameSources;
	return r.friendDetail?.user?.overriddenName ||
		r.contact?.displayNameOverridden ||
		r.targetProfileDetail?.profileName ||
		r.contact?.displayName ||
		"(unknown)";
}

type PushOperation = {
	type: unknown;
	param1: string;
	param2: string;
	param3: string;
	message: RawMessage;
};

function contentTypeName(m: RawMessage): string {
	return typeof m.contentType === "number"
		? CONTENT_TYPES[m.contentType] ?? String(m.contentType)
		: String(m.contentType ?? "NONE");
}

function kindOf(m: RawMessage): MessageKind {
	switch (contentTypeName(m)) {
		case "NONE": return "text";
		case "STICKER": return "sticker";
		case "IMAGE": case "EXTIMAGE": return "image";
		case "VIDEO": return "video";
		case "AUDIO": return "audio";
		case "FILE": return "file";
		case "LOCATION": return "location";
		case "CONTACT": return "contact";
		case "FLEX": case "RICH": case "HTML": case "APPLINK": case "LINK": return "rich";
		case "CALL": return "call";
		case "CHATEVENT": return "system";
		default: return "other";
	}
}

/** Keeps only what a later media download needs; chunks hold the encrypted key. */
function serializeRaw(m: RawMessage): string {
	return JSON.stringify({
		id: String(m.id),
		from: m.from,
		to: m.to,
		toType: m.toType,
		contentType: m.contentType,
		contentMetadata: m.contentMetadata,
		chunks: (m.chunks ?? []).map((c) =>
			typeof c === "string" ? c : { b64: Buffer.from(c).toString("base64") }
		),
	});
}

function reviveRaw(json: string): RawMessage {
	const r = JSON.parse(json);
	r.chunks = r.chunks.map((c: string | { b64: string }) =>
		typeof c === "string" ? c : Buffer.from(c.b64, "base64")
	);
	return r as RawMessage;
}

function reactionsOf(m: RawMessage): { type: string; from_id: string }[] {
	return (m.reactions ?? []).map((r) => ({
		type: String(r.reactionType?.predefinedReactionType ?? ""),
		from_id: r.fromUserMid,
	})).filter((r) => r.type);
}

function reactionMessageId(param: string): string | undefined {
	try {
		const parsed = JSON.parse(param);
		return parsed?.messageId ? String(parsed.messageId) : undefined;
	} catch {
		return /^\d+$/.test(param) ? param : undefined;
	}
}

/**
 * LINE keeps serving an unsent message in history, emptied: a text message
 * with neither text nor encrypted chunks. Nothing a person sends looks like that.
 */
function isUnsentStub(m: RawMessage): boolean {
	return contentTypeName(m) === "NONE" && !m.text && !m.chunks?.length;
}

/**
 * When the sender last edited the message. Only text can be edited. Edit
 * pushes set `EDITED` and `UPDATED_TIME`; messages read from history carry
 * only `UPDATED_TIME`, which photos have too without being edited.
 */
function editedMs(m: RawMessage): number | undefined {
	if (contentTypeName(m) !== "NONE") return undefined;
	const at = Number(m.contentMetadata?.UPDATED_TIME);
	return at > Number(m.createdTime) ? at : undefined;
}

function isEdited(m: RawMessage): boolean {
	return m.contentMetadata?.EDITED === "true" || editedMs(m) !== undefined;
}

function describe(m: RawMessage): string {
	const type = contentTypeName(m);
	const meta = m.contentMetadata ?? {};
	switch (type) {
		case "NONE":
			return m.text ?? "";
		case "STICKER":
			return "[sticker]";
		case "IMAGE":
		case "EXTIMAGE":
			return "[image]";
		case "VIDEO":
			return "[video]";
		case "AUDIO":
			return "[voice message]";
		case "FILE":
			return `[file: ${meta.FILE_NAME ?? "unnamed"}${Number(meta.FILE_SIZE) > 0 ? `, ${formatSize(Number(meta.FILE_SIZE))}` : ""}]`;
		case "CONTACT":
			return `[contact card: ${meta.displayName ?? ""}]`;
		case "LOCATION":
			return `[location: ${[m.location?.title, m.location?.address].filter(Boolean).join(", ")}]`;
		case "CALL":
			return "[call]";
		case "FLEX":
		case "RICH":
			return `[rich message${meta.ALT_TEXT ? `: ${meta.ALT_TEXT}` : ""}]`;
		default:
			return m.text || `[${type.toLowerCase()}]`;
	}
}

function lastActivity(box: { lastMessages?: RawMessage[]; lastDeliveredMessageId?: { deliveredTime: unknown } }): number {
	return Number(box.lastMessages?.[0]?.createdTime ?? box.lastDeliveredMessageId?.deliveredTime ?? 0);
}

export function chatType(mid: string): Contact["type"] {
	return mid.startsWith("c") ? "group" : mid.startsWith("r") ? "room" : "user";
}

function assertMid(mid: string) {
	if (!MID_RE.test(mid)) {
		throw new Error(
			"chat_id must be a LINE id like u…/c…/r… followed by 32 hex characters. Use line_list_chats or line_search_contacts to find it.",
		);
	}
}

function parseCursor(cursor: string): Cursor {
	const match = /^(\d+)_(\d+)$/.exec(cursor);
	if (!match) throw new Error("Invalid cursor; pass older_cursor from a previous call.");
	return { deliveredTime: BigInt(match[1]), messageId: BigInt(match[2]) };
}

const timeFormat = new Intl.DateTimeFormat("sv-SE", {
	timeZone: config.timeZone,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
});

export function formatTime(ms: number): string {
	return timeFormat.format(new Date(ms));
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
