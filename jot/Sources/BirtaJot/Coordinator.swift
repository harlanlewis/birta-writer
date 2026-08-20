import AppKit
import WebKit
import BirtaJotCore
import os

/// The one object that knows the whole flow: prewarm → summon → edit →
/// persist → hide, plus saving, theme, settings and cold recovery.
///
/// Persistence model (MAR-375): exactly one buffer, one plain `.md` file the
/// user can find (Settings names it), written atomically. WHEN it is written
/// is `BirtaJotCore.AutosavePolicy`'s answer: an edit is held for a beat and
/// only written at all with autosave on, and every other reason to write
/// (Cmd+S, hiding, quitting, New Note, handing the file to an agent) writes
/// immediately whatever the setting says. Each of those first asks the page to
/// flush (`flushSave`), bounded by `flushTimeout` like the extension's
/// will-save participant, then writes.
///
/// Nothing empties the buffer. Jot edits a document the way any editor edits
/// one: Save a Copy As writes a COPY somewhere else while the panel goes on
/// showing the same note bound to the same file, and New Note leaves the old
/// note in its own file and binds to a fresh one.
///
/// State machine for the web view: `cold` (nothing loaded, or the content
/// process died) → `loading` (page requested, `ready` not yet seen) → `warm`
/// (`init` sent, editor mounted). Summoning in any state shows the panel; the
/// editor appears when it is ready.
@MainActor
final class Coordinator {
    enum State { case cold, loading, warm }

    /// How far the status line sits above the window's bottom edge, so it
    /// centres on the formatting bar rather than floating beside it.
    ///
    /// Derived rather than chosen: `webview/components/toolbar/dock.css` gives
    /// the bar a 1px top border and `--ui-space-2` (4px) of padding around a
    /// 24px `.tb-btn`, so its controls are centred 17pt up, and a 20pt-tall
    /// label centres there when its bottom sits 7pt up.
    ///
    /// A number on this side of the bridge that follows one on the other, so
    /// it can go stale. What it costs when it does is a status line a few
    /// points off centre, and `jot/scripts/measure.sh` prints the bar's real
    /// height in its `dock` line, which is where to check it.
    private static let statusBaseline: CGFloat = 7

    let hotkey: GlobalHotkey
    private let panel = JotPanel()
    private let contentView = AppearanceObservingView()
    /// The draggable middle of the titlebar band (TitlebarDrag.swift). Above
    /// the web view, which is what covers the band and swallowed the drag.
    private let titlebarDrag = TitlebarDragView()
    /// What the page's trailing controls take from the band, as last reported.
    /// Held so a resize can resize the strip without asking the page again.
    private var titlebarControlsWidth: CGFloat = 0
    private let statusOverlay = StatusOverlay()
    private let titleBar = TitleBarAccessory()
    private let host: WebHost
    private let writer: CoalescingWriter
    private let attachments = AttachmentStore()
    /// Outbound page fetches for link cards and paste-unfurl. Built once: the
    /// transport holds an ephemeral URLSession with no cookie store and no
    /// cache, so nothing a fetch touches persists between requests.
    private let fetcher = PageMetadataFetcher(transport: URLSessionTransport())
    private var guardState = SyncGuard()
    private var state: State = .cold
    /// The newest buffer content the host has seen or written.
    private var latest = ""
    /// Whether `latest` holds bytes the bound file does not.
    ///
    /// A flag rather than a comparison, because the comparison is the whole
    /// buffer and the question is asked on every keystroke. It is set in
    /// exactly two places and both are unavoidable: an inbound edit raises it,
    /// and `writeLatest` clears it, which is the only thing that puts the
    /// file and the buffer back in step. Binding to a new file re-reads from
    /// disk, so it clears there for the same reason.
    private var isEdited = false { didSet { refreshTitle() } }
    /// The file the last Save wrote, for "Reveal Last Save in Finder".
    private(set) var lastSavedURL: URL?
    /// Opens the app's Settings window. Owned by the app delegate, which holds
    /// the window; the page asks for it through the gear menu.
    var openPreferences: (() -> Void)?
    /// Closes it again, because the panel going away takes it along.
    var hidePreferences: (() -> Void)?
    private var pendingFlushes: [String: (String?) -> Void] = [:]
    /// In-flight `requestEditorContext` calls, by id. Bounded the same way the
    /// flushes are: a page that never answers must not leave a closure holding
    /// the coordinator for the life of the app.
    private var pendingContexts: [String: (AgentReference.Selection?) -> Void] = [:]
    private let agent = AgentRunner()
    private var autosaveTimer: Timer?
    private var autosaveDeadline: Date?
    /// The typing pause that ends a burst, and the ceiling a burst cannot pass.
    private let autosaveDebounce: TimeInterval = 0.5
    private let autosaveMaxWait: TimeInterval = 2
    private var previousApp: NSRunningApplication?
    /// The next `ready` reads the bound file (launch, a changed scratchpad or
    /// document path) rather than re-showing `latest` (a remount after the
    /// content process died).
    private var reloadFromDisk = true
    /// False until the bound file has been read once; nothing is written before.
    private var hasLoaded = false
    /// The file the buffer's bytes belong to. Bound when the file is read, and
    /// only there: a Preferences change that points at another file first
    /// flushes to THIS one, then rebinds, so a scratchpad is never written
    /// over the document the user just chose to open.
    /// Its folder is also what the page may read images from, so the two move
    /// together by construction rather than by two call sites remembering to.
    private var boundURL: URL = Prefs.activeURL {
        didSet {
            host.schemeHandler.roots =
                host.schemeHandler.roots.rebound(toDocument: boundURL.deletingLastPathComponent())
            refreshTitle()
        }
    }
    private var escMonitor: Any?
    private var lastEscape: TimeInterval = 0
    private let flushTimeout: TimeInterval = 1.0
    private let measure = Measure()

    var isVisible: Bool { panel.isVisible }

    init() {
        let webRoot = Coordinator.locateWebRoot()
        host = WebHost(webRoot: webRoot, documentDirectory: Prefs.activeURL.deletingLastPathComponent())
        writer = CoalescingWriter(onError: { error in
            NSLog("Birta Jot: write failed: \(error)")
        })
        hotkey = GlobalHotkey()
    }

    // MARK: lifecycle

