import AVFoundation
import Observation
import SwiftUI

/// One video to show for a track: a file or an HLS stream, or a music video on YouTube, whose
/// stream yt-dlp finds; AVPlayer plays them all.
enum Visual: Equatable {
    case file(URL, musicVideo: Bool)
    case youtube(String)

    var key: String {
        switch self {
        case let .file(url, _): url.absoluteString
        case let .youtube(id): "youtube:\(id)"
        }
    }
}

enum VideoPlace: Equatable {
    case background, tile
}

/// The video to show, in order of preference: a music video (the iTunes Store's preview, then
/// the one on YouTube), the track's own video shot, the artist's video, the album's motion cover.
func pickVisual(_ v: TrackVisuals?) -> Visual? {
    guard let v else { return nil }
    if let s = v.musicVideo, let u = URL(string: s) { return .file(u, musicVideo: true) }
    if let id = v.youtubeId, YouTubeStreams.available { return .youtube(id) }
    for s in [v.video, v.artistVideo, v.motionCover] {
        if let s, let u = URL(string: s) { return .file(u, musicVideo: false) }
    }
    return nil
}

/**
 * The video streams of YouTube videos, as yt-dlp finds them: H.264 (or HEVC) without sound, no
 * larger than 720p, enough for a background, which AVPlayer plays as a plain file. A web view would play them too, but
 * its processes would cost more memory than the whole app. Google's links last some hours; a
 * found one is kept for one.
 */
enum YouTubeStreams {
    private static let keep: TimeInterval = 3600
    @MainActor private static var found: [String: (url: URL, at: Date)] = [:]
    private static let format = "bv*[vcodec^=avc1][height<=720]/bv*[vcodec^=hvc1][height<=720]/bv*[protocol=m3u8_native][height<=720]"

    /// yt-dlp, where Homebrew, pip or the user put it.
    static let tool: URL? = {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let paths = ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp", "\(home)/.local/bin/yt-dlp"]
            + (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map { "\($0)/yt-dlp" }
        return paths.first { FileManager.default.isExecutableFile(atPath: $0) }.map { URL(fileURLWithPath: $0) }
    }()

    static var available: Bool { tool != nil }

    @MainActor static func stream(_ id: String) async -> URL? {
        if let f = found[id], Date().timeIntervalSince(f.at) < keep { return f.url }
        guard let tool else { return nil }
        let url = await Task.detached { run(tool, id) }.value
        if let url { found[id] = (url, Date()) }
        return url
    }

    private static func run(_ tool: URL, _ id: String) -> URL? {
        let p = Process()
        p.executableURL = tool
        p.arguments = ["-q", "--no-warnings", "--no-playlist", "-f", format, "--get-url", "https://www.youtube.com/watch?v=\(id)"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0, let text = String(data: data, encoding: .utf8) else { return nil }
        return text.split(separator: "\n").first.flatMap { URL(string: String($0)) }
    }
}

/**
 * Plays one video at a time, without sound, wherever it fits: a wide one fills the background,
 * a tall or square one takes the cover's tile. The video plays only while the music does and the
 * window is visible.
 */
@MainActor
@Observable
final class VideoStage {
    private(set) var player: AVPlayer?
    private(set) var place: VideoPlace?
    /// The video has started playing; it fades in then.
    private(set) var shown = false
    var onPlace: (VideoPlace?) -> Void = { _ in }

    /// A video on YouTube drifts this far from the track before it is put back in step.
    private static let youtubeDrift: Double = 3

    private var key = ""
    /// The video is the track's music video from YouTube, which keeps to the track's position.
    private var inStep = false
    private var playing = false
    var visible = true {
        didSet { apply() }
    }
    /// Where the track is now, for a YouTube video to follow.
    var position: () -> Double = { 0 }
    private var observers: [NSKeyValueObservation] = []
    private var endObserver: NSObjectProtocol?

    private var active: Bool { playing && visible }

    func show(_ visual: Visual?) {
        guard (visual?.key ?? "") != key else { return }
        key = visual?.key ?? ""
        clear()
        switch visual {
        case let .file(url, musicVideo):
            load(url, background: musicVideo)
        case let .youtube(id):
            let key = key
            Task {
                guard let url = await YouTubeStreams.stream(id), self.key == key else { return }
                inStep = true
                load(url, background: true)
            }
        case nil:
            break
        }
    }

    /// Follows the music: plays and pauses with it, and keeps a YouTube video at the track's position.
    func follow(playing: Bool) {
        if playing != self.playing {
            self.playing = playing
            apply()
        }
    }

    /// Puts a YouTube video back in step with the track when it has drifted.
    func keepInStep() {
        guard inStep, active, let player, player.currentItem?.status == .readyToPlay else { return }
        let at = position()
        if abs(player.currentTime().seconds - at) > Self.youtubeDrift {
            player.seek(to: CMTime(seconds: at, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        }
    }

    private func apply() {
        guard let player else { return }
        if active { player.play() } else { player.pause() }
    }

    private func setPlace(_ p: VideoPlace?) {
        place = p
        onPlace(p)
    }

    private func clear() {
        observers = []
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        player = nil
        shown = false
        inStep = false
        setPlace(nil)
    }

    /// A music video always goes to the background; another video goes there only if it is wide.
    private func load(_ url: URL, background: Bool) {
        let item = AVPlayerItem(url: url)
        // A plain MP4 (YouTube's) is otherwise fetched far ahead, all of it kept in memory.
        item.preferredForwardBufferDuration = 10
        // Only as sharp as the screen it fills: a smaller stream is less to fetch and decode.
        item.preferredMaximumResolution = NSScreen.main.map { $0.frame.size.applying(.init(scaleX: $0.backingScaleFactor, y: $0.backingScaleFactor)) } ?? .zero
        let p = AVPlayer(playerItem: item)
        p.isMuted = true
        p.preventsDisplaySleepDuringVideoPlayback = false
        player = p
        let key = self.key
        observers.append(item.observe(\.status) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self, self.key == key else { return }
                switch item.status {
                case .readyToPlay:
                    let size = item.presentationSize
                    let wide = background || (size.height > 0 && size.width / size.height > 1.2)
                    self.setPlace(wide ? .background : .tile)
                    if self.inStep {
                        p.seek(to: CMTime(seconds: self.position(), preferredTimescale: 600))
                    }
                    self.apply()
                case .failed:
                    self.clear() // the cover stays
                default:
                    break
                }
            }
        })
        observers.append(p.observe(\.timeControlStatus) { [weak self] player, _ in
            DispatchQueue.main.async {
                if player.timeControlStatus == .playing, self?.key == key { self?.shown = true }
            }
        })
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak p] _ in
            p?.seek(to: .zero)
            p?.play()
        }
    }
}

/// An AVPlayer's picture, filling its frame as the gravity says.
struct PlayerLayerView: NSViewRepresentable {
    let player: AVPlayer
    let gravity: AVLayerVideoGravity

    func makeNSView(context: Context) -> PlayerNSView {
        let v = PlayerNSView()
        v.playerLayer.player = player
        v.playerLayer.videoGravity = gravity
        return v
    }

    func updateNSView(_ v: PlayerNSView, context: Context) {
        if v.playerLayer.player !== player { v.playerLayer.player = player }
        v.playerLayer.videoGravity = gravity
    }

    final class PlayerNSView: NSView {
        let playerLayer = AVPlayerLayer()

        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
            layer = playerLayer
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func layout() {
            super.layout()
            playerLayer.frame = bounds
        }
    }
}
