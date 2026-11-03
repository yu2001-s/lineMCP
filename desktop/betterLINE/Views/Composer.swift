import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct Composer: View {
	let chat: Chat
	@Bindable var conversation: Conversation

	@Environment(AppModel.self) private var app
	@State private var height: CGFloat = 20
	@State private var composing = false
	@State private var showStickers = false

	var body: some View {
		VStack(spacing: 0) {
			if let reply = conversation.replyTo {
				ReplyBar(message: reply) { conversation.replyTo = nil }
			}
			if !conversation.attachments.isEmpty {
				AttachmentTray(files: $conversation.attachments)
			}
			HStack(alignment: .bottom, spacing: 10) {
				Menu {
					Button("照片與檔案…", systemImage: "photo.on.rectangle") { pickFiles() }
					Button("貼圖", systemImage: "face.smiling") { showStickers = true }
				} label: {
					Image(systemName: "plus.circle.fill")
						.symbolRenderingMode(.hierarchical)
						.font(.system(size: 24))
						.foregroundStyle(.secondary)
				}
				.menuStyle(.button)
				.buttonStyle(.plain)
				.menuIndicator(.hidden)
				.fixedSize()
				.frame(height: 32)
				.help("加入照片、檔案或貼圖")
				.popover(isPresented: $showStickers, arrowEdge: .top) {
					StickerPicker { sticker in
						showStickers = false
						conversation.sendSticker(sticker)
					}
				}

				HStack(alignment: .bottom, spacing: 4) {
					ComposerTextView(
						text: $conversation.draft,
						height: $height,
						composing: $composing,
						sendOnEnter: app.prefs.sendOnEnter,
						focusKey: "\(chat.chatId)#\(conversation.composerFocusRequests)",
						onSubmit: { conversation.sendDraft() },
						onFiles: { conversation.attachments.append(contentsOf: $0) },
						onEscape: { conversation.replyTo = nil },
					)
					.frame(height: min(max(height, 20), 150))
					.overlay(alignment: .topLeading) {
						if conversation.draft.isEmpty, !composing {
							Text("訊息")
								.foregroundStyle(.tertiary)
								.padding(.leading, 5)
								.padding(.top, 1)
								.allowsHitTesting(false)
						}
					}
					if canSend {
						Button {
							conversation.sendDraft()
						} label: {
							Image(systemName: "arrow.up.circle.fill")
								.font(.system(size: 22))
								.foregroundStyle(Color.accentColor)
						}
						.buttonStyle(.plain)
						.help(app.prefs.sendOnEnter ? "傳送 (↩)" : "傳送 (⌘↩)")
						.transition(.scale.combined(with: .opacity))
					}
				}
				.padding(.leading, 10)
				.padding(.trailing, 4)
				.padding(.vertical, 4)
				.frame(minHeight: 32)
				.overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(.separator))
				.animation(.easeOut(duration: 0.15), value: canSend)
			}
			.padding(.horizontal, 12)
			.padding(.vertical, 10)
		}
	}

	private var canSend: Bool {
		!conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !conversation.attachments.isEmpty
	}

	private func pickFiles() {
		let panel = NSOpenPanel()
		panel.allowsMultipleSelection = true
		panel.canChooseDirectories = false
		panel.prompt = "加入"
		guard panel.runModal() == .OK else { return }
		conversation.attachments.append(contentsOf: panel.urls)
	}
}

private struct ReplyBar: View {
	let message: Message
	let onClose: () -> Void

	var body: some View {
		HStack(spacing: 8) {
			Image(systemName: "arrowshape.turn.up.left.fill").foregroundStyle(Color.accentColor)
			VStack(alignment: .leading, spacing: 1) {
				Text("回覆 \(message.mine ? "自己" : message.fromName)").font(.caption.weight(.semibold))
				Text(message.preview).font(.caption).foregroundStyle(.secondary).lineLimit(1)
			}
			Spacer()
			Button(action: onClose) {
				Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
			}
			.buttonStyle(.plain)
			.help("取消回覆 (esc)")
		}
		.padding(.horizontal, 14)
		.padding(.top, 8)
	}
}

private struct AttachmentTray: View {
	@Binding var files: [URL]

