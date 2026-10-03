import SwiftUI

struct ChatView: View {
    let threadId: String

    @Environment(AppState.self) private var store
    @State private var draft = ""

    private var entries: [ChatEntry] { store.entries[threadId] ?? [] }
    private var isRunning: Bool { store.runningThreads.contains(threadId) }
    private var thread: SessionSummary? { store.threads.first { $0.id == threadId } }

    var body: some View {
        VStack(spacing: 0) {
            // Inverted list: the ScrollView is flipped 180°, each row flipped
            // back, and entries iterated newest-first. Offset 0 therefore IS
            // the tail — the viewport stays glued to the newest entry while it
            // appends, grows, replaces, or removes, with zero scroll code.
            //
            // Plain VStack, deliberately not lazy: LazyVStack's measureEstimates
            // pass walks every row to reconcile estimated vs actual positions,
            // and against 800-line Text rows that pass re-invalidates forever —
            // the timeline blanked or the main thread pegged at 100%. Entries
            // are bounded (the server snapshot is capped), so one full layout
            // pass is cheap and correct.
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if entries.isEmpty && !isRunning {
                        Text("No messages")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 48)
                            .rotationEffect(.radians(.pi))
                    }
                    ForEach(entries.reversed()) { entry in
                        Group {
                            switch entry {
                            case .message(let m): MessageBubble(message: m)
                            case .tool(let t): ToolActivityRow(activity: t)
                            case .streaming(_, let text): StreamingBubble(text: text)
                            }
                        }
                        .rotationEffect(.radians(.pi))
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
            .rotationEffect(.radians(.pi))

            ComposerView(
                draft: $draft,
                isRunning: isRunning,
                onSend: { attachments in
                    store.send(threadId: threadId, text: draft, attachments: attachments)
                },
                onInterrupt: { store.interrupt(threadId: threadId) }
            )
        }
        .navigationTitle(thread?.title ?? "Thread")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if isRunning {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .destructive) { store.interrupt(threadId: threadId) } label: {
                        Label("Stop", systemImage: "stop.circle")
                    }
                }
            }
        }
        .onAppear { store.openThread(threadId) }
        .onDisappear { store.closeThread(threadId) }
    }

}

private struct MessageBubble: View {
    let message: ChatMessage

    /// Tool-use-only or text-only turns still render; only a fully empty
    /// payload collapses (avoids blank pills between activity rows).
    private var isEmpty: Bool {
        message.text.isEmpty
            && (message.toolUses?.isEmpty ?? true)
            && (message.attachments?.isEmpty ?? true)
            && message.delivery == nil
    }

    var body: some View {
        if isEmpty {
            EmptyView()
        } else if message.isUser {
            HStack(alignment: .top, spacing: 0) {
                Spacer(minLength: 56)
                content
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        Color.accentColor.opacity(0.16),
                        in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                    )
            }
        } else {
            content
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    Color(.secondarySystemBackground),
                    in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                )
        }
    }

    /// The server prepends a "[client: …]" marker line for the agent's benefit
    /// — meaningful in the transcript, noise in the bubble.
    private var displayText: String {
        if message.text.hasPrefix("[client:"),
           let nl = message.text.firstIndex(of: "\n") {
            return String(message.text[message.text.index(after: nl)...])
        }
        return message.text
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let delivery = message.delivery {
                Label(delivery.label ?? delivery.source, systemImage: "clock.arrow.circlepath")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if !displayText.isEmpty {
                if message.isUser {
                    Text(displayText)
                } else {
                    MarkdownText(displayText)
                }
            }
            if let attachments = message.attachments {
                ForEach(Array(attachments.enumerated()), id: \.offset) { _, a in
                    AttachmentView(attachment: a)
                }
            }
            if let toolUses = message.toolUses, !toolUses.isEmpty {
                ForEach(toolUses) { tool in
                    Label(tool.name, systemImage: tool.result?.ok == false ? "wrench.trianglebadge.exclamationmark" : "wrench")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct StreamingBubble: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if text.isEmpty {
                ProgressView().controlSize(.small)
            } else {
                // Plain Text while streaming — markdown re-parse every
                // delta was the hot path saturating the main thread.
                Text(text)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color(.secondarySystemBackground),
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
    }
}

private struct ToolActivityRow: View {
    let activity: ToolActivity
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .foregroundStyle(color)
                    .font(.caption)
                    .frame(width: 14)
                Text(activity.name)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
            .onTapGesture { expanded.toggle() }

            if expanded {
                VStack(alignment: .leading, spacing: 6) {
                    if !activity.input.isEmpty {
                        Text(activity.input)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                    if let output = activity.output {
                        if !activity.input.isEmpty { Divider() }
                        Text(output)
                            .font(.caption.monospaced())
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color(.tertiarySystemBackground),
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
    }

    private var icon: String {
        switch activity.ok {
        case .none: return "ellipsis.circle"
        case .some(true): return "checkmark.circle"
        case .some(false): return "xmark.circle"
        }
    }

    private var color: Color {
        switch activity.ok {
        case .none: return .secondary
        case .some(true): return .green
        case .some(false): return .red
        }
    }
}

private struct AttachmentView: View {
    let attachment: ChatAttachment

    var body: some View {
        if attachment.mediaType.hasPrefix("image/"),
           let data = Data(base64Encoded: attachment.data),
           let image = UIImage(data: data) {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: 240)
                .clipShape(RoundedRectangle(cornerRadius: 10))
        } else {
            Label(attachment.mediaType, systemImage: "doc")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

struct MarkdownText: View {
    private let text: String

    /// AttributedString(markdown:) is expensive — every row re-parsed on every
    /// render (i.e. every delta). Memoized so finished messages parse once.
    private static let cache = NSCache<NSString, NSAttributedString>()

    init(_ text: String) { self.text = text }

    private var content: AttributedString {
        if let hit = Self.cache.object(forKey: text as NSString) {
            return AttributedString(hit)
        }
        let parsed = (try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(text)
        Self.cache.setObject(NSAttributedString(parsed), forKey: text as NSString)
        return parsed
    }

    var body: some View {
        Text(content)
            .textSelection(.enabled)
    }
}


