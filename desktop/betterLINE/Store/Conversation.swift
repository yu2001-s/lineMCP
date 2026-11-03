import Foundation

/// One chat's loaded history, drafts and pending sends.
@MainActor
@Observable
final class Conversation {
	let chatId: String
	private(set) var messages: [Message] = []
	private(set) var olderCursor: String?
	private(set) var loadedInitial = false
	private(set) var loading = false
	private(set) var loadingOlder = false
	var error: String?

	var draft = ""
	var attachments: [URL] = []
	var replyTo: Message?
	/// A message to scroll to and flash (search results, reply quotes).
	var focus: String?
	/// Asks the user before unsending.
	var confirmUnsend: Message?
	/// Bumped to put the cursor back in the composer, e.g. after choosing Reply.
	private(set) var composerFocusRequests = 0
	/// The oldest unread message when the chat was opened, for the "new messages" divider.
	private(set) var firstUnreadId: String?

	/// readerId → id of the newest message they have read: fetched from LINE when
	/// the chat opens or refreshes, then kept current by live read events.
	private(set) var readers: [String: String] = [:]

	@ObservationIgnored private unowned let app: AppModel
	@ObservationIgnored private var sendChain: Task<Void, Never>?
	@ObservationIgnored private var refreshTask: Task<Void, Never>?

	init(chatId: String, app: AppModel) {
		self.chatId = chatId
		self.app = app
	}

	var isRoom: Bool { chatId.hasPrefix("r") }
	var hasOlder: Bool { olderCursor != nil }
	var latestServerMessage: Message? { messages.last { !$0.isLocal } }

	// MARK: Loading

	func loadInitial() async {
		guard !loadedInitial, !loading, let api = app.api else { return }
		loading = true
		defer { loading = false }
		do {
			var page = try await api.messages(chatId: chatId)
			if page.messages.isEmpty, page.olderCursor == nil, app.isArchived(chatId) {
				// Nothing in LINE's 14 days: an archived chat continues from the local copy.
				page = try await api.messages(chatId: chatId, before: "a:\(Self.nowMs + 1)")
			}
			merge(page.messages)
			olderCursor = page.olderCursor
			loadedInitial = true
			error = nil
		} catch {
			self.error = error.userMessage
		}
		Task { await refreshReads() }
	}

	/// Asks LINE how far everyone has read. Markers only ever move forward, so a
	/// live event that arrived meanwhile is never undone.
	func refreshReads() async {
		guard let api = app.api, let markers = try? await api.reads(chatId: chatId) else { return }
		for (reader, messageId) in markers {
			noteRead(readerId: reader, messageId: messageId)
		}
	}

	func loadOlder(limit: Int = 50) async {
		guard loadedInitial, !loadingOlder, let cursor = olderCursor, let api = app.api else { return }
		loadingOlder = true
		defer { loadingOlder = false }
		do {
			let page = try await api.messages(chatId: chatId, before: cursor, limit: limit)
			merge(page.messages)
			// A cursor that does not move would page forever.
			olderCursor = page.olderCursor == cursor ? nil : page.olderCursor
			error = nil
		} catch {
			self.error = error.userMessage
		}
	}

	/// Newest page again: catches what the event stream missed, new reactions,
	/// and messages unsent while the app was not listening.
	func refreshLatest() async {
		guard loadedInitial, let api = app.api else { return }
		let started = Self.nowMs
		guard let page = try? await api.messages(chatId: chatId) else { return }
		merge(page.messages)
		Task { await refreshReads() }
		if let oldest = page.messages.first?.timeMs {
			let served = Set(page.messages.map(\.id))
			messages.removeAll { !$0.isLocal && $0.timeMs >= oldest && $0.timeMs < started && !served.contains($0.id) }
		}
	}

	/// Reaction events do not say what changed; reload the newest page shortly.
	func scheduleRefresh() {
		refreshTask?.cancel()
		refreshTask = Task {
			try? await Task.sleep(for: .milliseconds(600))
			guard !Task.isCancelled else { return }
			await refreshLatest()
		}
	}

	/// Pages back until the message is loaded, then scrolls to it.
	func reveal(messageId: String, timeMs: Int64) async {
		await loadInitial()
		var pages = 0
		while !messages.contains(where: { $0.id == messageId }),
			let first = messages.first, first.timeMs >= timeMs, hasOlder, pages < 30 {
			await loadOlder(limit: 200)
			pages += 1
		}
		if messages.contains(where: { $0.id == messageId }) {
			focus = messageId
		} else {
			error = "找不到這則訊息，可能已被收回"
		}
	}

	/// Remembers where the unread messages start; `count` is the chat's unread count.
	func markUnread(count: Int) {
		guard count > 0 else {
			firstUnreadId = nil
			return
		}
		var remaining = count
		for m in messages.reversed() where !m.mine && m.kind != .system {
			remaining -= 1
			if remaining == 0 {
				firstUnreadId = m.id
				return
			}
		}
		firstUnreadId = messages.first { !$0.mine }?.id
	}

	func reply(to message: Message) {
		replyTo = message
		composerFocusRequests += 1
	}

	func message(_ id: String) -> Message? {
		messages.first { $0.id == id }
	}

	// MARK: Push events

	func receive(_ message: Message) {
		guard loadedInitial else { return }
		merge([message])
	}

	func remove(_ messageId: String) {
		messages.removeAll { $0.id == messageId }
		if replyTo?.id == messageId { replyTo = nil }
	}

	func noteRead(readerId: String, messageId: String) {
		if let current = readers[readerId], MessageOrder.id(current, isAtLeast: messageId) { return }
		readers[readerId] = messageId
	}

