import SwiftUI

struct ThreadListView: View {
    @Environment(AppState.self) private var store
    @State private var showNewThread = false
    @State private var showSettings = false

    var body: some View {
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
                    Button { showNewThread = true } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .disabled(store.connection != .connected)
                }
            }
        }
        .refreshable { store.refreshThreads() }
        .sheet(isPresented: $showNewThread) { NewThreadView() }
        .sheet(isPresented: $showSettings) {
            NavigationStack { SettingsView() }
        }
        .onAppear { store.refreshThreads() }
    }

    private var connectionBadge: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            if let label = store.serverLabel, store.connection == .connected {
                Text(label).font(.caption2).foregroundStyle(.secondary)
            }
        }
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
    let thread: SessionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(thread.title ?? "Untitled")
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                if let ts = thread.lastMessageAt ?? Optional(thread.createdAt) {
                    Text(Date(timeIntervalSince1970: ts / 1000), style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Text(thread.lastMessagePreview ?? thread.model)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(.vertical, 2)
    }
}
