import SwiftUI
import Vision
import VisionKit

/// Live camera QR scanner — thin UIViewControllerRepresentable over VisionKit's
/// DataScannerViewController (iOS 16+, not subclassable → wrapped in a container
/// that starts scanning on viewDidAppear). Calls `onCode` with the first decoded
/// payload; callers dismiss the sheet.
struct QRScannerView: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    static var isAvailable: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var fired = false
        let onCode: (String) -> Void

        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            guard !fired else { return }
            for item in addedItems {
                if case .barcode(let barcode) = item, let payload = barcode.payloadStringValue {
                    fired = true
                    onCode(payload)
                    return
                }
            }
        }
    }

    final class ScannerContainerViewController: UIViewController {
        let scanner: DataScannerViewController

        init(scanner: DataScannerViewController) {
            self.scanner = scanner
            super.init(nibName: nil, bundle: nil)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

        override func viewDidLoad() {
            super.viewDidLoad()
            addChild(scanner)
            scanner.view.frame = view.bounds
            scanner.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(scanner.view)
            scanner.didMove(toParent: self)
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            try? scanner.startScanning()
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            scanner.stopScanning()
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    func makeUIViewController(context: Context) -> ScannerContainerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        return ScannerContainerViewController(scanner: scanner)
    }

    func updateUIViewController(
        _ uiViewController: ScannerContainerViewController, context: Context
    ) {}
}
