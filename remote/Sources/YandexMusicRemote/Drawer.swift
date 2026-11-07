import SwiftUI

/// The side panel with the queue, Liked, playlists, search and My Vibe's settings.
struct DrawerView: View {
    @Environment(PlayerModel.self) private var model
    @FocusState private var queryFocused: Bool

    var body: some View {
        VStack(spacing: 14) {
            HStack(spacing: 10) {
                HStack(spacing: 4) {
                    ForEach(Tab.withButton, id: \.self) { tab in
                        Button {
                            model.selectTab(tab)
                        } label: {
                            Text(tab.title)
                                .font(Fonts.sans(20, .semibold))
                                .foregroundStyle(model.tab == tab ? .white : .white.opacity(0.7))
                                .frame(maxWidth: .infinity, minHeight: 56)
                                .background(
                                    model.tab == tab ? Color.white.opacity(0.16) : .clear,
                                    in: RoundedRectangle(cornerRadius: 15)
                                )
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(5)
                .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 20))
                Button {
                    model.openDrawer(false)
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 22, weight: .semibold))
                        .frame(width: 66, height: 66)
                        .chip(
                            RoundedRectangle(cornerRadius: 20),
                            base: .white.opacity(0.08),
                            hover: .white.opacity(0.18)
                        )
                }
                .buttonStyle(PressStyle())
                .help("Close")
            }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        switch model.tab {
                        case .queue: queue
                        case .liked: liked
                        case .playlists: playlists
                        case .search: search
                        case .vibe: vibe
                        }
                    }
                    .padding(.trailing, 4)
                }
                .scrollIndicators(.automatic)
                .onChange(of: model.state?.index, initial: true) { _, index in
                    if model.tab == .queue, let index { proxy.scrollTo(index, anchor: .center) }
                }
            }
        }
        .padding(18)
        .background(
            Color(red: 12 / 255, green: 14 / 255, blue: 20 / 255).opacity(0.9),
            in: RoundedRectangle(cornerRadius: 32)
        )
        .overlay(RoundedRectangle(cornerRadius: 32).stroke(.white.opacity(0.12), lineWidth: 1))
        .shadow(color: .black.opacity(0.45), radius: 40, y: 30)
        .onChange(of: model.tab, initial: true) { _, tab in queryFocused = tab == .search }
    }

    private func hint(_ text: String) -> some View {
        Text(text)
            .font(Fonts.sans(20))
            .lineSpacing(6)
            .foregroundStyle(.white.opacity(0.66))
            .padding(.vertical, 12)
            .padding(.horizontal, 8)
    }

    @ViewBuilder private var queue: some View {
        if let state = model.state, !state.queue.isEmpty {
            ForEach(Array(state.queue.enumerated()), id: \.offset) { index, track in
                TrackRow(track: track, current: index == state.index, past: index < state.index) {
                    model.playIndex(index)
                }
                .id(index)
            }
        } else {
            hint("The queue is empty. Start My Vibe or a playlist.")
        }
    }

    @ViewBuilder private var liked: some View {
        let tracks = model.state?.likedTracks ?? []
        if model.state?.account == nil {
            hint("Sign in to Yandex Music in VS Code to see your Liked tracks.")
        } else if tracks.isEmpty {
            hint(model.likedLoading ? "Loading Liked…" : "No Liked tracks yet.")
        } else {
            // Nothing plays until a track is picked; then Liked plays from it.
            ForEach(Array(tracks.enumerated()), id: \.offset) { index, track in
                TrackRow(track: track, current: model.current?.id == track.id) {
                    model.playList("likedTracks", from: index, as: .liked)
                }
            }
        }
    }

    @ViewBuilder private var vibe: some View {
        let settings = model.state?.waveOptions ?? []
        let chosen = model.state?.waveSettings ?? [:]
        if settings.isEmpty {
            hint(
                model.state?.account != nil
                    ? "Loading My Vibe settings…" : "Sign in to Yandex Music in VS Code to set up My Vibe."
            )
        } else {
            ForEach(settings, id: \.id) { setting in
                VStack(alignment: .leading, spacing: 12) {
                    Text(setting.name)
                        .font(Fonts.sans(17, .semibold))
                        .tracking(0.7)
                        .foregroundStyle(.white.opacity(0.66))
                    FlowLayout(spacing: 10) {
                        // No option chosen is the "any" one, left to Yandex Music.
                        ForEach(setting.options.filter { $0.any != true }, id: \.seed) { option in
                            let picked = chosen[setting.id] == option.seed
                            Button {
                                model.pickWave(setting.id, option.seed)
                            } label: {
                                Text(option.name)
                                    .font(Fonts.sans(20, picked ? .semibold : .medium))
                                    .foregroundStyle(picked ? Color.ink : .white)
                                    .padding(.horizontal, 22)
                                    .frame(height: 56)
                                    .chip(
                                        Capsule(),
                                        base: picked ? .accent : .white.opacity(0.06),
                                        hover: picked ? .accent : .white.opacity(0.12),
                                        border: picked ? .accent : .white.opacity(0.18)
                                    )
                            }
                            .buttonStyle(PressStyle())
                        }
                    }
                }
                .padding(.init(top: 8, leading: 6, bottom: 18, trailing: 6))
            }
            hint("While My Vibe plays, the tracks after the current one change at once.")
        }
    }

    private static let tileColors: [(Color, Color)] = [
        ("#8E1E10", "#FF5A36"), ("#0E3E48", "#5FE0C8"), ("#2E1B5C", "#B69CFF"),
        ("#5A4410", "#FFCC00"), ("#14305E", "#7FB4FF"), ("#1E2028", "#FF4F9A"),
    ].map { (Color(hex: $0.0), Color(hex: $0.1)) }

    @ViewBuilder private var playlists: some View {
        if let state = model.state, state.account != nil {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                let likedPlaying = if case .liked = state.source { true } else { false }
                PlaylistTile(
                    name: "Liked",
                    subtitle: "Your collection",
                    systemImage: "heart.fill",
                    colors: Self.tileColors[0],
                    current: likedPlaying,
                    action: model.showLiked
                )
                ForEach(state.playlists, id: \.key) { playlist in
                    let playing =
                        if case .playlist(let source) = state.source { source.key == playlist.key } else { false }
                    PlaylistTile(
                        name: playlist.title,
                        subtitle: "\(playlist.trackCount) \(playlist.trackCount == 1 ? "track" : "tracks")",
                        systemImage: "music.note.list",
                        colors: Self.tileColors[Int(stableHash(playlist.key) % UInt32(Self.tileColors.count))],
                        current: playing
                    ) { model.play(.playlist(playlist)) }
                }
            }
            if state.playlists.isEmpty {
                hint(model.playlistsRequested ? "Loading playlists…" : "No playlists yet.")
            }
        } else {
            hint("Sign in to Yandex Music in VS Code to see your playlists.")
        }
    }

    @ViewBuilder private var search: some View {
        @Bindable var model = model
        HStack(spacing: 12) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(.white.opacity(0.7))
            TextField("Track, artist or genre", text: $model.query)
                .textFieldStyle(.plain)
                .font(Fonts.sans(22))
                .focused($queryFocused)
                .onSubmit { model.search(now: true) }
                .onChange(of: model.query) { model.search(now: false) }
        }
        .padding(.horizontal, 20)
        .frame(height: 68)
        .background(.black.opacity(0.3), in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.accent, lineWidth: 2))
        .padding(.bottom, 4)
        let typed = model.query.trimmingCharacters(in: .whitespaces)
        let fresh = model.state != nil && !typed.isEmpty && typed == model.searchedQuery
        let stations = fresh ? model.state?.searchStations ?? [] : []
        let results = fresh ? model.state?.searchResults ?? [] : []
        if typed.isEmpty {
            hint("Type a track, artist or genre. Tap a result to play it.")
        } else if model.searching {
            hint("Searching…")
        } else if fresh, stations.isEmpty, results.isEmpty {
            hint("Nothing found")
        }
        ForEach(stations, id: \.id) { station in
            let playing = if case .station(let id, _) = model.state?.source { id == station.id } else { false }
            StationRow(station: station, current: playing) {
                model.play(.station(id: station.id, name: station.name))
            }
        }
        ForEach(Array(results.enumerated()), id: \.offset) { index, track in
            TrackRow(track: track, current: model.current?.id == track.id) {
                model.playList("searchResults", from: index, as: .search(query: model.searchedQuery))
            }
        }
    }
}

