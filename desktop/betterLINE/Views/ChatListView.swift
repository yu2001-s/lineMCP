import SwiftUI

struct ChatListView: View {
	@Environment(AppModel.self) private var app
	@State private var query = ""
	@State private var hits: [SearchHit] = []
	@State private var searching = false
	@State private var searchError: String?
	@FocusState private var searchFocused: Bool

	private var isSearching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

	var body: some View {
		@Bindable var app = app
		List(selection: $app.selectedChatId) {
			if isSearching {
				searchResults
			} else {
				sections
			}
		}
		.listStyle(.sidebar)
		.searchable(text: $query, placement: .sidebar, prompt: "搜尋")
		.searchFocused($searchFocused)
		.onChange(of: app.searchRequests) { searchFocused = true }
		.task(id: query) { await search() }
		.safeAreaInset(edge: .top, spacing: 0) {
			VStack(spacing: 0) {
				StatusStrip()
				if !isSearching { TagFilterStrip() }
			}
		}
		.overlay { placeholder }
		.toolbar {
			ToolbarItem {
				tagFilterMenu
			}
			ToolbarItem {
				Button {
					app.showingNewChat = true
				} label: {
					Label("新聊天", systemImage: "square.and.pencil")
				}
				.help("新聊天 (⌘N)")
			}
		}
	}

	// MARK: Sections

	@ViewBuilder
	private var sections: some View {
		let sections = app.sidebarSections
		let hasGroups = sections.contains { $0.group != nil }
		ForEach(sections) { section in
			if let group = section.group {
				Section(isExpanded: expanded(group)) {
					if section.chats.isEmpty, section.archived.isEmpty {
						Text("在聊天室上按右鍵，選「移到群組」")
							.font(.caption)
							.foregroundStyle(.tertiary)
					}
					rows(section)
				} header: {
					GroupHeader(name: group.name, unread: section.unread, collapsed: app.organizer.collapsed.contains(group.id))
						.contextMenu { groupMenu(group) }
				}
			} else if section.id == "older" {
				Section("較早的聊天（僅封存）") { rows(section) }
			} else if hasGroups {
				if !section.chats.isEmpty {
					Section("其他") { rows(section) }
				}
			} else {
				rows(section)
			}
		}
	}

	@ViewBuilder
	private func rows(_ section: SidebarSection) -> some View {
		ForEach(section.chats) { chat in
			ChatRow(chat: chat, tags: app.organizer.tags(of: chat.chatId))
				.tag(chat.chatId)
				.contextMenu { chatMenu(chat.chatId, unread: chat.unread) }
		}
		ForEach(section.archived) { archived in
			ArchivedChatRow(chat: archived)
				.tag(archived.chatId)
				.contextMenu { chatMenu(archived.chatId, unread: 0) }
		}
	}

	private func expanded(_ group: Organizer.Group) -> Binding<Bool> {
		Binding(
			get: { !app.organizer.collapsed.contains(group.id) },
			set: { app.organizer.setCollapsed(group.id, !$0) },
		)
	}

	// MARK: Menus

