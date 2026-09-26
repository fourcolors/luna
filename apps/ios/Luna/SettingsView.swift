import SwiftUI

struct SettingsView: View {
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var host = ""
    @State private var port = 4753
    @State private var useTLS = false
    @State private var token = ""

    var body: some View {
        @Bindable var store = store
        Form {
            Section {
                TextField("Host (e.g. 192.168.1.10)", text: $host)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("Port", value: $port, format: .number)
                    .keyboardType(.numberPad)
                SecureField("Access token (≥16 chars)", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Toggle("TLS (wss://)", isOn: $useTLS)
            } header: {
                Text("Chat server")
            } footer: {
                Text("Same server your Luna desktop talks to — ws://host:4753/ui with the UI_WS_TOKEN bearer token. The server must be reachable from this phone (LAN IP or tunnel).")
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
        .navigationTitle("Settings")
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
    }

    private func save() {
        store.host = host
        store.port = port
        store.useTLS = useTLS
        store.token = token
        store.reconnect()
    }
}