	/// How many people have read up to this message.
	func readCount(_ message: Message) -> Int {
		guard !message.isLocal else { return 0 }
		return readers.values.reduce(0) { MessageOrder.id($1, isAtLeast: message.id) ? $0 + 1 : $0 }
	}

	// MARK: Sending

	func sendDraft() {
		let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
		let files = attachments
		guard !text.isEmpty || !files.isEmpty else { return }
		let reply = replyTo
		draft = ""
		attachments = []
		replyTo = nil
		for file in files { sendFile(file) }
		if !text.isEmpty { sendText(text, replyTo: reply?.id) }
	}

	func sendText(_ text: String, replyTo: String? = nil) {
		var local = makeLocal(kind: .text, text: text)
		local.replyTo = replyTo
		enqueue(local)
	}

	func sendSticker(_ sticker: Sticker) {
		var local = makeLocal(kind: .sticker, text: "[sticker]")
		local.sticker = sticker
		app.stickers.noteUsed(sticker)
		enqueue(local)
	}

	func sendFile(_ url: URL) {
		let kind = Upload.kind(of: url)
		let size = Upload.size(of: url)
		if size > Upload.maxBytes {
			error = "\(url.lastPathComponent) 超過 100 MB，無法傳送"
			return
		}
		if isRoom {
			error = "LINE 不支援在舊式多人聊天室傳送加密的媒體"
			return
		}
		var local = makeLocal(kind: kind, text: kind == .file ? "[file: \(url.lastPathComponent)]" : "[\(kind.rawValue)]")
		local.media = MediaInfo(fileName: url.lastPathComponent, size: size)
		local.localFile = url
		enqueue(local)
	}

	func retry(_ message: Message) {
		guard case .failed = message.local, let i = index(message.id) else { return }
		messages[i].local = .sending
		let local = messages[i]
		app.noteSendUpdated(localId: local.id, as: local)
		chain { await self.deliver(local) }
	}

	func discard(_ message: Message) {
		guard message.isLocal else { return }
		remove(message.id)
	}

	private func makeLocal(kind: MessageKind, text: String) -> Message {
		Message(
			id: "local-\(UUID().uuidString)",
			chatId: chatId,
			fromId: app.me?.id ?? "",
			fromName: "me",
			mine: true,
			timeMs: Self.nowMs,
			delivered: "0",
			kind: kind,
			text: text,
			local: .sending,
		)
	}

	private func enqueue(_ local: Message) {
		messages.append(local)
		app.noteOutgoing(local)
		chain { await self.deliver(local) }
	}

	/// Sends go out one at a time, in the order they were made.
	private func chain(_ work: @escaping @MainActor () async -> Void) {
		let previous = sendChain
		sendChain = Task {
			await previous?.value
			await work()
		}
	}

	private func deliver(_ local: Message) async {
		guard let api = app.api else {
			fail(local.id, "尚未連線伺服器")
			return
		}
		do {
			let id: String
			switch local.kind {
			case .text:
				id = try await api.sendText(chatId: chatId, text: local.text, replyTo: local.replyTo)
			case .sticker:
				id = try await api.sendSticker(chatId: chatId, sticker: local.sticker!)
			default:
				let upload = try await Upload.prepare(local.localFile!, kind: local.kind)
				id = try await api.sendMedia(chatId: chatId, file: upload.file, kind: upload.kind, name: upload.name, durationMs: upload.durationMs)
				await MediaStore.shared.adopt(upload.file, as: id)
			}
			confirm(localId: local.id, realId: id)
		} catch {
			fail(local.id, error.userMessage ?? "傳送失敗")
		}
	}

	private func confirm(localId: String, realId: String) {
		guard let i = index(localId) else { return }
		if let existing = index(realId) {
			// The push event got here first.
			app.noteSendUpdated(localId: localId, as: messages[existing])
			messages.remove(at: i)
		} else {
			messages[i].id = realId
			messages[i].local = nil
			app.noteSendUpdated(localId: localId, as: messages[i])
		}
	}

	private func fail(_ localId: String, _ reason: String) {
		guard let i = index(localId) else { return }
		messages[i].local = .failed(reason)
		app.noteSendUpdated(localId: localId, as: messages[i])
	}

	// MARK: Actions

	func react(_ message: Message, _ type: ReactionType?) {
		guard let api = app.api, let me = app.me?.id, let i = index(message.id) else { return }
		var reactions = (messages[i].reactions ?? []).filter { $0.fromId != me }
		if let type { reactions.append(Reaction(type: type.rawValue, fromId: me)) }
		messages[i].reactions = reactions.isEmpty ? nil : reactions
		Task {
			do {
				try await api.react(messageId: message.id, type: type?.rawValue ?? "UNDO")
			} catch {
				self.error = error.userMessage
				await refreshLatest()
			}
		}
	}

	func unsend(_ message: Message) {
		guard let api = app.api else { return }
		Task {
			do {
				try await api.unsend(messageId: message.id)
				remove(message.id)
				app.noteRemoved(chatId: chatId, messageId: message.id)
			} catch {
				self.error = error.userMessage
			}
		}
	}

	// MARK: Merging

	private func merge(_ incoming: [Message]) {
		guard !incoming.isEmpty else { return }
		var byId = [String: Message](minimumCapacity: messages.count + incoming.count)
		for m in messages { byId[m.id] = m }
		for m in incoming { byId[m.id] = m }
		messages = byId.values.sorted { ($0.timeMs, $0.id) < ($1.timeMs, $1.id) }
		app.stickers.noteSeen(incoming)
	}

	private func index(_ id: String) -> Int? {
		messages.lastIndex { $0.id == id }
	}

	static var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}
