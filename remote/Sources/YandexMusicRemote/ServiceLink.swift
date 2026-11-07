import Foundation

/// The link to the player service, as the window sees it.
enum LinkState: Equatable, Sendable {
    /// No service answered; the app has started the extension's service and waits for it.
    case starting
    /// The service didn't come up.
    case searching
    /// The Yandex Music extension isn't installed in VS Code or one of its forks.
    case noExtension
    /// The service took the app as its remote.
    case connected
    /// The service speaks another protocol; the app or the extension needs an update.
    case outdated
    /// The service predates remotes other than VS Code windows.
    case oldService
}

struct ServiceError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// What the service sends; the state and the status come with their raw JSON.
private struct Incoming: Decodable {
    let type: String
    let id: Int?
    let value: JSON?
    let error: String?
    let state: SharedState?
    let status: PlaybackStatus?
    let text: String?
}

/**
 * Keeps the app attached to the player service: finds its socket, attaches as a remote, passes
 * on what the service broadcasts and runs calls there. When no service is running, it starts the
 * one of the installed extension; when the service exits (the extension was updated), it looks
 * for the next one. Everything runs on the main queue.
 */
@MainActor
final class ServiceLink {
    private static let retry: TimeInterval = 1.5
    /// A service that turned the app away is asked again rarely, until a VS Code update replaces it.
    private static let outdatedRetry: TimeInterval = 15
    /// How often the app may start the service itself, and how long it waits for one it started.
    private static let launchEvery: TimeInterval = 30
    private static let launchWait: TimeInterval = 8
    /// A service that answers `attach` with silence predates remotes other than windows.
    private static let welcomeWait: TimeInterval = 2.5

    var onLink: (LinkState) -> Void = { _ in }
    var onState: (SharedState, JSON) -> Void = { _, _ in }
    var onStatus: (PlaybackStatus) -> Void = { _ in }
    var onNotice: (String) -> Void = { _ in }

    private(set) var state: LinkState = .starting
    private var fd: Int32 = -1
    private var source: DispatchSourceRead?
    private var buffer = Data()
    private var nextId = 1
    private var pending: [Int: CheckedContinuation<JSON?, Error>] = [:]
    private var retryWork: DispatchWorkItem?
    private var welcomeWork: DispatchWorkItem?
    private var launchedAt: Date = .distantPast
    private var visuals = false
    private let decoder = JSONDecoder()

    func start() {
        attach()
    }

    /// Asks the service for the tracks' videos and genres, or stops asking.
    func wantVisuals(_ want: Bool) {
        visuals = want
        if state == .connected {
            write(["type": .string("visuals"), "want": .bool(want)])
        }
    }

    @discardableResult
    func call(_ method: String, _ args: [JSON] = []) async throws -> JSON? {
        guard fd >= 0, state == .connected else { throw ServiceError(message: "The player is not running.") }
        let id = nextId
        nextId += 1
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            write(["type": .string("call"), "id": .number(Double(id)), "method": .string(method), "args": .array(args)])
        }
    }

    private func setLink(_ s: LinkState) {
        if s != state {
            state = s
            onLink(s)
        }
    }

    private func later() {
        retryWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.attach() }
        retryWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (state == .outdated ? Self.outdatedRetry : Self.retry), execute: work)
    }

    /// Sockets of running services, the most recently started first.
    private func serviceSockets() -> [String] {
        let dir = NSTemporaryDirectory()
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dir) else { return [] }
        let sockets = names.filter { $0.hasPrefix("vscode-yandex-music-service-") && $0.hasSuffix(".sock") && $0.count == "vscode-yandex-music-service-".count + 12 + 5 }
        return sockets
            .map { (dir as NSString).appendingPathComponent($0) }
            .compactMap { path -> (String, Date)? in
                guard let at = (try? fm.attributesOfItem(atPath: path))?[.modificationDate] as? Date else { return nil }
                return (path, at)
            }
            .sorted { $0.1 > $1.1 }
            .map(\.0)
    }

    private func attach() {
        for path in serviceSockets() {
            if let socket = Self.connect(path) {
                use(socket)
                return
            }
        }
        launch()
        later()
    }

    /// Starts the extension's service, unless one started recently is still coming up.
    private func launch() {
        guard let install = findInstall() else {
            setLink(.noExtension)
            return
        }
        let since = Date().timeIntervalSince(launchedAt)
        if since > Self.launchEvery {
            launchedAt = Date()
            do {
                try startService(install)
                setLink(.starting)
            } catch {
                setLink(.searching)
            }
        } else if since > Self.launchWait {
            setLink(.searching) // it started but never answered; see its service.log
        }
    }

    private static func connect(_ path: String) -> Int32? {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else {
            close(fd)
            return nil
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for (i, b) in bytes.enumerated() { raw[i] = UInt8(bitPattern: b) }
        }
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard ok == 0 else {
            close(fd) // a socket left by a service that crashed
            return nil
        }
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        return fd
    }

    private func use(_ socket: Int32) {
        fd = socket
        buffer = Data()
        let welcome = DispatchWorkItem { [weak self] in self?.setLink(.oldService) }
        welcomeWork = welcome
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.welcomeWait, execute: welcome)
        let src = DispatchSource.makeReadSource(fileDescriptor: socket, queue: .main)
        src.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.readAvailable() }
        }
        source = src
        src.resume()
        write(["type": .string("attach"), "protocol": .number(Double(protocolVersion))])
    }

    private func readAvailable() {
        var chunk = [UInt8](repeating: 0, count: 65536)
        let n = read(fd, &chunk, chunk.count)
        if n <= 0 {
            closed()
            return
        }
        buffer.append(contentsOf: chunk[0..<n])
        while let end = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<end]
            buffer.removeSubrange(buffer.startIndex...end)
            handle(Data(line))
        }
    }

    private func closed() {
        source?.cancel()
        source = nil
        if fd >= 0 {
            close(fd)
            fd = -1
        }
        welcomeWork?.cancel()
        let waiting = pending
        pending = [:]
        for c in waiting.values {
            c.resume(throwing: ServiceError(message: "The player service has stopped."))
        }
        if state != .outdated {
            setLink(.starting)
        }
        later()
    }

    private func handle(_ line: Data) {
        guard let m = try? decoder.decode(Incoming.self, from: line) else { return } // the next update arrives in full anyway
        switch m.type {
        case "welcome":
            welcomeWork?.cancel()
            setLink(.connected)
            if visuals {
                write(["type": .string("visuals"), "want": .bool(true)])
            }
        case "state":
            if let s = m.state, let raw = try? decoder.decode([String: JSON].self, from: line)["state"] {
                onState(s, raw)
            }
        case "status":
            if let s = m.status { onStatus(s) }
        case "notice":
            if let t = m.text { onNotice(t) }
        case "outdated":
            setLink(.outdated)
        case "result":
            guard let id = m.id, let c = pending.removeValue(forKey: id) else { return }
            if let error = m.error {
                c.resume(throwing: ServiceError(message: error))
            } else {
                c.resume(returning: m.value)
            }
        default:
            break
        }
    }

    private func write(_ message: [String: JSON]) {
        guard fd >= 0, var data = try? JSONEncoder().encode(JSON.object(message)) else { return }
        data.append(0x0A)
        data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let n = Darwin.write(fd, raw.baseAddress! + offset, raw.count - offset)
                if n <= 0 { break }
                offset += n
            }
        }
    }
}
