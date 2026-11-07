import SwiftUI

private func clamp(_ lo: CGFloat, _ v: CGFloat, _ hi: CGFloat) -> CGFloat { min(max(v, lo), hi) }

/// The sizes the stylesheet took from the window (`clamp(…vw…)`), worked out from its size; the
/// cover and the dock get smaller while the drawer takes part of the screen.
struct Metrics {
    let width: CGFloat
    let height: CGFloat
    let drawerOpen: Bool

    private var vw: CGFloat { width / 100 }
    private var vh: CGFloat { height / 100 }

    var cover: CGFloat { drawerOpen ? clamp(200, 34 * vh, 400) : clamp(220, 41 * vh, 470) }
    var play: CGFloat { drawerOpen ? clamp(84, 7.6 * vw, 130) : clamp(96, 10.4 * vw, 150) }
    var side: CGFloat { drawerOpen ? clamp(62, 5.2 * vw, 92) : clamp(70, 6.8 * vw, 104) }
    var small: CGFloat { drawerOpen ? clamp(52, 4.4 * vw, 76) : clamp(58, 5.4 * vw, 84) }
    var square: CGFloat { drawerOpen ? 56 : 64 }
    var meter: CGFloat { drawerOpen ? clamp(80, 7 * vw, 150) : clamp(110, 11 * vw, 180) }
    var dockGap: CGFloat { drawerOpen ? clamp(8, 1 * vw, 20) : clamp(12, 1.6 * vw, 24) }
    var drawer: CGFloat { clamp(360, 32 * vw, 500) }
    var gutter: CGFloat { clamp(16, 2.8 * vw, 40) }
    var nowGap: CGFloat { clamp(32, 4.4 * vw, 72) }
    var titleMax: CGFloat { clamp(48, 6.4 * vw, 124) }
    var artist: CGFloat { clamp(22, 2.3 * vw, 40) }
    var source: CGFloat { clamp(17, 1.5 * vw, 24) }
    var bars: CGFloat { clamp(56, 9 * vh, 96) }
    var barGap: CGFloat { clamp(3, 0.35 * vw, 6) }
    var times: CGFloat { clamp(18, 1.6 * vw, 26) }
    var bottom: CGFloat { clamp(16, 2.6 * vh, 32) }
    var drawerInset: CGFloat { clamp(12, 1.8 * vw, 24) }
}

/// The wave of My Vibe: `M3 12c2-3 4-3 6 0s4 3 6 0 4-3 6 0` in a 24×24 box.
struct WaveShape: Shape {
    func path(in r: CGRect) -> Path {
        let s = min(r.width, r.height) / 24
        let o = CGPoint(x: r.midX - 12 * s, y: r.midY - 12 * s)
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: o.x + x * s, y: o.y + y * s) }
        var path = Path()
        path.move(to: p(3, 12))
        path.addCurve(to: p(9, 12), control1: p(5, 9), control2: p(7, 9))
        path.addCurve(to: p(15, 12), control1: p(11, 15), control2: p(13, 15))
        path.addCurve(to: p(21, 12), control1: p(17, 9), control2: p(19, 9))
        return path
    }
}

struct WaveIcon: View {
    var lineWidth: CGFloat = 2.4
    var body: some View {
        WaveShape().stroke(style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
    }
}

/// A button that shrinks a little while pressed, as `:active` did.
struct PressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
            .contentShape(Rectangle())
    }
}

/// A fill that lightens under the pointer.
struct Hover<Content: View>: View {
    let base: Color
    let hover: Color
    let shape: AnyShape
    @ViewBuilder let content: (Bool) -> Content
    @State private var over = false

    var body: some View {
        content(over)
            .background(over ? hover : base, in: shape)
            .onHover { over = $0 }
            .animation(.easeOut(duration: 0.3), value: over)
    }
}

extension View {
    /// A pill or rounded button's look: a fill that lightens under the pointer.
    func chip(_ shape: some Shape, base: Color = .white.opacity(0.08), hover: Color = .white.opacity(0.14), border: Color? = nil) -> some View {
        Hover(base: base, hover: hover, shape: AnyShape(shape)) { _ in
            self.overlay { if let border { shape.stroke(border, lineWidth: 1) } }
        }
    }
}

let ease = Animation.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.55)