	private var tagFilterMenu: some View {
		@Bindable var app = app
		let filtering = !app.activeTagFilter.isEmpty
		return Menu {
			if app.organizer.allTags.isEmpty {
				Text("還沒有標籤。在聊天室上按右鍵，選「標籤」。")
			}
			ForEach(app.organizer.allTags, id: \.self) { tag in
				Toggle(tag, isOn: Binding(get: { app.tagFilter.contains(tag) }, set: { _ in app.toggleTagFilter(tag) }))
			}
			Divider()
			Picker("顯示", selection: $app.tagFilterMatchAll) {
				Text("有任一個選取標籤的聊天室").tag(false)
				Text("有所有選取標籤的聊天室").tag(true)
			}
			.pickerStyle(.inline)
			Button("顯示所有聊天室") { app.tagFilter = [] }
				.disabled(!filtering)
		} label: {
			Label("依標籤篩選", systemImage: filtering ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
		}
		.help("依標籤篩選聊天室")
	}

	private func chatMenu(_ chatId: String, unread: Int) -> some View {
		ChatActions(chatId: chatId, unread: unread)
	}

	@ViewBuilder
	private func groupMenu(_ group: Organizer.Group) -> some View {
		Button("重新命名…") { app.promptRename(group) }
		Button("上移") { app.organizer.move(group.id, by: -1) }
			.disabled(app.organizer.groups.first?.id == group.id)
		Button("下移") { app.organizer.move(group.id, by: 1) }
			.disabled(app.organizer.groups.last?.id == group.id)
		Divider()
		Button("刪除群組") { app.organizer.delete(group.id) }
	}

	// MARK: Search

	@ViewBuilder
	private var searchResults: some View {
		// Search looks through every chat, whatever the tag filter.
		let all = app.chats.filter { !app.organizer.isHidden($0.chatId) } + app.archiveOnlyChats.compactMap { app.chat($0.chatId) }
		let chats = all.filter { TextFold.matches($0.name, query: query) }
		let shown = Set(all.map(\.chatId))
		let people = app.contacts.filter {
			!shown.contains($0.id) && !app.organizer.isHidden($0.id) && TextFold.matches($0.name, query: query)
		}
		let messages = hits.filter { !app.organizer.isHidden($0.message.chatId) }

		Section("聊天") {
			if chats.isEmpty {
				Text("沒有符合的聊天").foregroundStyle(.secondary)
			}
			ForEach(chats) { chat in
				ChatRow(chat: chat, tags: app.organizer.tags(of: chat.chatId)).tag(chat.chatId)
			}
		}
		if !people.isEmpty {
			Section("聯絡人") {
				ForEach(people.prefix(50)) { contact in
					ContactRow(contact: contact).tag(contact.id)
				}
			}
		}
		Section("封存的訊息") {
			if searching {
				ProgressView().controlSize(.small).frame(maxWidth: .infinity)
			} else if let searchError {
				Text(searchError).foregroundStyle(.red)
			} else if messages.isEmpty {
				Text("沒有找到。只會搜尋已封存的聊天。").foregroundStyle(.secondary)
			}
			ForEach(messages) { hit in
				Button {
					app.open(hit)
				} label: {
					SearchHitRow(hit: hit)
				}
				.buttonStyle(.plain)
			}
		}
	}

	private func search() async {
		let q = query.trimmingCharacters(in: .whitespaces)
		guard !q.isEmpty, let api = app.api else {
			hits = []
			searchError = nil
			searching = false
			return
		}
		searching = true
		try? await Task.sleep(for: .milliseconds(300))
		guard !Task.isCancelled else { return }
		defer { searching = false }
		do {
			hits = try await api.search(q, limit: 100)
			searchError = nil
		} catch {
			if Task.isCancelled { return }
			hits = []
			searchError = error.userMessage
		}
	}

	@ViewBuilder
	private var placeholder: some View {
		if !app.chatsLoaded {
			if app.phase == .connecting || [.unknown, .starting, .ready].contains(app.sessionStatus) {
				ProgressView()
			}
		} else if app.chats.isEmpty, !isSearching {
			Text("最近 14 天沒有聊天").foregroundStyle(.secondary)
		} else if !isSearching, !app.activeTagFilter.isEmpty, app.sidebarSections.allSatisfy({ $0.chats.isEmpty && $0.archived.isEmpty }) {
			Text("沒有符合標籤的聊天室").foregroundStyle(.secondary)
		}
	}
}

private struct GroupHeader: View {
	let name: String
	let unread: Int
	let collapsed: Bool

	var body: some View {
		HStack {
			Text(name)
			if collapsed, unread > 0 {
				Spacer()
				Text(unread > 999 ? "999+" : String(unread))
					.font(.caption2.weight(.semibold).monospacedDigit())
					.foregroundStyle(.secondary)
			}
		}
	}
}

struct ChatRow: View {
	let chat: Chat
	var tags: [String] = []

	var body: some View {
		HStack(spacing: 10) {
			Avatar(name: chat.name, url: chat.picture, seed: chat.chatId, size: 40)
			VStack(alignment: .leading, spacing: 2) {
				HStack(alignment: .firstTextBaseline, spacing: 4) {
					Text(chat.name)
						.font(.body.weight(.semibold))
						.lineLimit(1)
					if chat.isMuted {
						Image(systemName: "bell.slash.fill")
							.font(.caption2)
							.foregroundStyle(.secondary)
					}
					Spacer(minLength: 4)
					if let last = chat.lastMessage {
						Text(Format.listTime(last.date))
							.font(.caption)
							.foregroundStyle(.secondary)
					}
				}
				HStack(alignment: .top, spacing: 4) {
					if chat.lastMessage?.local == .sending {
						Image(systemName: "clock").font(.caption2).foregroundStyle(.secondary)
					} else if case .failed = chat.lastMessage?.local {
						Image(systemName: "exclamationmark.circle.fill").font(.caption2).foregroundStyle(.red)
					}
					Text(preview)
						.font(.subheadline)
						.foregroundStyle(.secondary)
						.lineLimit(tags.isEmpty ? 2 : 1)
					Spacer(minLength: 4)
					if chat.unread > 0 {
						UnreadBadge(count: chat.unread, muted: chat.isMuted)
					}
				}
				if !tags.isEmpty {
					TagChips(tags: tags)
				}
			}
		}
		.padding(.vertical, 4)
	}

	private var preview: String {
		guard let last = chat.lastMessage else { return "" }
		let text = last.preview.replacingOccurrences(of: "\n", with: " ")
		if chat.type != .user, !last.mine, last.kind != .system {
			return "\(last.fromName)：\(text)"
		}
		return text
	}
}

struct UnreadBadge: View {
	let count: Int
	var muted = false

