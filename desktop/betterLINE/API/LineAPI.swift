import Foundation
import UniformTypeIdentifiers

struct ServerConfig: Sendable, Equatable {
	var baseURL: URL
	var key: String
}

enum APIError: LocalizedError, Equatable {
	case unauthorized
	case server(status: Int, message: String)
	case invalidResponse

	var errorDescription: String? {
		switch self {
		case .unauthorized: "金鑰不正確（401）"
		case let .server(status, message): message.isEmpty ? "伺服器錯誤 \(status)" : message
		case .invalidResponse: "伺服器回傳了無法辨識的回應"
		}
	}
}

/// Media as the server serves it: decrypted, with LINE's original file name.
struct DownloadedMedia: Sendable {
	var file: URL
	var mimeType: String?
	var fileName: String?
}

/// Client for the server's desktop API (server/src/clientapi.ts).
final class LineAPI: Sendable {
	let config: ServerConfig
	private let session: URLSession
	private let streamSession: URLSession

	init(config: ServerConfig) {
		self.config = config
		let c = URLSessionConfiguration.default
		// Decrypted messages and media must not land in a shared URL cache.
		c.urlCache = nil
		c.requestCachePolicy = .reloadIgnoringLocalCacheData
		c.timeoutIntervalForRequest = 45
		c.waitsForConnectivity = false
		session = URLSession(configuration: c)

		let s = URLSessionConfiguration.default
		s.urlCache = nil
		// The server pings every 25 s, so a silent minute means the stream is dead.
		s.timeoutIntervalForRequest = 70
		s.timeoutIntervalForResource = .greatestFiniteMagnitude
		streamSession = URLSession(configuration: s)
	}

	func invalidate() {
		session.invalidateAndCancel()
		streamSession.invalidateAndCancel()
	}

	// MARK: Endpoints

	func me() async throws -> Me {
		try await get("api/me")
	}

	func chats() async throws -> [Chat] {
		let list: ChatList = try await get("api/chats")
		return list.chats
	}

	/// The address book; an empty query returns every friend and group.
	func contacts(query: String = "") async throws -> [Contact] {
		let list: ContactList = try await get("api/contacts", query: query.isEmpty ? [] : [URLQueryItem(name: "q", value: query)])
		return list.contacts
	}

	func messages(chatId: String, before: String? = nil, limit: Int = 50) async throws -> MessagePage {
		var query = [URLQueryItem(name: "limit", value: String(limit))]
		if let before { query.append(URLQueryItem(name: "before", value: before)) }
		return try await get("api/chats/\(chatId)/messages", query: query)
	}

	func sendText(chatId: String, text: String, replyTo: String?) async throws -> String {
		var body: [String: String] = ["text": text]
		if let replyTo { body["reply_to"] = replyTo }
		let sent: SentMessage = try await post("api/chats/\(chatId)/messages", json: body)
		return sent.messageId
	}

	func sendSticker(chatId: String, sticker: Sticker) async throws -> String {
		let body = ["package_id": sticker.packageId, "sticker_id": sticker.stickerId, "version": sticker.version]
		let sent: SentMessage = try await post("api/chats/\(chatId)/sticker", json: body)
		return sent.messageId
	}

