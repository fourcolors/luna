import Foundation

// Luna UI WebSocket wire protocol (v2) — minimal client subset.
// Mirrors packages/ui-ws/src/protocol.ts: bearer token on the upgrade request
// (or ?token=), WS path "/ui", JSON text frames discriminated by `type`.

// MARK: - Arbitrary JSON (for `input: unknown` fields)

enum JSONValue: Codable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        self = .object(try c.decode([String: JSONValue].self))
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }

    var compactString: String {
        guard let data = try? JSONEncoder().encode(self),
              let s = String(data: data, encoding: .utf8) else { return "…" }
        return s.count > 4000 ? String(s.prefix(4000)) + "…" : s
    }
}

// MARK: - Shared models

struct ChatToolUseResult: Codable {
    let ok: Bool
    let output: String
    let truncated: Bool
}

struct ChatToolUse: Codable, Identifiable {
    let id: String
    let name: String
    let input: JSONValue?
    let result: ChatToolUseResult?
}

struct ChatAttachment: Codable {
    let mediaType: String
    let data: String // base64, no data: prefix
}

struct ChatMessageDelivery: Codable {
    let source: String
    let label: String?
}

struct ChatMessage: Codable, Identifiable {
    let id: String
    let seq: Int
    let ts: Double
    let role: String // "user" | "assistant"
    let text: String
    let toolUses: [ChatToolUse]?
    let attachments: [ChatAttachment]?
    let delivery: ChatMessageDelivery?

    var isUser: Bool { role == "user" }
}

struct SessionSummary: Codable, Identifiable {
    let id: String
    let parentId: String?
    let title: String?
    let tags: [String]?
    let createdAt: Double
    let endedAt: Double?
    let model: String
    let effort: String?
    let status: String // "active" | "idle" | "closed" | "errored"
    let lastMessageAt: Double?
    let lastMessagePreview: String?
}

struct ModelOption: Codable, Identifiable {
    let id: String
    let label: String
    let efforts: [String]?
    let defaultEffort: String?
}

struct HelloCapabilities: Codable {
    let chat: Bool?
    let streamingDeltas: Bool?
    let turnComplete: Bool?
    let agents: Bool?
}

struct HelloFrame: Codable {
    let protocolVersion: Int
    let kinds: [String]?
    let buildSha: String?
    let serverVersion: String?
    let availableModels: [ModelOption]?
    let capabilities: HelloCapabilities?
}

// MARK: - Server → client

enum ServerFrame {
    case hello(HelloFrame)
    case ping(ts: String)
    case bye(reason: String)
    case threadList([SessionSummary])
    case threadCreated(SessionSummary)
    case threadCreateError(String)
    case threadSnapshot(threadId: String, throughSeq: Int, messages: [ChatMessage])
    case userAccepted(threadId: String, seq: Int, message: ChatMessage)
    case assistantDelta(threadId: String, turnId: String, text: String)
    case assistantDone(threadId: String, turnId: String, seq: Int, message: ChatMessage)
    case assistantError(threadId: String, kind: String, message: String)
    case toolCall(threadId: String, turnId: String, toolCallId: String, name: String, input: JSONValue?)
    case toolResult(threadId: String, toolCallId: String, ok: Bool, output: String, truncated: Bool)
    case turnComplete(threadId: String)
    case threadArchived(threadId: String)
    case threadUnarchived(threadId: String)
    case resultDelivered(threadId: String, label: String, preview: String)
    /// Known or unknown frame types this client doesn't render.
    case ignored(String)
}

private struct TypeProbe: Codable { let type: String }

private struct PingFrameIn: Codable { let ts: String }
private struct ByeFrameIn: Codable { let reason: String }
private struct ThreadListFrameIn: Codable { let threads: [SessionSummary] }
private struct ThreadCreatedFrameIn: Codable { let thread: SessionSummary }
private struct ThreadCreateErrorFrameIn: Codable { let message: String }
private struct ThreadSnapshotFrameIn: Codable {
    let threadId: String
    let throughSeq: Int
    let messages: [ChatMessage]
}
private struct UserAcceptedFrameIn: Codable {
    let threadId: String
    let seq: Int
    let message: ChatMessage
}
private struct AssistantDeltaFrameIn: Codable {
    let threadId: String
    let turnId: String
    let text: String
}
private struct AssistantDoneFrameIn: Codable {
    let threadId: String
    let turnId: String
    let seq: Int
    let message: ChatMessage
}
private struct AssistantErrorFrameIn: Codable {
    struct Err: Codable { let kind: String; let message: String }
    let threadId: String
    let turnId: String?
    let error: Err
}
private struct ToolCallFrameIn: Codable {
    let threadId: String
    let turnId: String
    let toolCallId: String
    let name: String
    let input: JSONValue?
}
private struct ToolResultFrameIn: Codable {
    let threadId: String
    let toolCallId: String
    let status: String // "ok" | "error"
    let output: String
    let truncated: Bool
}
private struct ThreadIDFrameIn: Codable { let threadId: String }
private struct ResultDeliveredFrameIn: Codable {
    let threadId: String
    let label: String
    let preview: String
}

