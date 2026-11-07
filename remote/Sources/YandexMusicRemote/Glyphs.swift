import SwiftUI

/// The dock's icons, as the web version's SVGs draw them in a 24×24 box: outlines of the same
/// width, scaled with the icon, and the shapes filled where the SVG fills them.
enum Glyph: CaseIterable {
    case dislike, previous, next, play, pause, heart, heartFilled, muted, audible, minus, plus

    /// Each glyph as one shape to fill in the 24×24 box, its outlines turned into areas; built once.
    fileprivate static let outlines: [Glyph: Path] = Dictionary(
        uniqueKeysWithValues: allCases.map { glyph in (glyph, Path(glyph.outline)) }
    )

    private var outline: CGPath {
        parts.reduce(CGPath(rect: .zero, transform: nil)) { shape, part in
            var shape = shape
            if part.filled { shape = shape.union(part.path.cgPath) }
            if let width = part.stroke {
                let stroke = part.path.cgPath.copy(
                    strokingWithWidth: width,
                    lineCap: .round,
                    lineJoin: .round,
                    miterLimit: 10
                )
                shape = shape.union(stroke)
            }
            return shape
        }
    }

    fileprivate struct Part {
        let path: Path
        var stroke: CGFloat?
        var filled = false
    }

    fileprivate var parts: [Part] {
        switch self {
        case .dislike:
            [Part(path: Path(ellipseIn: CGRect(x: 3.5, y: 3.5, width: 17, height: 17)), stroke: 2),
             Part(path: line((6, 6), (18, 18)), stroke: 2)]
        case .previous:
            [Part(path: line((6, 5), (6, 19)), stroke: 1.8),
             Part(path: polygon([(19, 5), (9, 12), (19, 19)]), stroke: 1.8, filled: true)]
        case .next:
            [Part(path: line((18, 5), (18, 19)), stroke: 1.8),
             Part(path: polygon([(5, 5), (15, 12), (5, 19)]), stroke: 1.8, filled: true)]
        case .play:
            [Part(path: polygon([(7, 5), (7, 19), (19, 12)]), stroke: 1.6, filled: true)]
        case .pause:
            [Part(path: line((8.5, 5.5), (8.5, 18.5)), stroke: 3.2),
             Part(path: line((15.5, 5.5), (15.5, 18.5)), stroke: 3.2)]
        case .heart:
            [Part(path: heartPath, stroke: 1.9)]
        case .heartFilled:
            [Part(path: heartPath, filled: true)]
        case .muted:
            [Part(path: speaker, stroke: 1.9),
             Part(path: line((16, 9.5), (21, 14.5)), stroke: 1.9),
             Part(path: line((21, 9.5), (16, 14.5)), stroke: 1.9)]
        case .audible:
            [Part(path: speaker, stroke: 1.9),
             Part(path: arc(center: (13.354, 12), radius: 4, from: -48.6, to: 48.6), stroke: 1.9),
             Part(path: arc(center: (13.401, 12), radius: 7.5, from: -47.17, to: 47.17), stroke: 1.9)]
        case .minus:
            [Part(path: line((5, 12), (19, 12)), stroke: 2.4)]
        case .plus:
            [Part(path: line((12, 5), (12, 19)), stroke: 2.4),
             Part(path: line((5, 12), (19, 12)), stroke: 2.4)]
        }
    }
}

private typealias Point = (x: CGFloat, y: CGFloat)

private func line(_ start: Point, _ end: Point) -> Path {
    var path = Path()
    path.move(to: CGPoint(x: start.x, y: start.y))
    path.addLine(to: CGPoint(x: end.x, y: end.y))
    return path
}

private func polygon(_ points: [Point]) -> Path {
    var path = Path()
    path.addLines(points.map { CGPoint(x: $0.x, y: $0.y) })
    path.closeSubpath()
    return path
}

/// An arc of a circle going clockwise on screen, from one angle to another, in degrees.
private func arc(center: Point, radius: CGFloat, from start: Double, to end: Double, into path: Path = Path()) -> Path {
    var path = path
    let steps = 32
    for step in 0...steps {
        let angle = (start + (end - start) * Double(step) / Double(steps)) * .pi / 180
        let point = CGPoint(x: center.x + radius * cos(angle), y: center.y + radius * sin(angle))
        if step == 0, path.isEmpty { path.move(to: point) } else { path.addLine(to: point) }
    }
    return path
}

/// `M4 9h3l5-4v14l-5-4H4z`
private let speaker = polygon([(4, 9), (7, 9), (12, 5), (12, 19), (7, 15), (4, 15)])

/// `M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z`
private let heartPath: Path = {
    var path = Path()
    path.move(to: CGPoint(x: 12, y: 20))
    path.addCurve(to: CGPoint(x: 5, y: 10), control1: CGPoint(x: 12, y: 20), control2: CGPoint(x: 5, y: 15.6))
    path = arc(center: (9.004, 10.045), radius: 4, from: 180.6, to: 318.6, into: path)
    path = arc(center: (14.996, 10.045), radius: 4, from: 221.4, to: 359.4, into: path)
    path.addCurve(to: CGPoint(x: 12, y: 20), control1: CGPoint(x: 19, y: 15.6), control2: CGPoint(x: 12, y: 20))
    path.closeSubpath()
    return path
}()

/// A glyph's shape, scaled from its 24×24 box to the middle of the frame.
private struct GlyphShape: Shape {
    let glyph: Glyph

    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 24
        let box = CGAffineTransform(translationX: rect.midX - 12 * scale, y: rect.midY - 12 * scale)
            .scaledBy(x: scale, y: scale)
        return (Glyph.outlines[glyph] ?? Path()).applying(box)
    }
}

/// A glyph in the foreground color, filling its frame.
struct GlyphView: View {
    let glyph: Glyph

    var body: some View {
        GlyphShape(glyph: glyph).fill()
    }
}
