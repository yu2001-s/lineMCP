import SwiftUI

@main
struct BetterLINEApp: App {
	@NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
	@State private var app = AppModel()

	var body: some Scene {
		Window("betterLINE", id: "main") {
			RootView()
				.environment(app)
		}
		.defaultSize(width: 1080, height: 760)
		.commands { ChatCommands(app: app) }

		Settings {
			SettingsView()
				.environment(app)
		}
	}
}

/// Closing the window keeps the app running for notifications and the Dock badge;
/// clicking the Dock icon brings it back.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
	static var showMainWindow: (() -> Void)?

	func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
		false
	}

	func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
		if !hasVisibleWindows { Self.showMainWindow?() }
		return true
	}
}

struct ChatCommands: Commands {
	let app: AppModel

	var body: some Commands {
		CommandGroup(replacing: .newItem) {
			Button("新聊天") { app.showingNewChat = true }
				.keyboardShortcut("n")
		}
		CommandGroup(after: .textEditing) {
			Button("搜尋") { app.searchRequests += 1 }
				.keyboardShortcut("f")
		}
		CommandMenu("聊天室") {
			Button("重新整理") {
				Task { await app.resync() }
			}
			.keyboardShortcut("r")
			Button("標示為已讀") {
				if let id = app.selectedChatId { app.markRead(id, force: true) }
			}
			.keyboardShortcut("r", modifiers: [.command, .shift])
			.disabled(app.selectedChatId == nil)
			Divider()
			Button("上一個聊天室") { app.selectAdjacent(-1) }
				.keyboardShortcut(.upArrow, modifiers: [.command, .option])
			Button("下一個聊天室") { app.selectAdjacent(1) }
				.keyboardShortcut(.downArrow, modifiers: [.command, .option])
		}
	}
}
