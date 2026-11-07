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

/// Keeps the app attached to the player service: finds its socket, attaches as a remote, passes
/// on what the service broadcasts and runs calls there. When no service is running, it starts the
/// one of the installed extension; when the service exits (the extension was updated), it looks
/// for the next one. Everything runs on the main queue.
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
    private static let socketPrefix = "vscode-yandex-music-service-"

    var onLink: (LinkState) -> Void = { _ in }
    var onState: (SharedState, JSON) -> Void = { _, _ in }
    var onStatus: (PlaybackStatus) -> Void = { _ in }
    var onNotice: (String) -> Void = { _ in }

    private(set) var state: LinkState = .starting
    /// The connected socket's file descriptor, -1 when there is none.
    private var descriptor: Int32 = -1
    private var reader: DispatchSourceRead?
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
        guard descriptor >= 0, state == .connected else {
            throw ServiceError(message: "The player is not running.")
        }
        let id = nextId
        nextId += 1
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            write(["type": .string("call"), "id": .number(Double(id)), "method": .string(method), "args": .array(args)])
        }
    }

    private func setLink(_ newState: LinkState) {
        if newState != state {
            state = newState
            onLink(newState)
        }
    }

    private func later() {
        retryWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.attach() }
        retryWork = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + (state == .outdated ? Self.outdatedRetry : Self.retry),
            execute: work
        )
    }

    /// Sockets of running services, the most recently started first.
    private func serviceSockets() -> [String] {
        let dir = NSTemporaryDirectory()
        let files = FileManager.default
        guard let names = try? files.contentsOfDirectory(atPath: dir) else { return [] }
        let sockets = names.filter {
            $0.hasPrefix(Self.socketPrefix) && $0.hasSuffix(".sock") && $0.count == Self.socketPrefix.count + 12 + 5
        }
        return
            sockets
            .map { (dir as NSString).appendingPathComponent($0) }
            .compactMap { path -> (path: String, modified: Date)? in
                guard let modified = (try? files.attributesOfItem(atPath: path))?[.modificationDate] as? Date else {
                    return nil
                }
                return (path, modified)
            }
            .sorted { $0.modified > $1.modified }
            .map(\.path)
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
            setLink(.searching)  // it started but never answered; see its service.log
        }
    }

    private static func connect(_ path: String) -> Int32? {
        let socket = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard socket >= 0 else { return nil }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            close(socket)
            return nil
        }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            for (index, byte) in bytes.enumerated() { raw[index] = UInt8(bitPattern: byte) }
        }
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(socket, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else {
            close(socket)  // a socket left by a service that crashed
            return nil
        }
        var noSigPipe: Int32 = 1
        setsockopt(socket, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
        return socket
    }

    private func use(_ socket: Int32) {
        descriptor = socket
        buffer = Data()
        let welcome = DispatchWorkItem { [weak self] in self?.setLink(.oldService) }
        welcomeWork = welcome
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.welcomeWait, execute: welcome)
        let source = DispatchSource.makeReadSource(fileDescriptor: socket, queue: .main)
        source.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.readAvailable() }
        }
        reader = source
        source.resume()
        write(["type": .string("attach"), "protocol": .number(Double(protocolVersion))])
    }

    private func readAvailable() {
        var chunk = [UInt8](repeating: 0, count: 65536)
        let count = read(descriptor, &chunk, chunk.count)
        if count <= 0 {
            closed()
            return
        }
        buffer.append(contentsOf: chunk[0..<count])
        while let end = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<end]
            buffer.removeSubrange(buffer.startIndex...end)
            handle(Data(line))
        }
    }

    private func closed() {
        reader?.cancel()
        reader = nil
        if descriptor >= 0 {
            close(descriptor)
            descriptor = -1
        }
        welcomeWork?.cancel()
        let waiting = pending
        pending = [:]
        for request in waiting.values {
            request.resume(throwing: ServiceError(message: "The player service has stopped."))
        }
        if state != .outdated {
            setLink(.starting)
        }
        later()
    }

    private func handle(_ line: Data) {
        // A line that doesn't decode is skipped: the next update arrives in full anyway.
        guard let message = try? decoder.decode(Incoming.self, from: line) else { return }
        switch message.type {
        case "welcome":
            welcomeWork?.cancel()
            setLink(.connected)
            if visuals {
                write(["type": .string("visuals"), "want": .bool(true)])
            }
        case "state":
            if let state = message.state, let raw = try? decoder.decode([String: JSON].self, from: line)["state"] {
                onState(state, raw)
            }
        case "status":
            if let status = message.status { onStatus(status) }
        case "notice":
            if let text = message.text { onNotice(text) }
        case "outdated":
            setLink(.outdated)
        case "result":
            guard let id = message.id, let request = pending.removeValue(forKey: id) else { return }
            if let error = message.error {
                request.resume(throwing: ServiceError(message: error))
            } else {
                request.resume(returning: message.value)
            }
        default:
            break
        }
    }

    private func write(_ message: [String: JSON]) {
        guard descriptor >= 0, var data = try? JSONEncoder().encode(JSON.object(message)) else { return }
        data.append(0x0A)
        data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let written = Darwin.write(descriptor, raw.baseAddress! + offset, raw.count - offset)
                if written <= 0 { break }
                offset += written
            }
        }
    }
}
