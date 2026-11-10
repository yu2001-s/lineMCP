import AppKit
import Foundation
import SwiftUI
import Testing
import UniformTypeIdentifiers
@testable import betterLINE

struct DecodingTests {
	@Test func chatListWithStickerAndReactions() throws {
		let json = """
		{"chats":[{"chat_id":"c11111111111111111111111111111111","name":"群","type":"group","unread":3,"muted":true,
		"last_message":{"id":"100000000000000002","chat_id":"c11111111111111111111111111111111","from_id":"u22222222222222222222222222222222",
		"from_name":"小明","mine":false,"time_ms":1790517131342,"delivered":"1790517131342","kind":"sticker","text":"[sticker]",
		"reply_to":"100000000000000001","sticker":{"package_id":"7117","sticker_id":"12955359","version":"3","animated":false,
		"url":"https://stickershop.line-scdn.net/stickershop/v1/sticker/12955359/android/sticker.png"},
		"reactions":[{"type":"LOVE","from_id":"u33333333333333333333333333333333"}]}}]}
		"""
		let list = try JSONDecoder.api.decode(ChatList.self, from: Data(json.utf8))
		let chat = try #require(list.chats.first)
		#expect(chat.type == .group)
		#expect(chat.isMuted)
		#expect(chat.unread == 3)
		let last = try #require(chat.lastMessage)
		#expect(last.kind == .sticker)
		#expect(last.sticker?.stickerId == "12955359")
		#expect(last.replyTo == "100000000000000001")
		#expect(last.reactions?.first?.type == "LOVE")
		#expect(last.preview == "[貼圖]")
		#expect(last.local == nil)
	}

