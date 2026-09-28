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

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Text("What can Luna help with?")
                .font(.title3.weight(.medium))
                .foregroundStyle(.secondary)
            Spacer()
            Divider()
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
            Text(selectedModel?.label ?? "Model")
                .font(.caption)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Color.secondary.opacity(0.12))
                .clipShape(Capsule())
        }
    }
}
