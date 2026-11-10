import AppKit
import Foundation

@MainActor
@Observable
final class AppModel {
	enum Phase: Equatable {
		/// No server or key saved yet.
		case setup
		case connecting
		case online
		/// The event stream dropped; retrying.
		case offline(String)
		/// The server rejected the key.
		case unauthorized
	}

	let prefs = Preferences()
	let stickers = StickerHistory()
	let organizer = Organizer()
	@ObservationIgnored let notifier = Notifier()
	/// Set by the main window so a notification can bring it back after it was closed.
	@ObservationIgnored var showMainWindow: (() -> Void)?

	private(set) var phase: Phase = .connecting
	private(set) var sessionStatus: SessionStatus = .unknown
	private(set) var me: Me?
	private(set) var chats: [Chat] = []
	/// The chat list has been fetched at least once since connecting.
	private(set) var chatsLoaded = false
	private(set) var archive: ArchiveStatus?
	/// Every friend and group, for the address book and search.
	private(set) var contacts: [Contact] = [] {
		didSet { contactIndex = Dictionary(contacts.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }) }
	}
	@ObservationIgnored private var contactIndex: [String: Contact] = [:]
	private(set) var api: LineAPI?
	/// A short-lived error worth showing (failed refresh, failed mark-read).
	var banner: String?
	/// Bumped by ⌘F; the chat list focuses its search field.
	var searchRequests = 0
	/// The new-chat (address book) sheet, opened with ⌘N.
	var showingNewChat = false
	/// The name prompt for adding a tag to a chat or renaming one.
	var tagPrompt: TagPrompt?
	var tagNameDraft = ""
	/// Tags the chat list is limited to; empty shows every chat. Kept across
	/// launches, so a view such as Work stays put.
	var tagFilter: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "tagFilter") ?? []) {
		didSet { UserDefaults.standard.set(tagFilter.sorted(), forKey: "tagFilter") }
	}
	/// With `tagFilter`, show only chats that have every one of its tags.
	var tagFilterMatchAll = UserDefaults.standard.bool(forKey: "tagFilterMatchAll") {
		didSet { UserDefaults.standard.set(tagFilterMatchAll, forKey: "tagFilterMatchAll") }
	}
	/// Whether the main window is frontmost and visible.
	var windowActive = false {
		didSet {
			guard windowActive, !oldValue else { return }
			markSelectedReadIfVisible()
			// Reads may have happened while the app was in the background or asleep.
			if let chatId = selectedChatId, let conversation = conversations[chatId] {
				Task { await conversation.refreshReads() }
			}
		}
	}

	var selectedChatId: String? {
		didSet {
			guard selectedChatId != oldValue else { return }
			prefs.lastChatId = selectedChatId
			openSelected()
		}
	}

	@ObservationIgnored private var conversations: [String: Conversation] = [:]
	@ObservationIgnored private var streamTask: Task<Void, Never>?
	@ObservationIgnored private var chatRefreshTask: Task<Void, Never>?
	@ObservationIgnored private var organizerPush: Task<Void, Never>?
	@ObservationIgnored private var tagPush: Task<Void, Never>?
	@ObservationIgnored private var lastMarked: [String: String] = [:]
	@ObservationIgnored private var everConnected = false
	@ObservationIgnored private var started = false
	@ObservationIgnored private var observers: [NSObjectProtocol] = []

	init() {
		notifier.onOpen = { [weak self] chatId in self?.open(chatId: chatId) }
		notifier.onReply = { [weak self] chatId, text in self?.replyFromNotification(chatId: chatId, text: text) }
		notifier.onMarkRead = { [weak self] chatId in self?.markRead(chatId, force: true) }
		organizer.onChange = { [weak self] in self?.scheduleOrganizerPush() }
		organizer.onTagChange = { [weak self] in self?.scheduleTagPush() }
	}

	func start() {
		// Unit tests host the app; they must not read the keychain or connect.
		guard !started, ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
		started = true
		notifier.setUp()
		if prefs.notifications { notifier.requestAuthorization() }
		let workspace = NSWorkspace.shared.notificationCenter
		observers.append(workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
			MainActor.assumeIsolated { self?.reconnectNow() }
		})
		guard let config = prefs.serverConfig() else {
			phase = .setup
			return
		}
		connect(config)
	}

	// MARK: Connection

	/// Checks the credentials against the server, then saves and uses them.
	func configure(server: String, key: String) async throws {
		guard let url = Preferences.parseServer(server) else {
			throw APIError.server(status: 0, message: "伺服器位址無效")
		}
		if url.scheme == "http", let host = url.host(), host.allSatisfy({ $0.isNumber || $0 == "." || $0 == ":" }) {
			// App Transport Security blocks plain HTTP to IP addresses.
			throw APIError.server(status: 0, message: "請填寫 Tailscale 的 MagicDNS 名稱（例如 linebox.your-tailnet.ts.net），macOS 不允許以 HTTP 直接連線 IP 位址")
		}
		let trimmedKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
		let config = ServerConfig(baseURL: url, key: trimmedKey)
		let probe = LineAPI(config: config)
		defer { probe.invalidate() }
		_ = try await probe.me()
		try Keychain.write(trimmedKey)
		prefs.serverURL = url.absoluteString
		conversations = [:]
		chats = []
		archive = nil
		connect(config)
	}

	func signOut() {
		Keychain.delete()
		streamTask?.cancel()
		api?.invalidate()
		api = nil
		conversations = [:]
		chats = []
		me = nil
		archive = nil
		selectedChatId = nil
		updateBadge()
		phase = .setup
	}

	private func connect(_ config: ServerConfig) {
		streamTask?.cancel()
		api?.invalidate()
		let api = LineAPI(config: config)
		self.api = api
		phase = .connecting
		chatsLoaded = false
		everConnected = false
		streamTask = Task { await runEvents(api) }
		Task {
			await refreshAll()
			if selectedChatId == nil, let last = prefs.lastChatId, chat(last) != nil {
				selectedChatId = last
			} else if selectedChatId != nil {
				openSelected()
			}
		}
	}

	/// After sleep the stream is usually dead without having noticed.
	func reconnectNow() {
		guard let api, phase != .setup, phase != .unauthorized else { return }
		streamTask?.cancel()
		streamTask = Task { await runEvents(api) }
	}

	private func runEvents(_ api: LineAPI) async {
		var delay = 1.0
		while !Task.isCancelled {
			do {
				var first = true
				for try await item in EventStream.items(from: api) {
					if first {
						first = false
						delay = 1
						streamOpened()
					}
					if case let .event(event) = item { handle(event) }
				}
				if Task.isCancelled { return }
				phase = .offline("伺服器關閉了連線")
			} catch APIError.unauthorized {
				phase = .unauthorized
				return
			} catch {
				if Task.isCancelled { return }
				phase = .offline(error.userMessage ?? "連線中斷")
			}
			try? await Task.sleep(for: .seconds(delay))
			delay = min(delay * 2, 30)
		}
	}

	private func streamOpened() {
		phase = .online
		if everConnected {
			Task { await resync() }
		}
		everConnected = true
	}

	/// Everything again, after a reconnect or on ⌘R.
	func resync() async {
		await refreshAll()
		for conversation in conversations.values {
			await conversation.refreshLatest()
		}
	}

	func refreshAll() async {
		guard let api else { return }
		do {
			let me = try await api.me()
			self.me = me
			sessionStatus = me.status
			if me.status == .ready {
				applyChats(try await api.chats())
				Task { await refreshContacts() }
			}
			banner = nil
		} catch APIError.unauthorized {
			phase = .unauthorized
		} catch {
			banner = error.userMessage
		}
		await refreshArchive()
		await syncOrganizer()
	}

	func refreshChats() async {
		guard let api else { return }
		do {
			applyChats(try await api.chats())
		} catch {
			banner = error.userMessage
		}
	}

	func refreshContacts() async {
		guard let api, let list = try? await api.contacts() else { return }
		contacts = list.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
	}

	func refreshArchive() async {
		guard let api else { return }
		if let archive = try? await api.archive() { self.archive = archive }
	}

	func syncArchive() async throws -> [SyncResult] {
		guard let api else { throw APIError.server(status: 0, message: "尚未連線伺服器") }
		let results = try await api.syncArchive()
		await refreshArchive()
		return results
	}

	/// Hidden chats and tags live on the server too, so the MCP tools and
	/// other Macs see them. A server without `/api/organizer` is left alone.
	/// After an organizer event, hidden chats are left alone while this Mac
	/// has its own changes to send: our own saves echo back too.
	func syncOrganizer(event: Bool = false) async {
		guard let api, let server = try? await api.organizer() else { return }
		organizer.receiveTags(server)
		if !organizer.pendingTagOps.isEmpty { scheduleTagPush() }
		if event, organizer.dirty { return }
		let hiddenBefore = organizer.hidden
		if let state = organizer.reconcile(with: server) {
			await pushOrganizer(state)
		}
		if organizer.hidden != hiddenBefore { hiddenChanged() }
	}

	private func scheduleOrganizerPush() {
		organizerPush?.cancel()
		organizerPush = Task {
			try? await Task.sleep(for: .milliseconds(300))
			guard !Task.isCancelled else { return }
			await pushOrganizer(organizer.shared)
		}
	}

	/// A failed push leaves the organizer dirty; the next connect sends it.
	private func pushOrganizer(_ state: OrganizerState) async {
		guard let api, let saved = try? await api.saveOrganizer(state, baseRev: organizer.hiddenRev) else { return }
		let hiddenBefore = organizer.hidden
		organizer.markSaved(state, server: saved)
		organizer.receiveTags(saved)
		if organizer.hidden != hiddenBefore { hiddenChanged() }
	}

	/// Tag changes go out one batch at a time, so a batch never overtakes an earlier one.
	private func scheduleTagPush() {
		let previous = tagPush
		tagPush = Task {
			await previous?.value
			try? await Task.sleep(for: .milliseconds(300))
			await pushTags()
		}
	}

	/// Changes the server has not confirmed stay queued (offline, or a server
	/// older than tags) and go out on the next connect.
	private func pushTags() async {
		let ops = organizer.pendingTagOps
		guard let api, !ops.isEmpty else { return }
		do {
			organizer.tagOpsSaved(Set(ops.map(\.id)), state: try await api.changeTags(ops))
		} catch let APIError.server(status, _) where status == 400 {
			// One bad change (a chat with too many tags) refuses the whole batch:
			// send them one at a time and drop only the refused ones.
			for op in ops {
				do {
					organizer.tagOpsSaved([op.id], state: try await api.changeTags([op]))
				} catch let APIError.server(status, message) where status == 400 {
					organizer.dropTagOps([op.id])
					banner = "無法更新標籤：\(message)"
				} catch {
					return
				}
			}
		} catch {}
	}

	/// Another Mac hid or unhid chats.
	private func hiddenChanged() {
		if let chatId = selectedChatId, organizer.isHidden(chatId) { selectedChatId = nil }
		for chatId in organizer.hidden.keys { notifier.clear(chatId: chatId) }
		updateBadge()
	}

	private func scheduleChatRefresh() {
		chatRefreshTask?.cancel()
		chatRefreshTask = Task {
			try? await Task.sleep(for: .milliseconds(500))
			guard !Task.isCancelled else { return }
			await refreshChats()
		}
	}

	private func applyChats(_ list: [Chat]) {
		var list = list
		// A send still in flight keeps its chat on top until the server has it.
		for (i, chat) in list.enumerated() {
			if let pending = chats.first(where: { $0.chatId == chat.chatId })?.lastMessage, pending.isLocal,
				pending.timeMs > (chat.lastMessage?.timeMs ?? 0) {
				list[i].lastMessage = pending
			}
		}
		chats = list.sorted { ($0.lastMessage?.timeMs ?? 0) > ($1.lastMessage?.timeMs ?? 0) }
		chatsLoaded = true
		updateBadge()
	}

	// MARK: Events

	private func handle(_ event: LineEvent) {
		switch event {
		case let .message(chatId, message):
			conversations[chatId]?.receive(message)
			noteIncoming(chatId: chatId, message: message)
		case let .unsend(chatId, messageId):
			conversations[chatId]?.remove(messageId)
			noteRemoved(chatId: chatId, messageId: messageId)
			notifier.remove(messageId: messageId)
		case let .read(chatId, readerId, messageId):
			// Kept even for a chat not opened yet. A 1:1 chat may be named by the
			// owner's own mid; the chat is then the reader.
			let chat = chatId == me?.id ? readerId : chatId
			conversation(chat).noteRead(readerId: readerId, messageId: messageId)
		case let .chatRead(chatId, _):
			// Read on another device.
			setUnread(chatId, 0)
			notifier.clear(chatId: chatId)
		case let .reaction(chatId, _):
			conversations[chatId]?.scheduleRefresh()
		case .chatUpdate:
			scheduleChatRefresh()
		case .organizer:
			Task { await syncOrganizer(event: true) }
		case let .status(status):
			let previous = sessionStatus
			sessionStatus = status
			if status == .ready, previous != .ready, previous != .unknown {
				Task { await resync() }
			}
		case .unknown:
			break
		}
	}

	private func noteIncoming(chatId: String, message: Message) {
		guard let i = chats.firstIndex(where: { $0.chatId == chatId }) else {
			// A chat that was not active in the last 14 days, or a new one.
			scheduleChatRefresh()
			if !message.mine, prefs.notifications, !isViewing(chatId), !organizer.isHidden(chatId) {
				let chat = Chat(chatId: chatId, name: message.fromName, type: Self.type(of: chatId), unread: 1)
				notifier.post(chat: chat, message: message, preview: prefs.notificationPreview)
			}
			return
		}
		var chat = chats.remove(at: i)
		if (chat.lastMessage?.timeMs ?? 0) <= message.timeMs { chat.lastMessage = message }
		if !message.mine {
			if isViewing(chatId) && prefs.autoMarkRead {
				chats.insert(chat, at: 0)
				markRead(chatId, force: true)
			} else {
				chat.unread += 1
				chats.insert(chat, at: 0)
			}
			if prefs.notifications, !chat.isMuted, !organizer.isHidden(chatId), !isViewing(chatId), message.kind != .system {
				notifier.post(chat: chat, message: message, preview: prefs.notificationPreview)
			}
		} else {
			chats.insert(chat, at: 0)
		}
		updateBadge()
	}

	/// Called by a conversation when it starts sending.
	func noteOutgoing(_ message: Message) {
		guard let i = chats.firstIndex(where: { $0.chatId == message.chatId }) else { return }
		var chat = chats.remove(at: i)
		chat.lastMessage = message
		chats.insert(chat, at: 0)
	}

	/// A pending send was confirmed, failed or retried; the list row follows it.
	func noteSendUpdated(localId: String, as message: Message) {
		guard let i = chats.firstIndex(where: { $0.chatId == message.chatId }), chats[i].lastMessage?.id == localId else { return }
		chats[i].lastMessage = message
	}

	func noteRemoved(chatId: String, messageId: String) {
		guard let i = chats.firstIndex(where: { $0.chatId == chatId }), chats[i].lastMessage?.id == messageId else { return }
		if let previous = conversations[chatId]?.latestServerMessage {
			chats[i].lastMessage = previous
		} else {
			scheduleChatRefresh()
		}
	}

	// MARK: Selection and reading

	func conversation(_ chatId: String) -> Conversation {
		if let existing = conversations[chatId] { return existing }
		let created = Conversation(chatId: chatId, app: self)
		conversations[chatId] = created
		return created
	}

	/// A chat from the active list, an archived one older than LINE's 14 days,
	/// or a friend or group from the address book with no recent messages.
	func chat(_ chatId: String) -> Chat? {
		if let chat = chats.first(where: { $0.chatId == chatId }) { return chat }
		let contact = contactIndex[chatId]
		if let archived = archive?.chats.first(where: { $0.chatId == chatId }) {
			return Chat(chatId: archived.chatId, name: archived.name, type: Self.type(of: archived.chatId), picture: contact?.picture, unread: 0)
		}
		guard let contact else { return nil }
		return Chat(chatId: contact.id, name: contact.name, type: contact.type, picture: contact.picture, unread: 0)
	}

	/// A person's current profile picture: the address book first (it follows
	/// picture changes), then what the message carried.
	func picture(of userId: String, fallback: URL?) -> URL? {
		contactIndex[userId]?.picture ?? fallback
	}

	/// The display name for a chat id, for lists that only keep ids.
	func name(of chatId: String) -> String {
		chat(chatId)?.name ?? organizer.hidden[chatId] ?? chatId
	}

	/// Archived chats with nothing in LINE's 14-day window.
	var archiveOnlyChats: [ArchivedChat] {
		let active = Set(chats.map(\.chatId))
		return (archive?.chats ?? [])
			.filter { !active.contains($0.chatId) && !organizer.isHidden($0.chatId) }
			.sorted { ($0.newest ?? 0) > ($1.newest ?? 0) }
	}

	/// The tag filter, without tags no chat has any more.
	var activeTagFilter: Set<String> {
		tagFilter.intersection(organizer.allTags)
	}

	/// The sidebar: recent chats, then archive-only ones, both limited to the
	/// tag filter. Hidden chats appear nowhere.
	var sidebarSections: [SidebarSection] {
		let filter = activeTagFilter
		let shown = { [organizer, tagFilterMatchAll] (chatId: String) in
			filter.isEmpty || organizer.matches(chatId, tags: filter, all: tagFilterMatchAll)
		}
		var sections = [SidebarSection(id: "recent", chats: chats.filter { !organizer.isHidden($0.chatId) && shown($0.chatId) }, archived: [])]
		let older = archiveOnlyChats.filter { shown($0.chatId) }
		if !older.isEmpty {
			sections.append(SidebarSection(id: "older", chats: [], archived: older))
		}
		return sections
	}

	/// Unread messages in chats with `tag`, for the sidebar's tag bar.
	func unread(tagged tag: String) -> Int {
		chats.reduce(0) { total, chat in
			chat.isMuted || organizer.isHidden(chat.chatId) || !organizer.tags(of: chat.chatId).contains(tag) ? total : total + chat.unread
		}
	}

	/// Shows only chats with `tag`, or every chat if that is already the view.
	func showOnly(tag: String) {
		tagFilter = activeTagFilter == [tag] ? [] : [tag]
	}

	// MARK: Organizing

	/// Hides a chat from the list, search, badge and notifications.
	func hide(_ chatId: String) {
		organizer.hide(chatId, name: name(of: chatId))
		if selectedChatId == chatId { selectedChatId = nil }
		notifier.clear(chatId: chatId)
		updateBadge()
	}

	func unhide(_ chatId: String) {
		organizer.unhide(chatId)
		updateBadge()
	}

	func promptNewTag(for chatId: String) {
		tagNameDraft = ""
		tagPrompt = .add(chatId: chatId)
	}

	func promptRenameTag(_ name: String) {
		tagNameDraft = name
		tagPrompt = .rename(name)
	}

	func commitTagPrompt() {
		switch tagPrompt {
		case let .add(chatId):
			organizer.addTags([tagNameDraft], to: [chatId])
		case let .rename(name):
			renameTag(name, to: tagNameDraft)
		case nil:
			break
		}
		tagPrompt = nil
	}

	/// Renames a tag everywhere; the filter follows it.
	func renameTag(_ name: String, to newName: String) {
		organizer.renameTag(name, to: newName)
		guard tagFilter.remove(name) != nil else { return }
		let fold = TextFold.fold(Organizer.tagName(newName))
		if let renamed = organizer.allTags.first(where: { TextFold.fold($0) == fold }) { tagFilter.insert(renamed) }
	}

	func toggleTagFilter(_ tag: String) {
		if tagFilter.remove(tag) == nil { tagFilter.insert(tag) }
	}

	func isArchived(_ chatId: String) -> Bool {
		archive?.chats.contains { $0.chatId == chatId } ?? false
	}

	func open(chatId: String) {
		showMainWindow?()
		NSApp.activate()
		selectedChatId = chatId
	}

	func open(_ hit: SearchHit) {
		selectedChatId = hit.message.chatId
		let conversation = conversation(hit.message.chatId)
		Task { await conversation.reveal(messageId: hit.message.id, timeMs: hit.message.timeMs) }
	}

	/// Moves through the sidebar as shown.
	func selectAdjacent(_ step: Int) {
		let order = sidebarSections
			.flatMap { $0.chats.map(\.chatId) + $0.archived.map(\.chatId) }
		guard !order.isEmpty else { return }
		let index = order.firstIndex { $0 == selectedChatId } ?? -step
		selectedChatId = order[min(max(index + step, 0), order.count - 1)]
	}

	private func openSelected() {
		guard let chatId = selectedChatId else { return }
		let conversation = conversation(chatId)
		let unread = chat(chatId)?.unread ?? 0
		Task {
			await conversation.loadInitial()
			conversation.markUnread(count: unread)
			markSelectedReadIfVisible()
		}
	}

	func isViewing(_ chatId: String) -> Bool {
		selectedChatId == chatId && windowActive && NSApp.isActive
	}

	private func markSelectedReadIfVisible() {
		guard prefs.autoMarkRead, let chatId = selectedChatId, isViewing(chatId) else { return }
		markRead(chatId, force: false)
	}

	/// Sends LINE's read receipt up to the newest message. Without `force`, only
	/// when the chat shows unread messages.
	func markRead(_ chatId: String, force: Bool) {
		guard let api else { return }
		let unread = chats.first { $0.chatId == chatId }?.unread ?? 0
		guard force || unread > 0 else { return }
		let latest = conversations[chatId]?.latestServerMessage ?? chats.first { $0.chatId == chatId }?.lastMessage
		guard let target = latest, !target.isLocal, lastMarked[chatId] != target.id || unread > 0 else { return }
		lastMarked[chatId] = target.id
		setUnread(chatId, 0)
		notifier.clear(chatId: chatId)
		Task {
			do {
				try await api.markRead(chatId: chatId, messageId: target.id)
			} catch {
				lastMarked[chatId] = nil
				banner = "無法標示為已讀：\(error.userMessage ?? "")"
			}
		}
	}

	private func replyFromNotification(chatId: String, text: String) {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return }
		conversation(chatId).sendText(trimmed)
		markRead(chatId, force: true)
	}

	private func setUnread(_ chatId: String, _ count: Int) {
		guard let i = chats.firstIndex(where: { $0.chatId == chatId }), chats[i].unread != count else { return }
		chats[i].unread = count
		updateBadge()
	}

	var totalUnread: Int {
		chats.reduce(0) { $0 + ($1.isMuted || organizer.isHidden($1.chatId) ? 0 : $1.unread) }
	}

	private func updateBadge() {
		let total = totalUnread
		NSApp.dockTile.badgeLabel = total == 0 ? nil : total > 99 ? "99+" : String(total)
	}

	static func type(of chatId: String) -> ChatType {
		chatId.hasPrefix("c") ? .group : chatId.hasPrefix("r") ? .room : .user
	}
}

struct SidebarSection: Identifiable {
	let id: String
	let chats: [Chat]
	let archived: [ArchivedChat]
}

enum TagPrompt {
	case add(chatId: String)
	case rename(String)
}
