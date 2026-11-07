import Accelerate
import AppKit
import ImageIO
import SwiftUI

/// Colors taken from a cover: a dark base for the page and two vivid ones for the glow and the spots.
struct Palette: Equatable {
    var base: Color
    var primary: Color
    var secondary: Color

    static let standard = Palette(
        base: Color(hex: "#0B0D12"),
        primary: Color(hex: "#3B8FA8"),
        secondary: Color(hex: "#6A5CFF")
    )
}

extension Color {
    static let accent = Color(hex: "#FFCC00")
    static let ai = Color(hex: "#FF6A4D")
    static let like = Color(hex: "#FF5A36")
    static let ink = Color(hex: "#141416")

    init(hex: String) {
        var digits = hex.trimmingCharacters(in: .whitespaces)
        if digits.hasPrefix("#") { digits.removeFirst() }
        if digits.count == 3 { digits = digits.map { "\($0)\($0)" }.joined() }
        let rgb = UInt32(digits.prefix(6), radix: 16) ?? 0
        self.init(
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255
        )
    }

    /// A color from a `#rgb` or `#rrggbb` string the service sends, if it is one.
    static func parse(_ hex: String?) -> Color? {
        guard let hex, hex.range(of: "^#[0-9a-fA-F]{3,8}$", options: .regularExpression) != nil else { return nil }
        return Color(hex: hex)
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
            let bitmap = CGImageSourceCreateImageAtIndex(
                source,
                0,
                [kCGImageSourceShouldCacheImmediately: true] as CFDictionary
            )
        else { return NSImage(data: data) }  // an SVG, which ImageIO doesn't read
        return NSImage(cgImage: bitmap, size: NSSize(width: bitmap.width, height: bitmap.height))
    }

    /// Loads a cover ahead of time, such as the next track's.
    func preload(_ url: URL?) {
        guard let url, images[url] == nil else { return }
        Task { _ = await load(url) }
    }
}

/// A pixel's channels, 0–255.
private typealias RGB = (red: Double, green: Double, blue: Double)

private struct HSV {
    let hue: Double
    let saturation: Double
    let value: Double

    init(_ color: RGB) {
        let brightest = max(color.red, color.green, color.blue)
        let darkest = min(color.red, color.green, color.blue)
        let range = brightest - darkest
        var sector = 0.0
        if range > 0 {
            if brightest == color.red {
                sector = ((color.green - color.blue) / range).truncatingRemainder(dividingBy: 6)
            } else if brightest == color.green {
                sector = (color.blue - color.red) / range + 2
            } else {
                sector = (color.red - color.green) / range + 4
            }
        }
        hue = (sector * 60 + 360).truncatingRemainder(dividingBy: 360)
        saturation = brightest > 0 ? range / brightest : 0
        value = brightest / 255
    }
}

private func hueGap(_ first: Double, _ second: Double) -> Double {
    min(abs(first - second), 360 - abs(first - second))
}

/// Brings a color to at least the given brightness, keeping its hue, so it glows on a dark page.
private func lift(_ color: RGB, _ minValue: Double) -> Color {
    let value = max(color.red, color.green, color.blue) / 255
    if value == 0 { return Color(red: minValue, green: minValue, blue: minValue) }
    let gain = value >= minValue ? 1 : minValue / value
    return Color(
        red: min(255, color.red * gain) / 255,
        green: min(255, color.green * gain) / 255,
        blue: min(255, color.blue * gain) / 255
    )
}

