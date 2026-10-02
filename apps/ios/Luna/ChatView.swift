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
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(entries) { entry in
                            switch entry {
                            case .message(let m): MessageBubble(message: m)
                            case .tool(let t): ToolActivityRow(activity: t)
                            case .streaming(_, let text): StreamingBubble(text: text)
                            }
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .scrollTargetLayout()
                }
                // Keeps the tail in view while streaming — a per-delta manual
                // scrollTo raced LazyVStack layout and blanked the timeline.
                .defaultScrollAnchor(.bottom)
                // Snap on structural changes only: a count change is rare (new
                // entry appended, or the streaming row removed on interrupt)
                // and re-clamps the offset when content shrinks.
                .onChange(of: entries.count) { _, _ in
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
                .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
            }

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
            HStack {
                Spacer(minLength: 48)
                content
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .foregroundStyle(.white)
            }
        } else {
            content
                .frame(maxWidth: .infinity, alignment: .leading)
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
        .frame(maxWidth: .infinity, alignment: .leading)
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
                Text(activity.name)
                    .font(.caption.weight(.medium))
                Spacer()
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color.secondary.opacity(0.08))
            .clipShape(Capsule())
            .contentShape(Capsule())
            .onTapGesture { expanded.toggle() }

            if expanded {
                VStack(alignment: .leading, spacing: 4) {
                    if !activity.input.isEmpty {
                        Text(activity.input)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                    if let output = activity.output {
                        Divider()
                        Text(output)
                            .font(.caption.monospaced())
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.06))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
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


