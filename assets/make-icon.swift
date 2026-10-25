// Draws the JARVIS arc-reactor app icon with CoreGraphics and writes
// AppIcon.iconset/*.png. build.sh turns the set into AppIcon.icns with iconutil.
// Usage: swift make-icon.swift <output-iconset-dir>
import AppKit

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset"
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

func draw(size: CGFloat) -> NSImage {
    let img = NSImage(size: NSSize(width: size, height: size))
    img.lockFocus()
    guard let ctx = NSGraphicsContext.current?.cgContext else { img.unlockFocus(); return img }
    let s = size
    let c = CGPoint(x: s / 2, y: s / 2)

    // Rounded-square background (macOS icon shape), deep navy with a subtle vignette.
    let inset = s * 0.03
    let rect = CGRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    let path = CGPath(roundedRect: rect, cornerWidth: s * 0.22, cornerHeight: s * 0.22, transform: nil)
    ctx.addPath(path); ctx.clip()
    let bg = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                        colors: [CGColor(red: 0.05, green: 0.10, blue: 0.20, alpha: 1), CGColor(red: 0.01, green: 0.02, blue: 0.06, alpha: 1)] as CFArray,
                        locations: [0, 1])!
    ctx.drawRadialGradient(bg, startCenter: c, startRadius: 0, endCenter: c, endRadius: s * 0.75, options: [])

    // Outer glow.
    let glow = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                          colors: [CGColor(red: 0.22, green: 0.76, blue: 1, alpha: 0.55), CGColor(red: 0.22, green: 0.76, blue: 1, alpha: 0)] as CFArray,
                          locations: [0, 1])!
    ctx.drawRadialGradient(glow, startCenter: c, startRadius: s * 0.12, endCenter: c, endRadius: s * 0.46, options: [])

    let cyan = CGColor(red: 0.22, green: 0.76, blue: 1, alpha: 1)
    let dim = CGColor(red: 0.22, green: 0.76, blue: 1, alpha: 0.35)

    // Outer dial ring with ticks.
    ctx.setStrokeColor(cyan); ctx.setLineWidth(s * 0.012)
    ctx.strokeEllipse(in: CGRect(x: c.x - s * 0.40, y: c.y - s * 0.40, width: s * 0.80, height: s * 0.80))
    ctx.setStrokeColor(dim); ctx.setLineWidth(s * 0.006)
    ctx.strokeEllipse(in: CGRect(x: c.x - s * 0.36, y: c.y - s * 0.36, width: s * 0.72, height: s * 0.72))
    for i in 0..<36 {
        let a = CGFloat(i) / 36 * .pi * 2
        let long = i % 9 == 0
        let r1 = s * (long ? 0.33 : 0.345), r2 = s * 0.36
        ctx.setStrokeColor(long ? cyan : dim); ctx.setLineWidth(s * (long ? 0.012 : 0.006))
        ctx.move(to: CGPoint(x: c.x + cos(a) * r1, y: c.y + sin(a) * r1))
        ctx.addLine(to: CGPoint(x: c.x + cos(a) * r2, y: c.y + sin(a) * r2))
        ctx.strokePath()
    }

    // Arc segments (the reactor's broken rings).
    ctx.setLineCap(.round)
    for (radius, start, len, width, alpha) in [(0.30, 0.1, 1.9, 0.020, 1.0), (0.30, 2.4, 1.6, 0.020, 1.0), (0.30, 4.4, 1.4, 0.020, 1.0),
                                               (0.25, 0.9, 2.6, 0.014, 0.7), (0.25, 4.0, 1.9, 0.014, 0.7)] as [(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)] {
        ctx.setStrokeColor(CGColor(red: 0.22, green: 0.76, blue: 1, alpha: alpha)); ctx.setLineWidth(s * width)
        ctx.addArc(center: c, radius: s * radius, startAngle: start, endAngle: start + len, clockwise: false)
        ctx.strokePath()
    }

    // Triangle-ish inner core segments (10 spokes), then the bright core.
    for i in 0..<10 {
        let a = CGFloat(i) / 10 * .pi * 2
        ctx.setStrokeColor(CGColor(red: 0.6, green: 0.9, blue: 1, alpha: 0.8)); ctx.setLineWidth(s * 0.01)
        ctx.move(to: CGPoint(x: c.x + cos(a) * s * 0.11, y: c.y + sin(a) * s * 0.11))
        ctx.addLine(to: CGPoint(x: c.x + cos(a) * s * 0.20, y: c.y + sin(a) * s * 0.20))
        ctx.strokePath()
    }
    let core = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                          colors: [CGColor(red: 1, green: 1, blue: 1, alpha: 1), CGColor(red: 0.55, green: 0.9, blue: 1, alpha: 1), CGColor(red: 0.22, green: 0.76, blue: 1, alpha: 0)] as CFArray,
                          locations: [0, 0.45, 1])!
    ctx.drawRadialGradient(core, startCenter: c, startRadius: 0, endCenter: c, endRadius: s * 0.15, options: [])
    img.unlockFocus()
    return img
}

func write(_ img: NSImage, _ px: Int, _ name: String) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    img.draw(in: NSRect(x: 0, y: 0, width: px, height: px), from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
}

let master = draw(size: 1024)
for (pt, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)] {
    write(master, pt * scale, "icon_\(pt)x\(pt)\(scale == 2 ? "@2x" : "")")
}
print("wrote \(outDir)")
