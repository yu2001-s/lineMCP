import Foundation

// Shapes served by server/src/clientapi.ts. Keys arrive in snake_case and are
// decoded with `.convertFromSnakeCase`, so CodingKeys use camelCase.

enum SessionStatus: String, Codable, Sendable {
	case starting, ready, loggedOut = "logged_out", error, unknown

	init(from decoder: Decoder) throws {
		let raw = try decoder.singleValueContainer().decode(String.self)
		self = SessionStatus(rawValue: raw) ?? .unknown
	}

	var label: String {
		switch self {
		case .starting: "LINE 連線啟動中"
		case .ready: "已連線"
		case .loggedOut: "LINE 已將此裝置登出，請在伺服器上重新掃描 QR 碼登入"
		case .error: "LINE 連線發生錯誤"
		case .unknown: "未知狀態"
		}
	}
}

struct Me: Codable, Sendable, Equatable {
	var id: String
	var name: String
	var statusMessage: String?
	var status: SessionStatus
}

enum ChatType: String, Codable, Sendable {
	case user, group, room
}

enum MessageKind: String, Codable, Sendable {
	case text, sticker, image, video, audio, file, location, contact, rich, call, system, other

	init(from decoder: Decoder) throws {
		let raw = try decoder.singleValueContainer().decode(String.self)
		self = MessageKind(rawValue: raw) ?? .other
	}

	var isMedia: Bool { [.image, .video, .audio, .file].contains(self) }
}

struct Sticker: Codable, Sendable, Hashable {
	var packageId: String
	var stickerId: String
	var version: String
	var animated: Bool
	var url: URL

	/// The still image, also served for animated stickers.
	var staticURL: URL {
		URL(string: "https://stickershop.line-scdn.net/stickershop/v1/sticker/\(stickerId)/android/sticker.png")!
	}
}

struct MediaInfo: Codable, Sendable, Hashable {
	var fileName: String?
	var size: Int64?
	var durationMs: Int?
}

struct Location: Codable, Sendable, Hashable {
	var title: String?
	var address: String?
	var latitude: Double?
	var longitude: Double?
}

struct Reaction: Codable, Sendable, Hashable {
	var type: String
	var fromId: String
}

/// What the client knows about a message it sent but the server has not confirmed.
enum LocalState: Sendable, Hashable {
	case sending
	case failed(String)
}

struct Message: Codable, Sendable, Identifiable, Hashable {
	var id: String
	var chatId: String
	var fromId: String
	var fromName: String
	var fromPicture: URL?
	var mine: Bool
	var timeMs: Int64
	var delivered: String
	var kind: MessageKind
	var text: String
	var replyTo: String?
	var sticker: Sticker?
	var media: MediaInfo?
	var location: Location?
	var reactions: [Reaction]?
	var decryptFailed: Bool?

	// Client-only: optimistic sends.
	var local: LocalState?
	var localFile: URL?

	enum CodingKeys: String, CodingKey {
		case id, chatId, fromId, fromName, fromPicture, mine, timeMs, delivered, kind, text, replyTo,
			sticker, media, location, reactions, decryptFailed
	}

	var date: Date { Date(timeIntervalSince1970: Double(timeMs) / 1000) }
	var isLocal: Bool { local != nil }
	var failedToDecrypt: Bool { decryptFailed == true }

	/// One line for chat lists and notifications.
	var preview: String {
		if failedToDecrypt { return "無法解密的訊息" }
		switch kind {
		case .text: return text.isEmpty ? "[訊息]" : text
		case .sticker: return "[貼圖]"
		case .image: return "[照片]"
		case .video: return "[影片]"
		case .audio: return "[語音訊息]"
		case .file: return "[檔案] \(media?.fileName ?? "")"
		case .location: return "[位置資訊] \(location?.title ?? location?.address ?? "")"
		case .contact: return "[聯絡人] \(displayText)"
		case .call: return "[通話]"
		case .system: return "[系統訊息]"
		case .rich, .other: return displayText
		}
	}

