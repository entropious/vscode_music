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
        service.onLink = { [weak self] link in self?.linkChanged(link) }
        service.onState = { [weak self] state, raw in self?.stateChanged(state, raw) }
        service.onStatus = { [weak self] status in
            self?.status = status
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
        guard let state, state.current != nil, state.index + 1 < state.queue.count else { return nil }
        return state.queue[state.index + 1]
    }
    var visuals: TrackVisuals? { current.flatMap { state?.visuals?[$0.baseId] } }
    func isLiked(_ track: Track) -> Bool { state?.liked.contains(track.baseId) ?? false }
    func isDisliked(_ track: Track) -> Bool { state?.disliked?.contains(track.baseId) ?? false }
    func aiMark(_ track: Track) -> AiMark? { state?.aiMarks?[track.baseId] }
    var duration: Double { status.duration > 0 ? status.duration : (current?.durationMs ?? 0) / 1000 }

    func position(at now: Date) -> Double {
        guard status.playing else { return status.position }
        let length = duration
        return min(status.position + now.timeIntervalSince(statusAt), length > 0 ? length : .infinity)
    }

    var playing: Bool { status.playing && current != nil }
    var showsVideoInFront: Bool { videoFront && videoPlace == .background }
    var waveTuned: Bool { !(state?.waveSettings ?? [:]).isEmpty }
    var trackRadio: Bool {
        guard let current, case .station(let id, _) = state?.source else { return false }
        return id == "track:\(current.baseId)"
    }

    /// The names of the My Vibe options chosen, rather than left to Yandex Music, in the settings' order.
    var waveChoices: [String] {
        let chosen = state?.waveSettings ?? [:]
        return (state?.waveOptions ?? []).flatMap { setting in
            setting.options.filter { chosen[setting.id] == $0.seed }.map(\.name)
        }
    }

    var sourceLabel: String {
        switch state?.source {
        case .wave: (["My Vibe"] + waveChoices).joined(separator: " · ")
        case .station(let id, let name): id.hasPrefix("track:") ? "Radio · \(name)" : "Station · \(name)"
        case .liked: "Liked"
        case .playlist(let playlist): playlist.title
        case .search(let query): "Search · \(query)"
        case nil: ""
        }
    }

    /// The overlay over the player while it can't be used: its title and text.
    var overlay: (String, String)? {
        switch link {
        case .starting: return ("Starting the player", "Connecting to Yandex Music…")
        case .searching:
            return (
                "The player didn’t start",
                "Open VS Code with the Yandex Music extension once, then try again. The remote keeps trying by itself."
            )
        case .noExtension:
            return (
                "Install Yandex Music for VS Code",
                "The remote controls the player of the Yandex Music extension. Install it in VS Code "
                    + "from the Extensions view, sign in there once, and the remote will start the player by itself."
            )
        case .outdated:
            return (
                "Update needed",
                "This remote and the Yandex Music extension in VS Code speak different versions. "
                    + "Update both, then reload the VS Code windows."
            )
        case .oldService:
            return (
                "Restart the player",
                "The player was started by an older version of the Yandex Music extension. "
                    + "Update the extension, then reload the VS Code windows."
            )
        case .connected:
            if let state, state.accountChecked, state.account == nil {
                return ("Sign in in VS Code", "Run “Yandex Music: Sign In” from the VS Code Command Palette.")
            }
            return nil
        }
    }

    // MARK: - From the service

    private func linkChanged(_ newLink: LinkState) {
        link = newLink
        if newLink != .connected { accountRequested = false }
        checkAccount()
    }

    private func stateChanged(_ newState: SharedState, _ raw: JSON) {
        state = newState
        rawState = raw
        checkAccount()
        if let error = newState.lastError, error != lastError { show(error, error: true) }
        lastError = newState.lastError
        // The chosen My Vibe options are named in the source label, which needs the settings' names.
        if case .wave = newState.source, waveTuned, (newState.waveOptions ?? []).isEmpty, !waveOptionsRequested {
            waveOptionsRequested = true
            run("loadWaveSettings")
        }
    }

    /// A service the app has just started hasn't looked up the account; VS Code windows do it on their own.
    private func checkAccount() {
        if link == .connected, let state, !state.accountChecked, !accountRequested {
            accountRequested = true
            run("refreshAccount")
        }
    }

    func show(_ text: String, error: Bool = false) {
        let shown = Toast(text: text, error: error)
        toast = shown
        DispatchQueue.main.asyncAfter(deadline: .now() + (error ? 6 : 3.5)) { [weak self] in
            if self?.toast == shown { self?.toast = nil }
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
    func playIndex(_ index: Int) { run("playIndex", [.number(Double(index))]) }

    /// Plays a list the state holds (`likedTracks`, `searchResults`) from a track in it, sending
    /// the tracks as the service sent them.
    func playList(_ key: String, from index: Int, as source: Source) {
        run("playTracks", [rawState[key] ?? .array([]), .number(Double(index)), encode(source)])
    }

    func like() {
        guard current != nil else { return }
        heartBeat += 1
        run("toggleLike")
    }

    func playGenre() {
        if let genre = visuals?.genre { play(.station(id: "genre:\(genre.id)", name: genre.title)) }
    }

    func seek(fraction: Double) {
        let length = duration
        guard length > 0, current != nil else { return }
        let target = min(1, max(0, fraction)) * length
        status.position = target
        statusAt = Date()
        run("seek", [.number(target)])
    }

    func setVolume(_ value: Double) {
        let volume = (min(1, max(0, value)) * 100).rounded() / 100
        state?.volume = volume  // shown at once; the service confirms with its next state
        run("setVolume", [.number(volume)])
    }

    func stepVolume(_ delta: Double) { setVolume((state?.volume ?? Self.defaultVolume) + delta) }

    func toggleMute() {
        let volume = state?.volume ?? Self.defaultVolume
        if volume > 0 {
            preMuteVolume = volume
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
    func selectTab(_ tab: Tab) { tab == .liked ? showLiked() : openDrawer(true, tab) }

    func search(now: Bool) {
        searchWork?.cancel()
        let text = query.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            searching = true
            searchedQuery = text
            run("search", [.string(text)]) { [weak self] in self?.searching = false }
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
