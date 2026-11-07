/**
 * Yandex Music Remote: a fullscreen remote for the big screen. It plays nothing itself; it
 * attaches to the player service the VS Code extension runs on macOS (`out/service.js`) and
 * controls it the way a VS Code window does.
 *
 *   YandexMusicRemote [--fullscreen]
 */
import AppKit
import IOKit.pwr_mgt
import SwiftUI

@main
struct RemoteApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    /// The window is the app delegate's own: a SwiftUI scene would be restored, or not opened,
    /// as the system remembers it from the last launch.
    var body: some Scene {
        Settings { EmptyView() }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = PlayerModel()
    let videos = VideoStage()
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        Fonts.register()
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        w.title = "Yandex Music Remote"
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        w.isReleasedWhenClosed = false
        w.minSize = NSSize(width: 720, height: 600)
        w.contentView = NSHostingView(rootView: WindowContent().environment(model).environment(videos))
        window = w
        w.makeKeyAndOrderFront(nil)
        NSApp.activate()
        model.start()
    }

    /// A remote is no use without its window.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

/// The window's content and what it does to the window and the app: its size, the keys, the
/// pointer hiding when idle, videos and visuals only while it is seen, the display kept awake.
struct WindowContent: View {
    @Environment(PlayerModel.self) private var model
    @Environment(VideoStage.self) private var videos
    @State private var window: NSWindow?
    @State private var frames = Frames()
    @State private var idle = false
    @State private var idleTask: Task<Void, Never>?
    @State private var monitors: [Any] = []
    @State private var awake: IOPMAssertionID?
    private static let idleAfter: Duration = .seconds(3)
    private let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

    var body: some View {
        RootView(frames: frames, idle: idle)
            .background(WindowReader { w in
                guard window == nil else { return }
                window = w
                configure(w)
            })
            .onAppear(perform: installMonitors)
            .onChange(of: model.current?.id, initial: true) { showVideo() }
            .onChange(of: model.visuals, initial: true) { showVideo() }
            .onChange(of: model.playing, initial: true) { _, playing in
                videos.follow(playing: playing)
                keepAwake(playing && model.link == .connected)
            }
            .onChange(of: model.status) { videos.keepInStep() }
            .onAppear {
                videos.onPlace = { model.videoPlace = $0 }
                videos.position = { model.position(at: Date()) }
            }
    }

    private func showVideo() {
        videos.show(reduceMotion ? nil : pickVisual(model.visuals))
    }

    /// Without --fullscreen the window takes the whole screen short of the menu bar and the Dock.
    private func configure(_ w: NSWindow) {
        // Not restored: the system would keep a picture of the whole window (some 30 MB) for the next launch.
        w.isRestorable = false
        w.backgroundColor = NSColor(red: 6 / 255, green: 7 / 255, blue: 10 / 255, alpha: 1)
        w.acceptsMouseMovedEvents = true
        w.collectionBehavior.insert(.fullScreenPrimary)
        if let screen = w.screen ?? NSScreen.main {
            w.setFrame(screen.visibleFrame, display: true)
        }
        if CommandLine.arguments.contains("--fullscreen") {
            w.toggleFullScreen(nil)
        }
        NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: w, queue: .main) { _ in
            MainActor.assumeIsolated { visibilityChanged(w) }
        }
        visibilityChanged(w)
        if let path = ProcessInfo.processInfo.environment["YM_SNAPSHOT"] {
            snapshot(w, to: path)
        }
    }

    /// For development: saves a picture of the window to `path` every few seconds (YM_SNAPSHOT).
    private func snapshot(_ w: NSWindow, to path: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
            if let view = w.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                view.cacheDisplay(in: view.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
            }
            snapshot(w, to: path)
        }
    }

    /// Videos play, and the service looks up videos and genres, only while the window is seen.
    private func visibilityChanged(_ w: NSWindow) {
        let visible = w.occlusionState.contains(.visible)
        videos.visible = visible
        model.service.wantVisuals(visible)
    }

    private func keepAwake(_ on: Bool) {
        if on, awake == nil {
            var id = IOPMAssertionID(0)
            if IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleDisplaySleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), "Yandex Music is playing" as CFString, &id) == kIOReturnSuccess {
                awake = id
            }
        } else if !on, let id = awake {
            IOPMAssertionRelease(id)
            awake = nil
        }
    }

    private func installMonitors() {
        guard monitors.isEmpty else { return }
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            handleKey(event) ? nil : event
        } as Any)
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { event in
            wake()
            return event
        } as Any)
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { event in
            wake()
            closeDrawerOutside(event)
            return event
        } as Any)
        wake()
    }

    /// The pointer hides after a few idle seconds, as in a video player.
    private func wake() {
        if idle { idle = false }
        idleTask?.cancel()
        idleTask = Task {
            try? await Task.sleep(for: Self.idleAfter)
            guard !Task.isCancelled else { return }
            idle = true
            NSCursor.setHiddenUntilMouseMoves(true)
        }
    }

    /// A click anywhere outside the drawer closes it, and does what it does there too. The
    /// buttons that open the drawer open, switch or close it themselves.
    private func closeDrawerOutside(_ event: NSEvent) {
        guard model.drawerOpen, let w = event.window, let content = w.contentView else { return }
        let p = CGPoint(x: event.locationInWindow.x, y: content.bounds.height - event.locationInWindow.y)
        if frames.drawer.contains(p) || frames.openers.values.contains(where: { $0.contains(p) }) { return }
        DispatchQueue.main.async { model.openDrawer(false) }
    }

    /// The keys of the web version; true when the key was taken.
    private func handleKey(_ event: NSEvent) -> Bool {
        let typing = event.window?.firstResponder is NSTextView
        if event.keyCode == 53 { // Esc
            if typing {
                event.window?.makeFirstResponder(nil)
            } else {
                model.escape(window: event.window)
            }
            return true
        }
        if typing || !event.modifierFlags.intersection([.command, .control, .option]).isEmpty { return false }
        switch event.keyCode {
        case 49: model.playPause() // space
        case 124: model.nextTrack() // →
        case 123: model.previous() // ←
        case 126: model.stepVolume(PlayerModel.volumeStep) // ↑
        case 125: model.stepVolume(-PlayerModel.volumeStep) // ↓
        default:
            switch event.charactersIgnoringModifiers?.lowercased() {
            case "l": model.like()
            case "m": model.toggleMute()
            case "q": model.openDrawer(!model.drawerOpen || model.tab != .queue, .queue)
            case "/": model.openDrawer(true, .search)
            case "f": event.window?.toggleFullScreen(nil)
            case "v":
                guard videos.place == .background else { return false }
                model.setVideoFront(!model.videoFront)
            default: return false
            }
        }
        return true
    }
}

/// Hands the hosting window to the view once it is in one.
struct WindowReader: NSViewRepresentable {
    let found: (NSWindow) -> Void

    final class ReaderView: NSView {
        var found: (NSWindow) -> Void = { _ in }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window { found(window) }
        }
    }

    func makeNSView(context: Context) -> ReaderView {
        let v = ReaderView()
        v.found = found
        return v
    }

    func updateNSView(_ v: ReaderView, context: Context) {}
}
