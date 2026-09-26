import SwiftUI

struct NewThreadView: View {
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var title = ""
    @State private var modelID: String?
    @State private var effort: String?

    private var selectedModel: ModelOption? {
        store.models.first { $0.id == modelID }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title (optional)", text: $title)
                }
                if !store.models.isEmpty {
                    Section("Model") {
                        Picker("Model", selection: $modelID) {
                            Text("Server default").tag(String?.none)
                            ForEach(store.models) { m in
                                Text(m.label).tag(String?.some(m.id))
                            }
                        }
                        if let efforts = selectedModel?.efforts, !efforts.isEmpty {
                            Picker("Effort", selection: $effort) {
                                ForEach(efforts, id: \.self) { e in
                                    Text(e).tag(String?.some(e))
                                }
                                Text("Auto").tag(String?.none)
                            }
                        }
                    }
                }
            }
            .navigationTitle("New thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        store.createThread(title: title, modelID: modelID, effort: effort)
                        dismiss()
                    }
                }
            }
            .onChange(of: modelID) { _, _ in
                effort = selectedModel?.defaultEffort
            }
        }
    }
}
