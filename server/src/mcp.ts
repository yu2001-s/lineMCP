import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type Archive, type ArchiveSync, lastSyncLabel } from "./archive.ts";
import { config } from "./config.ts";
import { chatType, errorMessage, formatTime, type LineService, type MediaFile, REACTIONS } from "./line.ts";
import { readCache, writeCache } from "./mediacache.ts";
import { type Listeners, maskHeaders } from "./listeners.ts";
import { FILE_LIMIT, formatSize, isTextFile, previewImage, readText, sendKind, textFileType } from "./mediatools.ts";
import type { Organizer } from "./organizer.ts";
import { UPLOAD_ID_RE, type Uploads } from "./uploads.ts";

// Hosts cut server instructions off at 2048 characters (mcp.test.ts checks
// the length), so details belong in the tool descriptions.
export const INSTRUCTIONS = `Tools for the user's personal LINE account (tool descriptions call the user "the owner"). They can do what the owner does in the betterLINE app.

- Chat ids: u… 1:1, c… group, r… multi-person room. line_search_contacts and line_list_chats find them.
- line_read_messages reads the last 14 days, all LINE serves. Archived chats are also kept locally: line_read_archive reads further back and line_search_messages searches them (archived chats only). The line_archive_* tools choose which chats are archived.
- The user tags chats in betterLINE, e.g. Work, or the company a contact works at (Acme); a chat can have several tags, and betterLINE shows the chats by tag. line_list_tags lists them, the tags filter narrows line_list_chats and line_search_messages, and line_tag_* change them.
- Chats the user hid in betterLINE are left out of every tool; line_hide_chats hides more.
- line_send_message, line_send_sticker, line_send_file (text you wrote, or any file uploaded with line_create_upload) and line_forward_media send; line_react, line_unsend and line_mark_read act on messages; line_read_receipts shows who read what; line_get_media opens photos and files.
- line_listen_set POSTs every new message in the chosen chats or tags to a webhook.
- Reading never marks messages read.`;

const HIDDEN = "The owner hid this chat in betterLINE, so these tools leave it alone. They can unhide it in betterLINE → Settings → 聊天室.";

const chatId = z
	.string()
	.regex(/^[ucr][0-9a-f]{32}$/)
	.describe("LINE chat id (u… for a 1:1 chat, c… for a group, r… for a room)");

const userId = z
	.string()
	.regex(/^u[0-9a-f]{32}$/)
	.describe("LINE user id (u…): a friend's chat id from line_search_contacts, or a message's from_id");

const tagFilter = z.array(z.string().min(1)).min(1).max(20);

const tagNames = z.array(z.string().trim().min(1).max(40)).min(1).max(10);

const messageId = z
	.string()
	.regex(/^\d+$/)
	.describe("Message id from line_read_messages or line_read_archive");