	var body: some View {
		Text(count > 999 ? "999+" : String(count))
			.font(.caption2.weight(.semibold).monospacedDigit())
			.foregroundStyle(.white)
			.padding(.horizontal, 6)
			.padding(.vertical, 1.5)
			.background(muted ? Color.gray : Color.accentColor, in: Capsule())
	}
}

private struct ArchivedChatRow: View {
	let chat: ArchivedChat

	@Environment(AppModel.self) private var app

	var body: some View {
		HStack(spacing: 10) {
			Avatar(name: chat.name, url: app.chat(chat.chatId)?.picture, seed: chat.chatId, size: 40)
			VStack(alignment: .leading, spacing: 2) {
				HStack(alignment: .firstTextBaseline) {
					Text(chat.name).font(.body.weight(.semibold)).lineLimit(1)
					Spacer(minLength: 4)
					if let newest = chat.newest {
						Text(Format.listTime(Date(timeIntervalSince1970: Double(newest) / 1000)))
							.font(.caption)
							.foregroundStyle(.secondary)
					}
				}
				Label("\(chat.messages) 則已封存的訊息", systemImage: "archivebox")
					.font(.subheadline)
					.foregroundStyle(.secondary)
					.labelStyle(.titleAndIcon)
				let tags = app.organizer.tags(of: chat.chatId)
				if !tags.isEmpty {
					TagChips(tags: tags)
				}
			}
		}
		.padding(.vertical, 4)
	}
}

struct ContactRow: View {
	let contact: Contact

	var body: some View {
		HStack(spacing: 10) {
			Avatar(name: contact.name, url: contact.picture, seed: contact.id, size: 32)
			VStack(alignment: .leading, spacing: 1) {
				Text(contact.name).lineLimit(1)
				Text(contact.type == .user ? "好友" : "群組")
					.font(.caption)
					.foregroundStyle(.secondary)
			}
		}
		.padding(.vertical, 2)
	}
}

private struct SearchHitRow: View {
	let hit: SearchHit

	var body: some View {
		VStack(alignment: .leading, spacing: 2) {
			HStack {
				Text(hit.chatName ?? "聊天").font(.callout.weight(.semibold)).lineLimit(1)
				Spacer()
				Text(Format.listTime(hit.message.date)).font(.caption).foregroundStyle(.secondary)
			}
			Text(hit.message.mine ? "我：\(hit.message.preview)" : "\(hit.message.fromName)：\(hit.message.preview)")
				.font(.subheadline)
				.foregroundStyle(.secondary)
				.lineLimit(2)
		}
		.padding(.vertical, 3)
		.contentShape(Rectangle())
	}
}

/// The tags the list is limited to, above it; clicking one drops it.
private struct TagFilterStrip: View {
	@Environment(AppModel.self) private var app

	var body: some View {
		let tags = app.activeTagFilter.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
		if !tags.isEmpty {
			HStack(spacing: 6) {
				Image(systemName: "tag")
					.font(.caption)
					.foregroundStyle(.secondary)
				ScrollView(.horizontal, showsIndicators: false) {
					HStack(spacing: 4) {
						ForEach(tags, id: \.self) { tag in
							Button {
								app.toggleTagFilter(tag)
							} label: {
								TagChip(name: tag)
							}
							.buttonStyle(.plain)
							.help("不再依「\(tag)」篩選")
						}
						if tags.count > 1 {
							Text(app.tagFilterMatchAll ? "（全部符合）" : "（任一符合）")
								.font(.caption2)
								.foregroundStyle(.secondary)
						}
					}
				}
				Button {
					app.tagFilter = []
				} label: {
					Image(systemName: "xmark.circle.fill")
				}
				.buttonStyle(.plain)
				.foregroundStyle(.secondary)
				.help("顯示所有聊天室")
			}
			.padding(.horizontal, 12)
			.padding(.bottom, 6)
		}
	}
}

/// Connection and session problems, above the chat list.
private struct StatusStrip: View {
	@Environment(AppModel.self) private var app

	var body: some View {
		VStack(spacing: 6) {
			switch app.phase {
			case let .offline(reason):
				InfoStrip(text: "\(reason)，正在重新連線…", tone: .warning, systemImage: "wifi.exclamationmark")
			case .connecting where !app.chats.isEmpty:
				InfoStrip(text: "正在連線…", systemImage: "arrow.triangle.2.circlepath")
			default:
				EmptyView()
			}
			if app.sessionStatus == .loggedOut || app.sessionStatus == .error {
				InfoStrip(text: app.sessionStatus.label, tone: .error, systemImage: "person.crop.circle.badge.exclamationmark")
			}
			if let banner = app.banner, app.phase != .offline(banner) {
				InfoStrip(text: banner, tone: .warning, systemImage: "exclamationmark.triangle") {
					app.banner = nil
				}
			}
		}
		.padding(.horizontal, 10)
		.padding(.bottom, hasContent ? 6 : 0)
	}

	private var hasContent: Bool {
		if case .offline = app.phase { return true }
		return app.banner != nil || app.sessionStatus == .loggedOut || app.sessionStatus == .error
	}
}
