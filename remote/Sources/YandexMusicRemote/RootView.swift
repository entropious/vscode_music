import AppKit
import SwiftUI

/// Where the drawer and the buttons that open it are, in the window, for clicks outside the drawer.
@MainActor
final class Frames {
    var drawer: CGRect = .zero
    var openers: [String: CGRect] = [:]
}

struct RootView: View {
    @Environment(PlayerModel.self) private var model
    @Environment(VideoStage.self) private var videos
    let frames: Frames
    let idle: Bool

    @State private var cover: NSImage?
    @State private var label: NSImage?
    @State private var blurred: NSImage?
    @State private var palette = Palette.standard
    @State private var recordOut = false
    @State private var recordHold: Task<Void, Never>?

    var body: some View {
        GeometryReader { g in
            let m = Metrics(width: g.size.width, height: g.size.height, drawerOpen: model.drawerOpen)
            let front = model.showsVideoInFront
            ZStack(alignment: .topLeading) {
                BackgroundView(palette: palette, blurred: blurred, idle: idle)
                VStack(spacing: 0) {
                    TopBar(frames: frames, metrics: m)
                    VStack(spacing: 16) {
                        HStack(spacing: m.nowGap) {
                            ArtView(size: m.cover, palette: palette, cover: cover, label: label, recordOut: recordOut)
                                .id(model.current?.id)
                                .transition(.asymmetric(insertion: .offset(y: 28).combined(with: .scale(scale: 0.96)), removal: .identity))
                            InfoView(metrics: m)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        DockView(metrics: m)
                    }
                    .padding(.horizontal, m.gutter)
                    .padding(.bottom, m.bottom)
                    .padding(.trailing, model.drawerOpen ? m.drawer + 8 : 0)
                }
                .opacity(front && idle ? 0 : 1)
                .animation(.easeInOut(duration: 0.4), value: idle)
                if model.drawerOpen {
                    DrawerView()
                        .frame(width: min(m.drawer, g.size.width - 24))
                        .padding(.top, 96)
                        .padding(.trailing, m.drawerInset)
                        .padding(.bottom, m.drawerInset)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frames.drawer = $0 }
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
                ToastView()
                if let (title, text) = model.overlay {
                    OverlayView(title: title, text: text)
                }
            }
            .animation(ease, value: model.drawerOpen)
            .animation(.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.7), value: model.current?.id)
        }
        .background(Color(hex: "#06070A"))
        .foregroundStyle(.white)
        .task(id: model.current?.id) { await loadArt(model.current) }
        .onChange(of: model.playing, initial: true) { _, playing in holdRecord(playing) }
    }

    /// The cover, the record's label, the blurred background and the palette of a track. The
    /// previous ones stay until the new ones are in.
    private func loadArt(_ t: Track?) async {
        let store = ImageStore.shared
        guard let t, let big = t.cover(800), let small = t.cover(200), let bg = t.cover(400) else {
            cover = nil
            label = nil
            blurred = nil
            palette = .standard
            return
        }
        if let c = store.cached(big) { cover = c }
        async let bigImage = store.load(big)
        async let smallImage = store.load(small)
        async let bgImage = store.load(bg)
        if let s = await smallImage {
            label = s
            palette = paletteOf(s)
        }
        if let b = await bgImage { blurred = blurredOf(b) }
        cover = await bigImage
    }

    /// The record slides out while music plays and stays out for a moment after it stops, as it
    /// does between two tracks, so a track change doesn't move it.
    private func holdRecord(_ playing: Bool) {
        recordHold?.cancel()
        if playing {
            recordOut = true
        } else if recordOut {
            recordHold = Task {
                try? await Task.sleep(for: .seconds(1.5))
                if !Task.isCancelled { recordOut = false }
            }
        }
    }
}

/// The app's name, the sources in the middle, the queue and the account on the right.
struct TopBar: View {
    @Environment(PlayerModel.self) private var model
    @Environment(VideoStage.self) private var videos
    let frames: Frames
    let metrics: Metrics

