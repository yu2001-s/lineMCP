import Foundation

/// The owner's own arrangement of chats: named groups shown as sidebar
/// sections, chats hidden everywhere (list, search, Dock badge,
/// notifications) until unhidden in Settings, and any number of tags per
/// chat. Groups and hidden chats are mirrored to the server so the MCP tools
/// see them too; which groups are collapsed stays on this Mac.
///
/// Tags live on the server, which agents change too. This Mac keeps the
/// server's last copy and the changes it made that the server has not
/// confirmed yet (`pendingTagOps`), and shows the one with the other on top.
@MainActor
@Observable
final class Organizer {
	struct Group: Codable, Identifiable, Hashable {
		var id: UUID
		var name: String
	}

	private(set) var groups: [Group] = []
	/// chatId → group id.
	private(set) var membership: [String: UUID] = [:]
	/// chatId → chat name at the time it was hidden, for the Settings list.
	private(set) var hidden: [String: String] = [:]
	private(set) var collapsed: Set<UUID> = []
	/// This Mac has merged its groups with the server's once.
	private(set) var synced = false
	/// Changes made here that the server does not have yet.
	private(set) var dirty = false
	/// The server revision whose agent changes to groups and hidden chats this
	/// Mac has. Sent with a save, so the server adds the ones made after it.
	private(set) var foldersRev = 0
	/// Called after a change the server should get.
	@ObservationIgnored var onChange: (() -> Void)?

	/// chatId → tags as shown: the server's copy with `pendingTagOps` on top.
	private(set) var tags: [String: [String]] = [:]
	/// Tag changes made here that the server has not confirmed, oldest first.
	private(set) var pendingTagOps: [TagOp] = []
	private var serverTags: [String: [String]] = [:]
	/// The newest server copy applied, so one arriving late is ignored.
	@ObservationIgnored private var tagsRev = 0
	/// Called after a tag change the server should get.
	@ObservationIgnored var onTagChange: (() -> Void)?

	private let defaults: UserDefaults
	private static let key = "organizer"

	private struct Stored: Codable {
		var groups: [Group]
		var membership: [String: UUID]
		var hidden: [String: String]
		var collapsed: Set<UUID>
		var synced: Bool?
		var dirty: Bool?
		var serverTags: [String: [String]]?
		var pendingTagOps: [TagOp]?
		var foldersRev: Int?
	}

	init(defaults: UserDefaults = .standard) {
		self.defaults = defaults
		if let data = defaults.data(forKey: Self.key), let stored = try? JSONDecoder().decode(Stored.self, from: data) {
			groups = stored.groups
			membership = stored.membership.filter { _, id in stored.groups.contains { $0.id == id } }
			hidden = stored.hidden
			collapsed = stored.collapsed
			synced = stored.synced ?? false
			dirty = stored.dirty ?? false
			serverTags = stored.serverTags ?? [:]
			pendingTagOps = stored.pendingTagOps ?? []
			foldersRev = stored.foldersRev ?? 0
			showTags()
		}
	}

	func group(of chatId: String) -> Group? {
		membership[chatId].flatMap { id in groups.first { $0.id == id } }
	}

	func isHidden(_ chatId: String) -> Bool {
		hidden[chatId] != nil
	}

	// MARK: Groups

