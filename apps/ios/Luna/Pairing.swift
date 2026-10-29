import Foundation

/// A `luna://connect?host=…&port=…&token=…&tls=0|1` payload, as printed by
/// `apps/server/scripts/pair-qr.ts` (terminal QR or pasted link).
struct PairingInfo {
    var host: String
    var port: Int
    var token: String
    var tls: Bool

    init?(urlString: String) {
        guard let comps = URLComponents(
            string: urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        ),
            comps.scheme == "luna",
            comps.host == "connect"
        else { return nil }

        let q = comps.queryItems ?? []
        func val(_ name: String) -> String? { q.first { $0.name == name }?.value }

        guard let host = val("host"), !host.isEmpty,
              let token = val("token"), token.count >= 16
        else { return nil }

        let port = val("port").flatMap(Int.init) ?? 4753
        guard port > 0, port <= 65535 else { return nil }

        self.host = host
        self.port = port
        self.token = token
        self.tls = val("tls") == "1"
    }
}
