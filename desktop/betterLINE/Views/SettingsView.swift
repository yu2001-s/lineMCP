import SwiftUI

struct SettingsView: View {
	var body: some View {
		TabView {
			GeneralSettings()
				.tabItem { Label("一般", systemImage: "gearshape") }
			ChatsSettings()
				.tabItem { Label("聊天室", systemImage: "bubble.left.and.bubble.right") }
			ServerSettings()
				.tabItem { Label("伺服器", systemImage: "server.rack") }
			ArchiveSettings()
				.tabItem { Label("封存", systemImage: "archivebox") }
		}
		.frame(width: 580)
	}
}

private struct GeneralSettings: View {
	@Environment(AppModel.self) private var app
	@State private var cacheSize: Int64?

	var body: some View {
		@Bindable var prefs = app.prefs
		Form {
			Section("輸入") {
				Picker("傳送訊息", selection: $prefs.sendOnEnter) {
					Text("↩ 傳送，⇧↩ 換行").tag(true)
					Text("⌘↩ 傳送，↩ 換行").tag(false)
				}
			}
			Section {
				Toggle("打開聊天室時自動標示為已讀", isOn: $prefs.autoMarkRead)
			} header: {
				Text("已讀")
			} footer: {
				Text("開啟時，正在查看的聊天室會傳送已讀回條給對方，就像手機上的 LINE。關閉後可以用 ⇧⌘R 手動標示為已讀。")
			}
			Section("通知") {
				Toggle("新訊息通知", isOn: $prefs.notifications)
					.onChange(of: prefs.notifications) {
						if prefs.notifications { app.notifier.requestAuthorization() }
					}
				Toggle("在通知中顯示訊息內容", isOn: $prefs.notificationPreview)
					.disabled(!prefs.notifications)
			}
			Section {
				LabeledContent("媒體快取") {
					HStack {
						Text(cacheSize.map { Format.bytes($0) } ?? "…").foregroundStyle(.secondary)
						Button("清除") {
							Task {
								await MediaStore.shared.clear()
								cacheSize = await MediaStore.shared.totalSize()
							}
						}
					}
				}
			} footer: {
				Text("解密後的照片、影片和檔案快取在 ~/Library/Caches，只有你的帳號能讀取，上限 2 GB。")
			}
		}
		.formStyle(.grouped)
		.frame(minHeight: 540)
		.task { cacheSize = await MediaStore.shared.totalSize() }
	}
}

/// Tags and hidden chats.
private struct ChatsSettings: View {
	@Environment(AppModel.self) private var app

	var body: some View {
		Form {
			Section {
				if app.organizer.allTags.isEmpty {
					Text("還沒有標籤。在側邊欄的聊天室上按右鍵，選「標籤」→「新增標籤…」。")
						.foregroundStyle(.secondary)
				}
				let counts = app.organizer.tagCounts
				ForEach(app.organizer.allTags, id: \.self) { tag in
					HStack {
						TagChip(name: tag)
						Spacer()
						Text("\(counts[tag] ?? 0) 個聊天室").foregroundStyle(.secondary)
						Button("重新命名…") { app.promptRenameTag(tag) }
						Button(role: .destructive) {
							app.organizer.deleteTag(tag)
						} label: {
							Image(systemName: "trash")
						}
						.help("從所有聊天室移除這個標籤")
					}
				}
			} header: {
				Text("標籤")
			} footer: {
				Text("一個聊天室可以有多個標籤，例如 Work 或所屬的公司。側邊欄上方會列出所有標籤，點一下就只顯示那個標籤的聊天室。標籤存在伺服器上，Claude 也能讀取和修改。")
			}
			Section {
				if app.organizer.hidden.isEmpty {
					Text("沒有隱藏的聊天室。").foregroundStyle(.secondary)
				}
				ForEach(app.organizer.hidden.sorted { $0.value.localizedStandardCompare($1.value) == .orderedAscending }, id: \.key) { chatId, name in
					HStack {
						Avatar(name: name, url: app.chat(chatId)?.picture, seed: chatId, size: 24)
						Text(name)
						Spacer()
						Button("打開") { app.open(chatId: chatId) }
						Button("取消隱藏") { app.unhide(chatId) }
					}
				}
			} header: {
				Text("已隱藏的聊天室")
			} footer: {
				Text("隱藏的聊天室不會出現在列表和搜尋中，不計入未讀數，也不會通知。")
			}
		}
		.formStyle(.grouped)
		.frame(minHeight: 460)
		.tagPrompt(app)
	}
}

private struct ServerSettings: View {
	@Environment(AppModel.self) private var app
	@State private var server = ""
	@State private var key = ""
	@State private var working = false
	@State private var message: (text: String, ok: Bool)?

