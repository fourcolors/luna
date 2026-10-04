import SwiftUI

struct ThreadListView: View {
    @Environment(AppState.self) private var store
    @State private var showSettings = false

    var body: some View {
        Group {
            if store.connection == .connected && store.threads.isEmpty {
                ContentUnavailableView {
                    Label("No chats", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("Start a new chat from the compose button.")
                }
            } else {
                threadList
            }
        }
        .navigationTitle("Luna")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                connectionBadge
            }
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 16) {
                    Button { showSettings = true } label: {
                        Image(systemName: "gearshape")
                    }
                    Button { store.path.append(AppState.newChatRoute) } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .disabled(store.connection != .connected)
                }
            }
        }
        .refreshable { store.refreshThreads() }
        .sheet(isPresented: $showSettings) {
            NavigationStack { SettingsView() }
        }
        .onAppear { store.refreshThreads() }
    }

    private var threadList: some View {
        List {
            if let banner = store.banner {
                Section {
                    Text(banner)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(store.threads) { thread in
                ThreadRow(thread: thread)
                    // Plain row + manual navigation: NavigationLink rows swallow
                    // taps on the revealed swipe-action button.
                    .contentShape(Rectangle())
                    .onTapGesture { store.path.append(thread.id) }
                    .environment(store)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            store.archive(threadId: thread.id)
                        } label: {
                            Label("Archive", systemImage: "archivebox")
                        }
                    }
            }
        }
        .listStyle(.plain)
    }

    private var connectionBadge: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
            Text(
                store.connection == .connected
                    ? (store.serverLabel?.components(separatedBy: " · ").first ?? "Connected")
                    : store.connection.label
            )
            .font(.caption2)
            .fixedSize()
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color(.secondarySystemBackground), in: Capsule())
        .help(store.connection.label)
    }

    private var color: Color {
        switch store.connection {
        case .connected: return .green
        case .connecting: return .orange
        case .failed, .disconnected: return .red
        }
    }
}

private struct ThreadRow: View {
    @Environment(AppState.self) private var store
    let thread: SessionSummary

    private var statusColor: Color? {
        if store.runningThreads.contains(thread.id) { return .accentColor }
        if thread.status == "errored" { return .red }
        return nil
    }

    /// Markdown syntax reads as noise in a one-line preview.
    private var preview: String {
        (thread.lastMessagePreview ?? thread.model)
            .replacingOccurrences(of: "*", with: "")
            .replacingOccurrences(of: "`", with: "")
            .replacingOccurrences(of: "#", with: "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                if let statusColor {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 6, height: 6)
                }
                Text(thread.title ?? "Untitled")
                    .font(.body)
                    .lineLimit(1)
                Spacer()
                if let ts = thread.lastMessageAt ?? Optional(thread.createdAt) {
                    Text(Date(timeIntervalSince1970: ts / 1000), style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Text(preview)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(.vertical, 2)
    }
}
