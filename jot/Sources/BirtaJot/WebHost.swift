import AppKit
import WebKit
import BirtaJotCore

/// Serves the page and the webview bundle from the app's `web/` resources
/// over a custom scheme, `birta://app/...`.
///
/// A scheme rather than `file://` because a real origin is what module
/// scripts, dynamic `import()` of `dist/chunks/*` and a `'self'` CSP all
/// want, MIME types are explicit (WebKit is strict about `text/javascript` for
/// modules), and nothing outside `web/` is reachable. `index.html` is a
/// template: the CSP and the initial theme class are filled at serve time.
final class BirtaSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "birta"
    static let pageURL = URL(string: "birta://app/index.html")!

    let webRoot: URL
    private var stopped = Set<ObjectIdentifier>()
    private let lock = NSLock()
    /// What the page may read. Guarded by `lock` because scheme tasks arrive
    /// off the main thread while the coordinator rebinds this on the main one
    /// (opening a different document changes which folder serves images).
    private var _roots: ResourceRoots
    var roots: ResourceRoots {
        get { lock.lock(); defer { lock.unlock() }; return _roots }
        set { lock.lock(); _roots = newValue; lock.unlock() }
    }
    /// The theme class for the initial paint; the host updates it before every reload.
    var themeClass = "vscode-light"
    /// Whether the page may reach the network (Preferences opt-in).
    var networkEnabled = false

    init(webRoot: URL, documentDirectory: URL?) {
        self.webRoot = webRoot
        self._roots = ResourceRoots(bundle: webRoot, document: documentDirectory)
    }

    private static let mime: [String: String] = [
        "html": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "json": "application/json",
        "wasm": "application/wasm",
        "svg": "image/svg+xml",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "woff": "font/woff",
        "woff2": "font/woff2",
        "ttf": "font/ttf",
        "map": "application/json",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let key = ObjectIdentifier(task)
        lock.lock(); stopped.remove(key); lock.unlock()
        guard let url = task.request.url else { return fail(task, key) }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        // No escaping the web root.
        // What may be read is ResourceRoots' question, not this method's: the
        // request path can come from the open document (an image reference),
        // so containment is a rule rather than a check to remember here.
        guard let file = roots.resolve(path) else { return fail(task, key, status: 404) }
        let ext = file.pathExtension.lowercased()
        var data: Data
        if path == "/index.html" {
            guard let template = try? String(contentsOf: file, encoding: .utf8) else { return fail(task, key) }
            data = Data(renderPage(template).utf8)
        } else if let d = try? Data(contentsOf: file) {
            data = d
        } else {
            return fail(task, key, status: 404)
        }
        let headers = [
            "Content-Type": Self.mime[ext] ?? "application/octet-stream",
            "Content-Length": String(data.count),
            "Cache-Control": "no-store",
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
            return fail(task, key)
        }
        deliver(task, key) { task.didReceive(response) }
        deliver(task, key) { task.didReceive(data) }
        deliver(task, key) { task.didFinish() }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.lock(); stopped.insert(ObjectIdentifier(task)); lock.unlock()
    }

    /// Calling into a task WebKit has stopped is a crash; check first.
    private func deliver(_ task: WKURLSchemeTask, _ key: ObjectIdentifier, _ body: () -> Void) {
        lock.lock(); let isStopped = stopped.contains(key); lock.unlock()
        if !isStopped { body() }
    }

    private func fail(_ task: WKURLSchemeTask, _ key: ObjectIdentifier, status: Int = 500) {
        deliver(task, key) {
            task.didFailWithError(NSError(domain: "com.birtalabs.jot", code: status,
                                          userInfo: [NSLocalizedDescriptionKey: "birta scheme: \(status) for \(task.request.url?.absoluteString ?? "?")"]))
        }
    }

    /// The CSP mirrors src/webviewHtml.ts in shape: nothing by default, our
    /// own origin for scripts and styles, inline styles (ProseMirror and the
    /// components set them), wasm for the lazy engines, data: for the fonts
    /// esbuild inlines. The network opt-in widens img/frame/connect to https:,
    /// which is what link cards and embeds need and what NETWORK_POSTURE.md
    /// calls the user's consent.
    func csp() -> String {
        let net = networkEnabled ? " https:" : ""
        return [
            "default-src 'none'",
            "style-src 'self' 'unsafe-inline'",
            "script-src 'self' 'wasm-unsafe-eval'",
            "img-src 'self' data: blob:\(net)",
            "font-src 'self' data:",
            "connect-src 'self'\(net)",
            "frame-src\(networkEnabled ? " https:" : " 'none'")",
            "media-src 'self' data:\(net)",
        ].joined(separator: "; ")
    }

    func renderPage(_ template: String) -> String {
        template
            .replacingOccurrences(of: "{{CSP}}", with: csp())
            .replacingOccurrences(of: "{{THEME_CLASS}}", with: themeClass)
    }
}

