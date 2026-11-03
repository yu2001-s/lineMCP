import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct MessageRow: View {
	let message: Message
	let chat: Chat
	let startsRun: Bool
	let endsRun: Bool
	let showsReceipt: Bool
	let conversation: Conversation
	let highlighted: Bool
	let swipe: SwipeModel
	let preview: (URL) -> Void

	@Environment(AppModel.self) private var app

	private static let avatarSize: CGFloat = 28

	var body: some View {
		Group {
			if message.kind == .system {
				SystemNotice(message: message)
			} else {
				bubbleRow
					.onGeometryChange(for: CGRect.self) { $0.frame(in: .named(SwipeModel.space)) } action: { frame in
						swipe.frames[message.id] = frame
					}
					.onDisappear { swipe.frames[message.id] = nil }
					.offset(x: replyOffset)
					.background(alignment: .leading) { replyArrow }
					.overlay(alignment: .trailing) {
						// Hidden past the edge until a left swipe slides the transcript over.
						Text(Format.time(message.date))
							.font(.caption2)
							.foregroundStyle(.secondary)
							.fixedSize()
							.offset(x: SwipeTracker.timesWidth - 4)
					}
			}
		}
		.padding(.top, startsRun ? 8 : 2)
		.background {
			if highlighted {
				RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.accentColor.opacity(0.15)).padding(-4)
			}
		}
	}

	private var replyOffset: CGFloat {
		swipe.tracker.replyTarget == message.id ? swipe.tracker.replyOffset : 0
	}

	@ViewBuilder
	private var replyArrow: some View {
		if replyOffset > 0 {
			let armed = replyOffset >= SwipeTracker.replyThreshold
			Image(systemName: "arrowshape.turn.up.left.circle.fill")
				.font(.system(size: 22))
				.foregroundStyle(armed ? Color.accentColor : Color.secondary)
				.scaleEffect(armed ? 1 : 0.8)
				.opacity(min(1, replyOffset / SwipeTracker.replyThreshold))
				.animation(.snappy(duration: 0.15), value: armed)
		}
	}

	private var bubbleRow: some View {
		HStack(alignment: .bottom, spacing: 8) {
			if message.mine {
				Spacer(minLength: 72)
			} else if endsRun {
				Avatar(
					name: message.fromName,
					url: app.picture(of: message.fromId, fallback: message.fromPicture ?? (chat.type == .user ? chat.picture : nil)),
					seed: message.fromId,
					size: Self.avatarSize,
				)
				.help(message.fromName)
			} else {
				Color.clear.frame(width: Self.avatarSize, height: 1)
			}
			VStack(alignment: message.mine ? .trailing : .leading, spacing: 3) {
				if startsRun, !message.mine, chat.type != .user {
					Text(message.fromName)
						.font(.caption)
						.foregroundStyle(.secondary)
						.padding(.horizontal, 12)
				}
				MessageContent(message: message, conversation: conversation, preview: preview)
					.help(Format.dateTime(message.date))
					.contextMenu { menu }
				if let reactions = message.reactions, !reactions.isEmpty {
					ReactionChips(reactions: reactions, myId: app.me?.id) { type in
						conversation.react(message, type)
					}
				}
				status
			}
			if !message.mine { Spacer(minLength: 72) }
		}
	}

	/// Under a bubble: a failed send, or the read receipt on your latest message.
	@ViewBuilder
	private var status: some View {
		if case let .failed(reason) = message.local {
			Menu {
				Button("重新傳送") { conversation.retry(message) }
				Button("刪除", role: .destructive) { conversation.discard(message) }
			} label: {
				Label("未傳送", systemImage: "exclamationmark.circle.fill")
					.foregroundStyle(.red)
			}
			.menuStyle(.borderlessButton)
			.menuIndicator(.hidden)
			.fixedSize()
			.font(.caption)
			.help(reason)
		} else if showsReceipt {
			let readers = conversation.readCount(message)
			if readers > 0 {
				Text(chat.type == .user ? "已讀" : "已讀 \(readers)")
					.font(.caption2.weight(.medium))
					.foregroundStyle(.secondary)
					.padding(.trailing, 4)
			}
		}
	}

	@ViewBuilder
	private var menu: some View {
		if !message.isLocal {
			Button {
				conversation.reply(to: message)
			} label: {
				Label("回覆", systemImage: "arrowshape.turn.up.left")
			}
			Menu {
				ForEach(ReactionType.allCases, id: \.self) { type in
					Button("\(type.emoji)  \(type.title)") { conversation.react(message, type) }
				}
				if message.reactions?.contains(where: { $0.fromId == app.me?.id }) == true {
					Divider()
					Button("取消回應") { conversation.react(message, nil) }
				}
			} label: {
				Label("回應", systemImage: "face.smiling")
			}
		}
		if !message.text.isEmpty, message.kind == .text || message.kind == .rich {
			Button {
				NSPasteboard.general.clearContents()
				NSPasteboard.general.setString(message.displayText, forType: .string)
			} label: {
				Label("拷貝", systemImage: "doc.on.doc")
			}
		}
		if message.kind.isMedia, let api = app.api {
			Button {
				Task {
					if let url = try? await MediaStore.shared.file(for: message, api: api) { preview(url) }
				}
			} label: {
				Label("快速查看", systemImage: "eye")
			}
			Button {
				Task { await MediaActions.save(message, api: api) }
			} label: {
				Label("儲存為…", systemImage: "square.and.arrow.down")
			}
			Button {
				Task {
					if let url = try? await MediaStore.shared.file(for: message, api: api) {
						NSWorkspace.shared.open(url)
					}
				}
			} label: {
				Label("以預設 App 開啟", systemImage: "arrow.up.forward.app")
			}
			if message.kind == .image {
				Button {
					Task { await MediaActions.copyImage(message, api: api) }
				} label: {
					Label("拷貝影像", systemImage: "photo.on.rectangle")
				}
			}
		}
		if message.kind == .sticker, let sticker = message.sticker {
			Button {
				conversation.sendSticker(sticker)
			} label: {
				Label("傳送這張貼圖", systemImage: "paperplane")
			}
		}
		if message.mine, !message.isLocal, Date().timeIntervalSince(message.date) < 24 * 3600 {
			Divider()
			Button(role: .destructive) {
				conversation.confirmUnsend = message
			} label: {
				Label("收回", systemImage: "arrow.uturn.backward")
			}
		}
	}
}

