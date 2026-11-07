import AppKit
import CryptoKit

private let extensionID = "entro.vscode-yandex-music"

/// An editor the extension may be installed in: its extensions folder, its name under
/// Application Support, and its app's bundle ID, whose Electron runs the service.
private struct Editor {
    let extensions: String
    let appSupport: String
    let bundleID: String
}

private let editors = [
    Editor(extensions: ".vscode", appSupport: "Code", bundleID: "com.microsoft.VSCode"),
    Editor(extensions: ".vscode-insiders", appSupport: "Code - Insiders", bundleID: "com.microsoft.VSCodeInsiders"),
    Editor(extensions: ".cursor", appSupport: "Cursor", bundleID: "com.todesktop.230313mzl4w4u92"),
    Editor(extensions: ".vscode-oss", appSupport: "VSCodium", bundleID: "com.vscodium"),
    Editor(extensions: ".windsurf", appSupport: "Windsurf", bundleID: "com.exafunction.windsurf"),
]

/// An installed copy of the extension, where its windows keep their global storage, and the
/// editor's executable, which runs the service in Node mode.
struct Install {
    let dir: URL
    let storageDir: URL
    let node: URL
}

private func version(_ dir: URL) -> [Int] {
    dir.lastPathComponent.dropFirst(extensionID.count + 1).split(whereSeparator: { !$0.isNumber }).compactMap {
        Int($0)
    }
}

private func newer(_ candidate: [Int], _ than: [Int]) -> Bool {
    for part in 0..<max(candidate.count, than.count) {
        let difference = (part < candidate.count ? candidate[part] : 0) - (part < than.count ? than[part] : 0)
        if difference != 0 { return difference > 0 }
    }
    return false
}

/// The newest copy of the extension, in the first editor (VS Code before its forks) where the
/// user has run it, so its windows find the service on the socket they look at.
/// `YM_EXTENSION_DIR`, `YM_STORAGE_DIR` and `YM_NODE` point at a copy elsewhere, for development.
func findInstall() -> Install? {
    let env = ProcessInfo.processInfo.environment
    if let dir = env["YM_EXTENSION_DIR"], let storage = env["YM_STORAGE_DIR"], let node = env["YM_NODE"] {
        return Install(
            dir: URL(fileURLWithPath: dir),
            storageDir: URL(fileURLWithPath: storage),
            node: URL(fileURLWithPath: node)
        )
    }
    let files = FileManager.default
    let home = files.homeDirectoryForCurrentUser
    var found: [(install: Install, used: Bool)] = []
    for editor in editors {
        let extensions = home.appendingPathComponent(editor.extensions).appendingPathComponent("extensions")
        guard let names = try? files.contentsOfDirectory(atPath: extensions.path) else { continue }
        var best: URL?
        for name in names where name.hasPrefix("\(extensionID)-") {
            let full = extensions.appendingPathComponent(name)
            if files.fileExists(atPath: full.appendingPathComponent("out/service.js").path),
                best.map({ newer(version(full), version($0)) }) ?? true
            {
                best = full
            }
        }
        guard let best,
            let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: editor.bundleID),
            let node = Bundle(url: app)?.executableURL
        else { continue }
        let storage = home.appendingPathComponent(
            "Library/Application Support/\(editor.appSupport)/User/globalStorage/\(extensionID)"
        )
        found.append((Install(dir: best, storageDir: storage, node: node), files.fileExists(atPath: storage.path)))
    }
    return (found.first(where: \.used) ?? found.first)?.install
}

/// The service's socket for this storage, as `socketPathFor(storageDir, 'service')` in `src/protocol.ts` names it.
func serviceSocket(_ install: Install) -> String {
    let digest = Insecure.SHA1.hash(data: Data(install.storageDir.path.utf8))
    let id = digest.map { String(format: "%02x", $0) }.joined().prefix(12)
    return (NSTemporaryDirectory() as NSString).appendingPathComponent("vscode-yandex-music-service-\(id).sock")
}

/// Starts the extension's player service the way a VS Code window does, with the editor's
/// Electron in Node mode. It runs on its own: it outlives the app while VS Code windows are
/// connected, and exits a few seconds after the last remote leaves.
func startService(_ install: Install) throws {
    let files = FileManager.default
    try files.createDirectory(at: install.storageDir, withIntermediateDirectories: true)
    let socket = serviceSocket(install)
    try? files.removeItem(atPath: socket)  // left over from a service that crashed: nothing answered on it
    let service = Process()
    service.executableURL = install.node
    service.arguments = [
        install.dir.appendingPathComponent("out/service.js").path,
        socket,
        install.dir.appendingPathComponent("helper/avplayer.js").path,
        install.storageDir.appendingPathComponent("service.log").path,
    ]
    var env = ProcessInfo.processInfo.environment
    env["ELECTRON_RUN_AS_NODE"] = "1"
    service.environment = env
    service.standardInput = FileHandle.nullDevice
    service.standardOutput = FileHandle.nullDevice
    service.standardError = FileHandle.nullDevice
    try service.run()
}
