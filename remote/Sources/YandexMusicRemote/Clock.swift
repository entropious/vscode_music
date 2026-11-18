import AppKit
import SwiftUI

enum ClockPhase {
    case day, evening, night

    /// The minutes of the day at which the clock turns orange and red, and back to white; a build
    /// with `scripts/build-app.sh --personal` keeps its author's own hours.
    #if PERSONAL
    private static let eveningStart = 22 * 60 + 30
    private static let nightStart = 23 * 60
    private static let dayStart = 0
    #else
    private static let eveningStart = 21 * 60
    private static let nightStart = 23 * 60
    private static let dayStart = 7 * 60
    #endif

    /// From the first minute of the day up to the second, past midnight when the second comes first.
    private static func within(_ minute: Int, _ start: Int, _ end: Int) -> Bool {
        start <= end ? minute >= start && minute < end : minute >= start || minute < end
    }

    init(_ date: Date) {
        let time = Calendar.current.dateComponents([.hour, .minute], from: date)
        let minute = (time.hour ?? 0) * 60 + (time.minute ?? 0)
        if Self.within(minute, Self.nightStart, Self.dayStart) {
            self = .night
        } else if Self.within(minute, Self.eveningStart, Self.nightStart) {
            self = .evening
        } else {
            self = .day
        }
    }

    var color: Color {
        switch self {
        case .day: .white
        case .evening: Color(hex: "#FF9A3D")
        case .night: Color(hex: "#FF4D4D")
        }
    }

    /// The text's shadow, as `text-shadow` (whose blur is twice SwiftUI's radius).
    var shadow: (color: Color, radius: CGFloat, y: CGFloat) {
        switch self {
        case .day: (.black.opacity(0.35), 12, 2)
        case .evening: (Color(red: 1, green: 154 / 255, blue: 61 / 255).opacity(0.45), 14, 0)
        case .night: (Color(red: 1, green: 77 / 255, blue: 77 / 255).opacity(0.55), 16, 0)
        }
    }
}

/// The local time, HH:MM, white by day, orange in the evening and red at night. It changes on the
/// minute, playing or not.
struct ClockView: View {
    let size: CGFloat
    private let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

    private static let format: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    /// Where the tops of the digits are in the 64 pt block, which the text overflows, centered.
    private static func digitsTop(_ size: CGFloat) -> CGFloat {
        guard let font = NSFont(name: "IBMPlexSans-SmBld", size: size) else { return 0 }
        let lineHeight = font.ascender - font.descender + font.leading
        return (64 - lineHeight) / 2 + font.ascender - font.capHeight
    }

    var body: some View {
        let digitsTop = Self.digitsTop(size)
        TimelineView(.everyMinute) { context in
            let time = Self.format.string(from: context.date)
            let phase = ClockPhase(context.date)
            let shadow = phase.shadow
            Text(time)
                .font(Fonts.sans(size, .semibold))
                .monospacedDigit()
                .tracking(-0.03 * size)
                .lineLimit(1)
                .fixedSize()
                .foregroundStyle(phase.color)
                .shadow(color: shadow.color, radius: shadow.radius, y: shadow.y)
                .animation(reduceMotion ? nil : .easeInOut(duration: 1.5), value: phase)
                // The digits are taller than the block, which keeps the bar at its height.
                .frame(height: 64)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(time)
                .accessibilityAddTraits(.updatesFrequently)
        }
        // The bar's buttons line up with the tops of the digits.
        .alignmentGuide(.top) { dimensions in dimensions[.top] + digitsTop }
    }
}
