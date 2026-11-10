import QuickLook
import SwiftUI
import UniformTypeIdentifiers

struct ConversationView: View {
	let chat: Chat
	@Bindable var conversation: Conversation

	@Environment(AppModel.self) private var app
	@State private var previewURL: URL?
	@State private var dropTargeted = false

	var body: some View {
		VStack(spacing: 0) {
			MessageList(chat: chat, conversation: conversation) { previewURL = $0 }
				.overlay(alignment: .top) {
					if let error = conversation.error {
						InfoStrip(text: error, tone: .error, systemImage: "exclamationmark.triangle.fill") {
							conversation.error = nil
						}
						.background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
						.padding(10)
						.transition(.move(edge: .top).combined(with: .opacity))
					}
				}
			Composer(chat: chat, conversation: conversation)
		}
		.background(Color(nsColor: .textBackgroundColor))
		.navigationTitle(chat.name)
		.navigationSubtitle(subtitle)
		.toolbar {
			if !app.prefs.autoMarkRead, chat.unread > 0 {
				ToolbarItem {
					Button {
						app.markRead(chat.chatId, force: true)
					} label: {
						Label("標示為已讀", systemImage: "checkmark.message")
					}
					.help("傳送已讀回條 (⇧⌘R)")
				}
			}
			ToolbarItem {
				Menu {
					ChatActions(chatId: chat.chatId)
				} label: {
					Label("更多", systemImage: "ellipsis.circle")
				}
				.help("整理這個聊天室")
			}
		}
		.quickLookPreview($previewURL)
		.onDrop(of: [.fileURL, .image], isTargeted: $dropTargeted) { providers in
			for provider in providers {
				if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
					_ = provider.loadObject(ofClass: URL.self) { url, _ in
						guard let url, url.isFileURL else { return }
						Task { @MainActor in conversation.attachments.append(url) }
					}
				} else if let type = provider.registeredContentTypes.first(where: { $0.conforms(to: .image) }) {
					// An image dragged out of a browser or another app, not a file.
					_ = provider.loadDataRepresentation(for: type) { data, _ in
						guard let data, let file = Upload.writeImageData(data, type: type) else { return }
						Task { @MainActor in conversation.attachments.append(file) }
					}
				}
			}
			return true
		}
		.overlay {
			if dropTargeted {
				RoundedRectangle(cornerRadius: 12, style: .continuous)
					.strokeBorder(Color.accentColor, style: StrokeStyle(lineWidth: 2, dash: [8]))
					.background(Color.accentColor.opacity(0.06))
					.overlay { Label("放開以加入附件", systemImage: "paperclip").font(.title3) }
					.padding(8)
					.allowsHitTesting(false)
			}
		}
		.confirmationDialog(
			"要收回這則訊息嗎？",
			isPresented: Binding(get: { conversation.confirmUnsend != nil }, set: { if !$0 { conversation.confirmUnsend = nil } }),
			presenting: conversation.confirmUnsend,
		) { message in
			Button("收回", role: .destructive) { conversation.unsend(message) }
		} message: { _ in
			Text("對方的聊天室中也會刪除這則訊息。")
		}
		.animation(.default, value: conversation.error)
	}

	private var subtitle: String {
		var parts: [String] = []
		switch chat.type {
		case .group: parts.append("群組")
		case .room: parts.append("多人聊天室")
		case .user: break
		}
		parts += app.organizer.tags(of: chat.chatId)
		if app.isArchived(chat.chatId) { parts.append("已封存") }
		if chat.isMuted { parts.append("已靜音") }
		return parts.joined(separator: " · ")
	}
}

/// Rows for the message list, grouped the way Messages does it: a centered time
/// header after a pause, and runs of bubbles from the same sender.
struct MessageRowModel: Identifiable {
	enum Kind {
		case timeHeader(Date)
		case unreadDivider
		case message(Message, startsRun: Bool, endsRun: Bool)
	}

	let id: String
	let kind: Kind

	static let headerGapMs: Int64 = 15 * 60_000
	static let runGapMs: Int64 = 3 * 60_000

	static func build(_ messages: [Message], firstUnreadId: String? = nil) -> [MessageRowModel] {
		var rows: [MessageRowModel] = []
		rows.reserveCapacity(messages.count + 16)
		for (i, m) in messages.enumerated() {
			let previous = i > 0 ? messages[i - 1] : nil
			let next = i + 1 < messages.count ? messages[i + 1] : nil
			let header = previous.map { needsHeader(between: $0, and: m) } ?? true
			if header {
				rows.append(MessageRowModel(id: "time-\(m.id)", kind: .timeHeader(m.date)))
			}
			let unreadStarts = m.id == firstUnreadId
			if unreadStarts {
				rows.append(MessageRowModel(id: "unread", kind: .unreadDivider))
			}
			let startsRun = header || unreadStarts || previous.map { breaksRun($0, m) } ?? true
			let endsRun = next.map { breaksRun(m, $0) || needsHeader(between: m, and: $0) || $0.id == firstUnreadId } ?? true
			rows.append(MessageRowModel(id: m.id, kind: .message(m, startsRun: startsRun, endsRun: endsRun)))
		}
		return rows
	}

	private static func needsHeader(between a: Message, and b: Message) -> Bool {
		!Calendar.current.isDate(a.date, inSameDayAs: b.date) || b.timeMs - a.timeMs > headerGapMs
	}

	private static func breaksRun(_ a: Message, _ b: Message) -> Bool {
		a.fromId != b.fromId || a.kind == .system || b.kind == .system || b.timeMs - a.timeMs > runGapMs
	}
}