	@Test func unknownKindAndStatusFallBack() throws {
		let json = """
		{"id":"1","chat_id":"u0","from_id":"u1","from_name":"a","mine":true,"time_ms":1,"delivered":"1","kind":"hologram","text":"x","media":{}}
		"""
		let m = try JSONDecoder.api.decode(Message.self, from: Data(json.utf8))
		#expect(m.kind == .other)
		#expect(m.media == MediaInfo())
		let me = try JSONDecoder.api.decode(Me.self, from: Data(#"{"id":"u1","name":"me","status":"sleeping"}"#.utf8))
		#expect(me.status == .unknown)
	}

	@Test func searchHitCarriesChatName() throws {
		let json = """
		{"results":[{"id":"9","chat_id":"u2","from_id":"u2","from_name":"b","mine":false,"time_ms":5,"delivered":"5","kind":"text","text":"开会","chat_name":"Bob"}]}
		"""
		let results = try JSONDecoder.api.decode(SearchResults.self, from: Data(json.utf8))
		#expect(results.results.first?.chatName == "Bob")
		#expect(results.results.first?.message.text == "开会")
	}

	@Test func archiveStatus() throws {
		let json = """
		{"rules":{"auto":true,"maxGroupMembers":10,"skipOfficialAccounts":true},"chats":[{"chat_id":"u25","name":"x","mode":"auto",
		"added_at":1791200571496,"last_synced_at":null,"last_error":null,"messages":27,"oldest":1790059086912,"newest":1790920158572}]}
		"""
		let status = try JSONDecoder.api.decode(ArchiveStatus.self, from: Data(json.utf8))
		#expect(status.rules.maxGroupMembers == 10)
		#expect(status.chats.first?.lastSyncedAt == nil)
		#expect(status.chats.first?.messages == 27)
	}
}

struct EventTests {
	@Test func parsesEventLines() {
		guard case let .event(.read(chat, reader, message)) = EventStream.parse(#"data: {"type":"read","chat_id":"c1","reader_id":"u2","message_id":"3"}"#) else {
			Issue.record("expected a read event")
			return
		}
		#expect(chat == "c1" && reader == "u2" && message == "3")

		guard case .event(.chatRead(chatId: "c1", messageId: "9")) = EventStream.parse(#"data: {"type":"chat_read","chat_id":"c1","message_id":"9"}"#) else {
			Issue.record("expected chat_read")
			return
		}
		guard case .event(.status(.loggedOut)) = EventStream.parse(#"data: {"type":"status","status":"logged_out"}"#) else {
			Issue.record("expected status")
			return
		}
		guard case .heartbeat = EventStream.parse(": ping") else {
			Issue.record("expected heartbeat")
			return
		}
		#expect(EventStream.parse("") == nil)
	}

	@Test func reactionWithoutMessageId() {
		guard case .event(.reaction(chatId: "c1", messageId: nil)) = EventStream.parse(#"data: {"type":"reaction","chat_id":"c1"}"#) else {
			Issue.record("expected reaction")
			return
		}
	}
}

@MainActor
struct FormattingTests {
	@Test func foldsTraditionalAndSimplified() {
		#expect(TextFold.matches("炸雞", query: "炸鸡"))
		#expect(TextFold.matches("开会通知", query: "開會"))
		#expect(TextFold.matches("Ｌｉｎｅ Desk", query: "line"))
		#expect(!TextFold.matches("Alice", query: "bob"))
	}

	@Test func contentDispositionFileName() {
		#expect(LineAPI.fileName(fromDisposition: "inline; filename*=UTF-8''S__22749200.jpg") == "S__22749200.jpg")
		#expect(LineAPI.fileName(fromDisposition: "inline; filename*=UTF-8''%E5%A0%B1%E5%91%8A.pdf") == "報告.pdf")
		#expect(LineAPI.fileName(fromDisposition: nil) == nil)
	}

	@Test func serverAddresses() {
		#expect(Preferences.parseServer("linebox:8791")?.absoluteString == "http://linebox:8791")
		#expect(Preferences.parseServer(" http://linebox.your-tailnet.ts.net:8791/ ")?.absoluteString == "http://linebox.your-tailnet.ts.net:8791")
		#expect(Preferences.parseServer("ftp://x") == nil)
	}

	@Test func uploadKinds() {
		#expect(Upload.kind(of: URL(fileURLWithPath: "/a.HEIC")) == .image)
		#expect(Upload.kind(of: URL(fileURLWithPath: "/a.mp4")) == .video)
		#expect(Upload.kind(of: URL(fileURLWithPath: "/a.m4a")) == .audio)
		#expect(Upload.kind(of: URL(fileURLWithPath: "/a.pdf")) == .file)
		#expect(Upload.kind(of: URL(fileURLWithPath: "/a.zip")) == .file)
	}

	@Test func rowsGroupRunsAndTimeHeaders() {
		func msg(_ id: String, _ from: String, _ minutes: Int64, day: Int64 = 0) -> Message {
			let base: Int64 = 1_790_000_000_000
			return Message(id: id, chatId: "c", fromId: from, fromName: from, mine: false,
				timeMs: base + day * 86_400_000 + minutes * 60_000, delivered: "0", kind: .text, text: id)
		}
		// 1–2 a run; 3 another sender; 4 after a 2-minute pause, same run; 5 after 18 minutes
		// gets a time header; 6 is the next day.
		let rows = MessageRowModel.build([
			msg("1", "a", 0), msg("2", "a", 1), msg("3", "b", 2), msg("4", "b", 4), msg("5", "b", 22), msg("6", "b", 22, day: 1),
		])
		var runs: [String: String] = [:]
		var headers: [String] = []
		for row in rows {
			switch row.kind {
			case let .message(m, startsRun, endsRun): runs[m.id] = "\(startsRun ? "S" : "-")\(endsRun ? "E" : "-")"
			case .timeHeader: headers.append(row.id)
			case .unreadDivider: break
			}
		}
		#expect(runs == ["1": "S-", "2": "-E", "3": "S-", "4": "-E", "5": "SE", "6": "SE"])
		#expect(headers == ["time-1", "time-5", "time-6"])

		let withUnread = MessageRowModel.build([msg("1", "a", 0), msg("2", "a", 1), msg("3", "a", 2)], firstUnreadId: "2")
		#expect(withUnread.map(\.id) == ["time-1", "1", "unread", "2", "3"])
		if case let .message(_, _, endsRun) = withUnread[1].kind {
			#expect(endsRun, "the run ends before the unread divider")
		}
	}

	@Test func richTextIsUnwrapped() {
		var m = Message(id: "1", chatId: "c", fromId: "u", fromName: "u", mine: false, timeMs: 0, delivered: "0", kind: .rich, text: "[rich message: 帳戶通知]")
		#expect(m.preview == "帳戶通知")
		m.text = "[rich message]"
		#expect(m.displayText == "[rich message]")
		m.kind = .text
		m.text = ""
		#expect(m.preview == "[訊息]")
	}
}

/// Defaults kept in memory. A real suite leaves a plist in ~/Library/Preferences
/// on every run, even after removePersistentDomain.
private final class MemoryDefaults: UserDefaults {
	private var values: [String: Any] = [:]
	init() { super.init(suiteName: "betterLINE.tests")! }
	override func object(forKey key: String) -> Any? { values[key] }
	override func set(_ value: Any?, forKey key: String) { values[key] = value }
	override func removeObject(forKey key: String) { values[key] = nil }
}

@MainActor
struct OrganizerTests {
	private func fresh() -> Organizer {
		let defaults = MemoryDefaults()
		return Organizer(defaults: defaults)
	}

	@Test func hiddenChatsPersist() throws {
		let defaults = MemoryDefaults()
		let organizer = Organizer(defaults: defaults)
		organizer.hide("u7", name: "某人")

		let reloaded = Organizer(defaults: defaults)
		#expect(reloaded.isHidden("u7"))
		#expect(reloaded.hidden["u7"] == "某人")
		reloaded.unhide("u7")
		#expect(!Organizer(defaults: defaults).isHidden("u7"))
	}

	@Test func groupsFromAnOlderBuildBecomeTags() throws {
		let defaults = MemoryDefaults()
		let work = UUID(), empty = UUID()
		let stored = #"""
		{"groups":[{"id":"\#(work.uuidString)","name":" Work "},{"id":"\#(empty.uuidString)","name":"空的"}],
		 "membership":{"u1":"\#(work.uuidString)","c2":"\#(work.uuidString)"},
		 "hidden":{"u9":"某人"},"collapsed":["\#(work.uuidString)"],"synced":true,"dirty":false,
		 "serverTags":{"u1":["讀書會"]},"foldersRev":7}
		"""#
		defaults.set(Data(stored.utf8), forKey: "organizer")

		let organizer = Organizer(defaults: defaults)
		#expect(organizer.isHidden("u9"))
		#expect(organizer.hiddenRev == 7)
		#expect(organizer.pendingTagOps.map(\.tags) == [["Work"]])
		#expect(organizer.pendingTagOps.first?.chatIds == ["c2", "u1"])
		#expect(organizer.tags(of: "u1") == ["讀書會", "Work"].sorted { $0.localizedStandardCompare($1) == .orderedAscending })
		#expect(organizer.tags(of: "c2") == ["Work"])
		#expect(Organizer(defaults: defaults).pendingTagOps.count == 1, "it happens once")
	}

	@Test func firstSyncKeepsBothSides() throws {
		let organizer = fresh()
		organizer.hide("u9", name: "某人")
		let server = OrganizerState(hidden: [.init(chatId: "u8", name: "別人")], updatedMs: 1)

		let push = try #require(organizer.reconcile(with: server))
		#expect(organizer.synced)
		#expect(organizer.isHidden("u8") && organizer.isHidden("u9"))
		#expect(push.hidden.map(\.chatId) == ["u8", "u9"])

		organizer.markSaved(push, server: push)
		#expect(!organizer.dirty)
	}

	@Test func laterSyncsFollowTheServerUnlessChangedHere() throws {
		let organizer = fresh()
		let empty = OrganizerState(hidden: [], updatedMs: 0)
		#expect(organizer.reconcile(with: empty) == nil, "nothing to send when both sides are empty")
		var pushes = 0
		organizer.onChange = { pushes += 1 }

		let fromOtherMac = OrganizerState(hidden: [.init(chatId: "u5", name: "x")])
		#expect(organizer.reconcile(with: fromOtherMac) == nil)
		#expect(organizer.isHidden("u5"))
		#expect(pushes == 0, "applying the server's copy is not a local change")

		organizer.unhide("u5")
		#expect(pushes == 1 && organizer.dirty)
		let push = try #require(organizer.reconcile(with: fromOtherMac), "a change made offline wins")
		#expect(push.hidden.isEmpty)
		#expect(organizer.isHidden("u5") == false)

		organizer.markSaved(fromOtherMac, server: fromOtherMac)
		#expect(organizer.dirty, "only the state this Mac has now clears it")
		organizer.markSaved(push, server: push)
		#expect(!organizer.dirty)
	}

	@Test func savesCarryTheRevisionAndTakeBackAgentChanges() throws {
		let defaults = MemoryDefaults()
		let organizer = Organizer(defaults: defaults)
		let server = OrganizerState(hidden: [], rev: 5)
		#expect(organizer.reconcile(with: server) == nil)
		#expect(organizer.hiddenRev == 5)

		// Offline: the owner hides u2 while an agent hides u4 on the server.
		organizer.hide("u2", name: "某人")
		let push = try #require(organizer.reconcile(with: OrganizerState(hidden: [.init(chatId: "u4", name: "別人")], rev: 6)))
		#expect(organizer.hiddenRev == 5, "a save from here is based on what this Mac last took from the server")
		#expect(push.hidden.map(\.chatId) == ["u2"])

		// The server replays the agent's hide on top of the save.
		let saved = OrganizerState(hidden: [.init(chatId: "u2", name: "某人"), .init(chatId: "u4", name: "別人")], rev: 7)
		organizer.markSaved(push, server: saved)
		#expect(!organizer.dirty)
		#expect(organizer.isHidden("u4"))
		#expect(organizer.hiddenRev == 7)
		#expect(Organizer(defaults: defaults).hiddenRev == 7)
	}

	@Test func saveBodyNamesTheBaseRevision() throws {
		let save = OrganizerSave(hidden: [], baseRev: 12)
		let body = try #require(String(data: JSONEncoder.api.encode(save), encoding: .utf8))
		#expect(body.contains(#""base_rev":12"#))
		#expect(!body.contains("tags"))
		#expect(!body.contains("folders"))
	}

	@Test func organizerWireFormat() throws {
		let state = OrganizerState(hidden: [.init(chatId: "u2", name: "某人")])
		let body = try #require(String(data: JSONEncoder.api.encode(state), encoding: .utf8))
		#expect(body.contains(#""chat_id":"u2""#))
		// The server still sends an empty `folders` for builds from before tags replaced them.
		let served = try JSONDecoder.api.decode(OrganizerState.self, from: Data(#"{"folders":[],"hidden":[{"chat_id":"u2","name":"某人"}],"updated_ms":5}"#.utf8))
		#expect(served.sameContent(as: state))
		#expect(served.updatedMs == 5)
		let event = try JSONDecoder.api.decode(LineEvent.self, from: Data(#"{"type":"organizer"}"#.utf8))
		guard case .organizer = event else { Issue.record("expected .organizer"); return }
	}
}

@MainActor
struct TagTests {
	private func fresh(_ defaults: UserDefaults = MemoryDefaults()) -> Organizer {
		Organizer(defaults: defaults)
	}

	private func state(rev: Int, _ tags: [String: [String]]) -> OrganizerState {
		OrganizerState(hidden: [], tags: tags.map { .init(chatId: $0.key, tags: $0.value) }, rev: rev)
	}

	@Test func severalTagsPerChatAndOneTagPerSpelling() {
		let organizer = fresh()
		var pushes = 0
		organizer.onTagChange = { pushes += 1 }
		organizer.addTags(["讀書會", " 羽球 ", "  "], to: ["u1", "u2"])
		organizer.addTags(["读书会", "Book  Club"], to: ["u3"])
		organizer.addTags(["book club"], to: ["u1"])
		#expect(organizer.tags(of: "u1") == ["Book Club", "羽球", "讀書會"].sorted { $0.localizedStandardCompare($1) == .orderedAscending })
		#expect(organizer.tags(of: "u3").contains("讀書會"), "Simplified and Traditional spellings are one tag")
		#expect(organizer.allTags.count == 3)
		#expect(organizer.tagCounts["讀書會"] == 3)
		#expect(pushes == 3)

		organizer.removeTags(["讀書會", "羽球"], from: ["u2"])
		#expect(organizer.tags(of: "u2").isEmpty)
		#expect(organizer.tags["u2"] == nil, "a chat without tags is not kept")
		organizer.renameTag("羽球", to: "讀書會")
		#expect(organizer.tags(of: "u1") == ["Book Club", "讀書會"], "renaming to an existing tag merges them")
		organizer.renameTag("book club", to: "BOOK CLUB")
		#expect(organizer.tags(of: "u3").contains("BOOK CLUB"))
		organizer.deleteTag("读书会")
		#expect(organizer.allTags == ["BOOK CLUB"])
	}

	@Test func filterMatchesAnyOrAllTags() {
		let organizer = fresh()
		organizer.addTags(["讀書會", "羽球"], to: ["u1"])
		organizer.addTags(["讀書會"], to: ["u2"])
		organizer.addTags(["同事"], to: ["u3"])
		let both: Set = ["讀書會", "同事"]
		#expect(organizer.matches("u1", tags: both, all: false))
		#expect(organizer.matches("u3", tags: both, all: false))
		#expect(!organizer.matches("u1", tags: both, all: true))
		#expect(organizer.matches("u1", tags: ["讀書會", "羽球"], all: true))
		#expect(!organizer.matches("u4", tags: ["讀書會"], all: false))
	}

	@Test func changesMadeOfflineStayOnTopOfTheServersCopyUntilConfirmed() throws {
		let defaults = MemoryDefaults()
		let organizer = fresh(defaults)
		organizer.receiveTags(state(rev: 3, ["u1": ["同事"], "u2": ["讀書會"]]))
		organizer.addTags(["讀書會"], to: ["u1"])
		organizer.removeTags(["讀書會"], from: ["u2"])
		#expect(organizer.pendingTagOps.count == 2)

		// Quit and relaunch while offline: both copies are kept.
		let reloaded = fresh(defaults)
		#expect(reloaded.pendingTagOps == organizer.pendingTagOps)
		#expect(reloaded.tags(of: "u1") == ["讀書會", "同事"].sorted { $0.localizedStandardCompare($1) == .orderedAscending })
		#expect(reloaded.tags(of: "u2").isEmpty)

		// Meanwhile an agent tagged u3; the server's copy shows it, ours still apply on top.
		reloaded.receiveTags(state(rev: 4, ["u1": ["同事"], "u2": ["讀書會"], "u3": ["讀書會"]]))
		#expect(reloaded.tags(of: "u3") == ["讀書會"])
		#expect(reloaded.tags(of: "u2").isEmpty)

		let first = try #require(reloaded.pendingTagOps.first)
		reloaded.tagOpsSaved([first.id], state: state(rev: 5, ["u1": ["讀書會", "同事"], "u2": ["讀書會"], "u3": ["讀書會"]]))
		#expect(reloaded.pendingTagOps.count == 1, "only what the server confirmed leaves the queue")
		#expect(reloaded.tags(of: "u2").isEmpty)

		// A copy older than one already applied (a slow response) is ignored.
		reloaded.receiveTags(state(rev: 2, [:]))
		#expect(reloaded.tags(of: "u3") == ["讀書會"])

		reloaded.dropTagOps(Set(reloaded.pendingTagOps.map(\.id)))
		#expect(reloaded.pendingTagOps.isEmpty)
		#expect(reloaded.tags(of: "u2") == ["讀書會"], "a refused change is undone")
	}

	@Test func aServerOlderThanTagsKeepsChangesQueued() {
		let organizer = fresh()
		organizer.addTags(["讀書會"], to: ["u1"])
		organizer.receiveTags(OrganizerState(hidden: [], updatedMs: 1))
		#expect(organizer.tags(of: "u1") == ["讀書會"])
		#expect(organizer.pendingTagOps.count == 1)
	}

	@Test func tagWireFormat() throws {
		let op = TagOp(op: .add, tags: ["讀書會"], chatIds: ["u1"])
		let body = try #require(String(data: JSONEncoder.api.encode(op), encoding: .utf8))
		#expect(body.contains(#""chat_ids":["u1"]"#))
		#expect(body.contains(#""op":"add""#))
		let rename = try #require(String(data: JSONEncoder.api.encode(TagOp(op: .rename, tags: ["a"], to: "b")), encoding: .utf8))
		#expect(rename.contains(#""to":"b""#) && !rename.contains("chat_ids"))

		let served = try JSONDecoder.api.decode(OrganizerState.self, from: Data(#"{"folders":[],"hidden":[],"tags":[{"chat_id":"u1","tags":["讀書會","a_b"]}],"rev":7,"updated_ms":5}"#.utf8))
		#expect(served.tags == [.init(chatId: "u1", tags: ["讀書會", "a_b"])])
		#expect(served.rev == 7)

		// Saving groups never sends tags, so a save cannot overwrite them.
		let organizer = fresh()
		organizer.addTags(["讀書會"], to: ["u1"])
		let saved = try #require(String(data: JSONEncoder.api.encode(organizer.shared), encoding: .utf8))
		#expect(!saved.contains("tags") && !saved.contains("rev"))
	}
}

struct ContactDecodingTests {
	@Test func contactsAndSenderPictures() throws {
		let contacts = try JSONDecoder.api.decode(ContactList.self, from: Data(#"{"contacts":[{"id":"u1","name":"阿明","type":"user","picture":"https://profile.line-scdn.net/x/preview"},{"id":"c2","name":"家人","type":"group"}]}"#.utf8))
		#expect(contacts.contacts.count == 2)
		#expect(contacts.contacts[0].picture?.host() == "profile.line-scdn.net")
		#expect(contacts.contacts[1].type == .group)
		let m = try JSONDecoder.api.decode(Message.self, from: Data(#"{"id":"1","chat_id":"c2","from_id":"u3","from_name":"小華","from_picture":"https://profile.line-scdn.net/y/preview","mine":false,"time_ms":1,"delivered":"1","kind":"text","text":"hi"}"#.utf8))
		#expect(m.fromPicture?.path() == "/y/preview")
	}
}

@MainActor
struct ClipboardTests {
	private func board() -> NSPasteboard {
		let pasteboard = NSPasteboard(name: NSPasteboard.Name("betterLINE.tests.\(UUID().uuidString)"))
		pasteboard.clearContents()
		return pasteboard
	}

	private var tiff: Data {
		let image = NSImage(size: NSSize(width: 4, height: 4), flipped: false) { rect in
			NSColor.systemBlue.setFill()
			rect.fill()
			return true
		}
		return image.tiffRepresentation!
	}

	@Test func imageOnlyBecomesAnAttachment() throws {
		let pasteboard = board()
		pasteboard.setData(tiff, forType: .tiff)
		#expect(Clipboard.hasAttachment(pasteboard))
		let files = try #require(Clipboard.attachments(from: pasteboard))
		#expect(files.count == 1)
		#expect(files[0].pathExtension == "png")
		#expect(NSImage(contentsOf: files[0]) != nil)
	}

	@Test func textStaysText() {
		let pasteboard = board()
		pasteboard.setString("你好", forType: .string)
		#expect(!Clipboard.hasAttachment(pasteboard))
		#expect(Clipboard.attachments(from: pasteboard) == nil)
	}

	@Test func textThatAlsoCarriesAnImageStaysText() {
		let pasteboard = board()
		pasteboard.declareTypes([.string, .tiff], owner: nil)
		pasteboard.setString("一段網頁文字", forType: .string)
		pasteboard.setData(tiff, forType: .tiff)
		#expect(!Clipboard.hasImage(pasteboard))
	}

	@Test func copiedImageWithItsAddressIsAnImage() {
		let pasteboard = board()
		pasteboard.declareTypes([.tiff, .string], owner: nil)
		pasteboard.setData(tiff, forType: .tiff)
		pasteboard.setString("https://example.com/a.png", forType: .string)
		#expect(Clipboard.hasImage(pasteboard))
	}

	@Test func pasteIsOfferedForAnImage() {
		let pasteboard = board()
		pasteboard.setData(tiff, forType: .tiff)
		let input = InputTextView()
		input.isRichText = false
		input.importsGraphics = false
		input.pasteboard = pasteboard
		let item = NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
		#expect(input.validateMenuItem(item))
	}

	@Test func copiedFilesWin() throws {
		let file = FileManager.default.temporaryDirectory.appending(path: "betterLINE-test-\(UUID().uuidString).txt")
		try Data("x".utf8).write(to: file)
		defer { try? FileManager.default.removeItem(at: file) }
		let pasteboard = board()
		pasteboard.writeObjects([file as NSURL])
		#expect(Clipboard.attachments(from: pasteboard)?.map(\.lastPathComponent) == [file.lastPathComponent])
	}
}

@MainActor
struct ComposerTests {
	/// A composer's text view wired to plain fields instead of SwiftUI state.
	@MainActor
	private final class Harness {
		var text = ""
		var height: CGFloat = 20
		var composing = false
		let input = InputTextView()
		private var coordinator: ComposerTextView.Coordinator!
		// Input methods edit through the window's input context, so the view needs one.
		private let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 40), styleMask: .borderless, backing: .buffered, defer: true)

		init() {
			let view = ComposerTextView(
				text: Binding(get: { self.text }, set: { self.text = $0 }),
				height: Binding(get: { self.height }, set: { self.height = $0 }),
				composing: Binding(get: { self.composing }, set: { self.composing = $0 }),
				sendOnEnter: true,
				focusKey: "",
				onSubmit: {},
				onFiles: { _ in },
				onEscape: {},
			)
			coordinator = view.makeCoordinator()
			input.delegate = coordinator
			input.coordinator = coordinator
			window.contentView = input
			window.makeFirstResponder(input)
		}

		func mark(_ text: String) {
			input.setMarkedText(text, selectedRange: NSRange(location: text.utf16.count, length: 0), replacementRange: none)
		}

		func commit(_ text: String) {
			input.insertText(text, replacementRange: none)
		}

		private var none: NSRange { NSRange(location: NSNotFound, length: 0) }
	}

	@Test func placeholderHidesWhileAnInputMethodComposes() {
		let composer = Harness()
		composer.mark("ㄉ")
		#expect(composer.composing)
		#expect(composer.text.isEmpty, "marked text isn't the draft until it's committed")

		composer.commit("的")
		#expect(!composer.composing)
		#expect(composer.text == "的", "the candidate replaces the zhuyin")
	}

	@Test func cancellingTheInputMethodShowsThePlaceholderAgain() {
		let composer = Harness()
		composer.mark("ㄉ")
		#expect(composer.composing)
		composer.mark("")
		#expect(!composer.composing)
		#expect(composer.text.isEmpty)
	}
}

struct SwipeTrackerTests {
	@Test func leftSwipeShowsTimesAndSnapsBack() {
		var swipe = SwipeTracker()
		swipe.begin()
		let step1 = swipe.move(dx: -10, dy: 1, target: "m1")
		#expect(step1)
		#expect(swipe.timesOffset == 10)
		#expect(swipe.replyTarget == nil, "a left swipe never replies")
		let step2 = swipe.move(dx: -200, dy: 0, target: "m1")
		#expect(step2)
		#expect(swipe.timesOffset == SwipeTracker.timesWidth)
		#expect(swipe.isHorizontal)
		#expect(swipe.end() == nil)
		#expect(swipe.timesOffset == 0)
		#expect(swipe.mode == nil)
	}

	@Test func rightSwipeRepliesOnlyPastTheThreshold() {
		var short = SwipeTracker()
		short.begin()
		let step3 = short.move(dx: 20, dy: 0, target: "m1")
		#expect(step3)
		#expect(short.replyOffset > 0 && !short.replyArmed)
		#expect(short.end() == nil)

		var far = SwipeTracker()
		far.begin()
		let step4 = far.move(dx: 20, dy: 0, target: "m1")
		#expect(step4)
		let step5 = far.move(dx: 150, dy: 0, target: "m2")
		#expect(step5, "the target is fixed when the swipe starts")
		#expect(far.replyArmed)
		#expect(far.replyOffset < SwipeTracker.replyLimit)
		#expect(far.end() == "m1")
	}

	@Test func backingOffDisarmsTheReply() {
		var swipe = SwipeTracker()
		swipe.begin()
		_ = swipe.move(dx: 200, dy: 0, target: "m1")
		#expect(swipe.replyArmed)
		_ = swipe.move(dx: -180, dy: 0, target: "m1")
		#expect(!swipe.replyArmed)
		#expect(swipe.end() == nil)
	}

	@Test func verticalScrollsAreLeftAlone() {
		var swipe = SwipeTracker()
		swipe.begin()
		let step6 = swipe.move(dx: 0.2, dy: 0.1, target: "m1")
		#expect(!step6, "jitter does not decide the direction")
		#expect(swipe.mode == .undecided)
		let step7 = swipe.move(dx: 3, dy: -8, target: "m1")
		#expect(!step7)
		#expect(swipe.mode == .vertical)
		let step8 = swipe.move(dx: 40, dy: 0, target: "m1")
		#expect(!step8, "once vertical, the gesture stays a scroll")
		#expect(!swipe.isHorizontal)
	}

	@Test func rightSwipeOffAMessageScrolls() {
		var swipe = SwipeTracker()
		swipe.begin()
		let step9 = swipe.move(dx: 30, dy: 0, target: nil)
		#expect(!step9)
		#expect(swipe.mode == .vertical)
	}

	@Test func eventsOutsideAGestureAreIgnored() {
		var swipe = SwipeTracker()
		let step10 = swipe.move(dx: -30, dy: 0, target: nil)
		#expect(!step10)
		#expect(swipe.timesOffset == 0)
	}
}

@MainActor
struct ImagePipelineTests {
	/// The attachment chip asks for a 96 px thumbnail of a file before the sent
	/// bubble asks for 640 px of the same file; the bubble must not get the chip's.
	@Test func sizesOfTheSameFileAreCachedApart() async throws {
		let file = FileManager.default.temporaryDirectory.appending(path: "betterLINE-wide-\(UUID().uuidString).png")
		let image = NSImage(size: NSSize(width: 2000, height: 500), flipped: false) { rect in
			NSColor.systemTeal.setFill()
			rect.fill()
			return true
		}
		let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2000, pixelsHigh: 500, bitsPerSample: 8, samplesPerPixel: 4,
			hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
		NSGraphicsContext.saveGraphicsState()
		NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
		image.draw(in: NSRect(x: 0, y: 0, width: 2000, height: 500))
		NSGraphicsContext.restoreGraphicsState()
		try rep.representation(using: .png, properties: [:])!.write(to: file)
		defer { try? FileManager.default.removeItem(at: file) }

		let pipeline = ImagePipeline()
		let chip = try #require(await pipeline.image(key: "file:\(file.path)", maxPixel: 96) { file })
		let bubble = try #require(await pipeline.image(key: "file:\(file.path)", maxPixel: 640) { file })
		#expect(chip.size.width == 96)
		#expect(bubble.size.width == 640)
	}
}

struct ReadOrderTests {
	@Test func messageIdsOrderByValue() {
		#expect(MessageOrder.id("634900000000000004", isAtLeast: "634900000000000003"))
		#expect(!MessageOrder.id("634900000000000003", isAtLeast: "634900000000000004"))
		#expect(MessageOrder.id("634900000000000004", isAtLeast: "634900000000000004"))
		// Old short ids are older than today's long ones.
		#expect(MessageOrder.id("634900000000000001", isAtLeast: "12100000000001"))
		#expect(!MessageOrder.id("12100000000001", isAtLeast: "463100000000000001"))
	}

	@Test func readMarkersDecode() throws {
		let markers = try JSONDecoder.api.decode(ReadMarkers.self, from: Data(#"{"readers":{"u1":"634900000000000003"}}"#.utf8))
		#expect(markers.readers["u1"] == "634900000000000003")
	}
}

@MainActor
struct StickerAnimationTests {
	/// A three-frame APNG of solid squares, like a short animated sticker.
	private func apng() throws -> Data {
		let data = NSMutableData()
		let dest = try #require(CGImageDestinationCreateWithData(data as CFMutableData, UTType.png.identifier as CFString, 3, nil))
		CGImageDestinationSetProperties(dest, [kCGImagePropertyPNGDictionary: [kCGImagePropertyAPNGLoopCount: 1]] as CFDictionary)
		for color in [NSColor.systemRed, .systemGreen, .systemBlue] {
			let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 40, pixelsHigh: 40, bitsPerSample: 8, samplesPerPixel: 4,
				hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
			NSGraphicsContext.saveGraphicsState()
			NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
			color.setFill()
			NSRect(x: 0, y: 0, width: 40, height: 40).fill()
			NSGraphicsContext.restoreGraphicsState()
			CGImageDestinationAddImage(dest, rep.cgImage!, [kCGImagePropertyPNGDictionary: [kCGImagePropertyAPNGDelayTime: 0.05]] as CFDictionary)
		}
		#expect(CGImageDestinationFinalize(dest))
		return data as Data
	}

	private func visibleFraction(_ image: CGImage) -> Double {
		let w = image.width, h = image.height
		var px = [UInt8](repeating: 0, count: w * h * 4)
		let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
			space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
		ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
		return Double(stride(from: 3, to: px.count, by: 4).filter { px[$0] > 0 }.count) / Double(w * h)
	}

	/// ImageIO recycles the frames it hands to the animation block; a frame kept
	/// after playback ended used to come out blank, so animated stickers vanished.
	@Test func lastFrameStaysVisibleAfterPlayback() async throws {
		let player = FramePlayer()
		player.play(try apng())
		try await Task.sleep(for: .seconds(1))
		let frame = try #require(player.frame)
		#expect(visibleFraction(frame) > 0.9)
	}
}
