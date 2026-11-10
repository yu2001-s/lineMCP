import SwiftUI

struct RootView: View {
	@Environment(AppModel.self) private var app
	@Environment(\.openWindow) private var openWindow
	@Environment(\.appearsActive) private var appearsActive

	var body: some View {
		Group {
			switch app.phase {
			case .setup:
				SetupView()
			case .unauthorized:
				SetupView(problem: "伺服器拒絕了儲存的金鑰，請重新輸入。")
			default:
				MainView()
			}
		}
		.frame(minWidth: 760, minHeight: 480)
		.task {
			let show = { openWindow(id: "main") }
			app.showMainWindow = show
			AppDelegate.showMainWindow = show
			app.start()
		}
		.onChange(of: appearsActive, initial: true) {
			app.windowActive = appearsActive
		}
		.onDisappear { app.windowActive = false }
	}
}

private struct MainView: View {
	@Environment(AppModel.self) private var app

	var body: some View {
		@Bindable var app = app
		NavigationSplitView {
			ChatListView()
				.navigationSplitViewColumnWidth(min: 250, ideal: 300, max: 440)
		} detail: {
			if let id = app.selectedChatId, let chat = app.chat(id) {
				ConversationView(chat: chat, conversation: app.conversation(id))
					.id(id)
			} else if app.selectedChatId != nil {
				ProgressView()
			} else {
				ContentUnavailableView {
					Label("選擇一個聊天室", systemImage: "bubble.left.and.bubble.right")
				} description: {
					if let me = app.me {
						Text("已用 \(me.name) 的帳號登入")
					}
				} actions: {
					Button("新聊天") { app.showingNewChat = true }
				}
			}
		}
		.sheet(isPresented: $app.showingNewChat) {
			NewChatSheet()
		}
		.tagPrompt(app)
	}
}