	/// The server describes rich messages as "[rich message: alt text]".
	var displayText: String {
		for prefix in ["[rich message: ", "[contact card: "] where text.hasPrefix(prefix) && text.hasSuffix("]") {
			return String(text.dropFirst(prefix.count).dropLast())
		}
		return text
	}
}

struct Chat: Codable, Sendable, Identifiable, Hashable {
	var chatId: String
	var name: String
	var type: ChatType
	var picture: URL?
	var unread: Int
	var muted: Bool?
	var lastMessage: Message?

	var id: String { chatId }
	var isMuted: Bool { muted == true }
}

struct ChatList: Decodable, Sendable {
	var chats: [Chat]
}

/// A friend or group from the address book, including ones with no recent messages.
struct Contact: Decodable, Sendable, Identifiable, Hashable {
	var id: String
	var name: String
	var type: ChatType
	var picture: URL?
}

struct ContactList: Decodable, Sendable {
	var contacts: [Contact]
}

struct MessagePage: Decodable, Sendable {
	var messages: [Message]
	var olderCursor: String?
}

/// Member mid → id of the newest message they have read.
struct ReadMarkers: Decodable, Sendable {
	var readers: [String: String]
}

enum MessageOrder {
	/// LINE message ids grow over time, so two ids order their messages even
	/// when neither message is loaded.
	static func id(_ a: String, isAtLeast b: String) -> Bool {
		if let x = UInt64(a), let y = UInt64(b) { return x >= y }
		return a.count != b.count ? a.count > b.count : a >= b
	}
}

struct SentMessage: Decodable, Sendable {
	var messageId: String
}

struct SearchHit: Decodable, Sendable, Identifiable {
	var message: Message
	var chatName: String?

	var id: String { message.id }

	enum CodingKeys: String, CodingKey { case chatName }

	init(from decoder: Decoder) throws {
		message = try Message(from: decoder)
		chatName = try decoder.container(keyedBy: CodingKeys.self).decodeIfPresent(String.self, forKey: .chatName)
	}
}

struct SearchResults: Decodable, Sendable {
	var results: [SearchHit]
}

struct ArchiveRules: Decodable, Sendable, Equatable {
	var auto: Bool
	var maxGroupMembers: Int
	var skipOfficialAccounts: Bool
}

struct ArchivedChat: Decodable, Sendable, Identifiable, Equatable {
	var chatId: String
	var name: String
	var mode: String
	var addedAt: Int64
	var lastSyncedAt: Int64?
	var lastError: String?
	var messages: Int
	var oldest: Int64?
	var newest: Int64?

	var id: String { chatId }
}

struct ArchiveStatus: Decodable, Sendable, Equatable {
	var rules: ArchiveRules
	var chats: [ArchivedChat]
}

struct SyncResult: Decodable, Sendable, Identifiable {
	var chatId: String
	var name: String?
	var newMessages: Int?
	var error: String?

	var id: String { chatId }
}

struct SyncResults: Decodable, Sendable {
	var results: [SyncResult]
}

/// The owner's hidden chats and tags as the server keeps them
/// (`/api/organizer`), so the MCP tools can use them too.
struct OrganizerState: Codable, Sendable, Equatable {
	struct HiddenChat: Codable, Sendable, Equatable {
		var chatId: String
		var name: String
	}

	struct TaggedChat: Codable, Sendable, Equatable {
		var chatId: String
		var tags: [String]
	}

	var hidden: [HiddenChat]
	/// Set by the server; 0 until a Mac has saved one.
	var updatedMs: Int64?
	/// Sent by the server, never by this Mac: tags only change through `TagOp`s.
	/// nil from a server older than tags.
	var tags: [TaggedChat]?
	/// Goes up with every change on the server.
	var rev: Int?

