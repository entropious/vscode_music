import AVFoundation
import SwiftUI

/// The art's endless animations move in steps of 1/30 s, as in media/nowArt.css.
private let artFrame: TimeInterval = 1.0 / 30

// MARK: - Background

/// The page's background: the blurred cover, two soft spots in its colors, the video that fills
/// the background, and the vignette over them.
struct BackgroundView: View {
    @Environment(PlayerModel.self) private var model
    @Environment(VideoStage.self) private var videos
    let palette: Palette
    let blurred: NSImage?
    let idle: Bool

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let height = geometry.size.height
            let longest = max(width, height)
            let front = model.showsVideoInFront
            // Every layer is placed by its center in the window, so none of them sizes the others.
            ZStack {
                (front ? Color.black : palette.base)
                Group {
                    if let blurred {
                        // Past the window's edges, as `inset: -18%` did, so the soft edges don't show.
                        Image(bitmap: blurred)
                            .resizable()
                            .interpolation(.high)
                            .saturation(1.5)
                            .frame(width: width * 1.36, height: height * 1.36)
                            .position(x: width / 2, y: height / 2)
                            .opacity(0.95)
                            .id(blurred)
                            .transition(.opacity.animation(.easeInOut(duration: 1.4)))
                    }
                    RadialGradient(
                        colors: [palette.primary, .clear],
                        center: .center,
                        startRadius: 0,
                        endRadius: longest * 0.35
                    )
                    .frame(width: longest * 0.7, height: longest * 0.7)
                    .position(x: width * 0.52 + longest * 0.35, y: -height * 0.2 + longest * 0.35)
                    .opacity(0.35)
                    RadialGradient(
                        colors: [palette.secondary, .clear],
                        center: .center,
                        startRadius: 0,
                        endRadius: longest * 0.3
                    )
                    .frame(width: longest * 0.6, height: longest * 0.6)
                    .position(x: -width * 0.2 + longest * 0.3, y: height * 0.4 + longest * 0.3)
                    .opacity(0.32)
                }
                .opacity(front ? 0 : 1)
                if videos.place == .background {
                    backgroundVideo(front: front)
                        .frame(width: width, height: height)
                        .position(x: width / 2, y: height / 2)
                }
                vignette
                    .opacity(front && idle ? 0 : 1)
                    .animation(.easeInOut(duration: 0.4), value: idle)
            }
            .frame(width: width, height: height)
            .clipped()
            .animation(.easeInOut(duration: 1.2), value: palette)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    @ViewBuilder private func backgroundVideo(front: Bool) -> some View {
        if let player = videos.player {
            PlayerLayerView(player: player, gravity: front ? .resizeAspect : .resizeAspectFill)
                .opacity(videos.shown ? (front ? 1 : 0.85) : 0)
                .animation(.easeInOut(duration: 0.8), value: videos.shown)
        }
    }

