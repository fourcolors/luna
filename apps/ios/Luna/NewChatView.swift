import SwiftUI

/// Empty-chat draft screen pushed via `AppState.newChatRoute` — the first sent
/// message creates the thread server-side, like ChatGPT/Claude's "new chat".
struct NewChatView: View {
    @Environment(AppState.self) private var store
    @State private var draft = ""
    @State private var modelID: String?
    @State private var effort: String?

    private var selectedModel: ModelOption? {
        store.models.first { $0.id == modelID }
    }

    private let suggestions = [
        "Summarize today's Luna activity",
        "Help me debug an issue",
        "Brainstorm a new feature idea",
    ]

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 16) {
                Image(systemName: "moon.stars.fill")
                    .font(.system(size: 42))
                    .foregroundStyle(Color.accentColor)
                Text("How can Luna help?")
                    .font(.title2.weight(.semibold))
                VStack(spacing: 8) {
                    ForEach(suggestions, id: \.self) { s in
                        Button { draft = s } label: {
                            Text(s)
                                .font(.callout)
                                .foregroundStyle(.primary)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 9)
                                .background(
                                    Color(.secondarySystemBackground), in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(.horizontal, 24)
            Spacer()
            Spacer()
            ComposerView(
                draft: $draft,
                isSending: store.isCreatingThread,
                autofocus: true
            ) { attachments in
                store.createThreadAndSend(
                    text: draft, attachments: attachments,
                    modelID: modelID, effort: effort)
            }
        }
        .navigationTitle("New chat")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !store.models.isEmpty {
                ToolbarItem(placement: .topBarTrailing) { modelMenu }
            }
        }
    }

    private var modelMenu: some View {
        Menu {
            Button {
                modelID = nil
                effort = nil
            } label: {
                Label("Server default", systemImage: modelID == nil ? "checkmark" : "")
            }
            ForEach(store.models) { m in
                Button {
                    modelID = m.id
                    effort = m.defaultEffort
                } label: {
                    Label(m.label, systemImage: modelID == m.id ? "checkmark" : "")
                }
            }
            if let efforts = selectedModel?.efforts, !efforts.isEmpty {
                Divider()
                Button {
                    effort = nil
                } label: {
                    Label("Effort: auto", systemImage: effort == nil ? "checkmark" : "")
                }
                ForEach(efforts, id: \.self) { e in
                    Button {
                        effort = e
                    } label: {
                        Label("Effort: \(e)", systemImage: effort == e ? "checkmark" : "")
                    }
                }
            }
        } label: {
            HStack(spacing: 3) {
                Text(selectedModel?.label ?? "Model")
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color(.secondarySystemBackground), in: Capsule())
        }
    }
}
