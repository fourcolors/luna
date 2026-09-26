import Foundation
import Observation

struct ToolActivity: Identifiable {
    let id: String // toolCallId
    var name: String
    var input: String
    var output: String?
    var ok: Bool?
    var truncated: Bool = false
    var expanded = false
}

/// One row in a thread's timeline: a finished message, a live tool call,
/// or the in-flight streaming assistant text.
enum ChatEntry: Identifiable {
    case message(ChatMessage)
    case tool(ToolActivity)
    case streaming(id: String, text: String)

    var id: String {
        switch self {
        case .message(let m): return "m-\(m.id)"
        case .tool(let t): return "t-\(t.id)"
        case .streaming(let id, _): return "s-\(id)"
        }
    }
}

@Observable
@MainActor
final class AppState {
    // Connection / server state
    var connection: ConnectionState = .disconnected
    var serverLabel: String?
    var models: [ModelOption] = []
    var banner: String?

    // Threads + per-thread timelines
    var threads: [SessionSummary] = []
    var entries: [String: [ChatEntry]] = [:]
    var runningThreads: Set<String> = []
    var path: [String] = [] // NavigationStack path of thread ids

    // Settings (persisted)
    var host: String { didSet { defaults.set(host, forKey: "luna.host") } }
    var port: Int { didSet { defaults.set(port, forKey: "luna.port") } }
    var useTLS: Bool { didSet { defaults.set(useTLS, forKey: "luna.tls") } }
    var token: String { didSet { Keychain.save(token, account: tokenAccount) } }

    private let defaults = UserDefaults.standard
    private let tokenAccount = "ui-ws-token"
    private let client = LunaClient()
    private var seenIDs: [String: Set<String>] = [:]
    private var subscribed: Set<String> = []
    private var retryTask: Task<Void, Never>?
    private var intentionallyClosed = false
    private var pendingOpen = false
    private var supportsTurnComplete = false

    var isConfigured: Bool { !host.trimmingCharacters(in: .whitespaces).isEmpty && token.count >= 16 }

    init() {
        host = defaults.string(forKey: "luna.host") ?? ""
        port = defaults.object(forKey: "luna.port") == nil ? 4753 : defaults.integer(forKey: "luna.port")
        useTLS = defaults.bool(forKey: "luna.tls")
        token = Keychain.read(account: tokenAccount) ?? ""

        client.onText = { [weak self] text in
            Task { @MainActor in self?.handleText(text) }
        }
        client.onStateChange = { [weak self] state in
            Task { @MainActor in self?.handleState(state) }
        }
    }

    // MARK: - Connection lifecycle

    func connect() {
        intentionallyClosed = false
        retryTask?.cancel()
        guard isConfigured else {
            connection = .disconnected
            return
        }
        client.connect(host: host.trimmingCharacters(in: .whitespaces), port: port, token: token, useTLS: useTLS)
    }

    func disconnect() {
        intentionallyClosed = true
        retryTask?.cancel()
        client.disconnect()
    }

    func reconnect() {
        disconnect()
        connect()
    }

    private func handleState(_ state: ConnectionState) {
        connection = state
        switch state {
        case .connected:
            banner = nil
            refreshThreads()
            for threadId in subscribed { client.send(SubscribeFrameOut(threadId: threadId)) }
        case .failed(let message):
            banner = message
            scheduleRetry()
        case .connecting, .disconnected:
            break
        }
    }