    private var vignette: some View {
        ZStack {
            RadialGradient(
                colors: [
                    Color(red: 6 / 255, green: 7 / 255, blue: 10 / 255).opacity(0.15),
                    Color(red: 6 / 255, green: 7 / 255, blue: 10 / 255).opacity(0.62),
                ],
                center: UnitPoint(x: 0.35, y: 0.45),
                startRadius: 0,
                endRadius: 900
            )
            LinearGradient(
                stops: [
                    .init(color: Color.black.opacity(0.38), location: 0),
                    .init(color: Color.black.opacity(0.18), location: 0.35),
                    .init(color: Color.black.opacity(0.72), location: 1),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        }
    }
}

// MARK: - Cover and record

/// The cover and the record that slides out from under it while music plays; the record turns
/// and the cover breathes, in steps of 1/30 s.
struct ArtView: View {
    @Environment(PlayerModel.self) private var model
    @Environment(VideoStage.self) private var videos
    let size: CGFloat
    let palette: Palette
    let cover: NSImage?
    let label: NSImage?
    let recordOut: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: artFrame, paused: !model.playing)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            let turn = model.playing ? (time.truncatingRemainder(dividingBy: 3.6) / 3.6) * 360 : 0
            let breath = model.playing ? 1 + 0.011 * (1 - cos(time / 3.6 * 2 * .pi)) : 1
            ZStack(alignment: .topLeading) {
                record(turn: turn)
                    .frame(width: size * 0.94, height: size * 0.94)
                    .offset(x: size * (recordOut ? 0.5 : 0.1), y: size * 0.03)
                    .animation(.timingCurve(0.2, 0.8, 0.2, 1, duration: 1), value: recordOut)
                coverTile
                    .frame(width: size, height: size)
                    .scaleEffect(breath)
            }
            .frame(width: size * 1.46, height: size, alignment: .topLeading)
        }
    }

    private func record(turn: Double) -> some View {
        ZStack {
            Canvas { context, canvasSize in
                let center = canvasSize.width / 2
                let groove: CGFloat = 2
                var radius = center
                var dark = true
                while radius > 0 {
                    let ring = CGRect(x: center - radius, y: center - radius, width: radius * 2, height: radius * 2)
                    let shade = dark ? Color(hex: "#121216") : Color(hex: "#1D1D23")
                    context.fill(Path(ellipseIn: ring), with: .color(shade))
                    radius -= groove
                    dark.toggle()
                }
            }
            .clipShape(Circle())
            .shadow(color: .black.opacity(0.55), radius: 30, y: 24)
            Group {
                if let label {
                    Image(bitmap: label).resizable().aspectRatio(contentMode: .fill)
                } else {
                    palette.primary
                }
            }
            .clipShape(Circle())
            .overlay(Circle().stroke(Color.black.opacity(0.4), lineWidth: 2))
            .padding(size * 0.94 * 0.31)
            Circle().fill(Color(hex: "#08080A")).padding(size * 0.94 * 0.486)
        }
        .rotationEffect(.degrees(turn))
        .overlay(
            AngularGradient(
                stops: [
                    .init(color: .clear, location: 0),
                    .init(color: .clear, location: 0.08),
                    .init(color: .white.opacity(0.10), location: 0.13),
                    .init(color: .clear, location: 0.19),
                    .init(color: .clear, location: 0.56),
                    .init(color: .white.opacity(0.07), location: 0.62),
                    .init(color: .clear, location: 0.68),
                ],
                center: .center,
                angle: .degrees(20 - 90)
            )
            .clipShape(Circle())
        )
    }

    private var coverTile: some View {
        ZStack {
            Color(hex: "#1B1D24")
            if let cover {
                Image(bitmap: cover).resizable().aspectRatio(contentMode: .fill)
            } else {
                CoverPlaceholder(loading: model.current != nil)
            }
            if videos.place == .tile, let player = videos.player {
                PlayerLayerView(player: player, gravity: .resizeAspectFill)
                    .opacity(videos.shown ? 1 : 0)
                    .animation(.easeInOut(duration: 0.8), value: videos.shown)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .shadow(color: .black.opacity(0.55), radius: 40, y: 32)
        .shadow(color: palette.primary.opacity(0.33), radius: 70)
    }
}

/// The cover's place while there is none: the tile's grooves and My Vibe's wave in the middle.
/// While a cover loads, a yellow dash runs along the wave, as `stroke-dashoffset` ran it in the SVG
/// (CoreSVG draws the SVG's shapes but neither its CSS transforms nor its animations).
struct CoverPlaceholder: View {
    let loading: Bool
    /// The dash's share of the wave and the time it takes to run along it.
    private static let dash = 0.34
    private static let period = 1.3

    var body: some View {
        GeometryReader { geometry in
            let wave = min(geometry.size.width, geometry.size.height) * 0.38
            let stroke = StrokeStyle(lineWidth: wave / 24 * 2.2, lineCap: .round)
            let dashStroke = StrokeStyle(lineWidth: wave / 24 * 2.4, lineCap: .round)
            ZStack {
                if let tile = resourceImage(loading ? "cover-loading.svg" : "cover-empty.svg") {
                    Image(nsImage: tile).resizable()
                }
                WaveShape()
                    .stroke(.white.opacity(loading ? 0.16 : 0.34), style: stroke)
                    .frame(width: wave, height: wave)
                if loading {
                    TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                        let time = context.date.timeIntervalSinceReferenceDate
                        let start = time.truncatingRemainder(dividingBy: Self.period) / Self.period
                        let end = start + Self.dash
                        ZStack {
                            WaveShape().trim(from: start, to: min(end, 1))
                                .stroke(Color.accent, style: dashStroke)
                            if end > 1 {
                                WaveShape().trim(from: 0, to: end - 1)
                                    .stroke(Color.accent, style: dashStroke)
                            }
                        }
                        .shadow(color: Color.accent.opacity(0.6), radius: wave / 24)
                    }
                    .frame(width: wave, height: wave)
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
    }
}

// MARK: - Title

/// The title's size, up to the largest, at which no word is broken: one line if that doesn't make
/// it much smaller, otherwise the largest size for two lines (as fitTitle did in the web page).
func fitTitle(_ text: String, width: CGFloat, full: CGFloat) -> (size: CGFloat, lines: Int) {
    let minSize: CGFloat = 32
    let oneLineShare: CGFloat = 0.6
    func font(_ points: CGFloat) -> NSFont {
        NSFont(name: "IBMPlexSans-Bold", size: points) ?? .boldSystemFont(ofSize: points)
    }
    func styled(_ string: String, _ points: CGFloat) -> NSAttributedString {
        NSAttributedString(string: string, attributes: [.font: font(points), .kern: -0.035 * points])
    }
    func fits(_ lines: Int, _ points: CGFloat) -> Bool {
        let longestWord = text.split(separator: " ").map { styled(String($0), points).size().width }.max() ?? 0
        if longestWord > width { return false }
        let whole = styled(text, points)
        if lines == 1 { return whole.size().width <= width }
        let measured = font(points)
        let lineHeight = measured.ascender - measured.descender + measured.leading
        let height = whole.boundingRect(
            with: CGSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin]
        ).height
        return height <= CGFloat(lines) * lineHeight + 1
    }
    func largest(_ lines: Int, _ smallest: CGFloat) -> CGFloat? {
        if fits(lines, full) { return full }
        if !fits(lines, smallest) { return nil }
        var low = smallest
        var high = full
        while high - low > 1 {
            let middle = (low + high) / 2
            if fits(lines, middle) { low = middle } else { high = middle }
        }
        return low.rounded(.down)
    }
    if let size = largest(1, max(minSize, full * oneLineShare)) { return (size, 1) }
    return (largest(2, minSize) ?? minSize, 2)
}

// MARK: - Info

struct InfoView: View {
    @Environment(PlayerModel.self) private var model
    let metrics: Metrics
    /// The width the title has, which its size is fitted to.
    @State private var titleWidth: CGFloat = 0

    var body: some View {
        let track = model.current
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 12) {
                sourceLine
                let text = track?.fullTitle ?? "Nothing is playing"
                let fit =
                    titleWidth > 0
                    ? fitTitle(text, width: titleWidth, full: metrics.titleMax) : (size: metrics.titleMax, lines: 2)
                Text(text)
                    .font(Fonts.sans(fit.size, .bold))
                    .tracking(-0.035 * fit.size)
                    .lineLimit(fit.lines)
                    .padding(.vertical, Fonts.trim(to: 1.15, size: fit.size))
                    .shadow(color: .black.opacity(0.35), radius: 20, y: 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .onGeometryChange(for: CGFloat.self) {
                        $0.size.width
                    } action: {
                        titleWidth = $0
                    }
                Text(track?.artistLine ?? "Start My Vibe or Liked above")
                    .font(Fonts.sans(metrics.artist))
                    .foregroundStyle(.white.opacity(0.78))
                    .lineLimit(1)
                    .padding(.vertical, Fonts.trim(to: 1.2, size: metrics.artist))
            }
            .id(track?.id)
            .transition(
                .asymmetric(
                    insertion: .opacity.combined(with: .offset(y: 28)).combined(with: .scale(scale: 0.96)),
                    removal: .identity
                )
            )
            extras
            ProgressBars(metrics: metrics)
            if let next = model.next {
                UpNext(track: next)
            }
        }
        .frame(minWidth: 360, maxWidth: 860, alignment: .leading)
    }

    @ViewBuilder private var sourceLine: some View {
        let track = model.current
        let mark = track.flatMap { model.aiMark($0) }
        let label = track == nil ? "" : model.sourceLabel
        if mark != nil || !label.isEmpty {
            HStack(spacing: 12) {
                if let mark {
                    Text(mark.badge)
                        .font(Fonts.sans(metrics.source * 0.82, .semibold))
                        .foregroundStyle(Color(hex: "#FF7A5E"))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 1)
                        .background(
                            Color(red: 20 / 255, green: 10 / 255, blue: 8 / 255).opacity(0.35),
                            in: RoundedRectangle(cornerRadius: 8)
                        )
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.ai, lineWidth: 2))
                        .help(mark.help)
                }
                switch model.state?.source {
                case .wave, .station:
                    WaveIcon(lineWidth: 2.3).frame(width: metrics.source * 1.3, height: metrics.source * 1.3)
                default:
                    EmptyView()
                }
                Text(label).lineLimit(1)
            }
            .font(Fonts.sans(metrics.source, .semibold))
            .foregroundStyle(Color.accent)
        }
    }

    private var extras: some View {
        HStack(spacing: 12) {
            if let genre = model.visuals?.genre {
                let color = Color.parse(genre.color) ?? .accent
                Button(action: model.playGenre) {
                    HStack(spacing: 10) {
                        Circle().fill(color).frame(width: 12, height: 12).shadow(color: color, radius: 5)
                        Text(genre.title).font(Fonts.sans(19, .semibold)).fixedSize()
                    }
                    .padding(.leading, 18)
                    .padding(.trailing, 22)
                    .frame(height: 52)
                    .chip(Capsule(), border: .white.opacity(0.22))
                }
                .buttonStyle(PressStyle())
                .help("Play \(genre.title) radio")
            }
            if model.current != nil, !model.trackRadio {
                Button(action: model.startTrackRadio) {
                    HStack(spacing: 10) {
                        WaveIcon(lineWidth: 2.3).foregroundStyle(Color.accent).frame(width: 22, height: 22)
                        Text("Track radio").font(Fonts.sans(19, .medium)).fixedSize()
                    }
                    .padding(.horizontal, 22)
                    .frame(height: 52)
                    .chip(Capsule(), border: .white.opacity(0.22))
                }
                .buttonStyle(PressStyle())
            }
            if model.current != nil, let info = model.state?.streamInfo {
                Text(info.replacingOccurrences(of: "MP3 ", with: "MP3 · "))
                    .font(Fonts.mono(17))
                    .fixedSize()
                    .foregroundStyle(.white.opacity(0.7))
            }
        }
        .frame(minHeight: 52)
    }
}