    var body: some View {
        HStack(spacing: 16) {
            HStack(spacing: 14) {
                if let glyph = resourceImage("glyph.svg") {
                    Image(nsImage: glyph).resizable().frame(width: 44, height: 44)
                }
                Text("Yandex Music").font(Fonts.sans(22, .semibold)).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            pills
            HStack(spacing: 12) {
                Button { model.openDrawer(!model.drawerOpen) } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "line.3.horizontal").font(.system(size: 22, weight: .medium))
                        Text("Queue").font(Fonts.sans(20, .semibold))
                    }
                    .padding(.horizontal, 24)
                    .frame(height: 64)
                    .chip(RoundedRectangle(cornerRadius: 20), base: model.drawerOpen ? Color.accent.opacity(0.18) : .white.opacity(0.08), hover: .white.opacity(0.14),
                          border: model.drawerOpen ? .accent : .white.opacity(0.16))
                }
                .buttonStyle(PressStyle())
                .opener("queue", frames)
                if let acc = model.state?.account {
                    let name = (acc.displayName?.isEmpty == false ? acc.displayName! : acc.login).trimmingCharacters(in: .whitespaces)
                    Text(name.prefix(1).uppercased())
                        .font(Fonts.sans(21, .semibold))
                        .frame(width: 52, height: 52)
                        .background(.white.opacity(0.14), in: Circle())
                        .overlay(Circle().stroke(.white.opacity(0.2), lineWidth: 1))
                        .help(acc.login)
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(.vertical, 16)
        .padding(.horizontal, metrics.gutter)
        .frame(minHeight: 96)
        .background(WindowDragArea())
    }

    private var pills: some View {
        let waveOn = if case .wave = model.state?.source { true } else { false }
        let likedOn = if case .liked = model.state?.source { true } else { false }
        let tuneOpen = model.drawerOpen && model.tab == .vibe
        return HStack(spacing: 8) {
            HStack(spacing: 0) {
                Button(action: model.playWave) {
                    HStack(spacing: 10) {
                        WaveIcon().frame(width: 24, height: 24)
                        Text("Vibe").font(Fonts.sans(20, .semibold)).fixedSize()
                    }
                    .padding(.leading, 24)
                    .padding(.trailing, 18)
                    .frame(height: 52)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Rectangle().fill(waveOn ? Color.ink.opacity(0.22) : .white.opacity(0.18)).frame(width: 1, height: 52)
                Button(action: model.toggleTune) {
                    Image(systemName: "slider.horizontal.3")
                        .font(.system(size: 20, weight: .medium))
                        .frame(width: 52, height: 52)
                        .background(tuneOpen ? (waveOn ? Color.ink.opacity(0.14) : Color.accent.opacity(0.18)) : .clear)
                        .overlay(alignment: .topTrailing) {
                            if model.waveTuned {
                                Circle().fill(waveOn ? Color.ink : .accent).frame(width: 9, height: 9).padding(.top, 9).padding(.trailing, 11)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(model.waveTuned ? "My Vibe settings (changed)" : "My Vibe settings")
                .opener("tune", frames)
            }
            .foregroundStyle(waveOn ? Color.ink : (tuneOpen ? .white : .white))
            .background(waveOn ? Color.accent : .clear, in: Capsule())
            .clipShape(Capsule())
            pill("Liked", on: likedOn, action: model.toggleLikedPill) {
                Image(systemName: "heart.fill").font(.system(size: 18)).foregroundStyle(likedOn ? Color.ink : .like)
            }
            .opener("liked", frames)
            if videos.place == .background {
                pill("Video", on: model.showsVideoInFront, action: { model.setVideoFront(!model.videoFront) }) {
                    Image(systemName: "play.rectangle").font(.system(size: 20, weight: .medium))
                }
                .help(model.showsVideoInFront ? "Back to the player" : "Show the video")
            }
        }
        .padding(6)
        .background(.white.opacity(0.08), in: Capsule())
        .overlay(Capsule().stroke(.white.opacity(0.12), lineWidth: 1))
    }

    private func pill(_ title: String, on: Bool, action: @escaping () -> Void, @ViewBuilder icon: () -> some View) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                icon()
                Text(title).font(Fonts.sans(20, .semibold)).fixedSize()
            }
            .foregroundStyle(on ? Color.ink : .white)
            .padding(.horizontal, 24)
            .frame(height: 52)
            .chip(Capsule(), base: on ? .accent : .clear, hover: on ? .accent : .white.opacity(0.1))
        }
        .buttonStyle(.plain)
    }
}

extension View {
    /// Remembers where a button that opens the drawer is, so a click on it isn't taken for one outside.
    func opener(_ name: String, _ frames: Frames) -> some View {
        onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frames.openers[name] = $0 }
    }
}

/// Lets the window be dragged by the top bar, as the title bar would.
struct WindowDragArea: NSViewRepresentable {
    final class DragView: NSView {
        override var mouseDownCanMoveWindow: Bool { true }
        override func mouseDown(with event: NSEvent) {
            if event.clickCount == 2 {
                window?.zoom(nil)
            } else {
                window?.performDrag(with: event)
            }
        }
    }

    func makeNSView(context: Context) -> NSView { DragView() }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

struct ToastView: View {
    @Environment(PlayerModel.self) private var model

    var body: some View {
        VStack {
            if let toast = model.toast {
                Text(toast.text)
                    .font(Fonts.sans(20))
                    .lineSpacing(5)
                    .multilineTextAlignment(.center)
                    .padding(.vertical, 16)
                    .padding(.horizontal, 28)
                    .frame(maxWidth: 720)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22))
                    .background(Color(red: 14 / 255, green: 16 / 255, blue: 22 / 255).opacity(0.78), in: RoundedRectangle(cornerRadius: 22))
                    .overlay(RoundedRectangle(cornerRadius: 22).stroke(toast.error ? Color.ai.opacity(0.6) : .white.opacity(0.14), lineWidth: 1))
                    .shadow(color: .black.opacity(0.4), radius: 25, y: 20)
                    .id(toast.id)
                    .transition(.opacity.combined(with: .offset(y: -12)))
            }
            Spacer()
        }
        .padding(.top, 24)
        .frame(maxWidth: .infinity)
        .animation(.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.35), value: model.toast)
        .allowsHitTesting(false)
    }
}

struct OverlayView: View {
    let title: String
    let text: String

    var body: some View {
        ZStack {
            Color(red: 6 / 255, green: 7 / 255, blue: 10 / 255).opacity(0.9)
            VStack(spacing: 20) {
                if let glyph = resourceImage("glyph.svg") {
                    TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                        let t = context.date.timeIntervalSinceReferenceDate
                        Image(nsImage: glyph).resizable().frame(width: 120, height: 120)
                            .scaleEffect(1 + 0.0125 * (1 - cos(t / 3.6 * 2 * .pi)))
                    }
                }
                Text(title).font(Fonts.sans(44, .bold)).tracking(-0.9).padding(.top, 12)
                Text(text).font(Fonts.sans(22)).lineSpacing(10).foregroundStyle(.white.opacity(0.72))
            }
            .multilineTextAlignment(.center)
            .frame(maxWidth: 720)
            .padding(32)
        }
        .ignoresSafeArea()
    }
}