const fileName = z
	.string()
	.min(3)
	.max(100)
	.regex(/^[^/\\:*?"<>|\u0000-\u001f]+$/);

const ORGANIZE_ONLY = "Only when the owner asked for it, or as part of a task they gave you.";

export function buildMcpServer(
	line: LineService,
	archive: Archive,
	sync: ArchiveSync,
	organizer: Organizer,
	listeners: Listeners,
	uploads: Uploads,
): McpServer {
	const server = new McpServer(
		{ name: "line-personal", version: "0.1.0" },
		{ instructions: INSTRUCTIONS },
	);
	const visible = (id: string) => !organizer.isHidden(id);
	/** Every tool that takes a chat id goes through this first. */
	const allow = (...ids: (string | undefined)[]) => {
		if (ids.some((id) => id && organizer.isHidden(id))) throw new Error(HIDDEN);
	};
	/** Tags with their visible chats; a tag only hidden chats have is left out. */
	const visibleTags = () =>
		organizer.tagList().map((t) => ({ ...t, chat_ids: t.chat_ids.filter(visible) })).filter((t) => t.chat_ids.length);
	/** The owner's tags as spelled, or an error naming the tags there are. */
	const tagsNamed = (names: string[]) => {
		const known = visibleTags().map((t) => t.name);
		return names.map((name) => {
			const tag = organizer.tagNamed(name);
			if (tag && known.includes(tag)) return tag;
			throw new Error(known.length
				? `No tag named "${name}". The owner's tags: ${known.join(", ")}.`
				: "No chats are tagged yet.");
		});
	};
	const taggedWith = (tags: string[], all: boolean) => (id: string) => {
		const has = organizer.tagsOf(id);
		return all ? tags.every((t) => has.includes(t)) : tags.some((t) => has.includes(t));
	};
	const chatsWithTags = async (ids: string[]) => {
		const unique = [...new Set(ids)];
		const names = await line.chatNames(unique).catch(() => new Map<string, string>());
		return { chats: unique.map((id) => ({ chat_id: id, name: names.get(id), tags: organizer.tagsOf(id) })) };
	};
	const tagSummary = () => visibleTags().map((t) => ({ name: t.name, chats: t.chat_ids.length }));

	server.registerTool(
		"line_get_status",
		{
			title: "LINE connection status",
			description: "Shows whether the LINE session is connected and which account it is.",
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		() => run(async () => ({ status: line.status, error: line.lastError, account: line.me })),
	);

	server.registerTool(
		"line_list_chats",
		{
			title: "List LINE chats",
			description:
				"Lists recent chats (1:1, groups, rooms) with unread counts and the latest message, newest first. " +
				"Each tagged chat lists its tags. " +
				"Only chats with messages in the last 14 days; line_list_tags lists every tagged chat.",
			inputSchema: {
				limit: z.number().int().min(1).max(100).default(20),
				unread_only: z.boolean().default(false).describe("Only chats with unread messages"),
				tags: tagFilter.optional().describe(
					"Only chats with any of these tags (all of them with match_all_tags), see line_list_tags",
				),
				match_all_tags: z.boolean().default(false).describe("With tags: only chats that have every one of them"),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		({ limit, unread_only, tags, match_all_tags }) =>
			run(async () => {
				const tagged = tags === undefined ? undefined : taggedWith(tagsNamed(tags), match_all_tags);
				const chats = await line.listChats({
					limit,
					unreadOnly: unread_only,
					include: (id) => visible(id) && (!tagged || tagged(id)),
				});
				return chats.map((c) => {
					const chatTags = organizer.tagsOf(c.chat_id);
					return chatTags.length ? { ...c, tags: chatTags } : c;
				});
			}),
	);

	server.registerTool(
		"line_list_tags",
		{
			title: "List betterLINE tags",
			description:
				"Lists the tags on the owner's chats (for example Work, or the company a contact works at) with every chat that has each, " +
				"including chats with no messages in the last 14 days. A chat can have several tags. betterLINE shows the chats by tag.",
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		() =>
			run(async () => {
				const tags = visibleTags();
				if (!tags.length) return { tags: [], note: "No chats are tagged yet. Tag them in betterLINE or with line_tag_add." };
				const names = await line.chatNames([...new Set(tags.flatMap((t) => t.chat_ids))]);
				return {
					tags: tags.map((t) => ({
						name: t.name,
						chats: t.chat_ids.map((id) => ({ chat_id: id, name: names.get(id), type: chatType(id) })),
					})),
				};
			}),
	);

	server.registerTool(
		"line_tag_add",
		{
			title: "Tag LINE chats",
			description:
				"Adds tags to one or more chats; the owner sees them in betterLINE. A name that matches an existing tag " +
				"(ignoring case and Simplified/Traditional Chinese) adds that tag. Only when the owner asked for it, or as part of a task they gave you.",
			inputSchema: {
				chat_ids: z.array(chatId).min(1).max(100).describe("Chats to tag"),
				tags: tagNames.describe("Tags to add, e.g. Work, or a company name such as Acme"),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		({ chat_ids, tags }) =>
			run(async () => {
				allow(...chat_ids);
				organizer.addTags(chat_ids, tags);
				return chatsWithTags(chat_ids);
			}),
	);

	server.registerTool(
		"line_tag_remove",
		{
			title: "Untag LINE chats",
			description:
				"Removes tags from one or more chats. A tag no chat has any more disappears. Only when the owner asked for it, or as part of a task they gave you.",
			inputSchema: {
				chat_ids: z.array(chatId).min(1).max(100).describe("Chats to untag"),
				tags: tagNames.describe("Tags to remove"),
			},
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		({ chat_ids, tags }) =>
			run(async () => {
				allow(...chat_ids);
				organizer.removeTags(chat_ids, tags);
				return chatsWithTags(chat_ids);
			}),
	);

	server.registerTool(
		"line_tag_rename",
		{
			title: "Rename a betterLINE tag",
			description:
				"Renames a tag on every chat that has it. Renaming to the name of another tag merges the two. " + ORGANIZE_ONLY,
			inputSchema: {
				tag: z.string().min(1).describe("The tag to rename (see line_list_tags)"),
				to: z.string().trim().min(1).max(40).describe("New name"),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		({ tag, to }) =>
			run(async () => {
				const [name] = tagsNamed([tag]);
				organizer.changeTags([{ op: "rename", tags: [name], to }]);
				return { tags: tagSummary() };
			}),
	);

	server.registerTool(
		"line_tag_delete",
		{
			title: "Delete a betterLINE tag",
			description: "Takes a tag off every chat that has it, so the tag disappears. The chats are not changed otherwise. " + ORGANIZE_ONLY,
			inputSchema: { tag: z.string().min(1).describe("The tag to delete (see line_list_tags)") },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		({ tag }) =>
			run(async () => {
				const [name] = tagsNamed([tag]);
				organizer.changeTags([{ op: "delete", tags: [name] }]);
				return { deleted: name, tags: tagSummary() };
			}),
	);

	server.registerTool(
		"line_hide_chats",
		{
			title: "Hide LINE chats in betterLINE",
			description:
				"Hides chats in betterLINE (隱藏聊天室): they leave the owner's chat list, search and Dock badge, never notify, " +
				"and disappear from every LINE tool, yours included. Only the owner can unhide them, in betterLINE → Settings → 聊天室. " +
				"Only when the owner asked to hide these chats.",
			inputSchema: { chat_ids: z.array(chatId).min(1).max(100).describe("Chats to hide") },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		({ chat_ids }) =>
			run(async () => {
				allow(...chat_ids);
				const ids = [...new Set(chat_ids)];
				const names = await line.chatNames(ids).catch(() => new Map<string, string>());
				const chats = ids.map((id) => ({ chat_id: id, name: names.get(id) ?? "" }));
				organizer.hide(chats);
				return { hidden: chats, note: "The owner can unhide them in betterLINE → Settings → 聊天室." };
			}),
	);

	server.registerTool(
		"line_read_messages",
		{
			title: "Read LINE messages",
			description:
				"Returns messages of one chat in chronological order. Does not mark them as read. " +
				"A message the sender unsent has `unsent: true` and no text (LINE keeps none); " +
				"an edited one has `edited: true` and `edited_at`, with the edited text. " +
				"Pass older_cursor from a previous result as `before` to page further back.",
			inputSchema: {
				chat_id: chatId,
				limit: z.number().int().min(1).max(100).default(30),
				before: z.string().optional().describe("older_cursor from a previous call"),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		({ chat_id, limit, before }) =>
			run(() => {
				allow(chat_id);
				return line.readMessages({ chatId: chat_id, limit, before });
			}),
	);

	server.registerTool(
		"line_search_contacts",
		{
			title: "Search LINE friends and groups",
			description:
				"Finds friends and groups whose name contains the query (case-insensitive; Simplified and Traditional Chinese match each other). Returns their chat ids.",
			inputSchema: { query: z.string().min(1) },
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		({ query }) => run(async () => (await line.searchContacts(query)).filter((c) => visible(c.id))),
	);

	server.registerTool(
		"line_send_message",
		{
			title: "Send a LINE message",
			description:
				"Sends a text message from the owner's personal LINE account (end-to-end encrypted). " +
				"Only use when the user explicitly asked to send this exact text to this exact chat. " +
				"Rate limited to protect the account.",
			inputSchema: {
				chat_id: chatId,
				text: z.string().min(1).max(5000),
				reply_to_message_id: z
					.string()
					.regex(/^\d+$/)
					.optional()
					.describe("Message id to reply to (quote)"),
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		({ chat_id, text, reply_to_message_id }) =>
			run(() => {
				allow(chat_id);
				return line.sendMessage({ chatId: chat_id, text, replyTo: reply_to_message_id, agent: true });
			}),
	);

	server.registerTool(
		"line_get_media",
		{
			title: "Open a LINE photo or file",
			description:
				"Opens the photo, video, voice message or file in a message shown as [image], [video], [voice message] or [file: …] " +
				"by line_read_messages or line_read_archive (read the chat first). Photos come back as an image you can see, " +
				"resized to at most 1568 px; text files (txt, md, csv, json, …) come back as text. Anything else (PDF, Excel, Word, " +
				"zip, video, voice message, …) comes back whole as an embedded file resource, up to 20 MB; Claude Code saves it " +
				"to a local file and gives you the path, and the result also gives the original file name.",
			inputSchema: { chat_id: chatId, message_id: messageId },
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ chat_id, message_id }) => {
			try {
				allow(chat_id);
				return { content: await mediaContent(await loadMedia(line, archive, chat_id, message_id), message_id) };
			} catch (e) {
				return { isError: true, content: [{ type: "text", text: errorMessage(e) }] };
			}
		},
	);

	server.registerTool(
		"line_forward_media",
		{
			title: "Forward a LINE photo or file",
			description:
				"Sends the photo, video, voice message or file from one message to another chat, end-to-end encrypted. " +
				"Only use when the user explicitly asked to forward this item to this chat. Rate limited with line_send_message.",
			inputSchema: {
				from_chat_id: chatId.describe("Chat the message is in"),
				message_id: messageId,
				to_chat_id: chatId.describe("Chat to send it to"),
			},
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		},
		({ from_chat_id, message_id, to_chat_id }) =>
			run(async () => {
				allow(from_chat_id, to_chat_id);
				const media = await loadMedia(line, archive, from_chat_id, message_id);
				const sent = await line.sendMedia(to_chat_id, {
					data: new Blob([new Uint8Array(media.data)], { type: media.type }),
					kind: media.kind,
					fileName: media.name,
					durationMs: media.durationMs,
					agent: true,
				});
				return { ...sent, to_chat_id, forwarded: { message_id, kind: media.kind, file_name: media.name } };
			}),
	);

	server.registerTool(
		"line_create_upload",
		{
			title: "Upload a file to send on LINE",
			description:
				"Returns a one-time URL for a local file you want to send with line_send_file: a PDF, photo, video or any other file up to 100 MB. " +
				"PUT the file's bytes to the url (curl -T <path> '<url>'), then pass upload_id to line_send_file. " +
				"The upload is kept for an hour, so the same file can go to several chats.",
			inputSchema: { file_name: fileName.describe("The name the recipient sees, with its extension, e.g. 報價單.pdf or photo.jpg") },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		({ file_name }) =>
			run(async () => {
				const { id, expires } = uploads.create(file_name);
				const url = `${config.publicUrl}/upload/${id}`;
				return { upload_id: id, url, expires: formatTime(expires), how: `curl -sS -T '<path to the file>' '${url}'` };
			}),
	);

	server.registerTool(
		"line_send_file",
		{
			title: "Send a file or photo on LINE",
			description:
				"Sends a file end-to-end encrypted: a text file you wrote (content, with file_name), or a file you uploaded with line_create_upload (upload_id). " +
				"Uploaded .jpg .png .gif go as a photo and .mp4 .mov .m4v as a video unless as_file is true; everything else goes as a file. " +
				"Only use when the user explicitly asked to send this file to this chat. Rate limited with line_send_message.",
			inputSchema: {
				chat_id: chatId,
				file_name: fileName.optional().describe(
					"For content: a name ending in .txt .md .csv .tsv .json .html .xml .yaml .log .ics .vcf or .srt. For upload_id: overrides the uploaded name",
				),
				content: z.string().min(1).max(200_000).optional().describe("The file's text (UTF-8)"),
				upload_id: z.string().regex(UPLOAD_ID_RE).optional().describe("From line_create_upload, after the file was PUT to its url"),
				as_file: z.boolean().default(false).describe("Send a photo or video as a file attachment instead"),
			},
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		},
		({ chat_id, file_name, content, upload_id, as_file }) =>
			run(async () => {
				allow(chat_id);
				if ((content === undefined) === (upload_id === undefined)) throw new Error("Pass either content or upload_id.");
				if (upload_id !== undefined) {
					const upload = uploads.read(upload_id);
					const name = file_name ?? upload.fileName;
					const { kind, type } = sendKind(name, as_file);
					return await line.sendMedia(chat_id, {
						data: new Blob([new Uint8Array(upload.data)], { type }),
						kind,
						fileName: name,
						agent: true,
					});
				}
				const type = file_name && textFileType(file_name);
				if (!type) {
					throw new Error("With content, file_name must end in .txt, .md, .csv, .tsv, .json, .html, .xml, .yaml, .log, .ics, .vcf or .srt.");
				}
				return await line.sendMedia(chat_id, {
					data: new Blob([content!], { type: `${type}; charset=utf-8` }),
					kind: "file",
					fileName: file_name!,
					agent: true,
				});
			}),
	);

	server.registerTool(
		"line_send_sticker",
		{
			title: "Send a LINE sticker",
			description:
				"Sends a sticker. Take package_id, sticker_id and version from a message's sticker field in line_read_messages " +
				"(LINE refuses paid stickers the owner does not have). Only use when the user asked to send a sticker to this chat. " +
				"Rate limited with line_send_message.",
			inputSchema: {
				chat_id: chatId,
				package_id: z.string().regex(/^\d+$/),
				sticker_id: z.string().regex(/^\d+$/),
				version: z.string().regex(/^\d+$/).default("1"),
			},
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		},
		({ chat_id, package_id, sticker_id, version }) =>
			run(async () => {
				allow(chat_id);
				return { ...await line.sendSticker(chat_id, { packageId: package_id, stickerId: sticker_id, version, agent: true }), chat_id };
			}),
	);

	server.registerTool(
		"line_react",
		{
			title: "React to a LINE message",
			description:
				"Adds the owner's reaction to a message, or takes it back with UNDO: NICE 👍, LOVE ❤️, FUN 😆, AMAZING 😲, SAD 😢, OMG 😱. " +
				"Everyone in the chat sees it. Only when the owner asked for it. Rate limited with line_send_message.",
			inputSchema: {
				chat_id: chatId.describe("Chat the message is in"),
				message_id: messageId,
				reaction: z.enum([...REACTIONS, "UNDO"]),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		({ chat_id, message_id, reaction }) =>
			run(async () => {
				allow(chat_id);
				await line.react(message_id, reaction, chat_id);
				return { chat_id, message_id, reaction };
			}),
	);

	server.registerTool(
		"line_unsend",
		{
			title: "Unsend a LINE message",
			description:
				"Unsends one of the owner's own messages, removing it for everyone in the chat. LINE allows this within 24 hours of sending. " +
				"Only when the owner asked to unsend this message.",
			inputSchema: { chat_id: chatId.describe("Chat the message is in"), message_id: messageId },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		},
		({ chat_id, message_id }) =>
			run(async () => {
				allow(chat_id);
				await line.unsend(message_id, chat_id);
				return { chat_id, unsent: message_id };
			}),
	);

	server.registerTool(
		"line_mark_read",
		{
			title: "Mark a LINE chat as read",
			description:
				"Marks a chat read up to its newest message (or up to message_id), as opening it on the phone does: " +
				"the unread count clears and the other members see 已讀. Only when the owner asked for it.",
			inputSchema: {
				chat_id: chatId,
				message_id: messageId.optional().describe("Mark read up to this message instead of the newest"),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		({ chat_id, message_id }) =>
			run(async () => {
				allow(chat_id);
				const upTo = message_id ?? await line.newestMessageId(chat_id);
				if (!upTo) throw new Error("This chat has no messages in the last 14 days.");
				await line.markRead(chat_id, upTo);
				return { chat_id, read_up_to: upTo };
			}),
	);

	server.registerTool(
		"line_read_receipts",
		{
			title: "See who read LINE messages",
			description:
				"For each other member of a chat, the id of the newest message they have read: they have read every message up to it. " +
				"Compare with message ids from line_read_messages. Checking sends nothing to anyone.",
			inputSchema: { chat_id: chatId },
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		({ chat_id }) =>
			run(async () => {
				allow(chat_id);
				const markers = await line.readMarkers(chat_id);
				const names = await line.chatNames(Object.keys(markers)).catch(() => new Map<string, string>());
				return {
					chat_id,
					readers: Object.entries(markers).map(([id, upTo]) => ({ id, name: names.get(id), read_up_to: upTo })),
				};
			}),
	);

	server.registerTool(
		"line_archive_add",
		{
			title: "Archive a LINE chat",
			description:
				"Starts keeping a local copy of a chat, regardless of the auto-archive rules: saves the 14 days LINE still serves now, then syncs it daily so its history keeps growing beyond 14 days.",
			inputSchema: { chat_id: chatId },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		({ chat_id }) =>
			run(() => {
				allow(chat_id);
				return sync.syncChat(chat_id);
			}),
	);

	server.registerTool(
		"line_archive_remove",
		{
			title: "Stop archiving a LINE chat",
			description:
				"Stops archiving a chat; the auto-archive rules will not add it back. Its saved messages are kept unless delete_messages is true, which deletes them permanently.",
			inputSchema: {
				chat_id: chatId,
				delete_messages: z.boolean().default(false),
			},
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		({ chat_id, delete_messages }) =>
			run(async () => {
				allow(chat_id);
				return { chat_id, ...archive.remove(chat_id, delete_messages) };
			}),
	);

	server.registerTool(
		"line_archive_list",
		{
			title: "List archived LINE chats",
			description: "Lists archived chats with how many messages are saved, the date range, and the last sync.",
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		() =>
			run(async () => ({
				last_full_sync: lastSyncLabel(archive),
				chats: archive.chats().filter((c) => visible(c.chat_id)).map((c) => ({
					chat_id: c.chat_id,
					name: c.name,
					messages: c.messages,
					oldest: c.oldest ? formatTime(c.oldest) : undefined,
					newest: c.newest ? formatTime(c.newest) : undefined,
					last_synced: c.last_synced_at ? formatTime(c.last_synced_at) : undefined,
					last_error: c.last_error ?? undefined,
				})),
			})),
	);

	server.registerTool(
		"line_archive_rules",
		{
			title: "Show LINE auto-archive rules",
			description:
				"Shows the auto-archive rules and, for every chat active in the last 14 days, whether it is archived, matches the rules, or is skipped and why (official account, too many members, removed by the owner).",
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		() =>
			run(async () => ({
				rules: archive.policy(),
				chats: (await sync.preview()).filter((c) => visible(c.chat_id)),
			})),
	);

	server.registerTool(
		"line_archive_configure",
		{
			title: "Configure LINE auto-archive",
			description:
				"Changes the auto-archive rules. With auto_archive on, every chat matching the rules is archived now and new matching chats are picked up by the daily sync. " +
				"Turning it off stops adding chats; already archived chats keep syncing until removed.",
			inputSchema: {
				auto_archive: z.boolean().optional(),
				max_group_members: z.number().int().min(2).max(500).optional()
					.describe("Groups with more members than this are not archived automatically"),
				skip_official_accounts: z.boolean().optional()
					.describe("Leave out LINE official accounts (brands, shops, services)"),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		({ auto_archive, max_group_members, skip_official_accounts }) =>
			run(async () => {
				const current = archive.policy();
				const rules = {
					auto: auto_archive ?? current.auto,
					maxGroupMembers: max_group_members ?? current.maxGroupMembers,
					skipOfficialAccounts: skip_official_accounts ?? current.skipOfficialAccounts,
				};
				archive.setPolicy(rules);
				const synced = rules.auto ? await sync.syncAll() : [];
				return { rules, synced: synced.filter((r) => visible(r.chat_id)) };
			}),
	);

	server.registerTool(
		"line_archive_sync",
		{
			title: "Sync archived LINE chats now",
			description: "Pulls new messages for every archived chat immediately instead of waiting for the daily sync.",
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		() => run(async () => (await sync.syncAll()).filter((r) => visible(r.chat_id))),
	);

	server.registerTool(
		"line_search_messages",
		{
			title: "Search archived LINE messages",
			description:
				"Full-text search (substring, case-insensitive; Simplified and Traditional Chinese match each other) over archived chats only, newest first. " +
				"Use line_archive_list to see which chats are archived; read any other chat with line_read_messages instead.",
			inputSchema: {
				query: z.string().min(1),
				chat_id: chatId.optional().describe("Limit the search to one archived chat"),
				tags: tagFilter.optional().describe("Limit the search to archived chats with any of these tags (see line_list_tags)"),
				limit: z.number().int().min(1).max(200).default(30),
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		({ query, chat_id, tags, limit }) =>
			run(async () => {
				allow(chat_id);
				const hidden = organizer.state().hidden.map((h) => h.chat_id);
				const tagged = tags === undefined ? undefined : taggedWith(tagsNamed(tags), false);
				const only = tagged && organizer.state().tags.map((t) => t.chat_id).filter((id) => visible(id) && tagged(id));
				return archive.search(query, { chatId: chat_id, limit, only, exclude: hidden });
			}),
	);

	server.registerTool(
		"line_read_archive",
		{
			title: "Read archived LINE messages",
			description:
				"Reads an archived chat from the local copy in chronological order, including messages older than the 14 days LINE serves. " +
				"Pass older_cursor from a previous result as `before` to page further back.",
			inputSchema: {
				chat_id: chatId,
				limit: z.number().int().min(1).max(200).default(50),
				before: z.string().regex(/^\d+$/).optional().describe("older_cursor from a previous call"),
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		({ chat_id, limit, before }) =>
			run(async () => {
				allow(chat_id);
				if (!archive.isArchived(chat_id)) {
					throw new Error("This chat is not archived. Use line_read_messages, or line_archive_add if the owner wants it kept.");
				}
				return { chat_id, ...archive.read(chat_id, { beforeMs: before ? Number(before) : undefined, limit }) };
			}),
	);

	/** A listener's tags with the chats that have them now; a tag no chat has any more has none. */
	const listenedTags = (names: string[] = []) =>
		names.map((name) => {
			const tag = organizer.tagNamed(name);
			const chat_ids = tag ? organizer.tagList().find((t) => t.name === tag)!.chat_ids.filter(visible) : [];
			return { tag: tag ?? name, chat_ids, ...(chat_ids.length ? {} : { note: "No chat has this tag now." }) };
		});

	server.registerTool(
		"line_listen_set",
		{
			title: "Listen to LINE chats",
			description:
				"Registers a webhook for chats, tags, or both: every new message someone else sends in them is POSTed to url as JSON " +
				"{text, listener, chat_id, message: {id, from_id, from_name, kind, text, time}}. " +
				"A tag is followed as it changes: a chat tagged later is heard from, one untagged is not, and renaming the tag keeps the listener. " +
				"Each message is posted once, even if its chat is listed and has a listened tag. Setting an existing name replaces that listener; " +
				"omitting headers then keeps its headers, and headers: {} clears them. Header values are only ever shown masked.",
			inputSchema: {
				name: z.string().min(1).max(100).describe("Name for this listener, e.g. your agent's name"),
				url: z.string().url().describe("Webhook to POST each new message to"),
				chats: z.array(chatId).max(100).optional().describe("Chats to listen to"),
				tags: z
					.array(z.string().trim().min(1).max(40))
					.max(20)
					.optional()
					.describe("Tags to listen to (see line_list_tags): every chat with any of them"),
				headers: z
					.record(z.string(), z.string())
					.optional()
					.describe("Request headers the webhook needs, e.g. Authorization. Omit to keep a replaced listener's headers; {} clears them"),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		({ name, url, chats = [], tags = [], headers }) =>
			run(async () => {
				if (!chats.length && !tags.length) throw new Error("Give chats, tags or both to listen to.");
				allow(...chats);
				const tagList = tagsNamed(tags);
				const listener = listeners.set({
					name,
					url,
					chats: [...new Set(chats)],
					...(tagList.length ? { tags: [...new Set(tagList)] } : {}),
					headers: headers ?? listeners.list().find((l) => l.name === name)?.headers ?? {},
				});
				return { ...listener, headers: maskHeaders(listener.headers), tags: listenedTags(listener.tags) };
			}),
	);

	server.registerTool(
		"line_listen_list",
		{
			title: "List LINE listeners",
			description: "Lists the registered listeners: name, webhook, header names with masked values, the chats each listens to, and its tags with the chats that have them now.",
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		() =>
			run(async () => {
				const all = listeners.list();
				const names = await line.chatNames([...new Set(all.flatMap((l) => l.chats))]).catch(() => new Map<string, string>());
				return all.map((l) => ({
					...l,
					headers: maskHeaders(l.headers ?? {}),
					chats: l.chats.map((id) => ({ chat_id: id, name: names.get(id) })),
					tags: listenedTags(l.tags),
				}));
			}),
	);

	server.registerTool(
		"line_listen_remove",
		{
			title: "Stop listening to LINE chats",
			description: "Removes a listener so its webhook stops getting messages.",
			inputSchema: { name: z.string().min(1) },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		({ name }) => run(async () => ({ removed: listeners.remove(name).name })),
	);

	return server;
}

/** A message's media from the shared cache (also used by the desktop client), downloading it once. */
async function loadMedia(line: LineService, archive: Archive, chat: string, message: string): Promise<MediaFile> {
	const cached = readCache(config.mediaCacheDir, message);
	if (cached?.kind) return cached as MediaFile;
	const media = await line.downloadMedia(chat, message, undefined, archive.mediaRef(message));
	writeCache(config.mediaCacheDir, message, media);
	return media;
}

/** What Claude gets back for a media message: the photo, the text, or the file itself. */
async function mediaContent(media: MediaFile, messageId: string): Promise<CallToolResult["content"]> {
	const details = {
		file_name: media.name,
		kind: media.kind,
		type: media.type,
		size: media.data.length,
		...(media.durationMs ? { duration_ms: media.durationMs } : {}),
	};
	const json = (value: object) => ({ type: "text" as const, text: JSON.stringify(value) });
	let note: string | undefined;
	if (media.kind === "image" || media.type.startsWith("image/")) {
		try {
			const preview = await previewImage(media.data);
			return [
				json({ ...details, width: preview.originalWidth, height: preview.originalHeight, shown_as: `${preview.width}×${preview.height} JPEG` }),
				{ type: "image", data: preview.base64, mimeType: preview.mimeType },
			];
		} catch (e) {
			note = `The image could not be decoded (${errorMessage(e)}), so it comes as a file.`;
		}
	}
	if (isTextFile(media.type, media.name)) {
		const text = readText(media.data);
		if (text) return [json({ ...details, truncated: text.truncated }), { type: "text", text: text.text }];
	}
	if (media.data.length > FILE_LIMIT) {
		throw new Error(
			`${media.name} is ${formatSize(media.data.length)}; line_get_media returns files up to ${formatSize(FILE_LIMIT)}. ` +
				"Ask the owner to save it from LINE or betterLINE.",
		);
	}
	// Claude Code saves a blob to a local file and says where; the name above is the original.
	return [
		json({ ...details, note: note ?? "The file follows as an embedded resource." }),
		{
			type: "resource",
			resource: {
				uri: `line://messages/${messageId}/${encodeURIComponent(media.name)}`,
				mimeType: media.type,
				blob: Buffer.from(media.data).toString("base64"),
			},
		},
	];
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
	try {
		const result = await fn();
		// Compact: indentation costs Claude tokens on every result and adds nothing it needs.
		return { content: [{ type: "text", text: JSON.stringify(result) }] };
	} catch (e) {
		return { isError: true, content: [{ type: "text", text: errorMessage(e) }] };
	}
}