/// A track in one of the drawer's lists.
struct TrackRow: View {
    @Environment(PlayerModel.self) private var model
    let track: Track
    var current = false
    var past = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 16) {
                Thumb(url: track.cover(100), current: current)
                VStack(alignment: .leading, spacing: 2) {
                    Text(track.fullTitle)
                        .font(Fonts.sans(22, current ? .semibold : .medium))
                        .foregroundStyle(current ? Color(hex: "#FFE070") : .white)
                    Text(track.artistLine)
                        .font(Fonts.sans(17))
                        .foregroundStyle(.white.opacity(0.66))
                }
                .lineLimit(1)
                Spacer(minLength: 0)
                if model.isLiked(track) {
                    Image(systemName: "heart.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(Color.like)
                        .help("Liked")
                }
                if let mark = model.aiMark(track) {
                    Text(mark.badge)
                        .font(Fonts.sans(15, .semibold))
                        .foregroundStyle(Color(hex: "#FF7A5E"))
                        .padding(.horizontal, 8)
                        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color.ai, lineWidth: 2))
                        .help(mark.help)
                }
                if let milliseconds = track.durationMs {
                    Text(formatTime(milliseconds / 1000))
                        .font(Fonts.mono(18))
                        .foregroundStyle(.white.opacity(0.66))
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 84)
            .chip(
                RoundedRectangle(cornerRadius: 20),
                base: current ? Color.accent.opacity(0.14) : .clear,
                hover: current ? Color.accent.opacity(0.2) : .white.opacity(0.07)
            )
            .opacity(track.available == false ? 0.4 : past ? 0.5 : 1)
        }
        .buttonStyle(.plain)
    }
}

