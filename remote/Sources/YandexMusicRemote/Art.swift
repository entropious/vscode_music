import Accelerate
import AppKit
import ImageIO
import SwiftUI

/// Colors taken from a cover: a dark base for the page and two vivid ones for the glow and the spots.
struct Palette: Equatable {
    var base: Color
    var a: Color
    var b: Color

    static let standard = Palette(base: Color(hex: "#0B0D12"), a: Color(hex: "#3B8FA8"), b: Color(hex: "#6A5CFF"))
}

extension Color {
    static let accent = Color(hex: "#FFCC00")
    static let ai = Color(hex: "#FF6A4D")
    static let like = Color(hex: "#FF5A36")
    static let ink = Color(hex: "#141416")

    init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        let v = UInt32(s.prefix(6), radix: 16) ?? 0
        self.init(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }

    /// A color from a `#rgb` or `#rrggbb` string the service sends, if it is one.
    static func parse(_ s: String?) -> Color? {
        guard let s, s.range(of: "^#[0-9a-fA-F]{3,8}$", options: .regularExpression) != nil else { return nil }
        return Color(hex: s)
    }
}

/// Loads images once and keeps them, so a cover shown again (or loaded ahead) appears at once.
/// An image is decoded once, as a bitmap of its own size; the downloaded bytes aren't kept. Only
/// the latest images stay: the covers of the current, next and recent tracks and the visible rows.
@MainActor
final class ImageStore {
    static let shared = ImageStore()
    private static let limit = 80
    private var images: [URL: NSImage] = [:]
    private var order: [URL] = []
    private var loading: [URL: Task<NSImage?, Never>] = [:]
    /// The downloads go straight to the store: URLSession's own cache would keep them a second time.
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        return URLSession(configuration: config)
    }()

    func cached(_ url: URL?) -> NSImage? { url.flatMap { images[$0] } }

    func load(_ url: URL) async -> NSImage? {
        if let image = images[url] { return image }
        if let task = loading[url] { return await task.value }
        let session = session
        let task = Task<NSImage?, Never>.detached {
            guard let (data, _) = try? await session.data(from: url) else { return nil }
            return ImageStore.decode(data)
        }
        loading[url] = task
        let image = await task.value
        loading[url] = nil
        if let image {
            images[url] = image
            order.append(url)
            if order.count > Self.limit {
                images[order.removeFirst()] = nil
            }
        }
        return image
    }

    nonisolated private static func decode(_ data: Data) -> NSImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let cg = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        else { return NSImage(data: data) } // an SVG, which ImageIO doesn't read
        return NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
    }

    /// Loads a cover ahead of time, such as the next track's.
    func preload(_ url: URL?) {
        guard let url, images[url] == nil else { return }
        Task { _ = await load(url) }
    }
}

private struct HSV {
    let h: Double, s: Double, v: Double

    init(_ r: Double, _ g: Double, _ b: Double) {
        let mx = max(r, g, b), mn = min(r, g, b), d = mx - mn
        var h = 0.0
        if d > 0 {
            h = mx == r ? ((g - b) / d).truncatingRemainder(dividingBy: 6) : mx == g ? (b - r) / d + 2 : (r - g) / d + 4
        }
        self.h = (h * 60 + 360).truncatingRemainder(dividingBy: 360)
        s = mx > 0 ? d / mx : 0
        v = mx / 255
    }
}

private func hueGap(_ a: Double, _ b: Double) -> Double { min(abs(a - b), 360 - abs(a - b)) }

/// Brings a color to at least the given brightness, keeping its hue, so it glows on a dark page.
private func lift(_ c: (Double, Double, Double), _ minV: Double) -> Color {
    let v = max(c.0, c.1, c.2) / 255
    if v == 0 { return Color(red: minV, green: minV, blue: minV) }
    let k = v >= minV ? 1 : minV / v
    return Color(red: min(255, c.0 * k) / 255, green: min(255, c.1 * k) / 255, blue: min(255, c.2 * k) / 255)
}

/// The cover's palette, as `paletteOf` in media/nowArt.js works it out: the vivid colors are the
/// most saturated and bright pixels, the second of another hue when the cover has one; the base
/// is the cover's average color, darkened well below the text.
func paletteOf(_ image: NSImage) -> Palette {
    let size = 24
    guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
          let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return .standard }
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: size, height: size))
    guard let data = ctx.data?.assumingMemoryBound(to: UInt8.self) else { return .standard }
    var pixels: [(c: (Double, Double, Double), h: Double, score: Double)] = []
    var sum = (0.0, 0.0, 0.0)
    for i in stride(from: 0, to: size * size * 4, by: 4) {
        let c = (Double(data[i]), Double(data[i + 1]), Double(data[i + 2]))
        sum = (sum.0 + c.0, sum.1 + c.1, sum.2 + c.2)
        let hsv = HSV(c.0, c.1, c.2)
        pixels.append((c, hsv.h, hsv.s * 0.7 + hsv.v * 0.3 + (hsv.s > 0.25 && hsv.v > 0.3 ? 0.4 : 0)))
    }
    pixels.sort { $0.score > $1.score }
    guard let first = pixels.first else { return .standard }
    let second = pixels.first { hueGap($0.h, first.h) > 40 && $0.score > 0.5 } ?? pixels[pixels.count / 6]
    let n = Double(pixels.count)
    let base = Color(red: sum.0 / n * 0.28 / 255, green: sum.1 / n * 0.28 / 255, blue: sum.2 / n * 0.28 / 255)
    return Palette(base: base, a: lift(first.c, 0.6), b: lift(second.c, 0.5))
}

