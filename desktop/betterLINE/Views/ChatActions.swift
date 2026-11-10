import SwiftUI

/// Organizing actions for one chat, shared by the sidebar's context menu and
/// the conversation's "more" menu.
struct ChatActions: View {
	let chatId: String
	var unread = 0

	@Environment(AppModel.self) private var app

	var body: some View {
		if unread > 0 {
			Button("標示為已讀") { app.markRead(chatId, force: true) }
		}
		Menu("標籤") {
			let mine = app.organizer.tags(of: chatId)
			ForEach(app.organizer.allTags, id: \.self) { tag in
				Toggle(tag, isOn: Binding(
					get: { mine.contains(tag) },
					set: { on in
						if on { app.organizer.addTags([tag], to: [chatId]) } else { app.organizer.removeTags([tag], from: [chatId]) }
					},
				))
			}
			if !app.organizer.allTags.isEmpty { Divider() }
			Button("新增標籤…") { app.promptNewTag(for: chatId) }
			if !mine.isEmpty {
				Button("移除所有標籤") { app.organizer.removeTags(mine, from: [chatId]) }
			}
		}
		Divider()
		Button("隱藏聊天室") { app.hide(chatId) }
	}
}

extension View {
	/// The tag name sheet, driven by `AppModel.tagPrompt`.
	func tagPrompt(_ app: AppModel) -> some View {
		sheet(isPresented: Binding(get: { app.tagPrompt != nil }, set: { if !$0 { app.tagPrompt = nil } })) {
			TagNameSheet()
		}
	}
}

private struct TagNameSheet: View {
	@Environment(AppModel.self) private var app
	@FocusState private var focused: Bool

	private static let maxLength = 40

	var body: some View {
		@Bindable var app = app
		VStack(alignment: .leading, spacing: 12) {
			Text(title).font(.headline)
			TextField("標籤", text: $app.tagNameDraft, prompt: Text("例如：Work、讀書會"))
				.textFieldStyle(.roundedBorder)
				.focused($focused)
				.onSubmit { if canSave { app.commitTagPrompt() } }
			if case let .add(chatId) = app.tagPrompt, !suggestions(for: chatId).isEmpty {
				ScrollView(.horizontal, showsIndicators: false) {
					HStack(spacing: 6) {
						ForEach(suggestions(for: chatId), id: \.self) { tag in
							Button {
								app.organizer.addTags([tag], to: [chatId])
								app.tagPrompt = nil
							} label: {
								TagChip(name: tag)
							}
							.buttonStyle(.plain)
							.help("加上「\(tag)」")
						}
					}
				}
			}
			Text(note)
				.font(.callout)
				.foregroundStyle(.secondary)
			HStack {
				Spacer()
				Button("取消", role: .cancel) { app.tagPrompt = nil }
					.keyboardShortcut(.cancelAction)
				Button(isRename ? "儲存" : "加上") { app.commitTagPrompt() }
					.keyboardShortcut(.defaultAction)
					.disabled(!canSave)
			}
		}
		.padding(20)
		.frame(width: 360)
		.onAppear { focused = true }
	}

	private var isRename: Bool {
		if case .rename = app.tagPrompt { return true }
		return false
	}

	private var title: String {
		switch app.tagPrompt {
		case let .add(chatId): "為「\(app.name(of: chatId))」加上標籤"
		case let .rename(name): "重新命名標籤「\(name)」"
		case nil: ""
		}
	}

	private var note: String {
		if isRename { return "所有有這個標籤的聊天室都會改用新名稱；改成已有的標籤會合併兩者。" }
		return "一個聊天室可以有多個標籤。標籤存在伺服器上，其他 Mac 和 Claude（LINE connector）也看得到。"
	}

	/// Existing tags the chat does not have yet, narrowed by what is typed.
	private func suggestions(for chatId: String) -> [String] {
		let mine = Set(app.organizer.tags(of: chatId))
		return app.organizer.allTags.filter { !mine.contains($0) && TextFold.matches($0, query: app.tagNameDraft) }
	}

	private var canSave: Bool {
		let name = Organizer.tagName(app.tagNameDraft)
		return !name.isEmpty && name.count <= Self.maxLength
	}
}

/// A tag, tinted by its name.
struct TagChip: View {
	let name: String

	var body: some View {
		let color = Avatar.color(for: name)
		Text(name)
			.font(.caption2.weight(.medium))
			.lineLimit(1)
			.foregroundStyle(color)
			.padding(.horizontal, 5)
			.padding(.vertical, 1)
			.background(color.opacity(0.15), in: Capsule())
	}
}

/// A chat's tags under its name in the list: the first few, then how many more.
struct TagChips: View {
	let tags: [String]
	var limit = 3

	var body: some View {
		HStack(spacing: 4) {
			ForEach(tags.prefix(limit), id: \.self) { TagChip(name: $0) }
			if tags.count > limit {
				Text("+\(tags.count - limit)")
					.font(.caption2)
					.foregroundStyle(.secondary)
			}
		}
	}
}
