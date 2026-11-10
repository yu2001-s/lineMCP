import Foundation

/// The owner's own arrangement of chats: chats hidden everywhere (list,
/// search, Dock badge, notifications) until unhidden in Settings, and any
/// number of tags per chat, by which the sidebar shows chats. Hidden chats
/// are mirrored to the server so the MCP tools see them too.
///
/// Tags live on the server, which agents change too. This Mac keeps the
/// server's last copy and the changes it made that the server has not
/// confirmed yet (`pendingTagOps`), and shows the one with the other on top.
@MainActor
@Observable
final class Organizer {
	/// chatId → chat name at the time it was hidden, for the Settings list.
	private(set) var hidden: [String: String] = [:]
	/// This Mac has merged its hidden chats with the server's once.
	private(set) var synced = false
	/// Changes made here that the server does not have yet.
	private(set) var dirty = false
	/// The server revision whose agent hides this Mac has. Sent with a save,
	/// so the server adds the ones made after it.
	private(set) var hiddenRev = 0
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
		var hidden: [String: String]
		var synced: Bool?
		var dirty: Bool?
		var serverTags: [String: [String]]?
		var pendingTagOps: [TagOp]?
		/// Called foldersRev by builds that had groups.
		var foldersRev: Int?
		/// Builds before tags replaced groups (群組) kept these; each group
		/// becomes a tag of the same name on its chats.
		var groups: [LegacyGroup]?
		var membership: [String: UUID]?
	}

	private struct LegacyGroup: Codable {
		var id: UUID
		var name: String
	}

	init(defaults: UserDefaults = .standard) {
		self.defaults = defaults
		if let data = defaults.data(forKey: Self.key), let stored = try? JSONDecoder().decode(Stored.self, from: data) {
			hidden = stored.hidden
			synced = stored.synced ?? false
			dirty = stored.dirty ?? false
			serverTags = stored.serverTags ?? [:]
			pendingTagOps = stored.pendingTagOps ?? []
			hiddenRev = stored.foldersRev ?? 0
			if let groups = stored.groups {
				pendingTagOps += Self.tagOps(groups: groups, membership: stored.membership ?? [:])
				save()
			}
			showTags()
		}
	}

	/// An "add" per group with chats, so the server gives them the group's name as a tag.
	private static func tagOps(groups: [LegacyGroup], membership: [String: UUID]) -> [TagOp] {
		groups.compactMap { group in
			let chats = membership.filter { $0.value == group.id }.keys.sorted()
			let name = tagName(group.name)
			return chats.isEmpty || name.isEmpty ? nil : TagOp(op: .add, tags: [String(name.prefix(40))], chatIds: chats)
		}
	}

	func isHidden(_ chatId: String) -> Bool {
		hidden[chatId] != nil
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

	/// Hidden chats as the server stores them.
	var shared: OrganizerState {
		OrganizerState(hidden: hidden.map { .init(chatId: $0.key, name: $0.value) }.sorted { $0.chatId < $1.chatId })
	}

	/// Brings this Mac and the server's copy together after connecting, and
	/// returns what to send the server, if anything. The first time, both
	/// sides are kept; after that, changes made here while offline win (the
	/// server adds agents' hides back on top), and otherwise the server's
	/// copy (from another Mac or an agent) replaces this one.
	func reconcile(with server: OrganizerState) -> OrganizerState? {
		if !synced {
			apply(Self.merged(local: shared, server: server))
			hiddenRev = server.rev ?? 0
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
	/// hides this Mac had not seen. Changes made here since keep it dirty.
	func markSaved(_ sent: OrganizerState, server: OrganizerState) {
		guard dirty, shared.sameContent(as: sent) else { return }
		dirty = false
		apply(server)
	}

	/// Replaces hidden chats with the server's.
	private func apply(_ state: OrganizerState) {
		synced = true
		if let rev = state.rev { hiddenRev = rev }
		guard !state.sameContent(as: shared) else { return save() }
		hidden = Dictionary(state.hidden.map { ($0.chatId, $0.name) }, uniquingKeysWith: { first, _ in first })
		save()
	}

	/// Both sides' hidden chats.
	static func merged(local: OrganizerState, server: OrganizerState) -> OrganizerState {
		let serverHidden = Set(server.hidden.map(\.chatId))
		return OrganizerState(hidden: server.hidden + local.hidden.filter { !serverHidden.contains($0.chatId) })
	}

	private func changed() {
		dirty = true
		save()
		onChange?()
	}

	private func save() {
		let stored = Stored(
			hidden: hidden, synced: synced, dirty: dirty,
			serverTags: serverTags, pendingTagOps: pendingTagOps, foldersRev: hiddenRev,
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