enum FrameCodec {
    static let decoder = JSONDecoder()
    static let encoder = JSONEncoder()

    static func decodeServerFrame(_ text: String) -> ServerFrame? {
        guard let data = text.data(using: .utf8),
              let probe = try? decoder.decode(TypeProbe.self, from: data) else { return nil }
        func d<T: Decodable>(_ t: T.Type) -> T? { try? decoder.decode(t, from: data) }

        switch probe.type {
        case "hello":
            guard let f: HelloFrame = d(HelloFrame.self) else { return nil }
            return .hello(f)
        case "ping":
            guard let f: PingFrameIn = d(PingFrameIn.self) else { return nil }
            return .ping(ts: f.ts)
        case "bye":
            guard let f: ByeFrameIn = d(ByeFrameIn.self) else { return nil }
            return .bye(reason: f.reason)
        case "thread-list":
            guard let f: ThreadListFrameIn = d(ThreadListFrameIn.self) else { return nil }
            return .threadList(f.threads)
        case "thread-created":
            guard let f: ThreadCreatedFrameIn = d(ThreadCreatedFrameIn.self) else { return nil }
            return .threadCreated(f.thread)
        case "thread-create-error":
            guard let f: ThreadCreateErrorFrameIn = d(ThreadCreateErrorFrameIn.self) else { return nil }
            return .threadCreateError(f.message)
        case "thread-snapshot":
            guard let f: ThreadSnapshotFrameIn = d(ThreadSnapshotFrameIn.self) else { return nil }
            return .threadSnapshot(threadId: f.threadId, throughSeq: f.throughSeq, messages: f.messages)
        case "user-accepted":
            guard let f: UserAcceptedFrameIn = d(UserAcceptedFrameIn.self) else { return nil }
            return .userAccepted(threadId: f.threadId, seq: f.seq, message: f.message)
        case "assistant-delta":
            guard let f: AssistantDeltaFrameIn = d(AssistantDeltaFrameIn.self) else { return nil }
            return .assistantDelta(threadId: f.threadId, turnId: f.turnId, text: f.text)
        case "assistant-done":
            guard let f: AssistantDoneFrameIn = d(AssistantDoneFrameIn.self) else { return nil }
            return .assistantDone(threadId: f.threadId, turnId: f.turnId, seq: f.seq, message: f.message)
        case "assistant-error":
            guard let f: AssistantErrorFrameIn = d(AssistantErrorFrameIn.self) else { return nil }
            return .assistantError(threadId: f.threadId, kind: f.error.kind, message: f.error.message)
        case "tool-call":
            guard let f: ToolCallFrameIn = d(ToolCallFrameIn.self) else { return nil }
            return .toolCall(threadId: f.threadId, turnId: f.turnId, toolCallId: f.toolCallId, name: f.name, input: f.input)
        case "tool-result":
            guard let f: ToolResultFrameIn = d(ToolResultFrameIn.self) else { return nil }
            return .toolResult(threadId: f.threadId, toolCallId: f.toolCallId, ok: f.status == "ok", output: f.output, truncated: f.truncated)
        case "turn-complete":
            guard let f: ThreadIDFrameIn = d(ThreadIDFrameIn.self) else { return nil }
            return .turnComplete(threadId: f.threadId)
        case "thread-archived":
            guard let f: ThreadIDFrameIn = d(ThreadIDFrameIn.self) else { return nil }
            return .threadArchived(threadId: f.threadId)
        case "thread-unarchived":
            guard let f: ThreadIDFrameIn = d(ThreadIDFrameIn.self) else { return nil }
            return .threadUnarchived(threadId: f.threadId)
        case "result-delivered":
            guard let f: ResultDeliveredFrameIn = d(ResultDeliveredFrameIn.self) else { return nil }
            return .resultDelivered(threadId: f.threadId, label: f.label, preview: f.preview)
        default:
            return .ignored(probe.type)
        }
    }

    static func encode<E: Encodable>(_ frame: E) -> String? {
        guard let data = try? encoder.encode(frame) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

// MARK: - Client → server frames

struct PongFrameOut: Encodable { let type = "pong"; let ts: String }
struct SubscribeFrameOut: Encodable { let type = "subscribe"; let threadId: String }
struct UnsubscribeFrameOut: Encodable { let type = "unsubscribe"; let threadId: String }
struct ListThreadsFrameOut: Encodable {
    let type = "list-threads"
    let limit: Int?
    let status: String? // "active" | "archived", omit for default
}
struct ArchiveThreadFrameOut: Encodable { let type = "archive-thread"; let threadId: String }
struct InterruptFrameOut: Encodable { let type = "interrupt"; let threadId: String }

struct NewThreadFrameOut: Encodable {
    let type = "new-thread"
    let model: String?
    let effort: String?
    let title: String?
}

struct ClientInfo: Encodable {
    let name: String
    let version: String?
    let platform: String?
}

struct WireAttachment: Encodable {
    let mediaType: String
    let data: String // base64
}

struct UserMessageFrameOut: Encodable {
    let type = "user-message"
    let threadId: String
    let text: String
    let attachments: [WireAttachment]?
    let client: ClientInfo?
}
