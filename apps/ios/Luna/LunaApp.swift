import SwiftUI

@main
struct LunaApp: App {
    @State private var store = AppState()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active, store.isConfigured, store.connection != .connected {
                        store.connect()
                    }
                }
        }
    }
}

struct RootView: View {
    @Environment(AppState.self) private var store

    var body: some View {
        if store.isConfigured {
            NavigationStack(path: Binding(
                get: { store.path },
                set: { store.path = $0 }
            )) {
                ThreadListView()
                    .navigationDestination(for: String.self) { threadId in
                        ChatView(threadId: threadId)
                    }
            }
            .onAppear { store.connect() }
        } else {
            NavigationStack {
                SettingsView()
            }
        }
    }
}