	@discardableResult
	func addGroup(named name: String) -> Group? {
		let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return nil }
		let group = Group(id: UUID(), name: trimmed)
		groups.append(group)
		changed()
		return group
	}

	func rename(_ id: UUID, to name: String) {
		let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty, let i = groups.firstIndex(where: { $0.id == id }) else { return }
		groups[i].name = trimmed
		changed()
	}

	/// Deletes the group; its chats go back to the ungrouped list.
	func delete(_ id: UUID) {
		groups.removeAll { $0.id == id }
		membership = membership.filter { $0.value != id }
		collapsed.remove(id)
		changed()
	}

	func move(_ id: UUID, by offset: Int) {
		guard let i = groups.firstIndex(where: { $0.id == id }) else { return }
		let j = min(max(i + offset, 0), groups.count - 1)
		guard i != j else { return }
		groups.swapAt(i, j)
		changed()
	}

	func moveGroups(from source: IndexSet, to destination: Int) {
		groups.move(fromOffsets: source, toOffset: destination)
		changed()
	}

	/// Puts a chat in a group, or takes it out with `nil`.
	func assign(_ chatId: String, to groupId: UUID?) {
		if let groupId, groups.contains(where: { $0.id == groupId }) {
			membership[chatId] = groupId
		} else {
			membership[chatId] = nil
		}
		changed()
	}

	func setCollapsed(_ id: UUID, _ isCollapsed: Bool) {
		if isCollapsed { collapsed.insert(id) } else { collapsed.remove(id) }
		save()
	}

	// MARK: Hidden chats

	func hide(_ chatId: String, name: String) {
		hidden[chatId] = name
		changed()
	}

	func unhide(_ chatId: String) {
		hidden[chatId] = nil
		changed()
	}

	// MARK: Tags

	func tags(of chatId: String) -> [String] {
		tags[chatId] ?? []
	}

	/// Every tag some chat has, sorted.
	var allTags: [String] {
		Set(tags.values.joined()).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
	}

	/// How many chats have each tag.
	var tagCounts: [String: Int] {
		tags.values.joined().reduce(into: [:]) { $0[$1, default: 0] += 1 }
	}

	/// Whether a chat has any of `filter`'s tags, or all of them.
	func matches(_ chatId: String, tags filter: Set<String>, all: Bool) -> Bool {
		let mine = Set(tags(of: chatId))
		return all ? filter.isSubset(of: mine) : !filter.isDisjoint(with: mine)
	}

	func addTags(_ names: [String], to chatIds: [String]) {
		let names = names.map(Self.tagName).filter { !$0.isEmpty }
		guard !names.isEmpty, !chatIds.isEmpty else { return }
		record(TagOp(op: .add, tags: names, chatIds: chatIds))
	}

	func removeTags(_ names: [String], from chatIds: [String]) {
		guard !names.isEmpty, !chatIds.isEmpty else { return }
		record(TagOp(op: .remove, tags: names, chatIds: chatIds))
	}

	/// Renames a tag on every chat; renaming to another tag merges the two.
	func renameTag(_ name: String, to newName: String) {
		let newName = Self.tagName(newName)
		guard !newName.isEmpty, newName != name else { return }
		record(TagOp(op: .rename, tags: [name], to: newName))
	}

	/// Takes a tag off every chat.
	func deleteTag(_ name: String) {
		record(TagOp(op: .delete, tags: [name]))
	}

	/// The server's tags, from any copy it sent. A server older than tags sends none.
	func receiveTags(_ state: OrganizerState) {
		guard adopt(state) else { return }
		showTags()
		save()
	}

	/// The server applied these changes; `state` is its copy afterwards.
	func tagOpsSaved(_ ids: Set<UUID>, state: OrganizerState) {
		pendingTagOps.removeAll { ids.contains($0.id) }
		adopt(state)
		showTags()
		save()
	}

	/// The server refused these changes; they will not be sent again.
	func dropTagOps(_ ids: Set<UUID>) {
		pendingTagOps.removeAll { ids.contains($0.id) }
		showTags()
		save()
	}

	/// Trimmed, with runs of spaces and line breaks made one space, as the server stores it.
	static func tagName(_ raw: String) -> String {
		raw.split(whereSeparator: \.isWhitespace).joined(separator: " ")
	}

	/// Takes the server's tags unless a newer copy already arrived.
	@discardableResult
	private func adopt(_ state: OrganizerState) -> Bool {
		let rev = state.rev ?? 0
		guard rev >= tagsRev else { return false }
		tagsRev = rev
		serverTags = Dictionary((state.tags ?? []).map { ($0.chatId, $0.tags) }, uniquingKeysWith: { first, _ in first })
		return true
	}

	private func record(_ op: TagOp) {
		pendingTagOps.append(op)
		showTags()
		save()
		onTagChange?()
	}

	private func showTags() {
		var shown = serverTags
		for op in pendingTagOps { op.apply(to: &shown) }
		if shown != tags { tags = shown }
	}

	// MARK: Server copy

	/// Groups and hidden chats as the server stores them.
	var shared: OrganizerState {
		OrganizerState(
			folders: groups.map { group in
				.init(id: group.id, name: group.name, chatIds: membership.filter { $0.value == group.id }.keys.sorted())
			},
			hidden: hidden.map { .init(chatId: $0.key, name: $0.value) }.sorted { $0.chatId < $1.chatId },
		)
	}

	/// Brings this Mac and the server's copy together after connecting, and
	/// returns what to send the server, if anything. The first time, both
	/// sides are kept; after that, changes made here while offline win (the
	/// server adds agents' changes back on top), and otherwise the server's
	/// copy (from another Mac or an agent) replaces this one.
	func reconcile(with server: OrganizerState) -> OrganizerState? {
		if !synced {
			apply(Self.merged(local: shared, server: server))
			foldersRev = server.rev ?? 0
			let merged = shared
			dirty = !merged.sameContent(as: server)
			save()
			return dirty ? merged : nil
		}
		if dirty { return shared }
		apply(server)
		return nil
	}

	/// The server saved `sent` and now has `server`: the same, plus any agent
	/// changes this Mac had not seen. Changes made here since keep it dirty.
	func markSaved(_ sent: OrganizerState, server: OrganizerState) {
		guard dirty, shared.sameContent(as: sent) else { return }
		dirty = false
		apply(server)
	}

	/// Replaces groups and hidden chats with the server's.
	private func apply(_ state: OrganizerState) {
		synced = true
		if let rev = state.rev { foldersRev = rev }
		guard !state.sameContent(as: shared) else { return save() }
		groups = state.folders.map { Group(id: $0.id, name: $0.name) }
		membership = Dictionary(state.folders.flatMap { folder in folder.chatIds.map { ($0, folder.id) } }, uniquingKeysWith: { first, _ in first })
		hidden = Dictionary(state.hidden.map { ($0.chatId, $0.name) }, uniquingKeysWith: { first, _ in first })
		collapsed = collapsed.filter { id in groups.contains { $0.id == id } }
		save()
	}

	/// Both sides' groups, matched by name; a chat already filed on the server stays there.
	static func merged(local: OrganizerState, server: OrganizerState) -> OrganizerState {
		var folders = server.folders
		var filed = Set(folders.flatMap(\.chatIds))
		for folder in local.folders {
			let index = folders.firstIndex { $0.name.compare(folder.name, options: [.caseInsensitive, .widthInsensitive]) == .orderedSame }
				?? { folders.append(.init(id: folder.id, name: folder.name, chatIds: [])); return folders.count - 1 }()
			let added = folder.chatIds.filter { !filed.contains($0) }
			folders[index].chatIds += added
			filed.formUnion(added)
		}
		let serverHidden = Set(server.hidden.map(\.chatId))
		return OrganizerState(folders: folders, hidden: server.hidden + local.hidden.filter { !serverHidden.contains($0.chatId) })
	}

	private func changed() {
		dirty = true
		save()
		onChange?()
	}

	private func save() {
		let stored = Stored(
			groups: groups, membership: membership, hidden: hidden, collapsed: collapsed, synced: synced, dirty: dirty,
			serverTags: serverTags, pendingTagOps: pendingTagOps, foldersRev: foldersRev,
		)
		if let data = try? JSONEncoder().encode(stored) { defaults.set(data, forKey: Self.key) }
	}
}

