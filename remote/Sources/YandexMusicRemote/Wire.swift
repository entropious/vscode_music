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
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let flag = try? container.decode(Bool.self) {
            self = .bool(flag)
        } else if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else if let text = try? container.decode(String.self) {
            self = .string(text)
        } else if let items = try? container.decode([JSON].self) {
            self = .array(items)
        } else {
            self = .object(try container.decode([String: JSON].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let flag): try container.encode(flag)
        case .number(let number): try container.encode(number)
        case .string(let text): try container.encode(text)
        case .array(let items): try container.encode(items)
        case .object(let fields): try container.encode(fields)
        }
    }

    subscript(key: String) -> JSON? {
        if case .object(let fields) = self { return fields[key] }
        return nil
    }

    var array: [JSON] {
        if case .array(let items) = self { return items }
        return []
    }
}

/// An ID the service sends as a number or a string.
struct FlexibleID: Codable, Hashable, Sendable, CustomStringConvertible {
    let value: String
    var description: String { value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let number = try? container.decode(Int.self) {
            value = String(number)
        } else {
            value = try container.decode(String.self)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(value)
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
        let container = try decoder.container(keyedBy: Keys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "station":
            self = .station(
                id: try container.decode(String.self, forKey: .id),
                name: try container.decode(String.self, forKey: .name)
            )
        case "liked": self = .liked
        case "playlist": self = .playlist(try container.decode(Playlist.self, forKey: .playlist))
        case "search": self = .search(query: try container.decode(String.self, forKey: .query))
        default: self = .wave
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        switch self {
        case .wave:
            try container.encode("wave", forKey: .kind)
        case .station(let id, let name):
            try container.encode("station", forKey: .kind)
            try container.encode(id, forKey: .id)
            try container.encode(name, forKey: .name)
        case .liked:
            try container.encode("liked", forKey: .kind)
        case .playlist(let playlist):
            try container.encode("playlist", forKey: .kind)
            try container.encode(playlist, forKey: .playlist)
        case .search(let query):
            try container.encode("search", forKey: .kind)
            try container.encode(query, forKey: .query)
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
    let sized = uri.replacingOccurrences(of: "%%", with: "\(size)x\(size)")
    return URL(string: sized.hasPrefix("http") ? sized : "https://\(sized)")
}
