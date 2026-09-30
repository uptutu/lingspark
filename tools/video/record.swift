// Records the demo stage (tools/video/stage.html) to an MP4, with nothing but
// macOS: the system web view renders the page in a fully transparent,
// click-through window -- nobody sees it -- and AVFoundation encodes the
// snapshots. The stage says when it is ready (`window.__ready`) and when it
// is done (`window.__done`).
//
// A 1080p snapshot takes longer than a frame lasts, so the stage runs SLOW
// times slower (slowtime.js, set by proxy.mjs --slow) and each frame is
// stamped with the time it was taken divided by SLOW: at SLOW 5, a dozen
// snapshots a second of real time make 60 a second of video.
//
//   swiftc -O tools/video/record.swift -o record && ./record <stage url> <out.mp4> <slow> [fps]

import AVFoundation
import Cocoa
import WebKit

let args = CommandLine.arguments
let stageURL = URL(string: args[1])!
let outURL = URL(fileURLWithPath: args[2])
let slow = args.count > 3 ? Double(args[3]) ?? 1 : 1
let fps = args.count > 4 ? Double(args[4]) ?? 60 : 60
/// The stage is 1280x720 CSS pixels; snapshots come at the screen's 2x and are
/// drawn down to 1080p.
let pageW = 1280, pageH = 720
let W = 1920, H = 1080
let maxSeconds = 150.0 * slow

final class Recorder: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var writer: AVAssetWriter!
    var input: AVAssetWriterInput!
    var adaptor: AVAssetWriterInputPixelBufferAdaptor!
    var start: CFTimeInterval = 0
    var frames = 0
    var repeats = 0
    /// Constant frame rate: frame n is shown at n / fps. A snapshot fills the
    /// slot its time falls in; slots it skipped over repeat the previous
    /// frame, so every frame lasts exactly as long as the next.
    var nextSlot = 0
    var previous: CVPixelBuffer?
    var finishing = false

    func applicationDidFinishLaunching(_ n: Notification) {
        let rect = NSRect(x: 0, y: 0, width: pageW, height: pageH)
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
        // Index at the front: a browser can start playing before the end arrives.
        writer.shouldOptimizeForNetworkUse = true
        input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: W,
            AVVideoHeightKey: H,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 16_000_000,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoExpectedSourceFrameRateKey: Int(fps),
                AVVideoMaxKeyFrameIntervalKey: Int(fps) * 2,
            ],
        ])
        input.expectsMediaDataInRealTime = false
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
        tick()
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in self.checkDone() }
    }

    /// Snapshots back to back: each one starts when the last is done.
    func tick() {
        if finishing { return }
        let config = WKSnapshotConfiguration()
        config.snapshotWidth = NSNumber(value: pageW)
        web.takeSnapshot(with: config) { image, _ in
            defer { DispatchQueue.main.async { self.tick() } }
            guard let image, !self.finishing, self.input.isReadyForMoreMediaData,
                  let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
            let slot = Int(((CACurrentMediaTime() - self.start) / slow * fps).rounded(.down))
            if slot < self.nextSlot { return }
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
            let at = { (n: Int) in CMTime(value: CMTimeValue(n), timescale: CMTimeScale(fps)) }
            if let previous = self.previous {
                while self.nextSlot < slot, self.input.isReadyForMoreMediaData {
                    self.adaptor.append(previous, withPresentationTime: at(self.nextSlot))
                    self.nextSlot += 1
                    self.repeats += 1
                }
            }
            if self.adaptor.append(buffer, withPresentationTime: at(slot)) {
                self.nextSlot = slot + 1
                self.previous = buffer
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
            let video = elapsed / slow
            print(String(format: "%d frames (%d repeated to keep the rate), %.1f s of video at a constant %.0f fps -> %@",
                         self.frames + self.repeats, self.repeats, video, fps, outURL.path))
            exit(self.writer.status == .completed ? 0 : 1)
        }
    }
}

let app = NSApplication.shared
let delegate = Recorder()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