/// The bubble (or bare sticker or photo) for one message.
private struct MessageContent: View {
	let message: Message
	let conversation: Conversation
	let preview: (URL) -> Void

	var body: some View {
		VStack(alignment: message.mine ? .trailing : .leading, spacing: 3) {
			if let replyTo = message.replyTo, message.kind != .text {
				bubble {
					ReplyQuote(original: conversation.message(replyTo)) { conversation.focus = replyTo }
				}
			}
			content
		}
	}

	@ViewBuilder
	private var content: some View {
		if message.failedToDecrypt {
			bubble {
				Label("無法解密這則訊息", systemImage: "lock.trianglebadge.exclamationmark")
					.foregroundStyle(.secondary)
			}
		} else {
			switch message.kind {
			case .text:
				bubble {
					VStack(alignment: .leading, spacing: 6) {
						if let replyTo = message.replyTo {
							ReplyQuote(original: conversation.message(replyTo)) { conversation.focus = replyTo }
						}
						if message.text.isEmpty {
							Text("不支援這種訊息").foregroundStyle(.secondary)
						} else {
							LinkedText(text: message.text, onAccent: message.mine)
						}
					}
				}
			case .sticker:
				if let sticker = message.sticker {
					StickerView(sticker: sticker)
				} else {
					bubble { Text("[貼圖]") }
				}
			case .image:
				ImageContent(message: message, preview: preview)
			case .video:
				VideoContent(message: message, preview: preview)
			case .audio:
				bubble { AudioContent(message: message) }
			case .file:
				bubble { FileContent(message: message, preview: preview) }
			case .location:
				bubble { LocationContent(location: message.location, fallback: message.text) }
			case .call:
				bubble { Label(message.text == "[call]" ? "通話" : message.text, systemImage: "phone.fill") }
			case .contact:
				bubble { Label(message.displayText, systemImage: "person.crop.square") }
			case .rich:
				bubble {
					Label {
						LinkedText(text: message.displayText == "[rich message]" ? "圖文訊息（請在手機上查看）" : message.displayText, onAccent: message.mine)
					} icon: {
						Image(systemName: "rectangle.on.rectangle.angled")
					}
				}
			case .other, .system:
				bubble { Text(message.text).foregroundStyle(.secondary) }
			}
		}
	}