// MARK: - Progress

/// The track's bars; the played ones are yellow and glow. A click seeks.
struct ProgressBars: View {
    @Environment(PlayerModel.self) private var model
    let metrics: Metrics
    private static let count = 64

    var body: some View {
        let heights = barHeights(model.current?.id ?? "", Self.count)
        TimelineView(.periodic(from: .now, by: 0.25)) { context in
            let length = model.duration
            let position = model.position(at: context.date)
            let played = length > 0 ? min(1, position / length) : 0
            VStack(spacing: 10) {
                GeometryReader { geometry in
                    HStack(alignment: .center, spacing: metrics.barGap) {
                        ForEach(0..<Self.count, id: \.self) { bar in
                            let lit = (Double(bar) + 0.5) / Double(Self.count) <= played
                            Capsule()
                                .fill(lit ? Color.accent : Color.white.opacity(0.30))
                                .shadow(color: lit ? Color.accent.opacity(0.45) : .clear, radius: 7)
                                .frame(height: geometry.size.height * heights[bar])
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0).onEnded { drag in
                            model.seek(fraction: drag.location.x / geometry.size.width)
                        }
                    )
                }
                .frame(height: metrics.bars)
                HStack {
                    Text(formatTime(position)).foregroundStyle(.white)
                    Spacer()
                    Text(formatTime(length)).foregroundStyle(.white.opacity(0.7))
                }
                .font(Fonts.mono(metrics.times))
            }
            .padding(.top, 8)
        }
    }
}