/// A row's picture: the cover, with the equalizer over the current track's.
struct Thumb: View {
    @Environment(PlayerModel.self) private var model
    let url: URL?
    var current = false
    @State private var image: NSImage?

    var body: some View {
        ZStack {
            Color.white.opacity(0.1)
            if let image { Image(bitmap: image).resizable().aspectRatio(contentMode: .fill) }
            if current {
                Color.black.opacity(0.45)
                Equalizer(running: model.playing)
            }
        }
        .frame(width: 60, height: 60)
        .clipShape(RoundedRectangle(cornerRadius: 13))
        .task(id: url) {
            image = ImageStore.shared.cached(url)
            if image == nil, let url { image = await ImageStore.shared.load(url) }
        }
    }
}

/// Three bars bouncing in steps of 1/30 s; they freeze on pause.
struct Equalizer: View {
    let running: Bool
    private let bars: [(period: Double, phase: Double)] = [(0.7, 0), (0.9, -0.3), (0.6, -0.5)]

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !running)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            HStack(alignment: .bottom, spacing: 4) {
                ForEach(0..<3, id: \.self) { index in
                    let bar = bars[index]
                    // Alternating 1 → .38 → 1, as `now-bounce … infinite alternate`.
                    let cycle = ((time - bar.phase) / bar.period).truncatingRemainder(dividingBy: 2)
                    let squeeze = cycle < 1 ? cycle : 2 - cycle
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color.accent)
                        .frame(width: 5, height: 26 * (running ? 1 - 0.62 * squeeze : 1))
                }
            }
            .frame(height: 26, alignment: .bottom)
            .padding(.bottom, 16)
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
    }
}

struct StationRow: View {
    let station: Station
    let current: Bool
    let action: () -> Void
    @State private var icon: NSImage?

    var body: some View {
        Button(action: action) {
            HStack(spacing: 16) {
                ZStack {
                    (Color.parse(station.color) ?? .white.opacity(0.1))
                    if let icon {
                        Image(bitmap: icon).resizable().aspectRatio(contentMode: .fit).padding(9)
                    } else {
                        WaveIcon(lineWidth: 2.3).foregroundStyle(Color.accent).frame(width: 28, height: 28)
                    }
                }
                .frame(width: 60, height: 60)
                .clipShape(RoundedRectangle(cornerRadius: 13))
                VStack(alignment: .leading, spacing: 2) {
                    Text(station.name)
                        .font(Fonts.sans(22, current ? .semibold : .medium))
                        .foregroundStyle(current ? Color(hex: "#FFE070") : .white)
                    Text("Genre station")
                        .font(Fonts.sans(17))
                        .foregroundStyle(.white.opacity(0.66))
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(height: 84)
            .chip(
                RoundedRectangle(cornerRadius: 20),
                base: current ? Color.accent.opacity(0.14) : .clear,
                hover: .white.opacity(0.07)
            )
        }
        .buttonStyle(.plain)
        .task(id: station.icon) {
            if let link = station.icon, let url = URL(string: link) { icon = await ImageStore.shared.load(url) }
        }
    }
}

struct PlaylistTile: View {
    let name: String
    let subtitle: String
    let systemImage: String
    let colors: (Color, Color)
    let current: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                GeometryReader { geometry in
                    let side = geometry.size.width
                    ZStack {
                        LinearGradient(
                            colors: [colors.0, Color(hex: "#0B0D12")],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                        Circle()
                            .fill(colors.1)
                            .frame(width: side * 0.44)
                            .position(x: side * 0.3, y: geometry.size.height * 0.3)
                        Image(systemName: systemImage)
                            .font(.system(size: side * 0.3))
                            .foregroundStyle(.white.opacity(0.85))
                    }
                }
                .aspectRatio(1, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                Text(name)
                    .font(Fonts.sans(20, .semibold))
                    .lineLimit(1)
                    .padding(.horizontal, 4)
                Text(subtitle)
                    .font(Fonts.sans(16))
                    .foregroundStyle(.white.opacity(0.66))
                    .padding(.horizontal, 4)
                    .padding(.bottom, 4)
            }
            .padding(10)
            .chip(
                RoundedRectangle(cornerRadius: 22),
                base: .white.opacity(0.05),
                hover: .white.opacity(0.1),
                border: current ? .accent : .clear
            )
        }
        .buttonStyle(.plain)
    }
}

/// Lays its views out in rows, wrapping to the next row when one is full.
struct FlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let available = proposal.width ?? .infinity
        var rowEnd: CGFloat = 0
        var rowTop: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if rowEnd > 0, rowEnd + size.width > available {
                rowTop += rowHeight + spacing
                rowEnd = 0
                rowHeight = 0
            }
            rowEnd += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, rowEnd - spacing)
        }
        return CGSize(width: min(widest, available), height: rowTop + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var left = bounds.minX
        var top = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if left > bounds.minX, left + size.width > bounds.maxX {
                top += rowHeight + spacing
                left = bounds.minX
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: left, y: top), proposal: ProposedViewSize(size))
            left += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
