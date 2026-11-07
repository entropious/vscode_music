import SwiftUI

private func clamp(_ low: CGFloat, _ value: CGFloat, _ high: CGFloat) -> CGFloat { min(max(value, low), high) }

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
    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 24
        let origin = CGPoint(x: rect.midX - 12 * scale, y: rect.midY - 12 * scale)
        /// A point of the 24×24 box, in the rectangle.
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: origin.x + x * scale, y: origin.y + y * scale)
        }
        var path = Path()
        path.move(to: point(3, 12))
        path.addCurve(to: point(9, 12), control1: point(5, 9), control2: point(7, 9))
        path.addCurve(to: point(15, 12), control1: point(11, 15), control2: point(13, 15))
        path.addCurve(to: point(21, 12), control1: point(17, 9), control2: point(19, 9))
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

/// A fill that lightens under the pointer, and a border inside the same shape.
struct Chip<S: InsettableShape>: ViewModifier {
    let shape: S
    let base: Color
    let hover: Color
    let border: Color?
    @State private var over = false

    func body(content: Content) -> some View {
        content
            .background {
                ZStack {
                    shape.fill(over ? hover : base)
                    if let border { shape.strokeBorder(border, lineWidth: 1) }
                }
            }
            .onHover { over = $0 }
            .animation(.easeOut(duration: 0.3), value: over)
    }
}

extension View {
    /// A pill or rounded button's look: a fill that lightens under the pointer, and a border.
    func chip(
        _ shape: some InsettableShape,
        base: Color = .white.opacity(0.08),
        hover: Color = .white.opacity(0.14),
        border: Color? = nil
    ) -> some View {
        modifier(Chip(shape: shape, base: base, hover: hover, border: border))
    }
}

let ease = Animation.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.55)