struct UpNext: View {
    @Environment(PlayerModel.self) private var model
    let track: Track
    @State private var art: NSImage?

    var body: some View {
        Button(action: model.nextTrack) {
            HStack(spacing: 14) {
                Group {
                    if let art {
                        Image(bitmap: art).resizable().aspectRatio(contentMode: .fill)
                    } else {
                        Color.white.opacity(0.1)
                    }
                }
                .frame(width: 52, height: 52)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                VStack(alignment: .leading, spacing: 1) {
                    Text("UP NEXT").font(Fonts.sans(14, .semibold)).tracking(1.1).foregroundStyle(.white.opacity(0.66))
                    (Text(track.fullTitle).font(Fonts.sans(20, .semibold))
                        + Text(" · \(track.artistLine)").font(Fonts.sans(20)).foregroundColor(.white.opacity(0.7)))
                        .lineLimit(1)
                }
                Image(systemName: "chevron.right").font(.system(size: 18, weight: .semibold)).foregroundStyle(
                    .white.opacity(0.7)
                ).padding(.leading, 6)
            }
            .padding(.leading, 12)
            .padding(.trailing, 22)
            .frame(height: 76)
            .chip(
                RoundedRectangle(cornerRadius: 22),
                base: .white.opacity(0.07),
                hover: .white.opacity(0.12),
                border: .white.opacity(0.14)
            )
        }
        .buttonStyle(PressStyle())
        .padding(.top, 6)
        .task(id: track.id) {
            ImageStore.shared.preload(track.cover(800))
            art = ImageStore.shared.cached(track.cover(100))
            if art == nil, let url = track.cover(100) { art = await ImageStore.shared.load(url) }
        }
    }
}