/// Owns the WKWebView, the bridge in both directions, and the warm/cold state.
@MainActor
final class WebHost: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    let schemeHandler: BirtaSchemeHandler
    private let controller = WKUserContentController()
    var onMessage: ((WebviewMessage) -> Void)?
    var onProcessTerminated: (() -> Void)?
    /// Sent before the page loads; rebuilt on every reload so a fresh page
    /// gets the current prefs.
    var bootConfig: () -> BootConfig = { BootConfig() }

    init(webRoot: URL, documentDirectory: URL?) {
        schemeHandler = BirtaSchemeHandler(webRoot: webRoot, documentDirectory: documentDirectory)
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(schemeHandler, forURLScheme: BirtaSchemeHandler.scheme)
        config.userContentController = controller
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        controller.add(WeakScriptHandler(self), name: "birta")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = false
        webView.isInspectable = true
    }

    /// (Re)load the page with a fresh boot script.
    func load(themeClass: String) {
        schemeHandler.themeClass = themeClass
        controller.removeAllUserScripts()
        let script = WKUserScript(source: bootConfig().userScript(themeClass: themeClass),
                                  injectionTime: .atDocumentStart, forMainFrameOnly: true)
        controller.addUserScript(script)
        webView.load(URLRequest(url: BirtaSchemeHandler.pageURL))
    }

    /// Host → page: `window.postMessage`, the only inbound path the page has.
    func send(_ message: HostMessage) {
        let json = message.jsonString()
        webView.callAsyncJavaScript("window.postMessage(JSON.parse(m), '*');",
                                    arguments: ["m": json], in: nil, in: .page) { _ in }
    }

    func setThemeClass(_ cls: String) {
        schemeHandler.themeClass = cls
        let js = "document.body.classList.remove('vscode-light','vscode-dark'); document.body.classList.add(\(jsString(cls)));"
        webView.evaluateJavaScript(js) { _, _ in }
    }

    /// Host → page: whether the window is at rest, which the page's own
    /// stylesheet (jot/Resources/index.html) reads to put the toolbar away.
    /// A class rather than a message: the bundle is the extension's and knows
    /// nothing about a window nobody is pointing at.
    /// Toggle `body.jot-resting`, which the page styles when it has a resting
    /// treatment to apply.
    ///
    /// It currently has none. The rule this drove faded the formatting
    /// controls when the pointer left the window, and that stopped being
    /// possible when they became a row of the bar: the strip it was written
    /// for was fixed to the window's bottom edge and outside the layout, so
    /// fading it left nothing behind, where fading a row of the bar leaves the
    /// text pushed down around a gap with nothing drawn in it. Removing the
    /// row instead reflows the document every time the pointer leaves the
    /// window, which is what the original rule chose opacity to avoid.
    ///
    /// The machinery is kept rather than deleted because the question it
    /// answers is still a good one and the hover tracking behind it is the
    /// expensive half to rebuild. Anything that fades here has to cost no
    /// layout, which is a real constraint on what the next treatment can be.
    func setChromeResting(_ resting: Bool) {
        let js = "document.body.classList.toggle('jot-resting', \(resting ? "true" : "false"));"
        webView.evaluateJavaScript(js) { _, _ in }
    }

    /// Ask the page where its formatting dock is, for `jot/scripts/measure.sh`.
    ///
    /// The panel's own page carries CSS the browser harness does not (the
    /// titlebar carve-out, and the leading inset that belongs to the first row
    /// alone), so "the row renders in WebKit" and "the row renders in THIS
    /// window, where the left edge is the window's" are different claims. This
    /// is how the second one gets asked.
    func reportDockGeometry(_ report: @escaping (String) -> Void) {
        let js = """
        (function () {
          var d = document.querySelector('.tb-dock');
          if (!d) { return 'absent'; }
          var bar = document.querySelector('.editor-topbar');
          var toggle = document.querySelector('.tb-dock-toggle');
          var r = d.getBoundingClientRect();
          var b = bar ? bar.getBoundingClientRect() : { top: -1, bottom: -1, height: -1 };
          var t = toggle ? toggle.getBoundingClientRect() : { left: -1, width: -1 };
          return ['x=' + Math.round(r.left), 'y=' + Math.round(r.top),
                  'w=' + Math.round(r.width), 'h=' + Math.round(r.height),
                  'bottomGap=' + Math.round(window.innerHeight - r.bottom),
                  'expanded=' + d.dataset.expanded,
                  'items=' + d.querySelectorAll('.tb-dock-row .tb-item').length,
                  // Where it sits in the bar, which is what the arrangement
                  // claims and what a rect alone cannot say: a row drawn at the
                  // right pixels while parented to the body would report the
                  // same numbers and take none of the bar's protections.
                  'inBar=' + (d.parentElement === bar),
                  'barBottom=' + Math.round(b.bottom),
                  'barHeight=' + Math.round(b.height),
                  // The toggle belongs to the bar's own row, not to the row it
                  // opens; collapsed, it is the only part of this on screen.
                  'toggleX=' + Math.round(t.left),
                  'toggleW=' + Math.round(t.width),
                  'toggleInRow=' + (toggle ? !!toggle.closest('.tb-dock') : 'absent')].join(' ');
        })()
        """
        webView.evaluateJavaScript(js) { value, _ in
            report(value as? String ?? "unavailable")
        }
    }

    /// How much of the titlebar band's trailing edge the page's own controls
    /// occupy, in CSS points, or nil when the page cannot say yet.
    ///
    /// A WIDTH rather than a position, and that is the point: the cluster is
    /// right-aligned, so its width changes only when the set of controls does,
    /// while its x moves with every window resize. Reporting the width lets the
    /// shell recompute the drag strip locally on resize instead of waiting on a
    /// round trip to the page, which during a live drag-resize would leave the
    /// strip a frame or more behind the window it is in.
    ///
    /// The first row only. The formatting row below it is not in the band, and
    /// including it would shrink the strip by the width of a row that is not
    /// there.
    func reportTitlebarControlsWidth(_ report: @escaping (CGFloat?) -> Void) {
        let js = """
        (function () {
          var bar = document.querySelector('.editor-topbar .toolbar');
          if (!bar) { return null; }
          var items = bar.querySelectorAll('.tb-zone--right > *');
          var left = null, right = null;
          for (var i = 0; i < items.length; i++) {
            var r = items[i].getBoundingClientRect();
            if (r.width === 0 && r.height === 0) { continue; }
            left = left === null ? r.left : Math.min(left, r.left);
            right = right === null ? r.right : Math.max(right, r.right);
          }
          if (left === null) { return 0; }
          // To the window's edge, not the cluster's own box: the gap between
          // the last control and the edge is padding nobody should be able to
          // grab the window by either, and treating it as draggable would put
          // a drag target under the pointer that is aiming for the gear.
          return Math.round(window.innerWidth - left);
        })()
        """
        webView.evaluateJavaScript(js) { value, _ in
            report((value as? NSNumber).map { CGFloat($0.doubleValue) })
        }
    }

    func focusEditor() {
        webView.evaluateJavaScript("(function(){var e=document.querySelector('.ProseMirror'); if(e){e.focus();} return !!e;})()") { _, _ in }
    }

    // MARK: WKScriptMessageHandler

    // WebKit calls these delegate methods on the main thread, so each one
    // states that with `assumeIsolated` before touching a main-actor-isolated
    // property of what it was handed. Without it they are warnings under the
    // Swift 5 language mode this package builds in, and errors under Swift 6.
    nonisolated func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let text = MainActor.assumeIsolated { message.body as? String }
        guard let text else { return }
        Task { @MainActor in
            if let m = WebviewMessage.parse(text) { self.onMessage?(m) }
        }
    }

    // MARK: WKNavigationDelegate

    nonisolated func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Task { @MainActor in self.onProcessTerminated?() }
    }

    nonisolated func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                             decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // The page never navigates; a link the editor did not intercept goes
        // to the default browser instead of replacing the editor.
        let (url, isOther, ownScheme) = MainActor.assumeIsolated {
            (navigationAction.request.url,
             navigationAction.navigationType == .other,
             BirtaSchemeHandler.scheme)
        }
        if let url, url.scheme == ownScheme || isOther {
            decisionHandler(.allow)
        } else {
            if let url { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }

    // MARK: WKUIDelegate

    nonisolated func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                             for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // WebKit calls its UI delegate on the main thread; `assumeIsolated`
        // states that so the main-actor-isolated `request` can be read here.
        MainActor.assumeIsolated {
            if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    private func jsString(_ s: String) -> String {
        let d = (try? JSONSerialization.data(withJSONObject: s, options: [.fragmentsAllowed])) ?? Data("\"\"".utf8)
        return String(decoding: d, as: UTF8.self)
    }
}

/// WKUserContentController retains its handlers; a weak proxy breaks the cycle.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}
