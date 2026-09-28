import PhotosUI
import SwiftUI

/// Shared message composer — photo attach, multi-line field, send/stop/spinner.
struct ComposerView: View {
    @Binding var draft: String
    var isRunning = false
    var isSending = false
    var autofocus = false
    var placeholder = "Message Luna…"
    var onSend: ([WireAttachment]) -> Void
    var onInterrupt: () -> Void = {}

    @State private var pickedItem: PhotosPickerItem?
    @State private var pendingImage: UIImage?
    @FocusState private var inputFocused: Bool

    var body: some View {
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

                TextField(placeholder, text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .focused($inputFocused)

                if isRunning {
                    Button { onInterrupt() } label: {
                        Image(systemName: "stop.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.red)
                    }
                } else if isSending {
                    ProgressView()
                } else {
                    Button { send() } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                    }
                    .disabled(
                        draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            && pendingImage == nil)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
        .onAppear { if autofocus { inputFocused = true } }
    }

    private func send() {
        var attachments: [WireAttachment] = []
        if let pendingImage,
            let jpeg = pendingImage.jpegData(compressionQuality: 0.8)
        {
            attachments.append(
                WireAttachment(mediaType: "image/jpeg", data: jpeg.base64EncodedString()))
        }
        onSend(attachments)
        draft = ""
        pendingImage = nil
        pickedItem = nil
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
