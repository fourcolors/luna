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
    var isCreatingThread = false
    /// NavigationStack path: thread ids plus the new-chat draft sentinel.
    static let newChatRoute = "new-chat"
    var path: [String] = []

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
    private var pendingSend: (text: String, attachments: [WireAttachment]?)?
    private var supportsTurnComplete = false
    /// Deltas are coalesced ~20Hz — a hot stream would otherwise re-render
    /// the whole timeline per wire frame and saturate the main thread.
    private var pendingDeltas: [String: (turnId: String, text: String)] = [:]
    private var deltaFlushScheduled = false
    /// Turns that already finished — late deltas (e.g. racing an interrupt)
    /// must not resurrect a streaming row or the running state.
    private var doneTurns: [String: Set<String>] = [:]
    /// Threads the user just interrupted — their trailing assistant-error
    /// (the SDK's aborted-stream diagnostic) isn't a real error for the UI.
    private var interruptedAt: [String: Date] = [:]

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
            retryTask?.cancel()
            retryTask = nil
            banner = nil
            refreshThreads()
            for threadId in subscribed { client.send(SubscribeFrameOut(threadId: threadId)) }
        case .failed(let message):
            banner = message
            abandonPendingCreate()
            scheduleRetry()
        case .disconnected:
            abandonPendingCreate()
        case .connecting:
            break
        }
    }

    /// A new-chat request whose socket dropped before `thread-created` will
    /// never get an answer; clear it so the draft view stops spinning and
    /// later new chats are not rejected by the `isCreatingThread` guard.
    private func abandonPendingCreate() {
        guard isCreatingThread || pendingSend != nil else { return }
        isCreatingThread = false
        pendingSend = nil
        banner = "Connection lost - message not sent"
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

    /// ChatGPT-style new chat: the first message creates the thread — the
    /// draft view sends this, then threadCreated swaps the draft route for
    /// the real thread id and flushes the queued message.
    /// Returns false when nothing was sent (not connected, empty, or a create
    /// is already in flight) so the composer keeps the user's draft.
    @discardableResult
    func createThreadAndSend(text: String, attachments: [WireAttachment], modelID: String?, effort: String?) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty, !isCreatingThread else { return false }
        guard connection == .connected else {
            banner = "Not connected - message not sent"
            return false
        }
        isCreatingThread = true
        pendingSend = (trimmed, attachments.isEmpty ? nil : attachments)
        guard client.send(NewThreadFrameOut(model: modelID, effort: effort, title: nil)) else {
            isCreatingThread = false
            pendingSend = nil
            banner = "Not connected - message not sent"
            return false
        }
        return true
    }

    func openThread(_ threadId: String) {
        if !subscribed.contains(threadId) {
            // Mark before the snapshot arrives — a second subscribe issued in
            // the gap would earn a second snapshot that clobbers live entries.
            subscribed.insert(threadId)
            client.send(SubscribeFrameOut(threadId: threadId))
        }
        if entries[threadId] == nil { entries[threadId] = [] }
    }

    func closeThread(_ threadId: String) {
        guard subscribed.contains(threadId) else { return }
        client.send(UnsubscribeFrameOut(threadId: threadId))
        subscribed.remove(threadId)
    }

    /// Returns false when the message was not sent (not connected or empty),
    /// so the composer keeps the draft and the Stop button never appears for
    /// a turn that never started.
    @discardableResult
    func send(threadId: String, text: String, attachments: [WireAttachment]) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return false }
        guard connection == .connected else {
            banner = "Not connected - message not sent"
            return false
        }
        let sent = client.send(UserMessageFrameOut(
            threadId: threadId,
            text: trimmed,
            attachments: attachments.isEmpty ? nil : attachments,
            client: ClientInfo(name: "luna-ios", version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String, platform: "ios")
        ))
        if sent {
            runningThreads.insert(threadId)
        } else {
            banner = "Not connected - message not sent"
        }
        return sent
    }

    func interrupt(threadId: String) {
        interruptedAt[threadId] = Date()
        pendingDeltas.removeValue(forKey: threadId)
        // The server's delta turnIds don't match the turnId on assistant-done,
        // so mark the live streaming rows' ids done — trailing deltas can't
        // resurrect the stream after Stop.
        if let list = entries[threadId] {
            for case .streaming(let id, _) in list {
                doneTurns[threadId, default: []].insert(id)
            }
        }
        client.send(InterruptFrameOut(threadId: threadId))
    }

    /// True while the thread sits inside the post-Stop window: the SDK keeps
    /// flushing queued deltas (under fresh turnIds, so doneTurns can't catch
    /// them), and applying them churns create/destroy streaming-row cycles at
    /// the delta cadence — enough layout work to wedge the main thread.
    private func deltasSuppressed(threadId: String) -> Bool {
        interruptedAt[threadId].map { Date().timeIntervalSince($0) < 30 } ?? false
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
            if isCreatingThread {
                isCreatingThread = false
                if let pending = pendingSend {
                    pendingSend = nil
                    openThread(thread.id)
                    send(threadId: thread.id, text: pending.text, attachments: pending.attachments ?? [])
                }
                if let i = path.lastIndex(of: Self.newChatRoute) {
                    path[i] = thread.id
                } else {
                    path.append(thread.id)
                }
            }
        case .threadCreateError(let message):
            isCreatingThread = false
            pendingSend = nil
            banner = message
        case .threadSnapshot(let threadId, _, let messages):
            subscribed.insert(threadId)
            entries[threadId] = messages.sorted { $0.seq < $1.seq }.map { .message($0) }
            seenIDs[threadId] = Set(messages.map(\.id))
            doneTurns[threadId] = []
            pendingDeltas.removeValue(forKey: threadId)
            runningThreads.remove(threadId)
        case .userAccepted(let threadId, _, let message):
            // A newly accepted user message starts a fresh turn — lift the
            // interrupt suppression so this turn's deltas stream normally.
            interruptedAt.removeValue(forKey: threadId)
            appendMessage(threadId: threadId, message)
        case .assistantDelta(let threadId, let turnId, let text):
            queueDelta(threadId: threadId, turnId: turnId, text: text)
        case .assistantDone(let threadId, let turnId, _, let message):
            doneTurns[threadId, default: []].insert(turnId)
            pendingDeltas.removeValue(forKey: threadId)
            removeStreaming(threadId: threadId, turnId: nil)
            appendMessage(threadId: threadId, message)
            if !supportsTurnComplete { runningThreads.remove(threadId) }
        case .assistantError(let threadId, let turnId, let kind, let message):
            if let turnId { doneTurns[threadId, default: []].insert(turnId) }
            pendingDeltas.removeValue(forKey: threadId)
            removeStreaming(threadId: threadId, turnId: nil)
            runningThreads.remove(threadId)
            // After Stop the server emits an "interrupted" ack plus an
            // "adapter stream failed" teardown error — the teardown lands
            // after turnComplete, so suppress expected teardown noise for a
            // window rather than until a specific frame.
            let recentInterrupt = interruptedAt[threadId].map {
                Date().timeIntervalSince($0) < 30
            } ?? false
            let teardown = kind == "interrupted" || message.hasPrefix("adapter stream failed")
            if !(recentInterrupt && teardown) {
                banner = "\(kind): \(message)"
            }
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
            pendingDeltas.removeValue(forKey: threadId)
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

    private func queueDelta(threadId: String, turnId: String, text: String) {
        if deltasSuppressed(threadId: threadId) { return }
        if doneTurns[threadId]?.contains(turnId) == true { return }
        var cur = pendingDeltas[threadId] ?? (turnId: turnId, text: "")
        cur.turnId = turnId
        cur.text += text
        pendingDeltas[threadId] = cur
        guard !deltaFlushScheduled else { return }
        deltaFlushScheduled = true
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(50))
            self?.flushDeltas()
        }
    }

    private func flushDeltas() {
        deltaFlushScheduled = false
        let batch = pendingDeltas
        pendingDeltas.removeAll()
        for (threadId, delta) in batch {
            applyDelta(threadId: threadId, turnId: delta.turnId, text: delta.text)
        }
    }

    private func applyDelta(threadId: String, turnId: String, text: String) {
        if deltasSuppressed(threadId: threadId) { return }
        if doneTurns[threadId]?.contains(turnId) == true { return }
        runningThreads.insert(threadId)
        var list = entries[threadId] ?? []
        // Exactly one streaming row per thread. Delta turnIds shift across a
        // single reply, so keying rows by turnId fragments one stream into
        // many rows (which also churned entry count and wedged the scroller).
        if let idx = list.lastIndex(where: {
            if case .streaming = $0 { return true } else { return false }
        }), case .streaming(let id, let existing) = list[idx] {
            list[idx] = .streaming(id: id, text: existing + text)
        } else {
            list.append(.streaming(id: turnId, text: text))
        }
        entries[threadId] = list
    }

    private func removeStreaming(threadId: String, turnId: String?) {
        var list = entries[threadId] ?? []
        // Record the removed rows' turnIds as done — their ids never match the
        // done/error turnId, so this is the only way late deltas get dropped.
        for case .streaming(let id, _) in list where turnId == nil || id == turnId {
            doneTurns[threadId, default: []].insert(id)
        }
        list.removeAll {
            if case .streaming(let id, _) = $0 { return turnId == nil || id == turnId }
            return false
        }
        entries[threadId] = list
    }
}