	var body: some View {
		Form {
			Section {
				TextField("伺服器", text: $server, prompt: Text(Preferences.defaultServer))
				SecureField("用戶端金鑰", text: $key, prompt: Text("留空則保留目前的金鑰"))
				HStack {
					if let message {
						Label(message.text, systemImage: message.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
							.foregroundStyle(message.ok ? .green : .red)
					}
					Spacer()
					Button("儲存並連線") { Task { await save() } }
						.disabled(working)
				}
			} header: {
				Text("連線")
			} footer: {
				Text("金鑰儲存在登入鑰匙圈中。伺服器只在 Tailscale 位址上監聽。")
			}
			Section("狀態") {
				LabeledContent("伺服器連線", value: phaseLabel)
				LabeledContent("LINE 連線", value: app.sessionStatus.label)
				if let me = app.me {
					LabeledContent("帳號", value: me.name)
				}
			}
			Section {
				Button("忘記金鑰", role: .destructive) { app.signOut() }
			}
		}
		.formStyle(.grouped)
		.frame(minHeight: 460)
		.onAppear { server = app.prefs.serverURL }
	}

	private var phaseLabel: String {
		switch app.phase {
		case .setup: "尚未設定"
		case .connecting: "正在連線…"
		case .online: "已連線"
		case let .offline(reason): "已中斷：\(reason)"
		case .unauthorized: "金鑰遭拒"
		}
	}

	private func save() async {
		working = true
		defer { working = false }
		let newKey = key.isEmpty ? (Keychain.read() ?? "") : key
		do {
			try await app.configure(server: server, key: newKey)
			key = ""
			message = ("已連線", true)
		} catch {
			message = (error.userMessage ?? "連線失敗", false)
		}
	}
}

private struct ArchiveSettings: View {
	@Environment(AppModel.self) private var app
	@State private var syncing = false
	@State private var result: String?

	var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			if let archive = app.archive {
				HStack(alignment: .top) {
					VStack(alignment: .leading, spacing: 4) {
						Text(archive.rules.auto ? "自動封存已開啟" : "自動封存已關閉").font(.headline)
						Text(rulesText(archive.rules)).font(.callout).foregroundStyle(.secondary)
					}
					Spacer()
					Button {
						Task { await sync() }
					} label: {
						if syncing {
							ProgressView().controlSize(.small)
						} else {
							Label("立即同步", systemImage: "arrow.triangle.2.circlepath")
						}
					}
					.disabled(syncing)
				}
				if let result {
					Text(result).font(.callout).foregroundStyle(.secondary)
				}
				Table(archive.chats.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }) {
					TableColumn("聊天室") { chat in
						VStack(alignment: .leading) {
							Text(chat.name)
							if let error = chat.lastError {
								Text(error).font(.caption).foregroundStyle(.red).lineLimit(1)
							}
						}
					}
					TableColumn("方式") { chat in Text(chat.mode == "manual" ? "手動" : "自動") }
						.width(44)
					TableColumn("訊息") { chat in Text("\(chat.messages)").monospacedDigit() }
						.width(56)
					TableColumn("範圍") { chat in Text(range(chat)).foregroundStyle(.secondary) }
					TableColumn("上次同步") { chat in
						Text(chat.lastSyncedAt.map { Format.listTime(Date(timeIntervalSince1970: Double($0) / 1000)) } ?? "從未")
							.foregroundStyle(.secondary)
					}
					.width(70)
				}
				.frame(minHeight: 280)
				Text("要加入或移除封存、修改規則，請在 Claude 中使用 line_archive_add、line_archive_remove 或 line_archive_configure。")
					.font(.caption)
					.foregroundStyle(.secondary)
			} else {
				ContentUnavailableView("無法取得封存資訊", systemImage: "archivebox", description: Text("連線到伺服器後會顯示。"))
			}
		}
		.padding(20)
		.frame(minHeight: 440)
		.task { await app.refreshArchive() }
	}

	private func rulesText(_ rules: ArchiveRules) -> String {
		"一對一聊天\(rules.skipOfficialAccounts ? "（不含官方帳號）" : "")，以及不超過 \(rules.maxGroupMembers) 人的群組。伺服器每天同步一次。"
	}

	private func range(_ chat: ArchivedChat) -> String {
		guard let oldest = chat.oldest, let newest = chat.newest else { return "—" }
		let from = Date(timeIntervalSince1970: Double(oldest) / 1000)
		let to = Date(timeIntervalSince1970: Double(newest) / 1000)
		return "\(Format.date(from)) – \(Format.date(to))"
	}

	private func sync() async {
		syncing = true
		defer { syncing = false }
		do {
			let results = try await app.syncArchive()
			let added = results.reduce(0) { $0 + ($1.newMessages ?? 0) }
			let failed = results.filter { $0.error != nil }.count
			result = "已同步 \(results.count) 個聊天室，新增 \(added) 則訊息" + (failed > 0 ? "，\(failed) 個失敗" : "")
		} catch {
			result = error.userMessage
		}
	}
}