	private func bubble(@ViewBuilder _ inner: () -> some View) -> some View {
		inner()
			.foregroundStyle(message.mine ? Color.white : Color.primary)
			.padding(.horizontal, 12)
			.padding(.vertical, 7)
			.background(message.mine ? Color.bubbleMine : Color.bubbleTheirs, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
			.opacity(message.local == .sending ? 0.6 : 1)
	}
}

/// Text with clickable links that can be selected and copied. Message text is
/// never interpreted as Markdown.
private struct LinkedText: View {
	let text: String
	/// On your own (accent-coloured) bubble, links stay white and underlined.
	let onAccent: Bool

	private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

	var body: some View {
		Text(attributed)
			.font(.system(size: 14))
			.fixedSize(horizontal: false, vertical: true)
			.tint(onAccent ? .white : .accentColor)
			.textSelection(.enabled)
	}

	private var attributed: AttributedString {
		var result = AttributedString(text)
		guard text.contains("."), let detector = Self.detector else { return result }
		let ns = NSRange(text.startIndex..., in: text)
		for match in detector.matches(in: text, range: ns) {
			guard let url = match.url, let range = Range(match.range, in: result) else { continue }
			result[range].link = url
			result[range].underlineStyle = .single
		}
		return result
	}
}

private struct ReplyQuote: View {
	let original: Message?
	let onTap: () -> Void

	var body: some View {
		HStack(spacing: 6) {
			RoundedRectangle(cornerRadius: 1).fill(.secondary).frame(width: 2)
			VStack(alignment: .leading, spacing: 1) {
				Text(original.map { $0.mine ? "你" : $0.fromName } ?? "回覆")
					.font(.caption.weight(.semibold))
				Text(original?.preview ?? "原訊息不在已載入的紀錄中")
					.font(.caption)
					.lineLimit(2)
			}
			.foregroundStyle(.secondary)
		}
		.fixedSize(horizontal: false, vertical: true)
		.pressable("跳到原訊息") { if original != nil { onTap() } }
	}
}

private struct ReactionChips: View {
	let reactions: [Reaction]
	let myId: String?
	let onToggle: (ReactionType?) -> Void

	var body: some View {
		HStack(spacing: 4) {
			ForEach(grouped, id: \.type) { group in
				Button {
					onToggle(group.mine ? nil : ReactionType(rawValue: group.type))
				} label: {
					Text("\(ReactionType.emoji(for: group.type)) \(group.count)")
						.font(.caption)
						.padding(.horizontal, 7)
						.padding(.vertical, 2)
						.background(group.mine ? Color.accentColor.opacity(0.2) : Color.bubbleTheirs, in: Capsule())
						.overlay(Capsule().strokeBorder(group.mine ? Color.accentColor.opacity(0.5) : .clear))
				}
				.buttonStyle(.plain)
				.help(group.mine ? "取消回應" : "回應")
			}
		}
		.padding(.horizontal, 4)
	}

	private var grouped: [(type: String, count: Int, mine: Bool)] {
		var order: [String] = []
		var counts: [String: Int] = [:]
		var mine: Set<String> = []
		for r in reactions {
			if counts[r.type] == nil { order.append(r.type) }
			counts[r.type, default: 0] += 1
			if r.fromId == myId { mine.insert(r.type) }
		}
		return order.map { ($0, counts[$0]!, mine.contains($0)) }
	}
}

private struct SystemNotice: View {
	let message: Message

	var body: some View {
		Text(label)
			.font(.caption)
			.foregroundStyle(.secondary)
			.frame(maxWidth: .infinity)
			.padding(.vertical, 2)
	}

	private var label: String {
		let text = message.text
		if text.isEmpty || (text.hasPrefix("[") && text.hasSuffix("]")) {
			return "\(message.mine ? "你" : message.fromName) 更新了群組"
		}
		return text
	}
}

enum MediaActions {
	@MainActor
	static func save(_ message: Message, api: LineAPI) async {
		guard let file = try? await MediaStore.shared.file(for: message, api: api) else { return }
		let panel = NSSavePanel()
		panel.nameFieldStringValue = file.lastPathComponent
		if let type = UTType(filenameExtension: file.pathExtension) { panel.allowedContentTypes = [type] }
		guard panel.runModal() == .OK, let target = panel.url else { return }
		try? FileManager.default.removeItem(at: target)
		try? FileManager.default.copyItem(at: file, to: target)
	}

	@MainActor
	static func copyImage(_ message: Message, api: LineAPI) async {
		guard let file = try? await MediaStore.shared.file(for: message, api: api), let image = NSImage(contentsOf: file) else { return }
		NSPasteboard.general.clearContents()
		NSPasteboard.general.writeObjects([image])
	}
}
