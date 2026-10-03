import PhotosUI
import SwiftUI

/// Shared message composer — one rounded card holding the attach button,
/// multi-line field, and a filled send/stop circle (ChatGPT-style).
struct ComposerView: View {
    @Binding var draft: String
    var isRunning = false
    var isSending = false
    var autofocus = false
    var placeholder = "Message"
    var onSend: ([WireAttachment]) -> Void
    var onInterrupt: () -> Void = {}

    @State private var pickedItem: PhotosPickerItem?
    @State private var pendingImage: UIImage?
    @FocusState private var inputFocused: Bool

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || pendingImage != nil
    }

    var body: some View {
        VStack(spacing: 8) {
            if let pendingImage {
                HStack {
                    Image(uiImage: pendingImage)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 44, height: 44)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    Button { self.pendingImage = nil; pickedItem = nil } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .padding(.horizontal, 4)
            }
            HStack(alignment: .bottom, spacing: 6) {
                PhotosPicker(selection: $pickedItem, matching: .images) {
                    Image(systemName: "plus")
                        .font(.title3.weight(.medium))
                        .foregroundStyle(.secondary)
                        .frame(width: 34, height: 34)
                        .contentShape(Rectangle())
                }
                .onChange(of: pickedItem) { _, item in
                    guard let item else { return }
                    Task {
                        if let data = try? await item.loadTransferable(type: Data.self),
                            let image = UIImage(data: data)
                        {
                            pendingImage = image.downscaled()
                        }
                    }
                }

                TextField(placeholder, text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .focused($inputFocused)
                    .padding(.vertical, 8)

                if isRunning {
                    Button { onInterrupt() } label: {
                        Image(systemName: "stop.fill")
                            .font(.callout.weight(.bold))
                            .foregroundStyle(.white)
                            .frame(width: 34, height: 34)
                            .background(Color(.label), in: Circle())
                            .contentShape(Rectangle())
                    }
                } else if isSending {
                    ProgressView()
                        .frame(width: 34, height: 34)
                } else {
                    Button { send() } label: {
                        Image(systemName: "arrow.up")
                            .font(.callout.weight(.bold))
                            .foregroundStyle(.white)
                            .frame(width: 34, height: 34)
                            .background(
                                canSend ? Color.accentColor : Color(.systemGray3), in: Circle()
                            )
                            .contentShape(Rectangle())
                    }
                    .disabled(!canSend)
                }
            }
            .padding(.leading, 4)
            .padding(.trailing, 6)
            .padding(.vertical, 4)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
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
