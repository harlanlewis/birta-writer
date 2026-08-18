import AppKit
import WebKit
import BirtaJotCore
import os

/// The one object that knows the whole flow: prewarm → summon → edit →
/// persist → hide, plus Save As, theme, preferences and cold recovery.
///
/// Persistence model (MAR-375): exactly one buffer, autosaved to a plain
/// `.md` file the user can find (Preferences names it), on every admitted
/// `update`, atomically. Hiding, quitting and Save As first ask the page to
/// flush (`flushSave`), bounded by `flushTimeout` like the extension's
/// will-save participant, then write. Cmd+S is Save As: the buffer goes to a
/// chosen file and is cleared, with "Reopen Last Saved" as the undo.
///
/// State machine for the web view: `cold` (nothing loaded, or the content
/// process died) → `loading` (page requested, `ready` not yet seen) → `warm`
/// (`init` sent, editor mounted). Summoning in any state shows the panel; the
/// editor appears when it is ready.
@MainActor
final class Coordinator {
    enum State { case cold, loading, warm }

    let hotkey: GlobalHotkey
    private let panel = JotPanel()
    private let contentView = AppearanceObservingView()
    private let host: WebHost
    private let writer: CoalescingWriter
    private var guardState = SyncGuard()
    private var state: State = .cold
    /// The newest buffer content the host has seen or written.
    private var latest = ""
    /// (file, content) of the last Save As, for "Reopen Last Saved".
    private var undoSlot: (url: URL, content: String)? {
        didSet { onUndoSlotChange?(undoSlot != nil) }
    }
    var onUndoSlotChange: ((Bool) -> Void)?
    private var pendingFlushes: [String: (String?) -> Void] = [:]
    private var previousApp: NSRunningApplication?
    private var escMonitor: Any?
    private var lastEscape: TimeInterval = 0
    private let flushTimeout: TimeInterval = 1.0
    private let measure = Measure()

    var isVisible: Bool { panel.isVisible }

    init() {
        let webRoot = Coordinator.locateWebRoot()
        host = WebHost(webRoot: webRoot)
        writer = CoalescingWriter(onError: { error in
            NSLog("Birta Jot: write failed: \(error)")
        })
        hotkey = GlobalHotkey()
    }

    // MARK: lifecycle

