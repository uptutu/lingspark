// The Mac client (D-061): a window around the setup page, and nothing else.
//
// The page and every operation behind it belong to the command-line lingspark
// shipped in Resources/bin. This shell starts `lingspark ui --window`, reads the
// address from the one line it prints, and shows it with the system's own web
// view -- the one Safari uses -- instead of bundling a browser. Hooks never
// launch this app: the CLI installs a copy of itself for them.

import Cocoa
import WebKit

let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"

/// Height of the title bar the page draws; the window buttons sit inside it.
let barHeight: CGFloat = 40
/// Where the gear button starts: the bar is draggable up to there.
let barButtonsFrom: CGFloat = 280

/// The page's title bar moves the window. A web view cannot say so itself, so
/// a transparent strip over the bar does it -- stopping short of the gear.
final class DragStrip: NSView {
    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

final class App: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    /// Held open for the server's lifetime: when this app goes, however it
    /// goes, the server reads end-of-input and exits.
    let serverInput = Pipe()
    var origin = ""
    let selfTest = ProcessInfo.processInfo.environment["LINGSPARK_SELFTEST"]

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let size = NSRect(x: 0, y: 0, width: 320, height: 400)
        window = NSWindow(
            contentRect: size,
            styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "LingSpark · 灵光"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = .black
        window.appearance = NSAppearance(named: .darkAqua)
        window.delegate = self

        let config = WKWebViewConfiguration()
        config.applicationNameForUserAgent = "LingSpark/\(appVersion)"
        web = WKWebView(frame: size, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        // Black until the page has drawn: no white flash on opening.
        web.setValue(false, forKey: "drawsBackground")
        web.isHidden = true

        let root = NSView(frame: size)
        root.addSubview(web)
        web.autoresizingMask = [.width, .height]
        let strip = DragStrip(frame: NSRect(x: 0, y: size.height - barHeight, width: barButtonsFrom, height: barHeight))
        strip.autoresizingMask = [.minYMargin]
        root.addSubview(strip)
        window.contentView = root

        if selfTest != nil {
            // On screen, so the page runs as it would, but fully transparent
            // and click-through: nobody sees it.
            window.alphaValue = 0
            window.ignoresMouseEvents = true
            window.orderFront(nil)
        } else {
            window.center()
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        placeWindowButtons()
        startServer()
    }

    // MARK: the server

    func startServer() {
        guard let cli = Bundle.main.resourceURL?.appendingPathComponent("bin/lingspark"),
              FileManager.default.isExecutableFile(atPath: cli.path) else {
            fail("安装包不完整：找不到命令行版 lingspark。请重新下载安装。")
            return
        }
        let process = Process()
        process.executableURL = cli
        process.arguments = ["ui", "--window"]
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        let output = Pipe()
        process.standardOutput = output
        process.standardInput = serverInput
        // "完成" or "退出" on the page ends the server; the app goes with it.
        process.terminationHandler = { _ in
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }

        var buffer = Data()
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            buffer.append(chunk)
            guard let text = String(data: buffer, encoding: .utf8),
                  let line = text.split(separator: "\n").first(where: { $0.hasPrefix("LINGSPARK_URL ") }),
                  let url = URL(string: String(line.dropFirst("LINGSPARK_URL ".count))) else { return }
            handle.readabilityHandler = nil
            DispatchQueue.main.async { self?.show(url) }
        }

        do {
            try process.run()
            server = process
        } catch {
            fail("启动失败：\(error.localizedDescription)")
        }
    }

    func show(_ url: URL) {
        origin = "\(url.scheme ?? "http")://\(url.host ?? ""):\(url.port ?? 80)"
        web.load(URLRequest(url: url))
    }

    func fail(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "LingSpark"
        alert.informativeText = message
        alert.runModal()
        NSApp.terminate(nil)
    }

    // MARK: the page

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        web.isHidden = false
        if let path = selfTest {
            // LINGSPARK_SELFTEST_CLICK=<element id> opens that view first;
            // LINGSPARK_SELFTEST_JS runs a script (for screenshots of a state).
            let env = ProcessInfo.processInfo.environment
            if let id = env["LINGSPARK_SELFTEST_CLICK"] {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    self.web.evaluateJavaScript("document.getElementById('\(id)').click()")
                }
            }
            if let js = env["LINGSPARK_SELFTEST_JS"] {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.web.evaluateJavaScript(js) }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.writeSelfTest(to: path) }
        }
    }

    /// The page stays the page: its own address loads here, https links open
    /// in the browser, anything else goes nowhere.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.absoluteString.hasPrefix(origin + "/") || url.absoluteString == origin {
            return decisionHandler(.allow)
        }
        if url.scheme == "https" { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    /// Links that ask for a new window.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = action.request.url, url.scheme == "https" { NSWorkspace.shared.open(url) }
        return nil
    }

    // MARK: the window

    /// The traffic lights sit centred in the page's 40-point bar, 14 points in,
    /// where the page leaves room for them.
    func placeWindowButtons() {
        guard let close = window.standardWindowButton(.closeButton),
              let titlebar = close.superview?.superview else { return }
        var frame = titlebar.frame
        frame.size.height = barHeight
        frame.origin.y = window.frame.height - barHeight
        titlebar.frame = frame
        let buttons: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
        for (i, type) in buttons.enumerated() {
            guard let button = window.standardWindowButton(type) else { continue }
            button.setFrameOrigin(NSPoint(
                x: 14 + CGFloat(i) * 20,
                y: (barHeight - button.frame.height) / 2
            ))
        }
    }

    // AppKit lays the title bar out again on these; put the buttons back.
    func windowDidResize(_ notification: Notification) { placeWindowButtons() }
    func windowDidBecomeKey(_ notification: Notification) { placeWindowButtons() }
    func windowDidResignKey(_ notification: Notification) { placeWindowButtons() }
    func windowDidDeminiaturize(_ notification: Notification) { placeWindowButtons() }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let server, server.isRunning { server.terminate() }
    }

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 LingSpark", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 LingSpark", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 LingSpark", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        // Copy and paste reach the page only through these.
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "关闭", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }

    // MARK: self-test (LINGSPARK_SELFTEST=<png>): transparent, never seen

    func writeSelfTest(to path: String) {
        let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].compactMap { type in
            window.standardWindowButton(type).map { b -> String in
                let r = b.convert(b.bounds, to: nil)
                return "\(Int(r.minX)),\(Int(window.frame.height - r.maxY)) \(Int(r.width))x\(Int(r.height))"
            }
        }
        print("buttons " + buttons.joined(separator: " | "))
        print("content \(Int(web.frame.width))x\(Int(web.frame.height)) window \(Int(window.frame.width))x\(Int(window.frame.height))")
        let probe = """
        (() => { const c = document.getElementById('orb'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let ink = 0; for (let i = 3; i < d.length; i += 4) ink += d[i] > 0 ? 1 : 0;
          return `orb ${c.width}x${c.height} ink=${ink} hidden=${document.hidden} engine=${typeof LingOrb} opacity=${getComputedStyle(c).opacity}`; })()
        """
        web.evaluateJavaScript(probe) { result, error in
            print(result as? String ?? "probe failed: \(String(describing: error))")
            self.snapshot(to: path)
        }
    }

    func snapshot(to path: String) {
        web.takeSnapshot(with: nil) { image, _ in
            if let tiff = image?.tiffRepresentation,
               let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: path))
            }
            fflush(stdout)
            NSApp.terminate(nil)
        }
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
// The self-test runs without a Dock icon.
app.setActivationPolicy(ProcessInfo.processInfo.environment["LINGSPARK_SELFTEST"] == nil ? .regular : .accessory)
app.run()
