import SwiftUI

struct ChatView: View {
    let threadId: String

    @Environment(AppState.self) private var store
    @State private var draft = ""

    private var entries: [ChatEntry] { store.entries[threadId] ?? [] }
    private var isRunning: Bool { store.runningThreads.contains(threadId) }
    private var thread: SessionSummary? { store.threads.first { $0.id == threadId } }

    /// Changes whenever the tail of the timeline changes — drives scroll-to-bottom.
    private var scrollKey: String {
        guard let last = entries.last else { return "empty" }
        var len = 0
        switch last {
        case .streaming(_, let t): len = t.count
        case .message(let m): len = m.text.count
        case .tool(let t): len = t.output?.count ?? 0
        }
        return "\(entries.count)-\(last.id)-\(len)"
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
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
                }
                .onChange(of: scrollKey) { _, _ in
                    // No animation: an animated scrollTo racing rapid LazyVStack
                    // updates can blank the whole timeline.
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
                .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
            }

            Divider()
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
        } else {
        HStack {
            if message.isUser { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 6) {
                if let delivery = message.delivery {
                    Label(delivery.label ?? delivery.source, systemImage: "clock.arrow.circlepath")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if !message.text.isEmpty {
                    if message.isUser {
                        Text(message.text)
                    } else {
                        MarkdownText(message.text)
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
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(message.isUser ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 14))
            if !message.isUser { Spacer(minLength: 40) }
        }
        }
    }
}

private struct StreamingBubble: View {
    let text: String

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 6) {
                if text.isEmpty {
                    ProgressView().controlSize(.small)
                } else {
                    MarkdownText(text)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.secondary.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 14))
            Spacer(minLength: 40)
        }
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
    private let content: AttributedString

    init(_ text: String) {
        content = (try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(text)
    }

    var body: some View {
        Text(content)
            .textSelection(.enabled)
    }
}