    func start() {
        // "Open to a blank note" is decided before the first page loads, so
        // the editor mounts against the file it will actually edit rather than
        // mounting the last one and swapping it out a moment later.
        if Prefs.openToBlankNote, Prefs.documentURL == nil {
            startBlank()
        }
        host.bootConfig = { Prefs.bootConfig() }
        host.onMessage = { [weak self] m in self?.handle(m) }
        host.onProcessTerminated = { [weak self] in self?.contentProcessDied() }

        contentView.onAppearanceChange = { [weak self] in self?.applyTheme() }
        contentView.addSubview(host.webView)
        contentView.addSubview(statusOverlay)
        // ABOVE the web view in z-order, which is the whole of why it works:
        // the web view covers the band, so a sibling below it would never see
        // a mouse event. Laid out by frame rather than by constraints because
        // its width answers to the page's controls and not to the window's
        // edges, and `layoutTitlebarDrag` is the one place that arithmetic
        // lives.
        contentView.addSubview(titlebarDrag)
        host.webView.translatesAutoresizingMaskIntoConstraints = false
        statusOverlay.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            // The web view fills the window: the status line floats over its
            // bottom trailing corner rather than taking a row from it.
            host.webView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            host.webView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            host.webView.topAnchor.constraint(equalTo: contentView.topAnchor),
            host.webView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
            statusOverlay.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -14),
            // Never past the window's midpoint: the formatting dock is a bar
            // across the whole bottom edge, and a message long enough to reach
            // its controls would read as one crowded strip.
            statusOverlay.leadingAnchor.constraint(greaterThanOrEqualTo: contentView.centerXAnchor),
            statusOverlay.bottomAnchor.constraint(equalTo: contentView.bottomAnchor,
                                                  constant: -Coordinator.statusBaseline),
            statusOverlay.heightAnchor.constraint(equalToConstant: StatusOverlay.height),
        ])
        contentView.onHoverChange = { [weak self] hovering in self?.applyChromeVisibility(hovering) }
        contentView.onLayout = { [weak self] in
            MainActor.assumeIsolated { self?.layoutTitlebarDrag() }
        }
        panel.addTitlebarAccessoryViewController(titleBar)
        titleBar.titleView.onReveal = { url in
            NSWorkspace.shared.activateFileViewerSelecting([url])
        }
        titleBar.titleView.onRelocate = { [weak self] target in
            MainActor.assumeIsolated { self?.relocateActiveFile(to: target) }
        }
        // Title ink follows the window's key state, as every macOS title does.
        // Both notifications are needed: a panel loses key to another app's
        // window without any pointer event.
        for (name, key) in [(NSWindow.didBecomeKeyNotification, true),
                            (NSWindow.didResignKeyNotification, false)] {
            NotificationCenter.default.addObserver(
                forName: name, object: panel, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.titleBar.titleView.setWindowKey(key) }
            }
        }
        titleBar.titleView.setWindowKey(panel.isKeyWindow)
        refreshTitle()
        panel.contentView = contentView
        panel.onHideRequest = { [weak self] in self?.hide() }
        applyTheme(initial: true)

        // The activation policy the Dock switch decides, as the app actually
        // took it. A setting whose only evidence is that its own getter
        // returns what was written to it is a setting nobody has checked.
        measure.trace("policy \(NSApp.activationPolicy() == .regular ? "regular" : "accessory") showInDock=\(Prefs.showInDock)")

        // Prewarm: load and mount now, hidden, so the first summon finds the editor mounted.
        measure.mark("launch")
        loadPage()

        hotkey.onPress = { [weak self] in self?.hotkeyPressed() }
        let status = hotkey.register(Prefs.hotkey)
        if status != noErr {
            NSLog("Birta Jot: hotkey \(Prefs.hotkey.spelling) registration failed (\(status)); another app may own it")
        }
        installEscapeMonitor()
        if measure.enabled { installDebugSignals() }
    }

    /// Measurement hooks, only under BIRTA_JOT_MEASURE=1: SIGUSR1 toggles the
    /// panel as the hotkey would (a shell cannot press a global hotkey without
    /// an Accessibility grant); SIGURG posts a message file to the page.
    /// jot/scripts/measure.sh drives both, and stages cold recovery itself by
    /// killing the WebContent helper (the private `_killWebContentProcess`
    /// selector does not reach `webViewWebContentProcessDidTerminate`).
    private var debugSignals: [DispatchSourceSignal] = []
    private func installDebugSignals() {
        let actions: [(Int32, () -> Void)] = [
            (SIGUSR1, { [weak self] in self?.hotkeyPressed() }),
            (SIGURG, { [weak self] in self?.postDebugMessageFile() }),
        ]
        for (sig, action) in actions {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler(handler: action)
            source.resume()
            debugSignals.append(source)
        }
        if ProcessInfo.processInfo.environment["BIRTA_JOT_SHOW_ON_LAUNCH"] == "1" {
            DispatchQueue.main.async { [weak self] in self?.show() }
        }
    }

    /// SIGURG: post the JSON object in `<scratchpad dir>/.debug-message.json`
    /// to the page verbatim (the test-only `__testInsertText` is the use), or,
    /// for `{"type":"__jotKeys","keys":[...]}` or `{"type":"__jotSave"}`,
    /// synthesize those keystrokes
    /// into the panel as NSEvents. The keys path is what makes real WebKit
    /// typing reachable from a script without an Accessibility grant: the
    /// events are the app's own, delivered through the same responder chain a
    /// keyboard uses, so `Return` and the characters after it exercise the
    /// engine the panel really renders in.
    private func postDebugMessageFile() {
        let file = Prefs.scratchpadURL.deletingLastPathComponent().appendingPathComponent(".debug-message.json")
        guard let json = try? String(contentsOf: file, encoding: .utf8) else {
            measure.trace("no debug message at \(file.path)")
            return
        }
        if let data = json.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if obj["type"] as? String == "__jotKeys", let keys = obj["keys"] as? [String] {
                measure.mark("debug-keys")
                typeKeys(keys)
                return
            }
            // Cmd+S, from a script that cannot press it. The menu is where Save
            // lives, and a menu key equivalent needs a key window, which an
            // accessory app driven from a shell frequently cannot get (the same
            // limitation `typeKeys` documents for editing chords). Without this
            // the only way a script could make the app write with autosave OFF
            // is to hide the panel, and hiding is exactly what stops working
            // once the app has been hidden once and cannot come forward again.
            if obj["type"] as? String == "__jotSave" {
                measure.mark("debug-save")
                saveNow()
                return
            }
            // The title's own gestures, which nothing else can reach: a click
            // on a titlebar accessory is not something a script can synthesize
            // (`typeKeys` reaches the web view, and the title is native chrome
            // beside it), and the popover it opens builds a form from the file
            // on disk. Without these the whole of it would ship on the
            // strength of its unit-tested halves and a reading of the wiring.
            if obj["type"] as? String == "__jotTitleClick" {
                measure.mark("debug-title-click")
                measure.trace("titlepopover \(titleBar.titleView.openPopoverForMeasurement())")
                return
            }
            if obj["type"] as? String == "__jotRename", let name = obj["name"] as? String {
                measure.mark("debug-rename")
                titleBar.titleView.commitNameForMeasurement(name)
                return
            }
            // The selection palette's button, without the palette. The button
            // lives in the page and needs a selection under the pointer to
            // appear at all, which a script cannot arrange; what is worth
            // checking is the half after the click, which is entirely the
            // shell's: flush, write, ask the page where the caret is, build
            // the payload against the file's real path, and put it on the
            // pasteboard.
            if obj["type"] as? String == "__jotCopyAgentReference" {
                measure.mark("debug-agentref")
                copyAgentReference()
                return
            }
        }
        measure.mark("debug-post")
        host.send(.raw(json: json))
    }

    /// Deliver key events to the panel as a keyboard would. Single characters
    /// type themselves; "Enter", "End", "Home", "Backspace", "Escape",
    /// "ArrowUp/Down/Left/Right", "Tab" and "Space" are named keys.
    ///
    /// A key may carry modifiers, written as `cmd+v` or `shift+ArrowLeft`.
    /// That is what lets a script drive a paste, which is the only way to
    /// exercise an image arriving through the real pasteboard, the real bridge
    /// and the real store rather than through a unit test of each. An editing
    /// chord is sent to the web view rather than through the menu; see the
    /// comment at that branch for why, and for what it therefore does not
    /// cover.
    private func typeKeys(_ keys: [String]) {
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeFirstResponder(host.webView)
        var delay: TimeInterval = 0
        for spec in keys {
            var flags: NSEvent.ModifierFlags = []
            var key = spec
            while let plus = key.firstIndex(of: "+"), key.distance(from: key.startIndex, to: plus) > 0 {
                let name = String(key[key.startIndex..<plus]).lowercased()
                let modifier: NSEvent.ModifierFlags? = switch name {
                case "cmd", "command": .command
                case "shift": .shift
                case "alt", "option": .option
                case "ctrl", "control": .control
                default: nil
                }
                guard let modifier else { break }
                flags.insert(modifier)
                key = String(key[key.index(after: plus)...])
            }
            let (chars, code): (String, UInt16) = {
                switch key {
                case "Enter": return ("\r", 36)
                case "End": return ("\u{F72B}", 119)
                case "Home": return ("\u{F729}", 115)
                case "Backspace": return ("\u{7F}", 51)
                case "Escape": return ("\u{1B}", 53)
                case "Tab": return ("\t", 48)
                case "Space": return (" ", 49)
                case "ArrowUp": return ("\u{F700}", 126)
                case "ArrowDown": return ("\u{F701}", 125)
                case "ArrowLeft": return ("\u{F702}", 123)
                case "ArrowRight": return ("\u{F703}", 124)
                default:
                    let code = (try? HotkeyCombo.parse("cmd+\(key.lowercased())").get().keyCode) ?? 0
                    return (key, UInt16(code))
                }
            }()
            let at = delay
            // Captured per key rather than shared across the loop: the loop
            // keeps mutating both as it parses the next spec.
            let heldFlags = flags
            let heldKey = key
            delay += 0.06
            DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
                guard let self else { return }
                for type in [NSEvent.EventType.keyDown, .keyUp] {
                    // With a modifier held, `characters` is what the system
                    // would deliver for the chord and is not the bare letter;
                    // AppKit routes a key equivalent by
                    // `charactersIgnoringModifiers`, so that one carries it.
                    let typed = heldFlags.contains(.command) ? "" : chars
                    if let ev = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: heldFlags, timestamp: ProcessInfo.processInfo.systemUptime,
                                                 windowNumber: self.panel.windowNumber, context: nil, characters: typed,
                                                 charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) {
                        if heldFlags.contains(.command), type == .keyDown {
                            // A chord goes through the main menu, and the menu
                            // needs a key window to send its action to. An
                            // accessory app driven from a shell frequently
                            // cannot take activation at all (observed:
                            // `active=false key=false`, the menu claiming the
                            // chord and the action reaching nothing), so the
                            // editing selectors are sent to the web view
                            // directly. What this exercises is the pasteboard,
                            // WebKit's own paste handling and everything
                            // downstream of it; what it does NOT exercise is
                            // the menu binding, which needs a real keyboard.
                            // `#selector(NSText.paste(_:))` and friends name
                            // the standard editing actions; WKWebView answers
                            // them without declaring them itself.
                            let selector: Selector? = switch heldKey.lowercased() {
                            case "v": #selector(NSText.paste(_:))
                            case "c": #selector(NSText.copy(_:))
                            case "x": #selector(NSText.cut(_:))
                            case "a": #selector(NSText.selectAll(_:))
                            default: nil
                            }
                            if let selector {
                                self.host.webView.perform(selector, with: nil)
                            } else {
                                _ = NSApp.mainMenu?.performKeyEquivalent(with: ev)
                            }
                            continue
                        }
                        self.panel.sendEvent(ev)
                    }
                }
            }
        }
    }

    private func loadPage() {
        state = .loading
        measure.mark("load-start")
        host.schemeHandler.networkEnabled = Prefs.networkEnabled
        host.load(themeClass: currentThemeClass())
    }

    private func contentProcessDied() {
        NSLog("Birta Jot: web content process terminated; remounting")
        measure.mark("terminate")
        state = .cold
        loadPage()
    }

    // MARK: summon / hide

    private func hotkeyPressed() {
        measure.mark("hotkey")
        toggle()
    }

    func toggle() {
        if panel.isVisible && NSApp.isActive { hide() } else { show() }
    }

    func show() {
        if let front = NSWorkspace.shared.frontmostApplication, front != .current {
            previousApp = front
        }
        panel.placeIfUnplaced()
        if panel.isMiniaturized { panel.deminiaturize(nil) }
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeFirstResponder(host.webView)
        if state == .warm { host.focusEditor() }
        if state == .cold { loadPage() }
        // Summoned under a pointer that never moved: no enter event fires, so
        // the window has to ask where the pointer is.
        contentView.syncHoverFromPointer()
        measure.mark("visible")
        traceTitleBar()
        // The page's controls are only measurable once it has laid out, and
        // showing the panel is the first moment that is true of a cold start.
        refreshTitlebarControlsWidth()
        traceTitlebarDrag()
        if measure.enabled, state == .warm {
            host.reportDockGeometry { [weak self] line in
                MainActor.assumeIsolated { self?.measure.trace("dock \(line)") }
            }
        }
    }

    /// Dismiss first, flush after. Hiding is not a teardown: the page stays
    /// mounted and answers the flush from behind the hidden panel, so there is
    /// nothing to wait for on screen. Waiting made the dismissal cost a
    /// round trip to the web content process, and up to `flushTimeout` when
    /// that process was busy, which is the one moment the user is asking for
    /// the panel to be gone. The bytes are no less safe: the flush still runs,
    /// and quitting flushes again.
    func hide() {
        guard panel.isVisible else { return }
        // Settings belongs to the panel, not to the app. Left behind it is a
        // window with no editor to change the settings OF, floating over
        // whatever the user went back to; and with the app hidden below it
        // reads as a stray dialog from nowhere.
        hidePreferences?()
        panel.orderOut(nil)
        if let prev = previousApp, prev.isTerminated == false {
            prev.activate()
        } else {
            NSApp.hide(nil)
        }
        previousApp = nil
        flushThen { [weak self] in self?.write(.panelHidden) }
    }

    /// Double-Esc hides: the first bare Escape belongs to the editor (block
    /// selection, closing a menu); a second within the window hides the panel.
    private func installEscapeMonitor() {
        escMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.panel.isKeyWindow, event.keyCode == 53,
                  event.modifierFlags.intersection([.command, .option, .control, .shift]).isEmpty else { return event }
            let now = ProcessInfo.processInfo.systemUptime
            if now - self.lastEscape < 0.4 {
                self.lastEscape = 0
                self.hide()
                return nil
            }
            self.lastEscape = now
            return event
        }
    }

    // MARK: bridge

    private func handle(_ message: WebviewMessage) {
        switch message {
        case .ready:
            measure.mark("ready")
            guardState.resetForReady()
            // The file is the source only at launch and after the bound file
            // changes; after a content-process death `latest` is fresher than
            // the disk can be (a write may still be in flight), and it is what
            // the remount must show.
            if reloadFromDisk {
                boundURL = Prefs.activeURL
                latest = readActiveFile()
                // The disk is the truth on this arm, so nothing is unwritten.
                // The other arm keeps `isEdited`: after a content-process
                // death `latest` can be ahead of the file, and saying it is
                // not would be the one lie this flag must never tell.
                isEdited = false
                reloadFromDisk = false
                hasLoaded = true
            }
            host.send(.initDoc(content: latest, syncVersion: guardState.version, viewStateJSON: Prefs.viewStateJSON))
            state = .warm
            // A fresh page starts with its chrome shown; tell it where the
            // pointer is, and say which file it is now bound to.
            refreshTitle()
            host.setChromeResting(!contentView.isHovering)
            if panel.isVisible { host.focusEditor() }
        case let .update(content, base, seq):
            switch guardState.judge(baseSyncVersion: base, seq: seq) {
            case .admit:
                latest = content
                isEdited = true
                write(.edit)
            case .repush:
                // Re-push authoritative content at the CURRENT version, as
                // the extension does: bumping here would read the page's next
                // correctly-based update as stale and replace typed text.
                host.send(.externalUpdate(content: latest, syncVersion: guardState.version))
            case .staleSeq:
                break
            }
        case let .flushResult(id, content, base, seq):
            let resolve = pendingFlushes.removeValue(forKey: id)
            switch guardState.judge(baseSyncVersion: base, seq: seq) {
            case .admit:
                latest = content
                // Not through the policy: a flush only ever happens because
                // something that always writes asked for one, and its own
                // `write(...)` follows. Deferring here would put the debounce
                // in front of a hide or a quit.
                cancelPendingAutosave()
                writeLatest()
                host.send(.flushAck(id: id, applied: true))
                resolve?(content)
            case .repush:
                host.send(.flushAck(id: id, applied: false))
                host.send(.externalUpdate(content: latest, syncVersion: guardState.version))
                resolve?(nil)
            case .staleSeq:
                host.send(.flushAck(id: id, applied: false))
                resolve?(nil)
            }
        case let .viewState(json):
            Prefs.viewStateJSON = json
        case let .openUrl(url):
            if let u = URL(string: url) { NSWorkspace.shared.open(u) }
        case .openHostPreferences:
            openPreferences?()
        case let .askAgent(prompt, requestId, model, effort):
            runAgent(prompt: prompt, requestId: requestId, model: model, effort: effort)
        case let .stopAgentRun(requestId):
            agent.stop(requestId: requestId) { [weak self] status in
                self?.reportAgent(requestId: requestId, status)
            }
        case let .clipboardWrite(format, data):
            writeToPasteboard(data, asHTML: format == "html")
        case .copyAgentReference:
            copyAgentReference()
        case let .editorContextResult(id, selection):
            pendingContexts.removeValue(forKey: id)?(selection)
        case let .setToolbarLayout(itemId, placement, order):
            var layout = Prefs.toolbarLayout
            layout.apply(itemId: itemId, placement: placement, order: order)
            Prefs.toolbarLayout = layout
        case let .setToolbarVisible(visible):
            var layout = Prefs.toolbarLayout
            layout.visible = visible
            Prefs.toolbarLayout = layout
        case let .setFontPreset(p): Prefs.fontPreset = p
        case let .setFontSize(s): Prefs.fontSize = s
        case let .setContentWidth(m): Prefs.contentWidth = m
        case let .focusState(focused):
            if focused { measure.mark("caret-ready") }
        case let .crash(message, source):
            NSLog("Birta Jot: webview crash (\(source)): \(message)")
        case let .uploadImage(id, data, mimeType, _):
            saveAttachment(id: id, data: data, mimeType: mimeType)
        case let .resolveLinkCard(id, url):
            resolveLinkCard(id: id, url: url)
        case let .unfurlUrl(id, url):
            unfurl(id: id, url: url)
        case let .resolveEmbedMeta(id, url):
            // Answered, not ignored: the page holds a pending request until it
            // hears back, and a caption that never resolves is a card that
            // never settles. Jot has no provider recognizer, which is what
            // this needs and which lives in TypeScript
            // (shared/embedProviders.ts); a second copy of that table in Swift
            // is the kind of duplication this shell has been careful to avoid.
            host.send(.embedMetaResult(id: id, url: url, title: nil))
        case let .perfMarks(json):
            measure.receivedPerfMarks(json)
        case let .other(type):
            measure.trace("message ignored: \(type)")
        }
    }

    // MARK: link data

    /// The page's title and description for a link the reader chose to show as
    /// a card.
    ///
    /// Gated on the network opt-in and nothing else, which mirrors the
    /// extension: the per-link choice lives in the page's own state, so a
    /// mirror of it posted by that same page would prove nothing, and the
    /// switch the user set is the whole host-side gate.
    private func resolveLinkCard(id: String, url: String) {
        guard Prefs.networkEnabled, let target = Self.fetchableURL(url) else {
            host.send(.linkCardResult(id: id, url: url, title: nil, description: nil))
            return
        }
        let fetcher = self.fetcher
        Task { @MainActor in
            let meta = await fetcher.metadata(for: target)
            self.host.send(.linkCardResult(id: id, url: url,
                                           title: meta.title, description: meta.description))
        }
    }

    /// The title of a bare URL just pasted, so the link text can be upgraded.
    /// A nil title leaves the `[url](url)` the page already inserted, which is
    /// what happens offline and is the honest default.
    private func unfurl(id: String, url: String) {
        guard Prefs.networkEnabled, let target = Self.fetchableURL(url) else {
            host.send(.unfurlResult(id: id, url: url, title: nil))
            return
        }
        let fetcher = self.fetcher
        Task { @MainActor in
            let title = await fetcher.title(for: target)
            self.host.send(.unfurlResult(id: id, url: url, title: title))
        }
    }

    /// A URL string from the document, as something fetchable, or nil. The
    /// scheme is checked here as well as in the guard so an obviously wrong
    /// string never reaches a Task at all.
    static func fetchableURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", url.host != nil else { return nil }
        return url
    }

    // MARK: attachments

    /// Save a pasted or dropped image beside the bound document and answer with
    /// the reference to put in it.
    ///
    /// The reply carries the store's RELATIVE reference, which is both what the
    /// document should say and, because the page is served from a scheme handler
    /// rooted at the document's folder, a URL the editor can render as-is. One
    /// string doing both jobs is the reason no `imageUriMap` is needed here.
    private func saveAttachment(id: String, data: Data, mimeType: String) {
        do {
            let reference = try attachments.save(data, mimeType: mimeType, besideDocument: boundURL)
            host.send(.imageUploaded(id: id, url: reference))
        } catch AttachmentStore.StoreError.unsupportedType(let type) {
            host.send(.imageUploadError(id: id, error: "Jot cannot save a \(type) image."))
        } catch {
            NSLog("Birta Jot: attachment save failed: \(error)")
            host.send(.imageUploadError(id: id, error: "The image could not be saved beside this document."))
        }
    }

    /// Copy the attachments a saved note references into its new home, and say
    /// so when some could not be copied.
    ///
    /// Reported rather than thrown: the markdown is already written by this
    /// point, and that is the thing the user asked to keep. An alert naming
    /// the files that did not make it leaves them able to fix it; failing the
    /// save would not put the bytes back.
    private func migrateAttachments(markdown: String, from source: URL, to target: URL) {
        let plan = AttachmentReferences.migrationPlan(markdown: markdown, from: source, to: target)
        guard !plan.isEmpty else { return }
        let failed = AttachmentReferences.apply(plan)
        guard !failed.isEmpty else { return }
        NSLog("Birta Jot: \(failed.count) attachment(s) could not be copied: \(failed.joined(separator: ", "))")
        let alert = NSAlert()
        alert.messageText = failed.count == 1
            ? "One image could not be copied"
            : "\(failed.count) images could not be copied"
        alert.informativeText = """
        The note was saved to \(target.lastPathComponent), but these images stayed behind and will not show in it: \
        \(failed.joined(separator: ", ")). They are still in the \(AttachmentStore.directoryName) folder beside \
        \(source.lastPathComponent).
        """
        alert.alertStyle = .warning
        alert.runModal()
    }

    // MARK: persistence

    private func readActiveFile() -> String {
        (try? String(contentsOf: boundURL, encoding: .utf8)) ?? ""
    }

    /// Ask the page for its freshest bytes, write them, then run `then`.
    /// Bounded: on timeout the latest admitted content is written instead
    /// (at most one scheduler window stale, see webview/syncScheduler.ts).
    private func flushThen(_ then: @escaping () -> Void) {
        guard state == .warm else {
            writeLatest()
            then()
            return
        }
        let id = "flush-\(UUID().uuidString)"
        var done = false
        let finish: () -> Void = { if !done { done = true; then() } }
        pendingFlushes[id] = { _ in finish() }
        host.send(.flushSave(id: id))
        DispatchQueue.main.asyncAfter(deadline: .now() + flushTimeout) { [weak self] in
            guard let self, self.pendingFlushes.removeValue(forKey: id) != nil else { return }
            NSLog("Birta Jot: flush timed out; writing the last admitted content")
            self.writeLatest()
            finish()
        }
    }

    func prepareToTerminate(_ done: @escaping () -> Void) {
        hotkey.unregister()
        // A child process outliving the app is litter nobody can attribute.
        agent.stopAll()
        flushThen(done)
    }

    /// Last-chance synchronous write, idempotent after `prepareToTerminate`.
    func finalWrite() {
        write(.terminating)
    }

    /// Write `latest` to the bound file, synchronously. Nothing is written
    /// before the file has been read once (`hasLoaded`): before the first
    /// `ready`, or forever when the web assets are missing, `latest` is the
    /// empty string and writing it would truncate the user's scratchpad.
    private func writeLatest() {
        guard hasLoaded else { return }
        writer.submit(latest, to: boundURL)
        writer.drain()
        // The one place the buffer and the file come back into step, so the
        // one place the title stops saying Edited. Guarded by `hasLoaded`
        // above: before the first read there is nothing to be behind.
        isEdited = false
    }

    /// The one funnel every write goes through, so the autosave setting is
    /// asked exactly once per reason rather than at each call site.
    ///
    /// An edit is held for `autosaveDebounce` and re-held by the next
    /// keystroke, with `autosaveMaxWait` as the ceiling so continuous typing
    /// still reaches disk. That ceiling is the whole crash-safety story: it is
    /// how far the file is ever allowed to trail the editor.
    private func write(_ trigger: WriteTrigger) {
        switch AutosavePolicy.action(for: trigger, autosaveEnabled: Prefs.autosave) {
        case .now:
            cancelPendingAutosave()
            writeLatest()
        case .deferred:
            scheduleAutosave()
        case .skip:
            cancelPendingAutosave()
        }
    }

    private func scheduleAutosave() {
        autosaveTimer?.invalidate()
        if autosaveDeadline == nil {
            autosaveDeadline = Date().addingTimeInterval(autosaveMaxWait)
        }
        // Whichever comes first: the typing pause, or the ceiling.
        let pause = Date().addingTimeInterval(autosaveDebounce)
        let fireAt = min(pause, autosaveDeadline ?? pause)
        let timer = Timer(fireAt: fireAt, interval: 0, target: self,
                          selector: #selector(autosaveFired), userInfo: nil, repeats: false)
        RunLoop.main.add(timer, forMode: .common)
        autosaveTimer = timer
    }

    @objc private func autosaveFired() {
        autosaveTimer = nil
        autosaveDeadline = nil
        writeLatest()
    }

    private func cancelPendingAutosave() {
        autosaveTimer?.invalidate()
        autosaveTimer = nil
        autosaveDeadline = nil
    }

    // MARK: the note

    /// Whether the buffer holds anything worth copying or saving.
    var hasContent: Bool { !latest.isBlank }

    /// Copy the whole note. Nothing leaves the buffer: Jot edits a file, and
    /// copying out of a file does not empty it.
    func copyEverything() {
        withFlushedContent { [weak self] content in
            guard let self else { return }
            self.writeToPasteboard(content)
            self.statusOverlay.flash("Copied the whole note.")
            self.focusEditorIfVisible()
        }
    }

    // MARK: /ai

    /// Run one `/ai` request against the file on disk.
    ///
    /// The buffer is flushed and WRITTEN first, always: the agent edits the
    /// file, so the bytes it opens have to be the bytes on screen, and the
    /// `path.md#L1` reference has to name something real. This is the one
    /// place a write happens regardless of the autosave setting for a reason
    /// that is not about safety: an agent reading a stale file would rewrite
    /// the wrong text.
    private func runAgent(prompt: String?, requestId: String?, model: String?, effort: String?) {
        let id = requestId ?? UUID().uuidString
        let request = (prompt ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !request.isEmpty else {
            reportAgent(requestId: id, .init(status: "failed", harness: nil, text: nil,
                                             message: "Nothing was asked."))
            return
        }
        var template = Prefs.agentCommand.trimmingCharacters(in: .whitespaces)
        guard !template.isEmpty else {
            reportAgent(requestId: id, .init(status: "failed", harness: nil, text: nil,
                                             message: "No agent command is set in Settings."))
            return
        }
        // The composer's per-request choices. Added before a trailing
        // `{prompt}` rather than appended, because a template that ends in the
        // placeholder hands the prompt positionally and a flag after it is not
        // the prompt's flag any more (`AgentRequest.adding`).
        if let model, !model.isEmpty {
            template = AgentRequest.adding(flag: "--model", value: model, to: template)
        }
        if let effort, !effort.isEmpty {
            template = AgentRequest.adding(flag: "--effort", value: effort, to: template)
        }
        let command = template

        flushThen { [weak self] in
            guard let self else { return }
            self.write(.explicitSave)
            let directory = self.boundURL.deletingLastPathComponent()
            let reference = "\(self.boundURL.lastPathComponent)#L1"
            let line = AgentRequest.compose(prompt: request, reference: reference)
            self.agent.run(requestId: id, line: line, template: command,
                           workingDirectory: directory) { [weak self] status in
                guard let self else { return }
                if status.status == "done" {
                    // The agent edited the file; bring it back into the panel.
                    // Whatever was typed during the run is the losing side,
                    // which jot/README.md says out loud.
                    self.reloadFromDiskIntoBuffer()
                }
                self.reportAgent(requestId: id, status)
            }
        }
    }

    private func reportAgent(requestId: String, _ status: AgentRunStatus) {
        guard state == .warm else { return }
        host.send(.agentRun(requestId: requestId, status: status.status,
                            harness: status.harness, text: status.text, message: status.message))
    }

    /// Take what is on disk as the buffer's new truth.
    private func reloadFromDiskIntoBuffer() {
        let onDisk = readActiveFile()
        guard onDisk != latest else { return }
        latest = onDisk
        isEdited = false
        if state == .warm {
            host.send(.externalUpdate(content: onDisk, syncVersion: guardState.bumpVersion()))
        }
    }

    /// Cmd+N. Put the current note beyond doubt, then start a fresh file.
    ///
    /// No Save/Don't Save sheet, and that is the macOS answer rather than a
    /// shortcut past it: the buffer is written before the switch every time,
    /// unconditionally and whatever the autosave setting says, so there is
    /// never an unsaved change to ask about. A prompt here would be asking
    /// permission to do something already done.
    ///
    /// A bound DOCUMENT is left alone. New Note makes a note in Jot's own
    /// folder; it is not a way to stop editing the file the user pointed Jot
    /// at, which is what the Document setting is for.
    func newNote() {
        flushThen { [weak self] in
            guard let self else { return }
            self.write(.explicitSave)
            guard Prefs.documentURL == nil else {
                self.statusOverlay.flash("Jot is set to edit a document; New Note is off while that is on.")
                return
            }
            let directory = Prefs.notesDirectory
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            } catch {
                NSLog("Birta Jot: could not create \(directory.path): \(error)")
                self.statusOverlay.flash("Could not make a new note in \(directory.lastPathComponent).")
                return
            }
            let target = Coordinator.unusedNoteURL(in: directory)
            do {
                // Create it now, empty. A note that exists only in memory is
                // one the next launch cannot find its way back to.
                try AtomicFile.writeString("", to: target)
            } catch {
                NSLog("Birta Jot: could not write \(target.path): \(error)")
                self.statusOverlay.flash("Could not make a new note.")
                return
            }
            Prefs.currentNoteURL = target
            self.bindTo(target, content: "")
            self.statusOverlay.flash("New note.")
        }
    }

    /// The launch half of New Note: a fresh file, chosen before anything has
    /// loaded, so there is no buffer to flush and nothing to write first.
    private func startBlank() {
        let directory = Prefs.notesDirectory
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let target = Coordinator.unusedNoteURL(in: directory)
            try AtomicFile.writeString("", to: target)
            Prefs.currentNoteURL = target
            boundURL = target
        } catch {
            // The scratchpad is the fallback, and it is a good one: the setting
            // says where to START, not that the old note may be lost.
            NSLog("Birta Jot: could not start a blank note in \(directory.path): \(error)")
        }
    }

    /// Point the editor and the file at `url`, with `content` as the truth.
    private func bindTo(_ url: URL, content: String) {
        cancelPendingAutosave()
        boundURL = url
        latest = content
        // `content` came off disk, so the buffer is the file.
        isEdited = false
        refreshTitle()
        if state == .warm {
            host.send(.externalUpdate(content: content, syncVersion: guardState.bumpVersion()))
        }
    }

    /// Put a reference to where the caret is on the clipboard, for pasting
    /// into an agent somewhere else.
    ///
    /// Three things have to be true at once, and the order is what makes them
    /// so.
    ///
    /// The reference names LINES IN A FILE, so the file has to hold them: this
    /// writes first, whatever autosave says, exactly as the `/ai` hand-off
    /// does and for the same reason. A pointer into bytes that are not on disk
    /// is worse than no pointer, because it looks like it worked.
    ///
    /// The path is ABSOLUTE. The extension writes a workspace-relative one,
    /// which is what a tool already working in that project resolves; Jot's
    /// file lives under Application Support, nowhere near any agent's working
    /// directory, so relative would name nothing anywhere.
    ///
    /// And the lines are quoted when there are any, because the tools this
    /// gets pasted into are not all able to open a file. What decides the
    /// shape is `BirtaJotCore.AgentReference`, which is the same shape the
    /// extension's `src/agentBridge/format.ts` produces and is tested against
    /// the same cases.
    private func copyAgentReference() {
        guard state == .warm else { return }
        flushThen { [weak self] in
            guard let self else { return }
            self.write(.explicitSave)
            self.requestEditorContext { [weak self] selection in
                guard let self else { return }
                guard let selection else {
                    // The page could not place the selection, which happens
                    // before the first sync. Saying so beats copying a
                    // reference to line 1 that names somewhere nobody is.
                    self.statusOverlay.flash("Could not tell where the caret is.")
                    return
                }
                let payload = AgentReference.clipboardPayload(
                    path: self.boundURL.path, selection: selection, source: self.latest)
                self.writeToPasteboard(payload)
                self.measure.trace("agentref \(payload.split(separator: "\n").first ?? "")")
                // "a reference to X" rather than "Copied X": the clipboard
                // holds the ABSOLUTE path and this names the file, which is
                // all the width there is down here. Saying "Copied <name>"
                // would name something narrower than what was copied, and the
                // whole job of this line is to be checkable against what you
                // are about to paste.
                let named = AgentReference.reference(
                    path: self.boundURL.lastPathComponent, selection: selection)
                self.statusOverlay.flash(selection.isEmpty
                    ? "Copied a reference to \(named)"
                    : "Copied a reference to \(named) and the selected lines")
            }
        }
    }

    /// Ask the page where the selection is, bounded in time.
    ///
    /// Bounded because the answer comes from the web content process, which
    /// can die between the question and the reply; the flush protocol is
    /// bounded for the same reason and this reuses its timeout rather than
    /// inventing a second number.
    private func requestEditorContext(_ then: @escaping (AgentReference.Selection?) -> Void) {
        let id = "ctx-\(UUID().uuidString)"
        pendingContexts[id] = then
        host.send(.requestEditorContext(id: id))
        DispatchQueue.main.asyncAfter(deadline: .now() + flushTimeout) { [weak self] in
            guard let self, let pending = self.pendingContexts.removeValue(forKey: id) else { return }
            NSLog("Birta Jot: the page did not answer requestEditorContext in time")
            pending(nil)
        }
    }

    /// Rename or move the file the panel is editing, from the title popover.
    ///
    /// The order is the whole of it, and every step is load-bearing:
    ///
    ///   1. flush, so the bytes on disk are the bytes on screen. Moving first
    ///      would leave the next write landing on the OLD path, because the
    ///      writer is handed a URL per submission.
    ///   2. refuse a name already taken, rather than replacing what is there.
    ///      A rename field is not a place to lose somebody's other file, and
    ///      macOS refuses this too.
    ///   3. move, or WRITE when there is nothing to move. A scratchpad that
    ///      has never been typed into has no file yet, and a rename that
    ///      failed for that reason would be a rename that silently did not
    ///      happen.
    ///   4. point the setting the panel is bound THROUGH at the new path
    ///      (`Prefs.rebindActive`), which is the one that was read to get
    ///      here. Writing any of the other two would leave the next launch
    ///      opening a file that never moved.
    ///   5. rebind, which re-roots the attachment scheme handler and renames
    ///      the title, both through `boundURL`'s `didSet`.
    ///
    /// The buffer is never re-read. This moves the file the editor is already
    /// showing, so the bytes on screen are already the right ones, and
    /// `bindTo` would push an `externalUpdate` that costs a document swap for
    /// content that did not change.
    func relocateActiveFile(to target: URL) {
        guard target.standardizedFileURL != boundURL.standardizedFileURL else { return }
        flushThen { [weak self] in
            guard let self else { return }
            // Read the bound file HERE, not when the move was asked for. A
            // second rename arriving while the first is still flushing would
            // otherwise carry the first one's idea of where the file is, and
            // move something that has already moved.
            let source = self.boundURL
            guard target.standardizedFileURL != source.standardizedFileURL else { return }
            let manager = FileManager.default
            if manager.fileExists(atPath: target.path) {
                self.measure.trace("relocate refused=taken \(target.lastPathComponent)")
                self.statusOverlay.flash("There is already a file called \(target.lastPathComponent) there.")
                return
            }
            do {
                try manager.createDirectory(at: target.deletingLastPathComponent(),
                                            withIntermediateDirectories: true)
                if manager.fileExists(atPath: source.path) {
                    try manager.moveItem(at: source, to: target)
                } else {
                    // Never typed into, so there is nothing on disk to move.
                    // Writing is what makes the new name real.
                    try AtomicFile.writeString(self.latest, to: target)
                }
            } catch {
                NSLog("Birta Jot: could not move \(source.path) to \(target.path): \(error)")
                self.measure.trace("relocate failed \(target.lastPathComponent)")
                self.statusOverlay.flash("Could not move the file to \(target.lastPathComponent).")
                return
            }
            Prefs.rebindActive(to: target)
            self.boundURL = target
            if self.lastSavedURL == source { self.lastSavedURL = target }
            let moved = target.deletingLastPathComponent().standardizedFileURL
                != source.deletingLastPathComponent().standardizedFileURL
            self.measure.trace("relocate ok \(moved ? "moved" : "renamed") \(target.lastPathComponent)")
            self.statusOverlay.flash(moved
                ? "Moved to \(WindowTitle.displayName(of: target.deletingLastPathComponent()))."
                : "Renamed to \(target.lastPathComponent).")
        }
    }

    /// `Note 2026-08-18.md`, numbered if that name is taken, so a second note
    /// on one day never lands on the first.
    static func unusedNoteURL(in directory: URL) -> URL {
        let stamp = DateFormatter()
        stamp.dateFormat = "yyyy-MM-dd"
        let base = "Note \(stamp.string(from: Date()))"
        var candidate = directory.appendingPathComponent("\(base).md")
        var n = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = directory.appendingPathComponent("\(base) \(n).md")
            n += 1
        }
        return candidate
    }

    /// Cmd+S. The buffer is already being written as you type, so this is a
    /// flush and an acknowledgement rather than news; it earns its place by
    /// being the key everyone presses, and by being the one write that happens
    /// when autosave is off.
    func saveNow() {
        flushThen { [weak self] in
            guard let self else { return }
            self.write(.explicitSave)
            self.statusOverlay.flash("Saved.")
            self.focusEditorIfVisible()
        }
    }

    private func writeToPasteboard(_ text: String, asHTML: Bool = false) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: asHTML ? .html : .string)
    }

    /// Flush the page's freshest bytes, then hand them to `body`. Nothing runs
    /// for an empty buffer, checked once before the flush and again after it:
    /// the flush is a round trip, and the note can be gone by the time it lands.
    private func withFlushedContent(_ body: @escaping (String) -> Void) {
        guard hasContent else { return }
        flushThen { [weak self] in
            guard let self, self.hasContent else { return }
            body(self.latest)
        }
    }

    /// Everything that follows a written copy.
    private func finishSave(to target: URL, content: String) {
        // The images travel with the note. Without this the markdown arrives at
        // its new home with references to a folder it no longer sits beside, so
        // a note that looked complete on screen is a note of broken images the
        // moment it is saved.
        migrateAttachments(markdown: content, from: boundURL, to: target)
        lastSavedURL = target
        // The buffer is untouched, always. Save As writes a COPY: the panel
        // goes on showing the note, still bound to the same file, which is
        // what every other editor on the machine does.
        statusOverlay.flash("Copy saved to \(target.lastPathComponent).")
        focusEditorIfVisible()
    }

    func revealLastSave() {
        guard let url = lastSavedURL else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    /// Hand the note to whatever the system can send it to. The macOS answer to
    /// "pipe it elsewhere" without integrating with anything in particular.
    /// Anchored on the panel's own content view, because the File menu is
    /// where Share is reached from now and a menu item is not a view the
    /// picker can hang off.
    func shareNote() {
        withFlushedContent { [weak self] content in
            guard let self else { return }
            let picker = NSSharingServicePicker(items: [content])
            picker.show(relativeTo: self.contentView.bounds, of: self.contentView, preferredEdge: .maxY)
        }
    }

    /// Where the title accessory actually landed, and what it says.
    ///
    /// A titlebar accessory is placed by AppKit, in a band this panel has
    /// already made transparent and full-height, and neither a unit test nor
    /// the browser harness can see whether it arrived, arrived empty, or
    /// arrived under the traffic lights. `jot/scripts/measure.sh` reads this
    /// line and checks it, which is the same seam and the same reason as every
    /// other question only a running panel can answer.
    /// The label's own box and the close button's, both in window coordinates,
    /// so the check can compare them.
    ///
    /// The comparison is the point. macOS puts a window title's vertical
    /// centre exactly on the close button's, at every titlebar height and
    /// title font the system uses, so the close button is a reference for
    /// "where a title goes" that lives in this window and needs no other
    /// application to be running. The accessory's own frame is the whole
    /// titlebar band and says nothing about where the text inside it sits, so
    /// a title drawn low in that band moves no number the old check read.
    /// Fit the drag strip to what neither the window's chrome nor the page's
    /// is using.
    ///
    /// The band's height is asked of the window rather than written down:
    /// `contentLayoutRect` is the part of the frame BELOW the titlebar, so the
    /// difference is the band, whatever height the system is using today.
    ///
    /// `titleBar.titleView.frame.maxX` is where the window's own furniture
    /// ends. It already accounts for the traffic lights, because AppKit places
    /// a leading accessory after them, so nothing here repeats a number the
    /// system owns.
    func layoutTitlebarDrag() {
        let bandHeight = panel.frame.height - panel.contentLayoutRect.height
        let titleView = titleBar.titleView
        let leading = titleView.convert(titleView.bounds, to: contentView).maxX
        guard bandHeight > 0,
              let span = TitlebarBand.draggableSpan(
                  windowWidth: contentView.bounds.width,
                  leading: leading,
                  trailingControlsWidth: titlebarControlsWidth) else {
            titlebarDrag.isHidden = true
            return
        }
        titlebarDrag.isHidden = false
        // The content view is flipped-free AppKit geometry, so the band is at
        // the TOP, which is the high end of y.
        titlebarDrag.frame = NSRect(x: span.x,
                                    y: contentView.bounds.height - bandHeight,
                                    width: span.width,
                                    height: bandHeight)
    }

    /// Ask the page how much of the band its controls take, then refit.
    ///
    /// Called when the page has mounted and whenever its chrome could have
    /// changed shape. Cheap, asynchronous, and never on the resize path: the
    /// width does not depend on the window's size, which is what makes a
    /// stored value correct between calls.
    ///
    /// The constraint that makes storing it safe: the cluster is right-aligned,
    /// so its width moves only when the SET of controls does. Two things in the
    /// page could do that without passing through here, and both are status
    /// badges pinned to the front of that cluster (`renderPinned` in
    /// webview/components/toolbar/layout.ts): the drift warning and the Logseq
    /// indicator. Neither is reachable in this shell, because the messages that
    /// raise them are the extension's and Jot's bridge does not send them. If
    /// Jot ever sends one, the strip will still be sized for a cluster that has
    /// since grown, and it will cover the badge it grew for. That is the day
    /// this needs the page to push its width rather than be asked.
    func refreshTitlebarControlsWidth() {
        host.reportTitlebarControlsWidth { [weak self] width in
            MainActor.assumeIsolated {
                guard let self, let width else { return }
                self.titlebarControlsWidth = width
                self.layoutTitlebarDrag()
                self.traceTitlebarDrag()
            }
        }
    }

    /// The drag strip's live frame, for `jot/scripts/measure.sh`.
    ///
    /// Whether the band can be dragged is not answerable from a script: a
    /// window move needs a real pointer, and synthesizing one needs an
    /// Accessibility grant this repository's checks do not have. What IS
    /// answerable is everything the drag depends on, which is where the strip
    /// is: a strip of zero width, or one lying under the page's controls, is
    /// the shape every way of getting this wrong takes.
    private func traceTitlebarDrag() {
        guard measure.enabled else { return }
        let frame = titlebarDrag.convert(titlebarDrag.bounds, to: nil)
        let titleView = titleBar.titleView
        let title = titleView.convert(titleView.bounds, to: nil)
        measure.trace(String(
            format: "titlebardrag x=%.1f w=%.1f h=%.1f hidden=%@ titleMaxX=%.1f controlsW=%.1f windowW=%.1f",
            frame.origin.x, frame.width, frame.height,
            titlebarDrag.isHidden ? "yes" : "no",
            title.maxX, titlebarControlsWidth, panel.frame.width))
    }

    private func traceTitleBar() {
        guard measure.enabled else { return }
        let view = titleBar.titleView
        let frame = view.convert(view.bounds, to: nil)
        let text = view.labelFrameInWindow()
        let close = panel.standardWindowButton(.closeButton)
            .map { $0.convert($0.bounds, to: nil) } ?? .zero
        measure.trace(String(
            format: "titlebar x=%.1f y=%.1f w=%.1f h=%.1f textW=%.1f textNeeds=%.1f textMidY=%.1f closeMidY=%.1f attached=%@ text=%@",
            frame.origin.x, frame.origin.y, frame.width, frame.height,
            text.width, view.textWidthNeeded(),
            text.midY, close.midY,
            panel.titlebarAccessoryViewControllers.contains(titleBar) ? "yes" : "no",
            view.accessibilityLabel() ?? ""))
    }

    /// Name the bound file in the titlebar, and say whether the reader has
    /// something to do about it. Called from the two `didSet`s that can change
    /// either answer, so no caller has to remember to.
    ///
    /// `Prefs.autosave` is read HERE, on every paint, and must stay that way.
    /// The setting can move while the app runs, and `isEdited` does not change
    /// at that moment, so a captured value would leave the title answering for
    /// a setting that is no longer in force until the next keystroke.
    private func refreshTitle() {
        titleBar.titleView.show(
            url: boundURL,
            edited: WindowTitle.showsEdited(hasUnwrittenBytes: isEdited,
                                            autosaveEnabled: Prefs.autosave))
        // The title's width is the drag strip's leading edge, so a title that
        // just changed leaves the strip starting somewhere the title no longer
        // ends. Harmless for clicks, because the accessory is in the titlebar's
        // own hierarchy and wins the hit test over anything in the content
        // view, and wrong for the geometry the checks read, which is reason
        // enough not to leave it stale.
        layoutTitlebarDrag()
        // Traced on every CALL rather than on every change, deliberately. What
        // this line is read for is whether the title holds still across a
        // typing burst, and a trace that fired only on a change could not tell
        // a title that never moved from one nothing ever asked about. Guarded
        // so the string is not built when nothing is reading: with autosave on
        // this runs on the keystroke path.
        if measure.enabled { measure.trace("titletext \(titleBar.titleView.currentText)") }
    }

    /// Chrome follows the pointer: everything on while it is over the window,
    /// and a page with a caret in it when it is not. Wholly the page's now,
    /// as a body class its own stylesheet reads; the window's own title is not
    /// part of it, because macOS titles a window whether or not you are
    /// pointing at it.
    private func applyChromeVisibility(_ hovering: Bool) {
        host.setChromeResting(!hovering)
    }

    private func focusEditorIfVisible() {
        guard panel.isVisible else { return }
        panel.makeFirstResponder(host.webView)
        if state == .warm { host.focusEditor() }
    }

    // MARK: Save As

    /// Write a copy somewhere the user chooses. The buffer is not touched and
    /// stays bound to the same file: this is "save a copy", not "move".
    func saveAs() {
        NSApp.activate(ignoringOtherApps: true)
        flushThen { [weak self] in
            guard let self else { return }
            let panel = NSSavePanel()
            panel.title = "Save a Copy As"
            panel.nameFieldStringValue = Coordinator.suggestedFileName(for: self.latest)
            panel.allowedContentTypes = [.init(filenameExtension: "md") ?? .plainText]
            panel.directoryURL = Prefs.saveAsDirectory ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            panel.canCreateDirectories = true
            let respond: (NSApplication.ModalResponse) -> Void = { [weak self] resp in
                guard resp == .OK, let url = panel.url, let self else { return }
                // Read `latest` now, not when the sheet opened: a flush that
                // timed out can still land while the sheet is up.
                let content = self.latest
                do {
                    try AtomicFile.writeString(content, to: url)
                } catch {
                    NSAlert(error: error).runModal()
                    return
                }
                Prefs.saveAsDirectory = url.deletingLastPathComponent()
                self.finishSave(to: url, content: content)
            }
            if self.panel.isVisible {
                panel.beginSheetModal(for: self.panel, completionHandler: respond)
            } else {
                respond(panel.runModal())
            }
        }
    }

    /// Run an editor command in the page (the Edit menu's Find and Insert
    /// Link, which the extension binds as VS Code keybindings).
    func runEditorCommand(_ command: String) {
        guard state == .warm else { return }
        show()
        host.send(.editorCommand(command))
    }

    /// Put `content` in the editor and the file, keeping the mounted editor
    /// (an `externalUpdate` is a cursor-preserving diff, and it re-baselines
    /// without echoing an `update`, so the write here is the only one).
    private func replaceBuffer(with content: String) {
        latest = content
        writer.submit(content, to: boundURL)
        // Handed to the writer, so the buffer is no longer ahead of where the
        // file is going. Same claim `writeLatest` makes at the same moment.
        isEdited = false
        if state == .warm {
            host.send(.externalUpdate(content: content, syncVersion: guardState.bumpVersion()))
        }
    }

    static func suggestedFileName(for content: String) -> String {
        for line in content.split(separator: "\n") {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("#") {
                let title = t.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces)
                let safe = title.replacingOccurrences(of: "[/:\\\\]", with: "-", options: .regularExpression)
                if !safe.isEmpty { return String(safe.prefix(80)) + ".md" }
            }
            break
        }
        let f = DateFormatter()
        // Pinned to a fixed locale and calendar, because `dateFormat` is read
        // against the USER's calendar otherwise: under a Japanese or Buddhist
        // calendar preference `yyyy` is the era year, so the fallback filename
        // would carry a date nothing else on the machine agrees with.
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "yyyy-MM-dd HH.mm"
        return "Jot \(f.string(from: Date())).md"
    }

    // MARK: preferences

    /// The hotkey text changed: rebind, and say whether the system took it.
    @discardableResult
    func hotkeyChanged() -> OSStatus {
        hotkey.register(Prefs.hotkey)
    }

    func preferencesChanged() {
        // A changed file, document or network setting means a fresh page:
        // flush the current buffer to where it belongs, then reload against
        // the new prefs. Cheap, and it keeps one code path.
        flushThen { [weak self] in
            guard let self else { return }
            self.reloadFromDisk = true
            self.loadPage()
            // The bound file may have changed; the titlebar names it.
            self.refreshTitle()
            self.panel.applyFloatLevel()
        }
    }

    // MARK: theme

    private func currentThemeClass() -> String {
        let match = contentView.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua])
        return match == .darkAqua ? "vscode-dark" : "vscode-light"
    }

    private func applyTheme(initial: Bool = false) {
        let cls = currentThemeClass()
        let bg = NSColor.textBackgroundColor
        panel.backgroundColor = bg
        host.webView.underPageBackgroundColor = bg
        if !initial { host.setThemeClass(cls) }
    }

    // MARK: resources

    /// The web assets: `Contents/Resources/web` in the bundle, or the
    /// directory `BIRTA_JOT_WEB_DIR` names for `swift run` during development.
    static func locateWebRoot() -> URL {
        if let env = ProcessInfo.processInfo.environment["BIRTA_JOT_WEB_DIR"], !env.isEmpty {
            return URL(fileURLWithPath: env, isDirectory: true)
        }
        if let res = Bundle.main.resourceURL {
            let web = res.appendingPathComponent("web", isDirectory: true)
            if FileManager.default.fileExists(atPath: web.appendingPathComponent("index.html").path) { return web }
        }
        NSLog("Birta Jot: no web assets found; set BIRTA_JOT_WEB_DIR or run jot/scripts/build-app.sh")
        return URL(fileURLWithPath: "/nonexistent", isDirectory: true)
    }
}

extension String {
    /// Nothing but whitespace, so nothing worth copying or saving. Stops at the
    /// first non-space character, which every real note has near its front.
    var isBlank: Bool { allSatisfy(\.isWhitespace) }
}
