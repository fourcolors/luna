import SwiftUI
import PhotosUI

struct ChatView: View {
    let threadId: String

    @Environment(AppState.self) private var store
    @State private var draft = ""
    @State private var pickedItem: PhotosPickerItem?
    @State private var pendingImage: UIImage?
    @FocusState private var inputFocused: Bool

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
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
                .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
            }

            Divider()
            inputBar
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

    private var inputBar: some View {
        VStack(spacing: 6) {
            if let pendingImage {
                HStack {
                    Image(uiImage: pendingImage)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 48, height: 48)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    Button { self.pendingImage = nil; pickedItem = nil } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                    Spacer()
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                PhotosPicker(selection: $pickedItem, matching: .images) {
                    Image(systemName: "photo")
                        .font(.title3)
                }
                .onChange(of: pickedItem) { _, item in
                    guard let item else { return }
                    Task {
                        if let data = try? await item.loadTransferable(type: Data.self),
                           let image = UIImage(data: data) {
                            pendingImage = image.downscaled()
                        }
                    }
                }

                TextField("Message Luna…", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .focused($inputFocused)

                if isRunning {
                    Button { store.interrupt(threadId: threadId) } label: {
                        Image(systemName: "stop.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.red)
                    }
                } else {
                    Button { send() } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && pendingImage == nil)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func send() {
        var attachments: [WireAttachment] = []
        if let pendingImage,
           let jpeg = pendingImage.jpegData(compressionQuality: 0.8) {
            attachments.append(WireAttachment(mediaType: "image/jpeg", data: jpeg.base64EncodedString()))
        }
        store.send(threadId: threadId, text: draft, attachments: attachments)
        draft = ""
        self.pendingImage = nil
        pickedItem = nil
    }
}

private struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
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
            Button { expanded.toggle() } label: {
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
            }
            .buttonStyle(.plain)

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

private extension UIImage {
    /// Clamp to ~1568px max edge so base64 payloads stay small.
    func downscaled(maxEdge: CGFloat = 1568) -> UIImage {
        let scale = min(1, maxEdge / max(size.width, size.height))
        if scale >= 1 { return self }
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: target)
        return renderer.image { _ in draw(in: CGRect(origin: .zero, size: target)) }
    }
}
