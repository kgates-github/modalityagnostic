// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "speech-sidecar",
    platforms: [.macOS("27.0")],
    targets: [
        .executableTarget(name: "SpeechSidecar", path: "Sources/SpeechSidecar")
    ]
)
