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
/// will-save participant, then write.
///
/// Chute model (MAR-379): the scratchpad is a chute, not an archive. Copy and
/// Delete and Save are siblings because they answer one question, "this note is
/// finished, get it out of here", and differ only in where the bytes go. Both
/// empty the buffer, both leave what they took in `undoSlot`, and neither is
/// allowed to empty a bound DOCUMENT (`ChuteDecision`).
///
/// State machine for the web view: `cold` (nothing loaded, or the content
/// process died) → `loading` (page requested, `ready` not yet seen) → `warm`
/// (`init` sent, editor mounted). Summoning in any state shows the panel; the
/// editor appears when it is ready.
@MainActor
final class Coordinator {
    enum State { case cold, loading, warm }

    /// What one chute action took, so the next gesture can put it back. One
    /// deep, in memory only: a chute that keeps copies on disk of everything it
    /// was told to delete is not a chute. What makes the loss survivable is
    /// that Copy and Delete puts the note on the CLIPBOARD on its way out, and
    /// Save writes it to `savedTo` first.
    struct UndoSlot {
        let content: String
        /// The file the note was saved to, or nil when it was only copied.
        let savedTo: URL?
    }

    let hotkey: GlobalHotkey
    private let panel = JotPanel()
    private let contentView = AppearanceObservingView()
    private let actionBar = ActionBar()
    private let host: WebHost
    private let writer: CoalescingWriter
    private var guardState = SyncGuard()
    private var state: State = .cold
    /// The newest buffer content the host has seen or written.
    private var latest = "" {
        didSet { if latest.isBlank != oldValue.isBlank { refreshActionBar() } }
    }
    /// What the last chute action took, for "Reopen Last Saved" / "Restore
    /// Deleted Note". Read when the overflow menu is built, which is why
    /// nothing observes it.
    private var undoSlot: UndoSlot?
    /// The file the last Save wrote, for "Reveal Last Save in Finder".
    private(set) var lastSavedURL: URL?
    /// Built by the app delegate on each click, so the items match the state
    /// the buffer is in right now rather than a state a callback last reported.
    /// Handed the view the menu is opening from, which the sharing picker needs.
    var makeOverflowMenu: ((NSView) -> NSMenu)?
    private var pendingFlushes: [String: (String?) -> Void] = [:]
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
    private var boundURL: URL = Prefs.activeURL
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
        contentView.addSubview(actionBar)
        host.webView.translatesAutoresizingMaskIntoConstraints = false
        actionBar.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            host.webView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            host.webView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            host.webView.topAnchor.constraint(equalTo: contentView.topAnchor),
            host.webView.bottomAnchor.constraint(equalTo: actionBar.topAnchor),
            actionBar.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            actionBar.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            actionBar.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
        ])
        actionBar.onChute = { [weak self] in self?.copyAndDelete() }
        actionBar.onSave = { [weak self] in self?.saveToDefaultDestination() }
        actionBar.onOverflow = { [weak self] view in self?.showOverflowMenu(from: view) }
        contentView.onHoverChange = { [weak self] hovering in self?.applyChromeVisibility(hovering) }
        refreshActionBar()
        refreshPathLabel()
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
        panel.orderOut(nil)
        if let prev = previousApp, prev.isTerminated == false {
            prev.activate()
        } else {
            NSApp.hide(nil)
        }
        previousApp = nil
        flushThen {}
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
                reloadFromDisk = false
                hasLoaded = true
            }
            host.send(.initDoc(content: latest, syncVersion: guardState.version, viewStateJSON: Prefs.viewStateJSON))
            state = .warm
            // A fresh page starts with its chrome shown; tell it where the
            // pointer is, and say which file it is now bound to.
            refreshPathLabel()
            host.setChromeResting(!contentView.isHovering)
            if panel.isVisible { host.focusEditor() }
        case let .update(content, base, seq):
            switch guardState.judge(baseSyncVersion: base, seq: seq) {
            case .admit:
                latest = content
                writer.submit(content, to: boundURL)
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
                writer.submit(content, to: boundURL)
                writer.drain()
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
        case let .clipboardWrite(format, data):
            writeToPasteboard(data, asHTML: format == "html")
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
        flushThen(done)
    }

    /// Last-chance synchronous write, idempotent after `prepareToTerminate`.
    func finalWrite() {
        writeLatest()
    }

    /// Write `latest` to the bound file, synchronously. Nothing is written
    /// before the file has been read once (`hasLoaded`): before the first
    /// `ready`, or forever when the web assets are missing, `latest` is the
    /// empty string and writing it would truncate the user's scratchpad.
    private func writeLatest() {
        guard hasLoaded else { return }
        writer.submit(latest, to: boundURL)
        writer.drain()
    }

    // MARK: the chute

    /// Whether the buffer holds anything worth copying or saving.
    var hasContent: Bool { !latest.isBlank }

    /// Whether a chute action may empty the buffer, or is only a copy. False
    /// when Preferences have Jot editing a document instead of the scratchpad.
    var chuteEmptiesBuffer: Bool {
        ChuteDecision.outcome(boundURL: boundURL, scratchpadURL: Prefs.scratchpadURL) == .emptyBuffer
    }

    /// The primary action's name, which is the honest one for what it does:
    /// on a bound document there is nothing to delete.
    var chuteActionTitle: String { chuteEmptiesBuffer ? "Copy and Delete" : "Copy" }

    /// The title of the restore action, or nil when there is nothing to
    /// restore. Two names because the note is in two different places: a saved
    /// note is still in its file, a deleted one is only on the clipboard.
    var restoreActionTitle: String? {
        guard let slot = undoSlot else { return nil }
        return slot.savedTo == nil ? "Restore Deleted Note" : "Reopen Last Saved"
    }

    /// The chute's terminal action: the note goes to the clipboard, the buffer
    /// is emptied, and the panel gets out of the way, because the paste is
    /// happening in the app the user came from and they should not have to
    /// dismiss anything first.
    func copyAndDelete() {
        withFlushedContent { [weak self] content in
            guard let self else { return }
            self.writeToPasteboard(content)
            if self.chuteEmptiesBuffer {
                self.undoSlot = UndoSlot(content: content, savedTo: nil)
                self.replaceBuffer(with: "")
            }
            self.hide()
        }
    }

    /// Copy without emptying: the same bytes, for when the note is not finished.
    func copyEverything() {
        withFlushedContent { [weak self] content in
            guard let self else { return }
            self.writeToPasteboard(content)
            self.actionBar.flash("Copied the whole note.")
            self.focusEditorIfVisible()
        }
    }

    /// Empty the buffer without copying. Only offered where the chute may empty
    /// (never on a bound document), and undone from the same slot as the rest.
    func discard() {
        withFlushedContent { [weak self] content in
            guard let self, self.chuteEmptiesBuffer else { return }
            self.undoSlot = UndoSlot(content: content, savedTo: nil)
            self.replaceBuffer(with: "")
            self.actionBar.flash("Deleted. Restore it from the ··· menu.")
            self.focusEditorIfVisible()
        }
    }

    /// Save with no panel, to the destination Preferences names.
    func saveToDefaultDestination() { saveNote(into: Prefs.saveDirectory) }

    /// Save with no panel, to a folder the user has saved to before.
    func saveNote(into directory: URL) {
        withFlushedContent { [weak self] content in
            guard let self else { return }
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let target = DestinationName.unique(Coordinator.suggestedFileName(for: content), in: directory)
                try AtomicFile.writeString(content, to: target)
                self.finishSave(to: target, content: content)
            } catch {
                // The likely failure is consent rather than a bug: macOS gates
                // Documents, Desktop and Downloads behind a per-app grant, and
                // choosing the file in a save panel is how a user gives one. So
                // fall through to the panel instead of reporting a dead end.
                NSLog("Birta Jot: save into \(directory.path) failed: \(error)")
                self.actionBar.flash("Could not write to \(directory.lastPathComponent). Choose where to save.")
                self.saveAs()
            }
        }
    }

    /// Put the note on the clipboard as plain Markdown text.
    ///
    /// Markdown, not rich text: it is what the editor's own bytes are, it
    /// pastes into everything, and the destinations that understand Markdown
    /// (an issue tracker, a chat box, another editor) render it. Copying the
    /// whole document as rich text needs a whole-document command in the page,
    /// which belongs in `webview/` where both surfaces get it.
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

    /// Everything that follows a written file, whichever action wrote it.
    private func finishSave(to target: URL, content: String) {
        lastSavedURL = target
        var recents = Prefs.recentDestinations
        recents.remember(target.deletingLastPathComponent())
        Prefs.recentDestinations = recents
        // Whether the scratchpad graduates is decided in
        // BirtaJotCore.SaveAsDecision, which has the tests: every branch of it
        // can lose bytes when it is decided wrongly.
        if SaveAsDecision.outcome(boundURL: boundURL, scratchpadURL: Prefs.scratchpadURL, target: target) == .graduate {
            undoSlot = UndoSlot(content: content, savedTo: target)
            replaceBuffer(with: "")
        }
        actionBar.flash("Saved to \(target.lastPathComponent).")
        focusEditorIfVisible()
    }

    func revealLastSave() {
        guard let url = lastSavedURL else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    /// Hand the note to whatever the system can send it to. The macOS answer to
    /// "pipe it elsewhere" without integrating with anything in particular.
    func shareNote(from view: NSView) {
        withFlushedContent { content in
            let picker = NSSharingServicePicker(items: [content])
            picker.show(relativeTo: view.bounds, of: view, preferredEdge: .maxY)
        }
    }

    private func showOverflowMenu(from view: NSView) {
        guard let menu = makeOverflowMenu?(view) else { return }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: view.bounds.maxY), in: view)
    }

    private func refreshActionBar() {
        actionBar.update(chuteTitle: chuteActionTitle, hasContent: hasContent)
    }

    /// The bound file, written the way a person reads a path.
    private func refreshPathLabel() {
        actionBar.setRestingText(boundURL.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
    }

    /// Chrome follows the pointer: everything on while it is over the window,
    /// and a page with a caret in it when it is not. The page's half is a body
    /// class its own stylesheet reads.
    private func applyChromeVisibility(_ hovering: Bool) {
        actionBar.setChromeVisible(hovering)
        host.setChromeResting(!hovering)
    }

    private func focusEditorIfVisible() {
        guard panel.isVisible else { return }
        panel.makeFirstResponder(host.webView)
        if state == .warm { host.focusEditor() }
    }

    // MARK: Save As / restore

    func saveAs() {
        NSApp.activate(ignoringOtherApps: true)
        flushThen { [weak self] in
            guard let self else { return }
            let panel = NSSavePanel()
            panel.title = "Save Jot As"
            panel.nameFieldStringValue = Coordinator.suggestedFileName(for: self.latest)
            panel.allowedContentTypes = [.init(filenameExtension: "md") ?? .plainText]
            panel.directoryURL = Prefs.saveAsDirectory ?? Prefs.saveDirectory
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

    /// Put back what the last chute action took.
    ///
    /// Restoring into a buffer the user has since typed into puts the note back
    /// ABOVE what is there, rather than replacing it. Either note is somebody's
    /// work, and there is no reading of "restore" under which one of them is
    /// meant to disappear.
    func restoreLastNote() {
        guard let slot = undoSlot else { return }
        undoSlot = nil
        if latest.isBlank {
            replaceBuffer(with: slot.content)
        } else {
            replaceBuffer(with: slot.content + "\n\n" + latest)
            actionBar.flash("Restored above what you had typed.")
        }
        show()
    }

    /// Put `content` in the editor and the file, keeping the mounted editor
    /// (an `externalUpdate` is a cursor-preserving diff, and it re-baselines
    /// without echoing an `update`, so the write here is the only one).
    private func replaceBuffer(with content: String) {
        latest = content
        writer.submit(content, to: boundURL)
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
            // The bound file may have changed, and with it whether the chute
            // may empty the buffer at all.
            self.refreshActionBar()
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
