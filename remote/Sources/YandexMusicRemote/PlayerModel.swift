import AppKit
import Observation

/// The drawer's panes; all but My Vibe's settings, which the tune button opens, have a tab.
enum Tab: String, CaseIterable {
    case queue, liked, playlists, search, vibe

    static let withButton: [Tab] = [.queue, .liked, .playlists, .search]
    var title: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
}

struct Toast: Equatable {
    let id = UUID()
    let text: String
    let error: Bool
}

/// Everything the window shows, kept up to date from the service, and what the user does to it.
@MainActor
@Observable
final class PlayerModel {
    static let volumeStep = 0.1
    /// Volume restored by unmuting when nothing was muted in this session.
    static let defaultVolume = 0.7
    private static let searchDelay: TimeInterval = 0.45
    private static let videoFrontKey = "videoInFront"

    var link: LinkState = .starting
    var state: SharedState?
    /// The state as the service sent it: tracks go back to it in full.
    private var rawState: JSON = .null
    var status = PlaybackStatus()
    /// When the status arrived: between updates the position runs on from it.
    var statusAt = Date()
    var drawerOpen = false
    var tab: Tab = .queue
    var toast: Toast?
    var query = ""
    /// The query the search results belong to.
    private(set) var searchedQuery = ""
    private(set) var searching = false
    private(set) var likedLoading = false
    private(set) var playlistsRequested = false
    private var waveOptionsRequested = false
    private var accountRequested = false
    private var lastError: String?
    private var preMuteVolume = PlayerModel.defaultVolume
    private var searchWork: DispatchWorkItem?
    /// Whether videos are wanted in front of the player, as the Video button left it: kept across tracks and launches.
    var videoFront = UserDefaults.standard.bool(forKey: PlayerModel.videoFrontKey)
    /// Where the current track's video plays, once it has started loading.
    var videoPlace: VideoPlace?
    var heartBeat = 0

    @ObservationIgnored let service = ServiceLink()

    init() {
        service.onLink = { [weak self] s in self?.linkChanged(s) }
        service.onState = { [weak self] s, raw in self?.stateChanged(s, raw) }
        service.onStatus = { [weak self] s in
            self?.status = s
            self?.statusAt = Date()
        }
        service.onNotice = { [weak self] text in
            self?.show(text.replacingOccurrences(of: "Yandex Music: ", with: ""))
        }
    }

    func start() {
        service.start()
    }

    // MARK: - Derived

    var current: Track? { state?.current }
    var next: Track? {
        guard let s = state, s.current != nil, s.index + 1 < s.queue.count else { return nil }
        return s.queue[s.index + 1]
    }
    var visuals: TrackVisuals? { current.flatMap { state?.visuals?[$0.baseId] } }
    func isLiked(_ t: Track) -> Bool { state?.liked.contains(t.baseId) ?? false }
    func isDisliked(_ t: Track) -> Bool { state?.disliked?.contains(t.baseId) ?? false }
    func aiMark(_ t: Track) -> AiMark? { state?.aiMarks?[t.baseId] }
    var duration: Double { status.duration > 0 ? status.duration : (current?.durationMs ?? 0) / 1000 }

    func position(at now: Date) -> Double {
        guard status.playing else { return status.position }
        let d = duration
        return min(status.position + now.timeIntervalSince(statusAt), d > 0 ? d : .infinity)
    }

    var playing: Bool { status.playing && current != nil }
    var showsVideoInFront: Bool { videoFront && videoPlace == .background }
    var waveTuned: Bool { !(state?.waveSettings ?? [:]).isEmpty }
    var trackRadio: Bool {
        guard let t = current, case let .station(id, _) = state?.source else { return false }
        return id == "track:\(t.baseId)"
    }

    /// The names of the My Vibe options chosen, rather than left to Yandex Music, in the settings' order.
    var waveChoices: [String] {
        let chosen = state?.waveSettings ?? [:]
        return (state?.waveOptions ?? []).flatMap { g in g.options.filter { chosen[g.id] == $0.seed }.map(\.name) }
    }

    var sourceLabel: String {
        switch state?.source {
        case .wave: (["My Vibe"] + waveChoices).joined(separator: " · ")
        case let .station(id, name): id.hasPrefix("track:") ? "Radio · \(name)" : "Station · \(name)"
        case .liked: "Liked"
        case let .playlist(p): p.title
        case let .search(q): "Search · \(q)"
        case nil: ""
        }
    }

    /// The overlay over the player while it can't be used: its title and text.
    var overlay: (String, String)? {
        switch link {
        case .starting: return ("Starting the player", "Connecting to Yandex Music…")
        case .searching: return ("The player didn’t start", "Open VS Code with the Yandex Music extension once, then try again. The remote keeps trying by itself.")
        case .noExtension: return ("Install Yandex Music for VS Code", "The remote controls the player of the Yandex Music extension. Install it in VS Code from the Extensions view, sign in there once, and the remote will start the player by itself.")
        case .outdated: return ("Update needed", "This remote and the Yandex Music extension in VS Code speak different versions. Update both, then reload the VS Code windows.")
        case .oldService: return ("Restart the player", "The player was started by an older version of the Yandex Music extension. Update the extension, then reload the VS Code windows.")
        case .connected:
            if let s = state, s.accountChecked, s.account == nil {
                return ("Sign in in VS Code", "Run “Yandex Music: Sign In” from the VS Code Command Palette.")
            }
            return nil
        }
    }

    // MARK: - From the service

    private func linkChanged(_ s: LinkState) {
        link = s
        if s != .connected { accountRequested = false }
        checkAccount()
    }

