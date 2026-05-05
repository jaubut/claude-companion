// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "claude-companion-menubar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "claude-companion-menubar",
            path: "Sources/claude-companion-menubar",
        ),
    ],
)
