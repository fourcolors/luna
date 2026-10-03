import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var host = ""
    @State private var port = 4753
    @State private var useTLS = false
    @State private var token = ""
    @State private var showScanner = false
    @State private var pairError: String?

    var body: some View {
        @Bindable var store = store
        Form {
            Section {
                Button {
                    if QRScannerView.isAvailable {
                        showScanner = true
                    } else {
                        pairError = "Camera unavailable. Paste the link instead."
                    }
                } label: {
                    Label("Scan code", systemImage: "qrcode.viewfinder")
                }
                Button { pasteLink() } label: {
                    Label("Paste link", systemImage: "doc.on.clipboard")
                }
                if let pairError {
                    Text(pairError)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            } header: {
                Text("Pair")
            } footer: {
                Text("Scan or paste the luna://connect link from your server.")
            }

            Section {
                TextField("Host", text: $host)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("Port", value: $port, format: .number.grouping(.never))
                    .keyboardType(.numberPad)
                SecureField("Access token", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Toggle("Use TLS", isOn: $useTLS)
            } header: {
                Text("Server")
            } footer: {
                Text("The chat server your desktop uses. It must be reachable from this phone.")
            }

            Section {
                HStack {
                    Text("Status")
                    Spacer()
                    Text(store.connection.label)
                        .foregroundStyle(.secondary)
                }
                if let label = store.serverLabel {
                    HStack {
                        Text("Server")
                        Spacer()
                        Text(label).foregroundStyle(.secondary)
                    }
                }
            }

            Section {
                Button(store.isConfigured ? "Save & Connect" : "Save") {
                    save()
                }
                .disabled(host.trimmingCharacters(in: .whitespaces).isEmpty || token.count < 16)
            }
        }
        .navigationTitle(store.isConfigured ? "Settings" : "Connect")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") { save(); dismiss() }
            }
        }
        .onAppear {
            host = store.host
            port = store.port
            useTLS = store.useTLS
            token = store.token
        }
        .sheet(isPresented: $showScanner) {
            NavigationStack {
                QRScannerView { payload in
                    showScanner = false
                    applyPairing(payload)
                }
                .ignoresSafeArea()
                .navigationTitle("Scan pairing code")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { showScanner = false }
                    }
                }
            }
        }
    }

    private func pasteLink() {
        guard let text = UIPasteboard.general.string, !text.isEmpty else {
            pairError = "Clipboard is empty"
            return
        }
        applyPairing(text)
    }

    private func applyPairing(_ payload: String) {
        guard let info = PairingInfo(urlString: payload) else {
            pairError = "Not a Luna pairing link"
            return
        }
        host = info.host
        port = info.port
        token = info.token
        useTLS = info.tls
        pairError = nil
        save()
    }

    private func save() {
        store.host = host
        store.port = port
        store.useTLS = useTLS
        store.token = token
        store.reconnect()
    }
}