private struct MessageList: View {
	let chat: Chat
	let conversation: Conversation
	let preview: (URL) -> Void

	@Environment(AppModel.self) private var app
	@State private var atBottom = true
	@State private var flash: String?
	@State private var swipe = SwipeModel()

	private static let bottomID = "bottom"

	var body: some View {
		let rows = MessageRowModel.build(conversation.messages, firstUnreadId: conversation.firstUnreadId)
		let receiptId = conversation.messages.last { $0.mine && !$0.isLocal }?.id
		ScrollViewReader { proxy in
			ScrollView {
				TimesShift(swipe: swipe) {
				LazyVStack(spacing: 0) {
					header
					ForEach(rows) { row in
						switch row.kind {
						case let .timeHeader(date):
							TimeHeader(date: date)
						case .unreadDivider:
							UnreadDivider()
						case let .message(message, startsRun, endsRun):
							MessageRow(
								message: message,
								chat: chat,
								startsRun: startsRun,
								endsRun: endsRun,
								showsReceipt: message.id == receiptId,
								conversation: conversation,
								highlighted: flash == message.id,
								swipe: swipe,
								preview: preview,
							)
						}
					}
					Color.clear.frame(height: 1).id(Self.bottomID)
				}
				.padding(.horizontal, 14)
				.padding(.top, 4)
				.padding(.bottom, 10)
				}
			}
			.background {
				ScrollSwipeMonitor { event, point in
					swipe.handle(event, at: point) { id in
						conversation.message(id).map { !$0.isLocal && $0.kind != .system } ?? false
					} onReply: { id in
						if let message = conversation.message(id) { conversation.reply(to: message) }
					}
				}
			}
			.coordinateSpace(.named(SwipeModel.space))
			.defaultScrollAnchor(.bottom)
			.onScrollGeometryChange(for: Bool.self) { geometry in
				geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 80
			} action: { _, isAtBottom in
				atBottom = isAtBottom
			}
			.onChange(of: conversation.messages.last?.id) {
				guard let last = conversation.messages.last else { return }
				if atBottom || last.isLocal {
					withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
				}
			}
			.onChange(of: conversation.firstUnreadId) {
				guard let id = conversation.firstUnreadId else { return }
				Task {
					try? await Task.sleep(for: .milliseconds(150))
					proxy.scrollTo(id, anchor: .top)
				}
			}
			.onChange(of: conversation.focus, initial: true) {
				guard let id = conversation.focus else { return }
				conversation.focus = nil
				Task {
					// A lazy stack scrolls by estimated row heights; once the rows
					// around the target are measured, scrolling again lands on it.
					for delay in [150, 120, 120] {
						try? await Task.sleep(for: .milliseconds(delay))
						proxy.scrollTo(id, anchor: .center)
					}
					flash = id
					try? await Task.sleep(for: .seconds(1.6))
					if flash == id { withAnimation { flash = nil } }
				}
			}
			.overlay(alignment: .bottomTrailing) {
				if !atBottom {
					Button {
						withAnimation { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
					} label: {
						Image(systemName: "arrow.down")
							.font(.body.weight(.semibold))
							.frame(width: 32, height: 32)
							.background(.regularMaterial, in: Circle())
							.overlay(Circle().strokeBorder(.separator))
					}
					.buttonStyle(.plain)
					.padding(14)
					.help("回到最新訊息")
				}
			}
		}
		.overlay {
			if !conversation.loadedInitial {
				if conversation.loading {
					ProgressView()
				} else if conversation.error != nil {
					Button("重試") { Task { await conversation.loadInitial() } }
				}
			} else if conversation.messages.isEmpty {
				ContentUnavailableView {
					Label("還沒有訊息", systemImage: "bubble.left.and.bubble.right")
				} description: {
					Text("LINE 只提供這台裝置最近 14 天的訊息。直接在下方輸入就能開始聊天。")
				}
			}
		}
	}

	@ViewBuilder
	private var header: some View {
		if conversation.hasOlder {
			ProgressView()
				.controlSize(.small)
				.frame(maxWidth: .infinity)
				.padding(10)
				.task(id: conversation.olderCursor) {
					await conversation.loadOlder()
				}
		} else if conversation.loadedInitial, !conversation.messages.isEmpty {
			Text(app.isArchived(chat.chatId) ? "封存從這裡開始" : "更早的訊息只在手機上（LINE 只提供這台裝置最近 14 天的訊息）")
				.font(.caption)
				.foregroundStyle(.tertiary)
				.frame(maxWidth: .infinity)
				.padding(12)
		}
	}
}

/// Slides the transcript left while a swipe shows message times.
private struct TimesShift<Content: View>: View {
	let swipe: SwipeModel
	@ViewBuilder let content: Content

	var body: some View {
		content.offset(x: -swipe.tracker.timesOffset)
	}
}

private struct TimeHeader: View {
	let date: Date

	var body: some View {
		Text("\(Text(Format.day(date)).fontWeight(.semibold)) \(Format.time(date))")
			.font(.caption)
			.foregroundStyle(.secondary)
			.frame(maxWidth: .infinity)
			.padding(.top, 14)
			.padding(.bottom, 4)
	}
}

private struct UnreadDivider: View {
	var body: some View {
		HStack(spacing: 10) {
			Rectangle().fill(Color.accentColor.opacity(0.5)).frame(height: 1)
			Text("以下為未讀訊息")
				.font(.caption.weight(.medium))
				.foregroundStyle(Color.accentColor)
				.fixedSize()
			Rectangle().fill(Color.accentColor.opacity(0.5)).frame(height: 1)
		}
		.padding(.vertical, 10)
	}
}
