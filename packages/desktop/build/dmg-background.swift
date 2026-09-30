// Draws the installer window's background (D-063): a line telling people what
// to do, an arrow from the app to Applications, and the first-launch step an
// unsigned app needs. Run by scripts/build-mac.mjs:
//
//   swift build/dmg-background.swift <out.png> <scale>
//
// Positions are in window points and must match the icon positions in
// scripts/dmg-settings.py.

import AppKit

let width: CGFloat = 540, height: CGFloat = 340
let appX: CGFloat = 135, appsX: CGFloat = 405, iconY: CGFloat = 170

let args = CommandLine.arguments
let out = args[1]
let scale = CGFloat(Double(args[2]) ?? 1)

let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(width * scale), pixelsHigh: Int(height * scale),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: width, height: height)

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
// Flip so y grows downwards, like Finder's icon positions.
let t = NSAffineTransform()
t.translateX(by: 0, yBy: height)
t.scaleX(by: 1, yBy: -1)
t.concat()
// Text needs to be told the context is flipped, or it draws upside down.
NSGraphicsContext.current = NSGraphicsContext(cgContext: NSGraphicsContext.current!.cgContext, flipped: true)

func gray(_ v: CGFloat, _ a: CGFloat = 1) -> NSColor { NSColor(white: v / 255, alpha: a) }

// Background: the app's black, a faint glow behind the app icon.
gray(10).setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
let glow = NSGradient(colors: [NSColor(red: 0.35, green: 0.85, blue: 1, alpha: 0.10), NSColor(red: 0.35, green: 0.85, blue: 1, alpha: 0)])!
glow.draw(fromCenter: NSPoint(x: appX, y: iconY), radius: 0, toCenter: NSPoint(x: appX, y: iconY), radius: 110, options: [])

func text(_ s: String, size: CGFloat, weight: NSFont.Weight, color: NSColor, y: CGFloat) {
    let font = NSFont(name: weight == .semibold ? "PingFangSC-Semibold" : "PingFangSC-Regular", size: size)
        ?? NSFont.systemFont(ofSize: size, weight: weight)
    let style = NSMutableParagraphStyle()
    style.alignment = .center
    let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .paragraphStyle: style]
    let str = NSAttributedString(string: s, attributes: attrs)
    let h = str.size().height
    str.draw(in: NSRect(x: 0, y: y - h / 2, width: width, height: h))
}

text("把 LingSpark 拖进「应用程序」", size: 15, weight: .semibold, color: gray(235), y: 52)

// The arrow, between the two icons.
let from = appX + 64, to = appsX - 64
let shaft = NSBezierPath()
shaft.move(to: NSPoint(x: from, y: iconY))
shaft.line(to: NSPoint(x: to - 2, y: iconY))
shaft.lineWidth = 1.5
shaft.setLineDash([4, 5], count: 2, phase: 0)
shaft.lineCapStyle = .round
gray(95).setStroke()
shaft.stroke()
let head = NSBezierPath()
head.move(to: NSPoint(x: to - 9, y: iconY - 7))
head.line(to: NSPoint(x: to, y: iconY))
head.line(to: NSPoint(x: to - 9, y: iconY + 7))
head.lineWidth = 1.5
head.lineCapStyle = .round
head.lineJoinStyle = .round
head.stroke()

// A hairline and the first-launch note.
gray(38).setFill()
NSRect(x: 40, y: 274, width: width - 80, height: 1).fill()
text("第一次打开被拦住：到「系统设置 → 隐私与安全性」，点「仍要打开」", size: 11.5, weight: .regular, color: gray(135), y: 302)

NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