extension TagOp {
	/// Applies this change to chatId → tags the way the server does: names
	/// that differ only in case, width or Traditional/Simplified Chinese are
	/// the same tag, spelled as it first was.
	func apply(to chats: inout [String: [String]]) {
		var spelling: [String: String] = [:]
		for name in chats.values.joined() where spelling[TextFold.fold(name)] == nil {
			spelling[TextFold.fold(name)] = name
		}
		func spelled(_ name: String) -> String {
			let fold = TextFold.fold(name)
			if let existing = spelling[fold] { return existing }
			spelling[fold] = name
			return name
		}
		func set(_ chatId: String, _ list: [String]) {
			var seen = Set<String>()
			let unique = list.filter { seen.insert(TextFold.fold($0)).inserted }
			chats[chatId] = unique.isEmpty ? nil : unique.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
		}
		let folds = Set(tags.map(TextFold.fold))
		let named = { (tag: String) in folds.contains(TextFold.fold(tag)) }
		switch op {
		case .add:
			let names = tags.map(spelled)
			for id in chatIds ?? [] { set(id, (chats[id] ?? []) + names) }
		case .remove:
			for id in chatIds ?? [] { set(id, (chats[id] ?? []).filter { !named($0) }) }
		case .rename:
			guard let from = tags.first, let to else { return }
			// Renaming to another spelling of itself respells it; to another tag, merges into it.
			let target = TextFold.fold(to) == TextFold.fold(from) ? to : spelled(to)
			for (id, list) in chats where list.contains(where: named) {
				set(id, list.filter { !named($0) } + [target])
			}
		case .delete:
			for (id, list) in chats where list.contains(where: named) {
				set(id, list.filter { !named($0) })
			}
		}
	}
}
