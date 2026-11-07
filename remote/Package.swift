// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "YandexMusicRemote",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "YandexMusicRemote",
            resources: [.copy("Resources")]
        ),
    ]
)
