import Foundation

/**
 * What the player service sends and takes over its socket. These types mirror `src/core.ts`,
 * `src/api.ts` and `src/protocol.ts` of the extension; the app reads only the fields below, and
 * fields that older services don't send are optional.
 */

/// Version of the messages between remotes and the service, `PROTOCOL` in `src/protocol.ts`.
let protocolVersion = 2

/// Any JSON value. Tracks go back to the service as it sent them, with the fields the app doesn't read.
enum JSON: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSON].self) {
            self = .array(a)
        } else {
            self = .object(try c.decode([String: JSON].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case let .bool(b): try c.encode(b)
        case let .number(n): try c.encode(n)
        case let .string(s): try c.encode(s)
        case let .array(a): try c.encode(a)
        case let .object(o): try c.encode(o)
        }
    }

    subscript(key: String) -> JSON? {
        if case let .object(o) = self { return o[key] }
        return nil
    }

    var array: [JSON] {
        if case let .array(a) = self { return a }
        return []
    }
}

/// An ID the service sends as a number or a string.
struct FlexibleID: Codable, Hashable, Sendable, CustomStringConvertible {
    let value: String
    var description: String { value }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let n = try? c.decode(Int.self) {
            value = String(n)
        } else {
            value = try c.decode(String.self)
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(value)
    }
}

struct Artist: Codable, Sendable, Equatable {
    let id: FlexibleID
    let name: String
}

struct Album: Codable, Sendable, Equatable {
    let id: FlexibleID
    let title: String
}

struct Track: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let title: String
    let version: String?
    let durationMs: Double?
    let artists: [Artist]
    let albums: [Album]
    let coverUri: String?
    let available: Bool?

    /// The track ID without the album, as likes, dislikes, AI marks and visuals are keyed.
    var baseId: String { String(id.split(separator: ":").first ?? Substring(id)) }
    var fullTitle: String { version.map { "\(title) (\($0))" } ?? title }
    var artistLine: String { artists.map(\.name).joined(separator: ", ") }
    func cover(_ size: Int) -> URL? { coverURL(coverUri, size) }
}

struct Playlist: Codable, Sendable, Equatable {
    let uid: FlexibleID
    let kind: FlexibleID
    let title: String
    let trackCount: Int
    var key: String { "\(uid):\(kind)" }
}

struct Account: Codable, Sendable, Equatable {
    let uid: FlexibleID
    let login: String
    let displayName: String?
    let hasPlus: Bool
}

struct Station: Codable, Sendable, Equatable {
    let id: String
    let name: String
    let icon: String?
    let color: String?
}

enum Source: Codable, Sendable, Equatable {
    case wave
    case station(id: String, name: String)
    case liked
    case playlist(Playlist)
    case search(query: String)

    private enum Keys: String, CodingKey { case kind, id, name, playlist, query }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "station": self = .station(id: try c.decode(String.self, forKey: .id), name: try c.decode(String.self, forKey: .name))
        case "liked": self = .liked
        case "playlist": self = .playlist(try c.decode(Playlist.self, forKey: .playlist))
        case "search": self = .search(query: try c.decode(String.self, forKey: .query))
        default: self = .wave
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .wave:
            try c.encode("wave", forKey: .kind)
        case let .station(id, name):
            try c.encode("station", forKey: .kind)
            try c.encode(id, forKey: .id)
            try c.encode(name, forKey: .name)
        case .liked:
            try c.encode("liked", forKey: .kind)
        case let .playlist(p):
            try c.encode("playlist", forKey: .kind)
            try c.encode(p, forKey: .playlist)
        case let .search(query):
            try c.encode("search", forKey: .kind)
            try c.encode(query, forKey: .query)
        }
    }
}

struct PlaybackStatus: Codable, Sendable, Equatable {
    var playing = false
    var position: Double = 0
    var duration: Double = 0
    var trackId: String?
    var error: String?
}

/// Yandex Music's AI label of a track, `AiMark` in `src/aiMarks.ts`.
enum AiMark: String, Codable, Sendable {
    case full, partial, possible

    var badge: String { self == .possible ? "AI?" : "AI" }
    var help: String {
        switch self {
        case .full: "AI-generated, as labeled by Yandex Music"
        case .partial: "Partly AI-generated, as labeled by Yandex Music"
        case .possible: "Possibly made with AI, as labeled by Yandex Music"
        }
    }
}

struct WaveOption: Codable, Sendable, Equatable {
    let name: String
    let seed: String
    let any: Bool?
}

struct WaveSetting: Codable, Sendable, Equatable {
    let id: String
    let name: String
    let options: [WaveOption]
}

struct Genre: Codable, Sendable, Equatable {
    let id: String
    let title: String
    let color: String?
}

/// A track's videos and genre, `TrackVisuals` in `src/visuals.ts`.
struct TrackVisuals: Codable, Sendable, Equatable {
    let genre: Genre?
    let musicVideo: String?
    let youtubeId: String?
    let video: String?
    let artistVideo: String?
    let motionCover: String?
}

struct SharedState: Codable, Sendable, Equatable {
    var queue: [Track]
    var index: Int
    var source: Source?
    var liked: [String]
    var disliked: [String]?
    var playlists: [Playlist]
    var searchResults: [Track]
    var searchStations: [Station]?
    var account: Account?
    var accountChecked: Bool
    var lastError: String?
    var streamInfo: String?
    var aiMarks: [String: AiMark]?
    var volume: Double?
    var visuals: [String: TrackVisuals]?
    var likedTracks: [Track]?
    var waveOptions: [WaveSetting]?
    var waveSettings: [String: String]?

    var current: Track? { index >= 0 && index < queue.count ? queue[index] : nil }
}

func coverURL(_ uri: String?, _ size: Int) -> URL? {
    guard let uri, !uri.isEmpty else { return nil }
    if uri.hasPrefix("data:") { return URL(string: uri) }
    let u = uri.replacingOccurrences(of: "%%", with: "\(size)x\(size)")
    return URL(string: u.hasPrefix("http") ? u : "https://\(u)")
}