/// The cover blurred once into a small image for the background, as `blurredOf` in
/// media/nowArt.js: drawn 64 px wide past its edges, so the blur doesn't fade them, and blurred
/// with vImage on the CPU (Core Image would bring Metal and its caches into memory for it).
func blurredOf(_ image: NSImage) -> NSImage? {
    let size = 64
    guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
          let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let pixels = ctx.data
    else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(cg, in: CGRect(x: -12, y: -12, width: size + 24, height: size + 24))
    var buffer = vImage_Buffer(data: pixels, height: vImagePixelCount(size), width: vImagePixelCount(size), rowBytes: size * 4)
    var temp = [UInt8](repeating: 0, count: size * size * 4)
    // Three tent passes come close to a Gaussian blur of about 5 px.
    for _ in 0..<3 {
        temp.withUnsafeMutableBytes { raw in
            var out = vImage_Buffer(data: raw.baseAddress, height: buffer.height, width: buffer.width, rowBytes: buffer.rowBytes)
            vImageTentConvolve_ARGB8888(&buffer, &out, nil, 0, 0, 9, 9, nil, vImage_Flags(kvImageEdgeExtend))
            memcpy(pixels, raw.baseAddress, size * size * 4)
        }
    }
    return ctx.makeImage().map { NSImage(cgImage: $0, size: NSSize(width: size, height: size)) }
}

/// Heights of a track's progress bars, as fractions of the tallest, shaped by the track's ID, as
/// `barHeights` in media/nowArt.js (the same 32-bit arithmetic, so each track keeps its look).
func barHeights(_ id: String, _ count: Int) -> [Double] {
    var h: UInt32 = 2_166_136_261
    for unit in id.utf16 {
        h = (h ^ UInt32(unit)) &* 16_777_619
    }
    var out: [Double] = []
    for i in 0..<count {
        h = (h ^ (h >> 15)) &* 2_246_822_507
        let r = Double(h % 1000) / 1000
        let env = 0.55 + 0.45 * abs(sin(Double(i) * 0.23 + 1))
        out.append((6 + env * (8 + r * 20)) / 34)
    }
    return out
}

/// A stable number from a string, for the colors that belong to a playlist.
func stableHash(_ s: String) -> UInt32 {
    var x: UInt32 = 2_166_136_261
    for scalar in s.unicodeScalars {
        x = (x ^ scalar.value) &* 16_777_619
    }
    return x
}

func formatTime(_ sec: Double) -> String {
    guard sec.isFinite, sec >= 0 else { return "0:00" }
    let s = Int(sec)
    return "\(s / 60):\(String(format: "%02d", s % 60))"
}

/// Fonts bundled with the app, registered once at launch.
enum Fonts {
    static func register() {
        guard let dir = resourceURL("Fonts"),
              let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
        else { return }
        for file in files where file.pathExtension == "ttf" {
            CTFontManagerRegisterFontsForURL(file as CFURL, .process, nil)
        }
    }

    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        let name = switch weight {
        case .bold: "IBMPlexSans-Bold"
        case .semibold: "IBMPlexSans-SemiBold"
        case .medium: "IBMPlexSans-Medium"
        default: "IBMPlexSans"
        }
        return .custom(name, fixedSize: size)
    }

    static func mono(_ size: CGFloat) -> Font { .custom("JetBrainsMono-Regular", fixedSize: size) }
}

extension Image {
    /// An image drawn from its bitmap as it is: SwiftUI scales a CGImage when it shows it, while
    /// an NSImage it may first render into a new bitmap of the size it is shown at.
    init(bitmap: NSImage) {
        if let cg = bitmap.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            self.init(decorative: cg, scale: 1)
        } else {
            self.init(nsImage: bitmap)
        }
    }
}

/// A file of the app's resources: in the app's bundle, or in SwiftPM's when run with `swift run`.
func resourceURL(_ name: String) -> URL? {
    Bundle.main.url(forResource: name, withExtension: nil) ?? Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Resources")
}

@MainActor private var resourceImages: [String: NSImage] = [:]

@MainActor func resourceImage(_ name: String) -> NSImage? {
    if let image = resourceImages[name] { return image }
    let image = resourceURL(name).flatMap { NSImage(contentsOf: $0) }
    resourceImages[name] = image
    return image
}