	var body: some View {
		ScrollView(.horizontal) {
			HStack(spacing: 8) {
				ForEach(Array(files.enumerated()), id: \.offset) { index, file in
					AttachmentChip(file: file) { files.remove(at: index) }
				}
			}
			.padding(.horizontal, 14)
			.padding(.top, 8)
		}
		.scrollIndicators(.never)
	}
}

private struct AttachmentChip: View {
	let file: URL
	let onRemove: () -> Void

	@State private var thumbnail: NSImage?

	var body: some View {
		HStack(spacing: 6) {
			Group {
				if let thumbnail {
					Image(nsImage: thumbnail).resizable().scaledToFill()
				} else {
					Image(nsImage: NSWorkspace.shared.icon(forFile: file.path)).resizable()
				}
			}
			.frame(width: 34, height: 34)
			.clipShape(RoundedRectangle(cornerRadius: 5))
			VStack(alignment: .leading, spacing: 1) {
				Text(file.lastPathComponent).font(.caption).lineLimit(1)
				Text(Format.bytes(Upload.size(of: file))).font(.caption2).foregroundStyle(.secondary)
			}
			.frame(maxWidth: 140, alignment: .leading)
			Button(action: onRemove) {
				Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
			}
			.buttonStyle(.plain)
		}
		.padding(5)
		.background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
		.task(id: file) {
			guard Upload.kind(of: file) == .image else { return }
			thumbnail = await ImagePipeline.shared.image(key: "file:\(file.path)", maxPixel: 96) { file }
		}
	}
}

private struct StickerPicker: View {
	let onPick: (Sticker) -> Void

	@Environment(AppModel.self) private var app

	var body: some View {
		if app.stickers.stickers.isEmpty {
			Text("聊天室中出現過的貼圖會顯示在這裡。")
				.foregroundStyle(.secondary)
				.padding(20)
				.frame(width: 280)
		} else {
			ScrollView {
				LazyVGrid(columns: Array(repeating: GridItem(.fixed(70), spacing: 6), count: 5), spacing: 6) {
					ForEach(app.stickers.stickers, id: \.stickerId) { sticker in
						Button {
							onPick(sticker)
						} label: {
							RemoteImage(url: sticker.staticURL, maxPixel: 140)
								.frame(width: 64, height: 64)
								.padding(3)
								.contentShape(Rectangle())
						}
						.buttonStyle(.plain)
					}
				}
				.padding(10)
			}
			.frame(width: 400, height: min(330, CGFloat((app.stickers.stickers.count + 4) / 5) * 76 + 20))
		}
	}
}

/// NSTextView-backed input: Return sends unless an input method is composing
/// (pinyin, zhuyin), pastes and drops of files and images become attachments.
struct ComposerTextView: NSViewRepresentable {
	@Binding var text: String
	@Binding var height: CGFloat
	@Binding var composing: Bool
	var sendOnEnter: Bool
	var focusKey: String
	var onSubmit: () -> Void
	var onFiles: ([URL]) -> Void
	var onEscape: () -> Void

	func makeCoordinator() -> Coordinator { Coordinator(self) }

	func makeNSView(context: Context) -> NSScrollView {
		let scroll = NSScrollView()
		scroll.drawsBackground = false
		scroll.hasVerticalScroller = true
		scroll.autohidesScrollers = true
		scroll.borderType = .noBorder

		let textView = InputTextView()
		textView.delegate = context.coordinator
		textView.coordinator = context.coordinator
		textView.isRichText = false
		textView.importsGraphics = false
		textView.allowsUndo = true
		textView.font = .systemFont(ofSize: 14)
		textView.textColor = .labelColor
		textView.drawsBackground = false
		textView.textContainerInset = NSSize(width: 0, height: 1)
		textView.textContainer?.lineFragmentPadding = 4
		textView.isAutomaticQuoteSubstitutionEnabled = false
		textView.isAutomaticDashSubstitutionEnabled = false
		textView.isVerticallyResizable = true
		textView.isHorizontallyResizable = false
		textView.autoresizingMask = [.width]
		textView.textContainer?.widthTracksTextView = true
		textView.string = text
		scroll.documentView = textView
		return scroll
	}