    func start() {
        host.bootConfig = { Prefs.bootConfig() }
        host.onMessage = { [weak self] m in self?.handle(m) }
        host.onProcessTerminated = { [weak self] in self?.contentProcessDied() }

        contentView.onAppearanceChange = { [weak self] in self?.applyTheme() }
        contentView.addSubview(host.webView)
        host.webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            host.webView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            host.webView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            host.webView.topAnchor.constraint(equalTo: contentView.topAnchor),
            host.webView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
        ])
        panel.contentView = contentView
        panel.onHideRequest = { [weak self] in self?.hide() }
        applyTheme(initial: true)

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
    /// for `{"type":"__jotKeys","keys":[...]}`, synthesize those keystrokes
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
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           obj["type"] as? String == "__jotKeys",
           let keys = obj["keys"] as? [String] {
            measure.mark("debug-keys")
            typeKeys(keys)
            return
        }
        measure.mark("debug-post")
        host.send(.raw(json: json))
    }

    /// Deliver key events to the panel as a keyboard would. Single characters
    /// type themselves; "Enter", "End", "Home", "Backspace", "Escape",
    /// "ArrowUp/Down/Left/Right", "Tab" and "Space" are named keys.
    private func typeKeys(_ keys: [String]) {
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeFirstResponder(host.webView)
        var delay: TimeInterval = 0
        for key in keys {
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
            delay += 0.06
            DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
                guard let self else { return }
                for type in [NSEvent.EventType.keyDown, .keyUp] {
                    if let ev = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                 windowNumber: self.panel.windowNumber, context: nil, characters: chars,
                                                 charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) {
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
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeFirstResponder(host.webView)
        if state == .warm { host.focusEditor() }
        if state == .cold { loadPage() }
        measure.mark("visible")
    }

    func hide() {
        guard panel.isVisible else { return }
        flushThen { [weak self] in
            guard let self else { return }
            self.panel.orderOut(nil)
            if let prev = self.previousApp, prev.isTerminated == false {
                prev.activate()
            } else {
                NSApp.hide(nil)
            }
            self.previousApp = nil
        }
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
            latest = readActiveFile()
            host.send(.initDoc(content: latest, syncVersion: guardState.version, viewStateJSON: Prefs.viewStateJSON))
            state = .warm
            if panel.isVisible { host.focusEditor() }
        case let .update(content, base, seq):
            switch guardState.judge(baseSyncVersion: base, seq: seq) {
            case .admit:
                latest = content
                writer.submit(content, to: Prefs.activeURL)
            case .repush:
                host.send(.externalUpdate(content: latest, syncVersion: guardState.bumpVersion()))
            case .staleSeq:
                break
            }
        case let .flushResult(id, content, base, seq):
            let resolve = pendingFlushes.removeValue(forKey: id)
            switch guardState.judge(baseSyncVersion: base, seq: seq) {
            case .admit:
                latest = content
                writer.submit(content, to: Prefs.activeURL)
                writer.drain()
                host.send(.flushAck(id: id, applied: true))
                resolve?(content)
            case .repush:
                host.send(.flushAck(id: id, applied: false))
                host.send(.externalUpdate(content: latest, syncVersion: guardState.bumpVersion()))
                resolve?(nil)
            case .staleSeq:
                host.send(.flushAck(id: id, applied: false))
                resolve?(nil)
            }
        case let .viewState(json):
            Prefs.viewStateJSON = json
        case let .openUrl(url):
            if let u = URL(string: url) { NSWorkspace.shared.open(u) }
        case let .clipboardWrite(format, data):
            let pb = NSPasteboard.general
            pb.clearContents()
            if format == "html" {
                pb.setString(data, forType: .html)
            } else {
                pb.setString(data, forType: .string)
            }
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
        case let .uploadImage(id):
            host.send(.imageUploadError(id: id, error: "Images are not supported in Jot yet."))
        case let .perfMarks(json):
            measure.receivedPerfMarks(json)
        case let .other(type):
            measure.trace("message ignored: \(type)")
        }
    }

    // MARK: persistence

    private func readActiveFile() -> String {
        (try? String(contentsOf: Prefs.activeURL, encoding: .utf8)) ?? ""
    }

    /// Ask the page for its freshest bytes, write them, then run `then`.
    /// Bounded: on timeout the latest admitted content is written instead
    /// (at most one scheduler window stale, see webview/syncScheduler.ts).
    private func flushThen(_ then: @escaping () -> Void) {
        guard state == .warm else {
            writer.submit(latest, to: Prefs.activeURL)
            writer.drain()
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
            self.writer.submit(self.latest, to: Prefs.activeURL)
            self.writer.drain()
            finish()
        }
    }

    func prepareToTerminate(_ done: @escaping () -> Void) {
        hotkey.unregister()
        flushThen(done)
    }

    /// Last-chance synchronous write, idempotent after `prepareToTerminate`.
    func finalWrite() {
        writer.submit(latest, to: Prefs.activeURL)
        writer.drain()
    }

    // MARK: Save As / reopen

    func saveAs() {
        NSApp.activate(ignoringOtherApps: true)
        flushThen { [weak self] in
            guard let self else { return }
            let panel = NSSavePanel()
            panel.title = "Save Jot As"
            panel.nameFieldStringValue = Coordinator.suggestedFileName(for: self.latest)
            panel.allowedContentTypes = [.init(filenameExtension: "md") ?? .plainText]
            panel.directoryURL = Prefs.saveAsDirectory
                ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            panel.canCreateDirectories = true
            let content = self.latest
            let respond: (NSApplication.ModalResponse) -> Void = { [weak self] resp in
                guard resp == .OK, let url = panel.url, let self else { return }
                do {
                    try AtomicFile.writeString(content, to: url)
                } catch {
                    NSAlert(error: error).runModal()
                    return
                }
                Prefs.saveAsDirectory = url.deletingLastPathComponent()
                self.undoSlot = (url, content)
                self.replaceBuffer(with: "")
            }
            if self.panel.isVisible {
                panel.beginSheetModal(for: self.panel, completionHandler: respond)
            } else {
                respond(panel.runModal())
            }
        }
    }

    func reopenLastSaved() {
        guard let slot = undoSlot else { return }
        undoSlot = nil
        replaceBuffer(with: slot.content)
        show()
    }

    /// Put `content` in the editor and the file, keeping the mounted editor
    /// (an `externalUpdate` is a cursor-preserving diff, and it re-baselines
    /// without echoing an `update`, so the write here is the only one).
    private func replaceBuffer(with content: String) {
        latest = content
        writer.submit(content, to: Prefs.activeURL)
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
        f.dateFormat = "yyyy-MM-dd HH.mm"
        return "Jot \(f.string(from: Date())).md"
    }

    // MARK: preferences

    func preferencesChanged() {
        hotkey.register(Prefs.hotkey)
        // A changed file, document or network setting means a fresh page:
        // flush the current buffer to where it belongs, then reload against
        // the new prefs. Cheap, and it keeps one code path.
        flushThen { [weak self] in
            guard let self else { return }
            self.loadPage()
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
