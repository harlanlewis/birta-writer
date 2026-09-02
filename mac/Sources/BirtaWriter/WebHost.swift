import AppKit
import WebKit
import BirtaWriterCore

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
    /// The outline panel's width, as a rule.
    ///
    /// It rides the served HTML rather than the boot script, for the reason
    /// `BootConfig.tocRootStyle` gives: the page reads it while it mounts, and
    /// no moment a document-start script has is both late enough to have a
    /// document and early enough to be read.
    ///
    /// Its SIDE rides the same HTML and is not a variable: `toc-right` is
    /// written on every page. A macOS sidebar is on the trailing edge, and this
    /// window has no reason to be the exception. The page is told the reader
    /// cannot move it by the `fixedTocSide` arrangement
    /// (`Bridge.i18nObject`), which is what withdraws the panel's flip button
    /// and the Swap Sides command; this is the other half, and the two have to
    /// agree or the control would be gone while the side still came back left
    /// from a stored preference.
    var tocRootStyle = ""
    /// How tall the titlebar band is, in points, or 0 before the window has
    /// been laid out.
    ///
    /// Served with the page rather than pushed into it afterwards, and that is
    /// the whole of why it lives here. The page's first row takes this height
    /// and centres its controls in it, which is what puts the two halves of
    /// the band on one axis; a document that has to be told separately is a
    /// document that is wrong until it is, and one that RELOADS is wrong again
    /// with nothing to notice. Every reload re-requests this template, so a
    /// number here reaches every document there will ever be, including the
    /// ones WebKit decides to make.
    ///
    /// The band is the system's rather than ours: it is not the same under
    /// every macOS titlebar style, which is why the page carries a fallback
    /// and not a literal.
    var titlebarBandHeight: CGFloat = 0
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
            task.didFailWithError(NSError(domain: "com.birtalabs.birta-writer", code: status,
                                          userInfo: [NSLocalizedDescriptionKey: "birta scheme: \(status) for \(task.request.url?.absoluteString ?? "?")"]))
        }
    }

    /// The CSP mirrors src/webviewHtml.ts in shape: nothing by default, our
    /// own origin for scripts and styles, inline styles (ProseMirror and the
    /// components set them), wasm for the lazy engines, data: for the fonts
    /// esbuild inlines, and a Blob worker for the save pipeline's verifying
    /// reparse (webview/utils/verifyOracle.ts says why it is a Blob and not a
    /// file under dist/). The network opt-in widens img/frame/connect to
    /// https:, which is what link cards and embeds need and what
    /// NETWORK_POSTURE.md calls the user's consent.
    func csp() -> String {
        let net = networkEnabled ? " https:" : ""
        return [
            "default-src 'none'",
            "style-src 'self' 'unsafe-inline'",
            "script-src 'self' 'wasm-unsafe-eval'",
            "worker-src blob:",
            "img-src 'self' data: blob:\(net)",
            "font-src 'self' data:",
            "connect-src 'self'\(net)",
            "frame-src\(networkEnabled ? " https:" : " 'none'")",
            "media-src 'self' data:\(net)",
        ].joined(separator: "; ")
    }

    func renderPage(_ template: String) -> String {
        // One slot, two declarations, because both are the same kind of fact:
        // a number the page needs while it mounts and cannot work out for
        // itself. Nothing is written for a height of zero, so a page served
        // before the window has been laid out keeps its own fallback rather
        // than being handed a zero to centre on.
        let band = titlebarBandHeight > 0
            ? ":root { --mac-titlebar-height: \(titlebarBandHeight)px; }"
            : ""
        return template
            .replacingOccurrences(of: "{{CSP}}", with: csp())
            .replacingOccurrences(of: "{{THEME_CLASS}}",
                                  with: "\(themeClass) toc-right")
            .replacingOccurrences(of: "{{ROOT_STYLE}}", with: tocRootStyle + band)
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
        // One read of the boot config, because two would let the body tag and
        // the boot script describe different panels.
        let boot = bootConfig()
        schemeHandler.themeClass = themeClass
        schemeHandler.tocRootStyle = boot.tocRootStyle
        // The document about to be served carries the band height in its own
        // stylesheet, so that is the baseline the next push measures against.
        reportedBandHeight = schemeHandler.titlebarBandHeight
        controller.removeAllUserScripts()
        let script = WKUserScript(source: boot.userScript(themeClass: themeClass),
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
    /// stylesheet (mac/Resources/index.html) reads to put the toolbar away.
    /// A class rather than a message: the bundle is the extension's and knows
    /// nothing about a window nobody is pointing at.
    /// Toggle `body.mac-resting`, which the page styles when it has a resting
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
        let js = "document.body.classList.toggle('mac-resting', \(resting ? "true" : "false"));"
        webView.evaluateJavaScript(js) { _, _ in }
    }

    /// Host → page: the bound file is gone, so the band shows the gear alone.
    ///
    /// A class, for the same reason `mac-resting` is one: the bundle is the
    /// extension's and knows nothing about a window whose file has been
    /// deleted. The rule it drives is the host page's
    /// (`mac/Resources/index.html`), which is also where the argument for it
    /// lives.
    ///
    /// The SET of controls in the band changes here, which is the one thing
    /// `Coordinator.refreshTitlebarControlsWidth` says it cannot see coming, so
    /// the caller re-measures after this. Two evaluations on one web view run
    /// in the order they were made, so the query that follows reads the row
    /// this class has already changed.
    func setNoteMissing(_ missing: Bool) {
        let js = "document.body.classList.toggle('mac-note-missing', \(missing ? "true" : "false"));"
        webView.evaluateJavaScript(js) { _, _ in }
    }

    /// What the band's trailing controls look like AT REST, for
    /// `mac/scripts/measure.sh`.
    ///
    /// Resting is set from the pointer and the key window
    /// (`Coordinator.applyChromeVisibility`), and a script has neither, so the
    /// class is put on and taken off around one read rather than waited for.
    /// Nothing is left behind: the state is restored before this answers, and
    /// the app's own writer is asked again afterwards.
    ///
    /// A COMPUTED style rather than the presence of a rule, because what can go
    /// wrong is specificity: the missing-note override and the resting rule are
    /// two selectors over one property, and a rule that lost the tie would leave
    /// the reader with a titlebar that empties when they look away, in the one
    /// state where its last control is the way to preferences.
    func reportRestingChrome(_ report: @escaping (String) -> Void) {
        let js = """
        (function () {
          var zone = document.querySelector('.editor-topbar .tb-zone--right');
          if (!zone) { return 'absent'; }
          var was = document.body.classList.contains('mac-resting');
          // The RULE, not a frame of the fade. Both properties are
          // transitioned here, so a computed read taken the instant the class
          // lands returns the value the fade is starting FROM whatever the
          // rule says, and the answer then depends on whether the window
          // happened to be resting already. Suppressing the transition on the
          // element makes the read the same every time it is taken.
          var prev = zone.style.transition;
          zone.style.transition = 'none';
          document.body.classList.add('mac-resting');
          var s = getComputedStyle(zone);
          var out = ['opacity=' + s.opacity, 'visibility=' + s.visibility,
                     'missing=' + document.body.classList.contains('mac-note-missing')].join(' ');
          if (!was) { document.body.classList.remove('mac-resting'); }
          zone.style.transition = prev;
          return out;
        })()
        """
        webView.evaluateJavaScript(js) { value, _ in
            report(value as? String ?? "unavailable")
        }
    }

    /// Whether the editor is actually locked, for `mac/scripts/measure.sh`.
    ///
    /// Read off the DOM rather than off what this side last sent, which is the
    /// only version of the question worth asking: the flag travels as a message
    /// and the page's memory of it is whatever it was last told, so "we sent
    /// it" and "the editor is locked" are different claims and a remount breaks
    /// the second while leaving the first true.
    ///
    /// Two independent answers, because `webview/readOnly.ts` keeps its promise
    /// in layers and they can disagree: `contenteditable` is what ProseMirror's
    /// `editable` predicate stamps, and `body.read-only` is what the chrome's
    /// CSS reads. One without the other is a half-applied mode.
    func reportEditorLock(_ report: @escaping (String) -> Void) {
        let js = """
        (function () {
          var pm = document.querySelector('.ProseMirror');
          if (!pm) { return 'absent'; }
          // ...and whether the document is still offering the slash menu. The
          // hint is a widget decoration gated on the editor having focus, and
          // "a locked editor cannot take focus" is a claim about WebKit rather
          // than about this code, so it is read rather than assumed: a
          // document nobody can type into that still says press / to show
          // commands is offering a gesture that does nothing.
          var hint = document.querySelector('.md-empty-hint-text');
          var shown = hint ? getComputedStyle(hint).display !== 'none' : null;
          return ['contenteditable=' + pm.getAttribute('contenteditable'),
                  'bodyClass=' + document.body.classList.contains('read-only'),
                  'hint=' + (hint === null ? 'absent' : (shown ? 'shown' : 'hidden'))].join(' ');
        })()
        """
        webView.evaluateJavaScript(js) { value, _ in
            report(value as? String ?? "unavailable")
        }
    }

    /// Where the document is scrolled to, for `mac/scripts/measure.sh`.
    ///
    /// Read off the page rather than off what this side last sent, for the
    /// reason `reportEditorLock` states: the scroll position is the page's, and
    /// this side has never held it. It is the only way to ask whether a file
    /// opened at the top, because a snapshot cannot answer: `writeSnapshot`
    /// draws the view hierarchy through the PDF path and a `WKWebView`
    /// contributes nothing to it, so a picture of a scrolled document and a
    /// picture of an unscrolled one are the same picture.
    ///
    /// The height goes with the offset because the offset alone cannot be
    /// judged: zero is the top of every document, and any other number is only
    /// meaningful against the room there was to scroll.
    func reportScroll(_ report: @escaping (String) -> Void) {
        let js = """
        (function () {
          var pm = document.querySelector('.ProseMirror');
          if (!pm) { return 'absent'; }
          return ['scrollY=' + Math.round(window.scrollY),
                  'scrollHeight=' + document.documentElement.scrollHeight,
                  'viewport=' + Math.round(window.innerHeight)].join(' ');
        })()
        """
        webView.evaluateJavaScript(js) { value, _ in
            report(value as? String ?? "unavailable")
        }
    }

    /// Ask the page where its formatting dock is, for `mac/scripts/measure.sh`.
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

    /// The band half the page draws: how much of the trailing edge it takes,
    /// and how it draws what it puts there.
    ///
    /// `width` is what the layout needs and every other field is what a check
    /// needs, and they are one query because they are one fact. A WIDTH rather
    /// than a position, and that is the point: the cluster is right-aligned,
    /// so its width changes only when the set of controls does, while its x
    /// moves with every window resize. Reporting the width lets the shell
    /// recompute the drag strip locally on resize instead of waiting on a
    /// round trip to the page, which during a live drag-resize would leave the
    /// strip a frame or more behind the window it is in.
    ///
    /// The first row only. The formatting row below it is not in the band, and
    /// including it would shrink the strip by the width of a row that is not
    /// there.
    ///
    /// The rest is there because the two halves of this band have to read as a
    /// single strip of controls, and every way that goes wrong is a number
    /// here disagreeing with the native strip's: buttons on a different
    /// vertical axis, in a different box, with a different width of air
    /// between them. None of it is answerable from a screenshot, and none of
    /// it is answerable in a browser either, because only this window puts the
    /// two halves in one band.
    struct TitlebarControls {
        /// From the leading edge of the cluster to the window's trailing edge.
        let width: CGFloat
        /// The buttons' shared vertical centre, from the top of the window.
        let midY: CGFloat
        /// The NARROWEST button's box. Narrowest because that is the one drawn
        /// around a single glyph, which is the shape every button on the
        /// native half is; the wider ones in this cluster are menu triggers
        /// carrying a chevron as well, and comparing against one of those
        /// would ask the native side to match a control it does not have.
        let boxWidth: CGFloat
        let boxHeight: CGFloat
        /// The smallest air between two adjacent buttons, which is the row's
        /// own rhythm. The largest is the deliberate inset before the sidebar
        /// toggle, a divider rather than spacing.
        let gap: CGFloat
        /// How many buttons the numbers above were taken from. A gap needs
        /// two, and nothing at all agrees with nothing at all, so a reader has
        /// to be able to tell a measurement from an absence.
        let count: Int
        /// What a button wears under the pointer, and how round it is:
        /// `--vscode-toolbar-hoverBackground` and `--ui-radius-m`, resolved
        /// against the theme in force. Nil when the palette did not parse,
        /// which the native side treats as "no wash" rather than as black.
        let hoverFill: NSColor?
        let cornerRadius: CGFloat
        /// The first row's own box and the number it was told to take, so a
        /// misaligned axis says WHICH half failed. The two ways this goes
        /// wrong look identical from the midY alone: the height never reached
        /// the page, or it did and something else is padding the row.
        let rowHeight: CGFloat
        let rowPadTop: CGFloat
        let bandVar: String
    }

    /// Follow a band that has CHANGED height while the app runs: full screen,
    /// or a titlebar style the system swaps under us. Every document is served
    /// with the height in force when it loaded
    /// (`BirtaSchemeHandler.titlebarBandHeight`), so this is the delta and not
    /// the delivery, which is what keeps a reload from needing one.
    ///
    /// The baseline is therefore whatever was SERVED, set on load rather than
    /// reset to a sentinel: a page that already carries the right number must
    /// not be sent it again on every layout pass, and a page that carries an
    /// old one must be.
    private var reportedBandHeight: CGFloat = 0

    func setTitlebarBandHeight(_ height: CGFloat) {
        // Zero is "not laid out yet" rather than a band with no height, and
        // the difference matters because this is also what the NEXT page will
        // be served: taking a zero here would strip the rule out of a document
        // loaded while the panel happened to be hidden, and send it back to
        // its fallback for the life of that page.
        guard height > 0 else { return }
        schemeHandler.titlebarBandHeight = height
        guard abs(height - reportedBandHeight) > 0.01 else { return }
        reportedBandHeight = height
        let js = "document.documentElement.style.setProperty('--mac-titlebar-height', '\(height)px')"
        webView.evaluateJavaScript(js) { _, _ in }
    }

    /// What the page's tooltip chip is showing, for `mac/scripts/measure.sh`.
    ///
    /// The one question that could not be asked at all while these buttons
    /// used `NSView.toolTip`: a system tooltip is drawn by the window server
    /// out of any view this app can read, so "does the label appear" needed a
    /// real pointer and a screenshot. Drawn by the page it is just an element,
    /// and the whole chain from a pointer on an AppKit button to a chip on
    /// screen becomes answerable in the running window.
    func reportTooltip(_ report: @escaping (String) -> Void) {
        let js = """
        (function () {
          var tip = document.querySelector('.custom-tooltip');
          if (!tip || tip.style.display === 'none') { return 'none'; }
          var r = tip.getBoundingClientRect();
          return ['text=' + JSON.stringify(tip.textContent || ''),
                  'x=' + Math.round(r.left), 'y=' + Math.round(r.top),
                  'w=' + Math.round(r.width), 'h=' + Math.round(r.height)].join(' ');
        })()
        """
        webView.evaluateJavaScript(js) { value, _ in
            report(value as? String ?? "unavailable")
        }
    }

    func reportTitlebarControls(_ report: @escaping (TitlebarControls?) -> Void) {
        let js = """
        (function () {
          var bar = document.querySelector('.editor-topbar .toolbar');
          if (!bar) { return null; }
          var items = bar.querySelectorAll('.tb-zone--right > *');
          var left = null;
          for (var i = 0; i < items.length; i++) {
            var r = items[i].getBoundingClientRect();
            if (r.width === 0 && r.height === 0) { continue; }
            left = left === null ? r.left : Math.min(left, r.left);
          }
          // The BUTTONS, not their wrappers: a wrapper is transparent to
          // layout and stretches to the zone's height, so its centre answers
          // where the row is rather than where the control is drawn.
          var buttons = [];
          var candidates = bar.querySelectorAll('.tb-zone--right button');
          for (var j = 0; j < candidates.length; j++) {
            var b = candidates[j].getBoundingClientRect();
            if (b.width === 0 && b.height === 0) { continue; }
            buttons.push(b);
          }
          buttons.sort(function (a, b) { return a.left - b.left; });
          var midY = 0, gap = null, boxW = null, boxH = 0;
          for (var k = 0; k < buttons.length; k++) {
            midY += (buttons[k].top + buttons[k].bottom) / 2;
            if (boxW === null || buttons[k].width < boxW) {
              boxW = buttons[k].width;
              boxH = buttons[k].height;
            }
            if (k > 0) {
              var air = buttons[k].left - buttons[k - 1].right;
              if (gap === null || air < gap) { gap = air; }
            }
          }
          if (buttons.length > 0) { midY = midY / buttons.length; }
          // The palette, resolved. Read off the root's computed style rather
          // than copied into Swift: it flips with the theme, it is tuned in
          // one file for two products, and a second copy is one nothing
          // compares to the first. A custom property computes with its own
          // `var()` references already substituted, so one read is enough
          // however the palette is spelled.
          var root = getComputedStyle(document.documentElement);
          var parts = (root.getPropertyValue('--vscode-toolbar-hoverBackground') || '').match(/-?[0-9.]+/g);
          var radius = parseFloat(root.getPropertyValue('--ui-radius-m'));
          var barBox = bar.getBoundingClientRect();
          var barStyle = getComputedStyle(bar);
          return {
            // To the window's edge, not the cluster's own box: the gap between
            // the last control and the edge is padding nobody should be able to
            // grab the window by either, and treating it as draggable would put
            // a drag target under the pointer that is aiming for the gear.
            width: left === null ? 0 : Math.round(window.innerWidth - left),
            midY: midY,
            boxWidth: boxW === null ? 0 : boxW,
            boxHeight: boxH,
            gap: gap === null ? 0 : gap,
            count: buttons.length,
            hover: parts && parts.length >= 3 ? parts.slice(0, 4).map(Number) : null,
            radius: isNaN(radius) ? 0 : radius,
            rowHeight: barBox.height,
            rowPadTop: parseFloat(barStyle.paddingTop) || 0,
            bandVar: (root.getPropertyValue('--mac-titlebar-height') || 'unset').trim()
          };
        })()
        """
        webView.evaluateJavaScript(js) { value, _ in
            guard let dict = value as? [String: Any],
                  let width = (dict["width"] as? NSNumber).map({ CGFloat($0.doubleValue) }) else {
                report(nil)
                return
            }
            let number: (String) -> CGFloat = { key in (dict[key] as? NSNumber).map { CGFloat($0.doubleValue) } ?? 0 }
            let hover = (dict["hover"] as? [NSNumber]).flatMap { parts -> NSColor? in
                guard parts.count >= 3 else { return nil }
                return NSColor(srgbRed: CGFloat(parts[0].doubleValue) / 255,
                               green: CGFloat(parts[1].doubleValue) / 255,
                               blue: CGFloat(parts[2].doubleValue) / 255,
                               alpha: parts.count > 3 ? CGFloat(parts[3].doubleValue) : 1)
            }
            report(TitlebarControls(width: width,
                                    midY: number("midY"),
                                    boxWidth: number("boxWidth"),
                                    boxHeight: number("boxHeight"),
                                    gap: number("gap"),
                                    count: Int(number("count")),
                                    hoverFill: hover,
                                    cornerRadius: number("radius"),
                                    rowHeight: number("rowHeight"),
                                    rowPadTop: number("rowPadTop"),
                                    bandVar: dict["bandVar"] as? String ?? "?"))
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