/// The cover's palette, as `paletteOf` in media/nowArt.js works it out: the vivid colors are the
/// most saturated and bright pixels, the second of another hue when the cover has one; the base
/// is the cover's average color, darkened well below the text.
func paletteOf(_ image: NSImage) -> Palette {
    let size = 24
    guard let bitmap = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
        let context = CGContext(
            data: nil,
            width: size,
            height: size,
            bitsPerComponent: 8,
            bytesPerRow: size * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
    else { return .standard }
    context.draw(bitmap, in: CGRect(x: 0, y: 0, width: size, height: size))
    guard let data = context.data?.assumingMemoryBound(to: UInt8.self) else { return .standard }
    var pixels: [(color: RGB, hue: Double, score: Double)] = []
    var sum: RGB = (0, 0, 0)
    for offset in stride(from: 0, to: size * size * 4, by: 4) {
        let color: RGB = (Double(data[offset]), Double(data[offset + 1]), Double(data[offset + 2]))
        sum = (sum.red + color.red, sum.green + color.green, sum.blue + color.blue)
        let hsv = HSV(color)
        let vivid = hsv.saturation > 0.25 && hsv.value > 0.3 ? 0.4 : 0
        pixels.append((color, hsv.hue, hsv.saturation * 0.7 + hsv.value * 0.3 + vivid))
    }
    pixels.sort { $0.score > $1.score }
    guard let first = pixels.first else { return .standard }
    let second =
        pixels.first { hueGap($0.hue, first.hue) > 40 && $0.score > 0.5 } ?? pixels[pixels.count / 6]
    let count = Double(pixels.count)
    let base = Color(
        red: sum.red / count * 0.28 / 255,
        green: sum.green / count * 0.28 / 255,
        blue: sum.blue / count * 0.28 / 255
    )
    return Palette(base: base, primary: lift(first.color, 0.6), secondary: lift(second.color, 0.5))
}

/// The cover blurred once into a small image for the background, as `blurredOf` in
/// media/nowArt.js: drawn 64 px wide past its edges, so the blur doesn't fade them, and blurred
/// with vImage on the CPU (Core Image would bring Metal and its caches into memory for it).
func blurredOf(_ image: NSImage) -> NSImage? {
    let size = 64
    guard let bitmap = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
        let context = CGContext(
            data: nil,
            width: size,
            height: size,
            bitsPerComponent: 8,
            bytesPerRow: size * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ),
        let pixels = context.data
    else { return nil }
    context.interpolationQuality = .high
    context.draw(bitmap, in: CGRect(x: -12, y: -12, width: size + 24, height: size + 24))
    var buffer = vImage_Buffer(
        data: pixels,
        height: vImagePixelCount(size),
        width: vImagePixelCount(size),
        rowBytes: size * 4
    )
    var scratch = [UInt8](repeating: 0, count: size * size * 4)
    // Three tent passes come close to a Gaussian blur of about 5 px.
    for _ in 0..<3 {
        scratch.withUnsafeMutableBytes { raw in
            var blurred = vImage_Buffer(
                data: raw.baseAddress,
                height: buffer.height,
                width: buffer.width,
                rowBytes: buffer.rowBytes
            )
            vImageTentConvolve_ARGB8888(&buffer, &blurred, nil, 0, 0, 9, 9, nil, vImage_Flags(kvImageEdgeExtend))
            memcpy(pixels, raw.baseAddress, size * size * 4)
        }
    }
    return context.makeImage().map { NSImage(cgImage: $0, size: NSSize(width: size, height: size)) }
}

/// Heights of a track's progress bars, as fractions of the tallest, shaped by the track's ID, as
/// `barHeights` in media/nowArt.js (the same 32-bit arithmetic, so each track keeps its look).
func barHeights(_ id: String, _ count: Int) -> [Double] {
    var hash: UInt32 = 2_166_136_261
    for unit in id.utf16 {
        hash = (hash ^ UInt32(unit)) &* 16_777_619
    }
    var heights: [Double] = []
    for bar in 0..<count {
        hash = (hash ^ (hash >> 15)) &* 2_246_822_507
        let random = Double(hash % 1000) / 1000
        let envelope = 0.55 + 0.45 * abs(sin(Double(bar) * 0.23 + 1))
        heights.append((6 + envelope * (8 + random * 20)) / 34)
    }
    return heights
}

/// A stable number from a string, for the colors that belong to a playlist.
func stableHash(_ text: String) -> UInt32 {
    var hash: UInt32 = 2_166_136_261
    for scalar in text.unicodeScalars {
        hash = (hash ^ scalar.value) &* 16_777_619
    }
    return hash
}

func formatTime(_ seconds: Double) -> String {
    guard seconds.isFinite, seconds >= 0 else { return "0:00" }
    let whole = Int(seconds)
    return "\(whole / 60):\(String(format: "%02d", whole % 60))"
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
        // The fonts' PostScript names, which IBM shortened for the semibold and medium weights.
        let name =
            switch weight {
            case .bold: "IBMPlexSans-Bold"
            case .semibold: "IBMPlexSans-SmBld"
            case .medium: "IBMPlexSans-Medm"
            default: "IBMPlexSans"
            }
        return .custom(name, fixedSize: size)
    }

    static func mono(_ size: CGFloat) -> Font { .custom("JetBrainsMono-Regular", fixedSize: size) }

    /// IBM Plex Sans' own line height, ascender plus descender, in ems.
    private static let sansLineHeight: CGFloat = 1.3

    /// The padding, negative, that takes a line of IBM Plex Sans down to the given CSS line height.
    static func trim(to lineHeight: CGFloat, size: CGFloat) -> CGFloat {
        (lineHeight - sansLineHeight) / 2 * size
    }
}

extension Image {
    /// An image drawn from its bitmap as it is: SwiftUI scales a CGImage when it shows it, while
    /// an NSImage it may first render into a new bitmap of the size it is shown at.
    init(bitmap: NSImage) {
        if let decoded = bitmap.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            self.init(decorative: decoded, scale: 1)
        } else {
            self.init(nsImage: bitmap)
        }
    }
}

/// A file of the app's resources: in the app's bundle, or in SwiftPM's when run with `swift run`.
func resourceURL(_ name: String) -> URL? {
    Bundle.main.url(forResource: name, withExtension: nil)
        ?? Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Resources")
}

@MainActor private var resourceImages: [String: NSImage] = [:]

@MainActor func resourceImage(_ name: String) -> NSImage? {
    if let image = resourceImages[name] { return image }
    let image = resourceURL(name).flatMap { NSImage(contentsOf: $0) }
    resourceImages[name] = image
    return image
}