	/// Hidden chats, the part this Mac saves.
	func sameContent(as other: OrganizerState) -> Bool {
		hidden == other.hidden
	}
}

/// The body of `PUT /api/organizer`.
struct OrganizerSave: Encodable, Sendable {
	var hidden: [OrganizerState.HiddenChat]
	var baseRev: Int
}

/// One change to tags (`POST /api/organizer/tags`). The server applies them in
/// order on top of what agents changed meanwhile, so neither side overwrites
/// the other's tags.
struct TagOp: Codable, Sendable, Equatable, Identifiable {
	enum Kind: String, Codable, Sendable {
		case add, remove, rename, delete
	}

	var id = UUID()
	var op: Kind
	/// The tags to add or remove, or the one tag to rename or delete.
	var tags: [String]
	/// For add and remove.
	var chatIds: [String]?
	/// The new name, for rename.
	var to: String?
}

enum ReactionType: String, CaseIterable, Sendable {
	case nice = "NICE", love = "LOVE", fun = "FUN", amazing = "AMAZING", sad = "SAD", omg = "OMG"

	var emoji: String {
		switch self {
		case .nice: "👍"
		case .love: "❤️"
		case .fun: "😆"
		case .amazing: "😲"
		case .sad: "😢"
		case .omg: "😱"
		}
	}

	var title: String {
		switch self {
		case .nice: "讚"
		case .love: "愛心"
		case .fun: "好好笑"
		case .amazing: "好厲害"
		case .sad: "難過"
		case .omg: "天啊"
		}
	}

	static func emoji(for raw: String) -> String {
		ReactionType(rawValue: raw)?.emoji ?? "•"
	}
}

/// Server-sent events from `GET /api/events`.
enum LineEvent: Sendable {
	case message(chatId: String, message: Message)
	case unsend(chatId: String, messageId: String)
	case read(chatId: String, readerId: String, messageId: String)
	case chatRead(chatId: String, messageId: String)
	case reaction(chatId: String, messageId: String?)
	case chatUpdate(chatId: String)
	case status(SessionStatus)
	/// Hidden chats or tags changed, from this Mac, another one or an agent.
	case organizer
	case unknown
}

extension LineEvent: Decodable {
	enum CodingKeys: String, CodingKey {
		case type, chatId, message, messageId, readerId, status
	}

	init(from decoder: Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		let type = try c.decode(String.self, forKey: .type)
		switch type {
		case "message":
			self = .message(chatId: try c.decode(String.self, forKey: .chatId), message: try c.decode(Message.self, forKey: .message))
		case "unsend":
			self = .unsend(chatId: try c.decode(String.self, forKey: .chatId), messageId: try c.decode(String.self, forKey: .messageId))
		case "read":
			self = .read(
				chatId: try c.decode(String.self, forKey: .chatId),
				readerId: try c.decode(String.self, forKey: .readerId),
				messageId: try c.decode(String.self, forKey: .messageId),
			)
		case "chat_read":
			self = .chatRead(chatId: try c.decode(String.self, forKey: .chatId), messageId: try c.decode(String.self, forKey: .messageId))
		case "reaction":
			self = .reaction(chatId: try c.decode(String.self, forKey: .chatId), messageId: try c.decodeIfPresent(String.self, forKey: .messageId))
		case "chat_update":
			self = .chatUpdate(chatId: try c.decode(String.self, forKey: .chatId))
		case "status":
			self = .status(try c.decode(SessionStatus.self, forKey: .status))
		case "organizer":
			self = .organizer
		default:
			self = .unknown
		}
	}
}

extension JSONDecoder {
	static let api: JSONDecoder = {
		let d = JSONDecoder()
		d.keyDecodingStrategy = .convertFromSnakeCase
		return d
	}()
}

extension JSONEncoder {
	/// For bodies built from the camelCase models above.
	static let api: JSONEncoder = {
		let e = JSONEncoder()
		e.keyEncodingStrategy = .convertToSnakeCase
		return e
	}()
}