	func sendMedia(chatId: String, file: URL, kind: MessageKind, name: String, durationMs: Int?) async throws -> String {
		var query = [URLQueryItem(name: "kind", value: kind.rawValue), URLQueryItem(name: "name", value: name)]
		if let durationMs { query.append(URLQueryItem(name: "duration_ms", value: String(durationMs))) }
		var req = request("POST", "api/chats/\(chatId)/media", query: query)
		req.timeoutInterval = 300
		req.setValue(UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream", forHTTPHeaderField: "Content-Type")
		let (data, response) = try await session.upload(for: req, fromFile: file)
		let sent: SentMessage = try decode(data, response)
		return sent.messageId
	}

	/// How far each other member has read; asking sends no read receipt.
	func reads(chatId: String) async throws -> [String: String] {
		let markers: ReadMarkers = try await get("api/chats/\(chatId)/reads")
		return markers.readers
	}

	func markRead(chatId: String, messageId: String) async throws {
		let _: Empty = try await post("api/chats/\(chatId)/read", json: ["message_id": messageId])
	}

	func unsend(messageId: String) async throws {
		let _: Empty = try await post("api/messages/\(messageId)/unsend", json: [String: String]())
	}

	/// `type` is a `ReactionType` raw value, or "UNDO".
	func react(messageId: String, type: String) async throws {
		let _: Empty = try await post("api/messages/\(messageId)/react", json: ["type": type])
	}

	/// Downloads to a temporary file the caller must move.
	func downloadMedia(_ message: Message) async throws -> DownloadedMedia {
		var req = request("GET", "api/media/\(message.id)", query: [
			URLQueryItem(name: "chat", value: message.chatId),
			URLQueryItem(name: "delivered", value: message.delivered),
		])
		req.timeoutInterval = 300
		let (file, response) = try await session.download(for: req)
		guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
		if http.statusCode != 200 {
			let data = (try? Data(contentsOf: file)) ?? Data()
			try? FileManager.default.removeItem(at: file)
			throw Self.error(status: http.statusCode, data: data)
		}
		return DownloadedMedia(
			file: file,
			mimeType: http.mimeType,
			fileName: Self.fileName(fromDisposition: http.value(forHTTPHeaderField: "Content-Disposition")),
		)
	}

	func search(_ query: String, chatId: String? = nil, limit: Int = 50) async throws -> [SearchHit] {
		var items = [URLQueryItem(name: "q", value: query), URLQueryItem(name: "limit", value: String(limit))]
		if let chatId { items.append(URLQueryItem(name: "chat_id", value: chatId)) }
		let results: SearchResults = try await get("api/search", query: items)
		return results.results
	}

	func archive() async throws -> ArchiveStatus {
		try await get("api/archive")
	}

	func syncArchive() async throws -> [SyncResult] {
		var req = request("POST", "api/archive/sync")
		// Syncing every archived chat pages through LINE slowly on purpose.
		req.timeoutInterval = 1800
		req.httpBody = Data("{}".utf8)
		req.setValue("application/json", forHTTPHeaderField: "Content-Type")
		let results: SyncResults = try await send(req)
		return results.results
	}

	func organizer() async throws -> OrganizerState {
		try await get("api/organizer")
	}

	/// Saves hidden chats. `baseRev` is the server revision whose
	/// agent changes they include; the server adds later ones on top.
	@discardableResult
	func saveOrganizer(_ state: OrganizerState, baseRev: Int) async throws -> OrganizerState {
		var req = request("PUT", "api/organizer")
		req.httpBody = try JSONEncoder.api.encode(OrganizerSave(hidden: state.hidden, baseRev: baseRev))
		req.setValue("application/json", forHTTPHeaderField: "Content-Type")
		return try await send(req)
	}

	/// Applies tag changes in order, all or none, and returns the server's copy after them.
	func changeTags(_ ops: [TagOp]) async throws -> OrganizerState {
		struct Body: Encodable { var ops: [TagOp] }
		var req = request("POST", "api/organizer/tags")
		req.httpBody = try JSONEncoder.api.encode(Body(ops: ops))
		req.setValue("application/json", forHTTPHeaderField: "Content-Type")
		return try await send(req)
	}

	/// The raw event stream; `EventStream` parses it.
	func eventBytes() async throws -> URLSession.AsyncBytes {
		var req = request("GET", "api/events")
		req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
		let (bytes, response) = try await streamSession.bytes(for: req)
		guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
		if http.statusCode != 200 {
			throw Self.error(status: http.statusCode, data: Data())
		}
		return bytes
	}

	// MARK: Plumbing

	private struct Empty: Decodable {}

	private func request(_ method: String, _ path: String, query: [URLQueryItem] = []) -> URLRequest {
		var components = URLComponents(url: config.baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
		if !query.isEmpty { components.queryItems = query }
		var req = URLRequest(url: components.url!)
		req.httpMethod = method
		req.setValue("Bearer \(config.key)", forHTTPHeaderField: "Authorization")
		return req
	}

	private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
		try await send(request("GET", path, query: query))
	}

	private func post<T: Decodable>(_ path: String, json: some Encodable) async throws -> T {
		var req = request("POST", path)
		req.httpBody = try JSONEncoder().encode(json)
		req.setValue("application/json", forHTTPHeaderField: "Content-Type")
		return try await send(req)
	}

	private func send<T: Decodable>(_ req: URLRequest) async throws -> T {
		let (data, response) = try await session.data(for: req)
		return try decode(data, response)
	}

	private func decode<T: Decodable>(_ data: Data, _ response: URLResponse) throws -> T {
		guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
		guard http.statusCode == 200 else { throw Self.error(status: http.statusCode, data: data) }
		do {
			return try JSONDecoder.api.decode(T.self, from: data)
		} catch {
			throw APIError.invalidResponse
		}
	}

	private static func error(status: Int, data: Data) -> APIError {
		if status == 401 { return .unauthorized }
		struct Body: Decodable { var error: String }
		let message = (try? JSONDecoder().decode(Body.self, from: data))?.error ?? ""
		return .server(status: status, message: message)
	}

	/// `inline; filename*=UTF-8''S__22749200.jpg`
	static func fileName(fromDisposition header: String?) -> String? {
		guard let header, let range = header.range(of: "filename*=UTF-8''") else { return nil }
		let encoded = header[range.upperBound...].split(separator: ";").first.map(String.init) ?? ""
		let name = encoded.removingPercentEncoding ?? encoded
		return name.isEmpty ? nil : name
	}
}

extension Error {
	/// A message worth showing; cancellations are not.
	var userMessage: String? {
		if self is CancellationError { return nil }
		if let url = self as? URLError {
			switch url.code {
			case .cancelled: return nil
			case .timedOut: return "連線伺服器逾時"
			case .cannotFindHost, .cannotConnectToHost, .networkConnectionLost, .notConnectedToInternet:
				return "無法連線伺服器（Tailscale 是否在線上？）"
			case .appTransportSecurityRequiresSecureConnection:
				return "macOS 只允許以 HTTP 連線 Tailscale 的 MagicDNS 名稱（例如 linebox.your-tailnet.ts.net），請在設定中改用它"
			default: return url.localizedDescription
			}
		}
		return localizedDescription
	}
}