    private func scheduleRetry() {
        guard isConfigured, !intentionallyClosed else { return }
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            self?.connect()
        }
    }

    // MARK: - Actions

    func refreshThreads() {
        client.send(ListThreadsFrameOut(limit: 200, status: nil))
    }

    func createThread(title: String, modelID: String?, effort: String?) {
        pendingOpen = true
        client.send(NewThreadFrameOut(
            model: modelID,
            effort: effort,
            title: title.trimmingCharacters(in: .whitespaces).isEmpty ? nil : title.trimmingCharacters(in: .whitespaces)
        ))
    }

    func openThread(_ threadId: String) {
        if !subscribed.contains(threadId) {
            client.send(SubscribeFrameOut(threadId: threadId))
        }
        if entries[threadId] == nil { entries[threadId] = [] }
    }

    func closeThread(_ threadId: String) {
        guard subscribed.contains(threadId) else { return }
        client.send(UnsubscribeFrameOut(threadId: threadId))
        subscribed.remove(threadId)
    }

    func send(threadId: String, text: String, attachments: [WireAttachment]) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return }
        runningThreads.insert(threadId)
        client.send(UserMessageFrameOut(
            threadId: threadId,
            text: trimmed,
            attachments: attachments.isEmpty ? nil : attachments,
            client: ClientInfo(name: "luna-ios", version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String, platform: "ios")
        ))
    }

    func interrupt(threadId: String) {
        client.send(InterruptFrameOut(threadId: threadId))
    }

    func archive(threadId: String) {
        threads.removeAll { $0.id == threadId }
        client.send(ArchiveThreadFrameOut(threadId: threadId))
    }

    // MARK: - Frame handling

    private func handleText(_ text: String) {
        guard let frame = FrameCodec.decodeServerFrame(text) else { return }
        switch frame {
        case .hello(let h):
            models = h.availableModels ?? []
            supportsTurnComplete = h.capabilities?.turnComplete ?? false
            serverLabel = [h.serverVersion, h.buildSha].compactMap { $0 }.joined(separator: " · ")
        case .ping(let ts):
            client.send(PongFrameOut(ts: ts))
        case .bye(let reason):
            banner = reason
        case .threadList(let list):
            threads = list.sorted { ($0.lastMessageAt ?? $0.createdAt) > ($1.lastMessageAt ?? $1.createdAt) }
        case .threadCreated(let thread):
            if !threads.contains(where: { $0.id == thread.id }) {
                threads.insert(thread, at: 0)
            }
            if pendingOpen {
                pendingOpen = false
                openThread(thread.id)
                path.append(thread.id)
            }
        case .threadCreateError(let message):
            pendingOpen = false
            banner = message
        case .threadSnapshot(let threadId, _, let messages):
            subscribed.insert(threadId)
            entries[threadId] = messages.sorted { $0.seq < $1.seq }.map { .message($0) }
            seenIDs[threadId] = Set(messages.map(\.id))
            runningThreads.remove(threadId)
        case .userAccepted(let threadId, _, let message):
            appendMessage(threadId: threadId, message)
        case .assistantDelta(let threadId, let turnId, let text):
            appendDelta(threadId: threadId, turnId: turnId, text: text)
        case .assistantDone(let threadId, let turnId, _, let message):
            removeStreaming(threadId: threadId, turnId: turnId)
            appendMessage(threadId: threadId, message)
            if !supportsTurnComplete { runningThreads.remove(threadId) }
        case .assistantError(let threadId, let kind, let message):
            removeStreaming(threadId: threadId, turnId: nil)
            runningThreads.remove(threadId)
            banner = "\(kind): \(message)"
        case .toolCall(let threadId, _, let toolCallId, let name, let input):
            runningThreads.insert(threadId)
            var list = entries[threadId] ?? []
            let activity = ToolActivity(
                id: toolCallId,
                name: name,
                input: input?.compactString ?? "",
                output: nil,
                ok: nil
            )
            list.append(.tool(activity))
            entries[threadId] = list
        case .toolResult(let threadId, let toolCallId, let ok, let output, let truncated):
            var list = entries[threadId] ?? []
            if let idx = list.firstIndex(where: { $0.id == "t-\(toolCallId)" }),
               case .tool(var activity) = list[idx] {
                activity.output = output
                activity.ok = ok
                activity.truncated = truncated
                list[idx] = .tool(activity)
                entries[threadId] = list
            }
        case .turnComplete(let threadId):
            runningThreads.remove(threadId)
        case .threadArchived(let threadId):
            threads.removeAll { $0.id == threadId }
            entries.removeValue(forKey: threadId)
            subscribed.remove(threadId)
        case .threadUnarchived:
            refreshThreads()
        case .resultDelivered:
            refreshThreads()
        case .ignored:
            break
        }
    }

    private func appendMessage(threadId: String, _ message: ChatMessage) {
        var seen = seenIDs[threadId] ?? []
        guard !seen.contains(message.id) else { return }
        seen.insert(message.id)
        seenIDs[threadId] = seen
        var list = entries[threadId] ?? []
        list.append(.message(message))
        entries[threadId] = list
    }

    private func appendDelta(threadId: String, turnId: String, text: String) {
        runningThreads.insert(threadId)
        var list = entries[threadId] ?? []
        if let idx = list.lastIndex(where: { $0.id == "s-\(turnId)" }),
           case .streaming(let id, let existing) = list[idx] {
            list[idx] = .streaming(id: id, text: existing + text)
        } else {
            list.append(.streaming(id: turnId, text: text))
        }
        entries[threadId] = list
    }

    private func removeStreaming(threadId: String, turnId: String?) {
        var list = entries[threadId] ?? []
        list.removeAll {
            if case .streaming(let id, _) = $0 { return turnId == nil || id == turnId }
            return false
        }
        entries[threadId] = list
    }
}
