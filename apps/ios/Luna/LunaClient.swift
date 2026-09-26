import Foundation

enum ConnectionState: Equatable {
    case disconnected
    case connecting
    case connected
    case failed(String)

    var label: String {
        switch self {
        case .disconnected: return "Offline"
        case .connecting: return "Connecting…"
        case .connected: return "Connected"
        case .failed(let m): return "Failed: \(m)"
        }
    }
}

/// Thin URLSessionWebSocketTask wrapper around the Luna chat server's
/// UI socket (`ws://host:4753/ui`, `Authorization: Bearer <token>`).
final class LunaClient {
    var onText: (String) -> Void = { _ in }
    var onStateChange: (ConnectionState) -> Void = { _ in }

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var sawFirstFrame = false

    func connect(host: String, port: Int, token: String, useTLS: Bool) {
        disconnect(notify: false)
        onStateChange(.connecting)

        var comps = URLComponents()
        comps.scheme = useTLS ? "wss" : "ws"
        comps.host = host
        comps.port = port
        comps.path = "/ui"
        guard let url = comps.url else {
            onStateChange(.failed("Bad server address"))
            return
        }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: req)
        self.session = session
        self.task = task
        sawFirstFrame = false
        task.resume()
        receiveLoop()
    }

    func send<E: Encodable>(_ frame: E) {
        guard let text = FrameCodec.encode(frame) else { return }
        task?.send(.string(text)) { _ in }
    }

    func disconnect(notify: Bool = true) {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        if notify { onStateChange(.disconnected) }
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                if !self.sawFirstFrame {
                    // The server sends `hello` immediately after upgrade; the
                    // first successful receive proves auth + handshake passed.
                    self.sawFirstFrame = true
                    self.onStateChange(.connected)
                }
                switch message {
                case .string(let s):
                    self.onText(s)
                case .data(let d):
                    if let s = String(data: d, encoding: .utf8) { self.onText(s) }
                @unknown default:
                    break
                }
                self.receiveLoop()
            case .failure(let error):
                self.onStateChange(.failed(error.localizedDescription))
            }
        }
    }
}