// MARK: - Dock

struct DockView: View {
    @Environment(PlayerModel.self) private var model
    let metrics: Metrics

    var body: some View {
        let track = model.current
        let liked = track.map(model.isLiked) ?? false
        let disliked = track.map(model.isDisliked) ?? false
        let volume = model.state?.volume
        let muted = volume == 0
        HStack(spacing: metrics.dockGap) {
            round(
                metrics.small,
                glyph: .dislike,
                share: 0.4,
                fill: disliked ? .white.opacity(0.26) : .white.opacity(0.10),
                color: disliked ? .white : .white.opacity(0.82),
                help: disliked ? "Remove dislike" : "Dislike and skip",
                action: model.dislike
            )
            .disabled(track == nil)
            round(
                metrics.side,
                glyph: .previous,
                share: 0.38,
                fill: .white.opacity(0.14),
                color: .white,
                help: "Previous track",
                action: model.previous
            )
            Button(action: model.playPause) {
                GlyphView(glyph: model.status.playing ? .pause : .play)
                    .frame(
                        width: metrics.play * (model.status.playing ? 0.38 : 0.4),
                        height: metrics.play * (model.status.playing ? 0.38 : 0.4)
                    )
                    .offset(x: model.status.playing ? 0 : metrics.play * 0.07)
                    .foregroundStyle(Color.ink)
                    .frame(width: metrics.play, height: metrics.play)
                    .background(Color.accent, in: Circle())
                    .shadow(color: Color.accent.opacity(0.35), radius: 24, y: 16)
            }
            .buttonStyle(PressStyle())
            .help(model.status.playing ? "Pause" : "Play")
            round(
                metrics.side,
                glyph: .next,
                share: 0.38,
                fill: .white.opacity(0.14),
                color: .white,
                help: "Next track",
                action: model.nextTrack
            )
            Button(action: model.like) {
                GlyphView(glyph: liked ? .heartFilled : .heart)
                    .frame(width: metrics.small * 0.46, height: metrics.small * 0.46)
                    .foregroundStyle(liked ? Color.ai : .white.opacity(0.82))
                    .keyframeAnimator(initialValue: 1.0, trigger: model.heartBeat) { heart, scale in
                        heart.scaleEffect(scale)
                    } keyframes: { _ in
                        KeyframeTrack {
                            CubicKeyframe(1.4, duration: 0.16)
                            CubicKeyframe(1, duration: 0.29)
                        }
                    }
                    .frame(width: metrics.small, height: metrics.small)
                    .chip(
                        Circle(),
                        base: liked ? Color.like.opacity(0.22) : .white.opacity(0.10),
                        hover: .white.opacity(0.2)
                    )
            }
            .buttonStyle(PressStyle())
            .disabled(track == nil)
            .help(liked ? "Remove from Liked" : "Like")
            Rectangle().fill(.white.opacity(0.16)).frame(width: 1, height: 64).padding(.horizontal, 4)
            HStack(spacing: 10) {
                square(
                    glyph: muted ? .muted : .audible,
                    side: 28,
                    help: muted ? "Unmute" : "Mute",
                    action: model.toggleMute
                )
                square(glyph: .minus, side: 26, help: "Volume down") { model.stepVolume(-PlayerModel.volumeStep) }
                VStack(spacing: 8) {
                    Text(volume.map { String(Int(($0 * 100).rounded())) } ?? "—").font(Fonts.mono(22))
                    GeometryReader { geometry in
                        ZStack(alignment: .leading) {
                            Capsule().fill(.white.opacity(0.18))
                            Capsule().fill(muted ? .white.opacity(0.4) : .white).frame(
                                width: geometry.size.width * (volume ?? 0)
                            )
                            .animation(.easeOut(duration: 0.3), value: volume)
                        }
                    }
                    .frame(height: 10)
                }
                .frame(width: metrics.meter)
                square(glyph: .plus, side: 26, help: "Volume up") { model.stepVolume(PlayerModel.volumeStep) }
            }
        }
        .padding(.vertical, 16)
        .padding(.horizontal, min(32, max(16, metrics.width * 0.02)))
        .background(
            Color(red: 14 / 255, green: 16 / 255, blue: 22 / 255).opacity(0.6),
            in: RoundedRectangle(cornerRadius: 44)
        )
        .overlay(RoundedRectangle(cornerRadius: 44).stroke(.white.opacity(0.12), lineWidth: 1))
        .shadow(color: .black.opacity(0.35), radius: 30, y: 24)
    }

    private func round(
        _ size: CGFloat,
        glyph: Glyph,
        share: CGFloat,
        fill: Color,
        color: Color,
        help: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            GlyphView(glyph: glyph)
                .frame(width: size * share, height: size * share)
                .foregroundStyle(color)
                .frame(width: size, height: size)
                .chip(Circle(), base: fill, hover: .white.opacity(0.2))
        }
        .buttonStyle(PressStyle())
        .help(help)
    }

    private func square(glyph: Glyph, side: CGFloat, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            GlyphView(glyph: glyph)
                .frame(width: side, height: side)
                .frame(width: metrics.square, height: metrics.square)
                .chip(RoundedRectangle(cornerRadius: 20), base: .white.opacity(0.10), hover: .white.opacity(0.18))
        }
        .buttonStyle(PressStyle())
        .help(help)
    }
}
