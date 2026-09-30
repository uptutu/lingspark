// Records the demo stage (tools/video/stage.html) to an MP4, with nothing but
// macOS: the system web view renders the page in a fully transparent,
// click-through window -- nobody sees it -- and AVFoundation encodes the
// snapshots. The stage says when it is ready (`window.__ready`) and when it
// is done (`window.__done`); frames carry the time they were taken.
//
//   swift tools/video/record.swift <stage url> <out.mp4> [fps]

import AVFoundation
import Cocoa
import WebKit

let args = CommandLine.arguments
let stageURL = URL(string: args[1])!
let outURL = URL(fileURLWithPath: args[2])
let fps = args.count > 3 ? Double(args[3]) ?? 24 : 24
let W = 1280, H = 720
let maxSeconds = 150.0

final class Recorder: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var writer: AVAssetWriter!
    var input: AVAssetWriterInput!
    var adaptor: AVAssetWriterInputPixelBufferAdaptor!
    var start: CFTimeInterval = 0
    var busy = false
    var frames = 0
    var lastTime = CMTime.invalid
    var finishing = false

    func applicationDidFinishLaunching(_ n: Notification) {
        let rect = NSRect(x: 0, y: 0, width: W, height: H)
        window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        web = WKWebView(frame: rect, configuration: WKWebViewConfiguration())
        web.navigationDelegate = self
        window.contentView = web
        window.orderFront(nil)
        web.load(URLRequest(url: stageURL))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        waitReady()
    }

    func waitReady() {
        web.evaluateJavaScript("window.__ready === true") { value, _ in
            if (value as? Bool) == true {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.begin() }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.waitReady() }
            }
        }
    }

    func begin() {
        try? FileManager.default.removeItem(at: outURL)
        writer = try! AVAssetWriter(outputURL: outURL, fileType: .mp4)
        input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: W,
            AVVideoHeightKey: H,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 6_000_000, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel],
        ])
        input.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
            kCVPixelBufferWidthKey as String: W,
            kCVPixelBufferHeightKey as String: H,
        ])
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        start = CACurrentMediaTime()
        web.evaluateJavaScript("window.__start()")
        Timer.scheduledTimer(withTimeInterval: 1 / fps, repeats: true) { _ in self.tick() }
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in self.checkDone() }
    }

    func tick() {
        if busy || finishing { return }
        busy = true
        let config = WKSnapshotConfiguration()
        config.snapshotWidth = NSNumber(value: W)
        web.takeSnapshot(with: config) { image, _ in
            defer { self.busy = false }
            guard let image, !self.finishing, self.input.isReadyForMoreMediaData,
                  let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
            let t = CMTime(seconds: CACurrentMediaTime() - self.start, preferredTimescale: 600)
            if self.lastTime.isValid && t <= self.lastTime { return }
            guard let pool = self.adaptor.pixelBufferPool else { return }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
            guard let buffer else { return }
            CVPixelBufferLockBaseAddress(buffer, [])
            let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: W, height: H, bitsPerComponent: 8,
                                bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
            ctx.interpolationQuality = .high
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: W, height: H))
            CVPixelBufferUnlockBaseAddress(buffer, [])
            if self.adaptor.append(buffer, withPresentationTime: t) {
                self.lastTime = t
                self.frames += 1
            }
        }
    }

    func checkDone() {
        if finishing { return }
        let elapsed = CACurrentMediaTime() - start
        web.evaluateJavaScript("window.__done === true") { value, _ in
            if (value as? Bool) == true || elapsed > maxSeconds { self.finish(elapsed) }
        }
    }

    func finish(_ elapsed: Double) {
        if finishing { return }
        finishing = true
        input.markAsFinished()
        writer.finishWriting {
            print(String(format: "%d frames, %.1f s, %.1f fps -> %@", self.frames, elapsed, Double(self.frames) / elapsed, outURL.path))
            exit(self.writer.status == .completed ? 0 : 1)
        }
    }
}

let app = NSApplication.shared
let delegate = Recorder()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