    private func stateChanged(_ s: SharedState, _ raw: JSON) {
        state = s
        rawState = raw
        checkAccount()
        if let e = s.lastError, e != lastError { show(e, error: true) }
        lastError = s.lastError
        // The chosen My Vibe options are named in the source label, which needs the settings' names.
        if case .wave = s.source, waveTuned, (s.waveOptions ?? []).isEmpty, !waveOptionsRequested {
            waveOptionsRequested = true
            run("loadWaveSettings")
        }
    }

    /// A service the app has just started hasn't looked up the account; VS Code windows do it on their own.
    private func checkAccount() {
        if link == .connected, let s = state, !s.accountChecked, !accountRequested {
            accountRequested = true
            run("refreshAccount")
        }
    }

    func show(_ text: String, error: Bool = false) {
        let t = Toast(text: text, error: error)
        toast = t
        DispatchQueue.main.asyncAfter(deadline: .now() + (error ? 6 : 3.5)) { [weak self] in
            if self?.toast == t { self?.toast = nil }
        }
    }

    // MARK: - Actions

    func run(_ method: String, _ args: [JSON] = [], then: (() -> Void)? = nil) {
        Task {
            do {
                try await service.call(method, args)
            } catch {
                show(error.localizedDescription, error: true)
            }
            then?()
        }
    }

    private func encode<T: Encodable>(_ value: T) -> JSON {
        (try? JSONDecoder().decode(JSON.self, from: JSONEncoder().encode(value))) ?? .null
    }

    func playPause() { run("playPause") }
    func nextTrack() { run("next") }
    func previous() { run("previous") }
    func dislike() { run("toggleDislike") }
    func startTrackRadio() { run("startTrackRadio") }
    func playWave() { run("playSource", [encode(Source.wave)]) }
    func play(_ source: Source) { run("playSource", [encode(source)]) }
    func playIndex(_ i: Int) { run("playIndex", [.number(Double(i))]) }

    /// Plays a list the state holds (`likedTracks`, `searchResults`) from a track in it, sending the tracks as the service sent them.
    func playList(_ key: String, from i: Int, as source: Source) {
        run("playTracks", [rawState[key] ?? .array([]), .number(Double(i)), encode(source)])
    }

    func like() {
        guard current != nil else { return }
        heartBeat += 1
        run("toggleLike")
    }

    func playGenre() {
        if let g = visuals?.genre { play(.station(id: "genre:\(g.id)", name: g.title)) }
    }

    func seek(fraction: Double) {
        let d = duration
        guard d > 0, current != nil else { return }
        let to = min(1, max(0, fraction)) * d
        status.position = to
        statusAt = Date()
        run("seek", [.number(to)])
    }

    func setVolume(_ value: Double) {
        let v = (min(1, max(0, value)) * 100).rounded() / 100
        state?.volume = v // shown at once; the service confirms with its next state
        run("setVolume", [.number(v)])
    }

    func stepVolume(_ delta: Double) { setVolume((state?.volume ?? Self.defaultVolume) + delta) }

    func toggleMute() {
        let v = state?.volume ?? Self.defaultVolume
        if v > 0 {
            preMuteVolume = v
            setVolume(0)
        } else {
            setVolume(preMuteVolume > 0 ? preMuteVolume : Self.defaultVolume)
        }
    }

    /// Picking the chosen option again leaves the setting to Yandex Music.
    func pickWave(_ setting: String, _ seed: String) {
        let again = state?.waveSettings?[setting] == seed
        run("setWaveSetting", [.string(setting), again ? .null : .string(seed)])
    }

    // MARK: - Drawer

    func openDrawer(_ open: Bool, _ which: Tab? = nil) {
        drawerOpen = open
        if let which { tab = which }
        guard open else { return }
        switch tab {
        case .vibe:
            if state?.account != nil, (state?.waveOptions ?? []).isEmpty, !waveOptionsRequested {
                waveOptionsRequested = true
                run("loadWaveSettings")
            }
        case .playlists:
            if state?.account != nil, (state?.playlists ?? []).isEmpty, !playlistsRequested {
                playlistsRequested = true
                run("loadPlaylists") { [weak self] in self?.playlistsRequested = false }
            }
        default:
            break
        }
    }

    /// Shows the Liked list without playing it; it's loaded afresh each time.
    func showLiked() {
        openDrawer(true, .liked)
        if state?.account != nil, !likedLoading {
            likedLoading = true
            run("loadLikedTracks") { [weak self] in self?.likedLoading = false }
        }
    }

    func toggleTune() { openDrawer(!(drawerOpen && tab == .vibe), .vibe) }
    func toggleLikedPill() { drawerOpen && tab == .liked ? openDrawer(false) : showLiked() }
    func selectTab(_ t: Tab) { t == .liked ? showLiked() : openDrawer(true, t) }

    func search(now: Bool) {
        searchWork?.cancel()
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            searching = true
            searchedQuery = q
            run("search", [.string(q)]) { [weak self] in self?.searching = false }
        }
        searchWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (now ? 0 : Self.searchDelay), execute: work)
    }

    // MARK: - Video in front

    /// Brings the background video to the front, over the whole player, or puts it back.
    func setVideoFront(_ front: Bool) {
        videoFront = front
        UserDefaults.standard.set(front, forKey: Self.videoFrontKey)
        if front { openDrawer(false) }
    }

    /// Esc: the field, the drawer, the video in front, then full screen, whichever is first.
    func escape(window: NSWindow?) {
        if drawerOpen {
            openDrawer(false)
        } else if showsVideoInFront {
            setVideoFront(false)
        } else if let window, window.styleMask.contains(.fullScreen) {
            window.toggleFullScreen(nil)
        }
    }
}
