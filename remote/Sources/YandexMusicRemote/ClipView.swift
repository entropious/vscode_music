import SwiftUI

/// The clip mode, with the video in front: the clock and the way back to the player on top; the
/// progress over the whole width at the bottom, and under it the artist, the buttons in the middle
/// and the track's title.
struct ClipView: View {
    @Environment(PlayerModel.self) private var model
    let metrics: Metrics

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 0) {
                ClockView(size: metrics.clock)
                Spacer(minLength: 16)
                modeSwitch
            }
            .padding(.top, 40)
            .padding(.bottom, 16)
            .padding(.horizontal, metrics.gutter)
            .frame(minHeight: TopBar.height)
            .background(WindowDragArea())
            Spacer(minLength: 0)
            VStack(spacing: 14) {
                ProgressBars(metrics: metrics, clip: true)
                HStack(spacing: 24) {
                    info.frame(maxWidth: .infinity, alignment: .leading)
                    TransportButtons(metrics: metrics, clip: true)
                        .padding(.vertical, 12)
                        .padding(.horizontal, 22)
                        .background(
                            Color(red: 14 / 255, green: 16 / 255, blue: 22 / 255).opacity(0.48),
                            in: RoundedRectangle(cornerRadius: 40)
                        )
                        .overlay(RoundedRectangle(cornerRadius: 40).stroke(.white.opacity(0.12), lineWidth: 1))
                        .shadow(color: .black.opacity(0.4), radius: 25, y: 20)
                    // As wide as the info, so the buttons stay in the middle.
                    Text(model.current?.fullTitle ?? "")
                        .font(Fonts.sans(metrics.clipTitle, .bold))
                        .tracking(-0.03 * metrics.clipTitle)
                        .foregroundStyle(.white.opacity(0.55))
                        .lineLimit(1)
                        .padding(.vertical, Fonts.trim(to: 1.05, size: metrics.clipTitle))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, metrics.gutter)
            .padding(.bottom, metrics.clipBottom)
        }
    }

    /// The source and the artist in large letters; the track's title is on the other side of the buttons.
    private var info: some View {
        let track = model.current
        let size = metrics.clipTitle
        return VStack(alignment: .leading, spacing: 6) {
            SourceLine(size: metrics.clipSource)
            Text(track?.artistLine ?? "Nothing is playing")
                .font(Fonts.sans(size, .bold))
                .tracking(-0.03 * size)
                .lineLimit(1)
                .padding(.vertical, Fonts.trim(to: 1.05, size: size))
                .shadow(color: .black.opacity(0.5), radius: 15, y: 4)
        }
    }

    /// Track goes back to the player; Video is where it is now.
    private var modeSwitch: some View {
        HStack(spacing: 6) {
            Button {
                model.setVideoFront(false)
            } label: {
                HStack(spacing: 10) {
                    WaveIcon(lineWidth: 2.3).frame(width: 22, height: 22)
                    Text("Track").fixedSize()
                }
                .padding(.horizontal, 24)
                .frame(height: 52)
                .chip(Capsule(), base: .clear, hover: .white.opacity(0.1))
            }
            .buttonStyle(.plain)
            .help("Back to the player")
            HStack(spacing: 10) {
                Image(systemName: "play.rectangle").font(.system(size: 20, weight: .medium))
                Text("Video").fixedSize()
            }
            .padding(.horizontal, 24)
            .frame(height: 52)
            .foregroundStyle(Color.ink)
            .background(Color.accent, in: Capsule())
        }
        .font(Fonts.sans(20, .semibold))
        .padding(6)
        .background(.white.opacity(0.10), in: Capsule())
        .overlay(Capsule().stroke(.white.opacity(0.16), lineWidth: 1))
    }
}
