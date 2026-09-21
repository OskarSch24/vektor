import Cocoa

// Packages the selected artwork as a macOS icon; it never redraws the logo.
// Usage: swift generate-icon.swift [output.png] [source.png]
// The source is the approved variant 02 (Statuslicht).

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let output = CommandLine.arguments.count > 1
    ? URL(fileURLWithPath: CommandLine.arguments[1])
    : root.appendingPathComponent("icon_1024.png")
let source = CommandLine.arguments.count > 2
    ? URL(fileURLWithPath: CommandLine.arguments[2])
    : root.appendingPathComponent("brand/icon-source.png")

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

guard let artwork = NSImage(contentsOf: source) else {
    fail("Icon-Quelle nicht lesbar: \(source.path)")
}
guard artwork.size.width > 0, artwork.size.width == artwork.size.height else {
    fail("Die Icon-Quelle muss quadratisch sein.")
}

let canvas: CGFloat = 1024
let size = CGSize(width: canvas, height: canvas)
guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: Int(canvas), pixelsHigh: Int(canvas),
    bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0
), let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fail("Icon-Zeichenfläche konnte nicht erzeugt werden.")
}
bitmap.size = size

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = graphics
graphics.imageInterpolation = .high
let ctx = graphics.cgContext
ctx.clear(CGRect(origin: .zero, size: size))
ctx.setShouldAntialias(true)

// Retain the app's existing macOS tile dimensions and outer transparent margin.
let body = CGRect(x: 104, y: 104, width: 816, height: 816)
let shape = CGPath(roundedRect: body, cornerWidth: 172, cornerHeight: 172,
                   transform: nil)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -20), blur: 44,
              color: CGColor(gray: 0, alpha: 0.55))
ctx.setFillColor(CGColor(gray: 0.055, alpha: 1))
ctx.addPath(shape)
ctx.fillPath()
ctx.restoreGState()

ctx.saveGState()
ctx.addPath(shape)
ctx.clip()
artwork.draw(in: body, from: .zero, operation: .sourceOver, fraction: 1,
             respectFlipped: false, hints: [.interpolation: NSImageInterpolation.high])
ctx.restoreGState()
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fail("PNG konnte nicht erzeugt werden.")
}
try png.write(to: output, options: .atomic)
print("Icon 1024×1024 geschrieben: \(output.path)")