	func updateNSView(_ scroll: NSScrollView, context: Context) {
		context.coordinator.parent = self
		guard let textView = scroll.documentView as? InputTextView else { return }
		if textView.string != text, !textView.hasMarkedText() {
			textView.string = text
			context.coordinator.updateHeight(textView)
		}
		if context.coordinator.focusedKey != focusKey {
			context.coordinator.focusedKey = focusKey
			DispatchQueue.main.async { textView.window?.makeFirstResponder(textView) }
		}
	}

	@MainActor
	final class Coordinator: NSObject, NSTextViewDelegate {
		var parent: ComposerTextView
		var focusedKey: String?

		init(_ parent: ComposerTextView) {
			self.parent = parent
		}

		func textDidChange(_ notification: Notification) {
			guard let textView = notification.object as? NSTextView else { return }
			parent.text = textView.string
			markedTextDidChange(textView)
			updateHeight(textView)
		}

		/// NSTextView posts no textDidChange while an input method composes
		/// (zhuyin, pinyin), so InputTextView reports its marked text here and
		/// the placeholder hides under the first keystroke. It leaves layout
		/// alone: the first touch of layoutManager moves the view off TextKit 2,
		/// and doing that mid-composition drops the marked text, so committing
		/// appends the candidate to the zhuyin instead of replacing it.
		func markedTextDidChange(_ textView: NSTextView) {
			let composing = textView.hasMarkedText()
			if parent.composing != composing { parent.composing = composing }
		}

		func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
			switch selector {
			case #selector(NSResponder.insertNewline(_:)):
				let flags = NSApp.currentEvent?.modifierFlags ?? []
				let modified = flags.contains(.shift) || flags.contains(.option)
				if parent.sendOnEnter, !modified {
					parent.onSubmit()
					return true
				}
				if parent.sendOnEnter || !flags.contains(.command) {
					textView.insertNewlineIgnoringFieldEditor(nil)
					return true
				}
				parent.onSubmit()
				return true
			case #selector(NSResponder.cancelOperation(_:)):
				parent.onEscape()
				return true
			default:
				return false
			}
		}

		func updateHeight(_ textView: NSTextView) {
			guard let layout = textView.layoutManager, let container = textView.textContainer else { return }
			layout.ensureLayout(for: container)
			let height = ceil(layout.usedRect(for: container).height + textView.textContainerInset.height * 2)
			if abs(height - parent.height) > 0.5 {
				DispatchQueue.main.async { self.parent.height = height }
			}
		}
	}
}

final class InputTextView: NSTextView {
	weak var coordinator: ComposerTextView.Coordinator?
	/// The clipboard; tests substitute a private one.
	var pasteboard: NSPasteboard = .general

	override func keyDown(with event: NSEvent) {
		// ⌘↩ sends when Return inserts newlines.
		if event.keyCode == 36, event.modifierFlags.contains(.command), !hasMarkedText() {
			coordinator?.parent.onSubmit()
			return
		}
		super.keyDown(with: event)
	}

	override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
		super.setMarkedText(string, selectedRange: selectedRange, replacementRange: replacementRange)
		coordinator?.markedTextDidChange(self)
	}

	override func unmarkText() {
		super.unmarkText()
		coordinator?.markedTextDidChange(self)
	}

	override func paste(_ sender: Any?) {
		if let files = Clipboard.attachments(from: pasteboard) {
			coordinator?.parent.onFiles(files)
			return
		}
		pasteAsPlainText(sender)
	}

	// A plain-text view greys out Paste when the clipboard holds only an image,
	// so ⌘V would never reach paste(_:).
	override func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
		if menuItem.action == #selector(paste(_:)), Clipboard.hasAttachment(pasteboard) { return true }
		return super.validateMenuItem(menuItem)
	}

	override func validateUserInterfaceItem(_ item: any NSValidatedUserInterfaceItem) -> Bool {
		if item.action == #selector(paste(_:)), Clipboard.hasAttachment(pasteboard) { return true }
		return super.validateUserInterfaceItem(item)
	}

	override var acceptableDragTypes: [NSPasteboard.PasteboardType] {
		super.acceptableDragTypes + [.fileURL] + Clipboard.imageTypes
	}

	override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
		if let files = Clipboard.attachments(from: sender.draggingPasteboard) {
			coordinator?.parent.onFiles(files)
			return true
		}
		return super.performDragOperation(sender)
	}
}
