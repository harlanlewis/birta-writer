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
    /// Numbers `/ai-advanced` attachments so two files of one name in a single
    /// request do not overwrite each other. Main thread only.
    private var agentAttachmentSeq = 0
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
    /// Per run, the file holding the agent's own version while the page's
    /// merge decides whether the document ended up with all of it.
    private var agentRescues: [String: URL] = [:]
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
    /// True while the bound file is THERE and could not be read: evicted by
    /// iCloud, not downloaded yet, or otherwise unavailable. Distinct from
    /// `!hasLoaded`, which is also true during an ordinary cold start, so the
    /// two must not be conflated: the retry on summon keys off this one, and
    /// keying it off `hasLoaded` announced an arrival on every first launch.
    private var noteUnreadable = false
    /// The first-run screen, built the first time it is needed and kept, so
    /// re-showing it from Settings does not lose what the switches are showing.
    private var welcome: WelcomeView?

    private let watcher = NoteWatcher()
    private let missingFileBar = MissingFileBar()
    /// Whether this path has ever been observed to hold the note.
    ///
    /// Read alongside a live `fileExists` to tell a DELETION from a note that
    /// has never been written. Set by a successful read and by a successful
    /// write; cleared with the binding, since it is a fact about one path.
    private var everSeenOnDisk = false

    /// The bound file is gone, so nothing may be written to its path.
    ///
    /// Blocks `writeLatest` the way `hasLoaded` blocks it for a note that is
    /// present but unreadable, and for the same reason: a write here does not
    /// fail, it RECREATES. `AtomicFile.write` makes the file and its whole
    /// directory, so without this an autosave tick a second after a Finder
    /// delete puts the note back and the warning never appears. The READ side
    /// is guarded too, in `adopt` and `reloadFromDiskIntoBuffer`: with the
    /// file gone the buffer is the only copy, and a read would replace it.
    private var noteMissing = false {
        didSet {
            guard noteMissing != oldValue else { return }
            missingFileBar.show(noteMissing, name: boundURL.lastPathComponent)
            layoutMissingFileBar()
        }
    }

    /// The file the buffer's bytes belong to.
    ///
    /// A Preferences change that points at another file first flushes to THIS
    /// one, then rebinds, so a scratchpad is never written over the document
    /// the user just chose to open. Its folder is also what the page may read
    /// images from, so the two move together by construction rather than by
    /// two call sites remembering to.
    private var boundURL: URL = Prefs.activeURL {
        didSet {
            guard boundURL != oldValue else { return }
            host.schemeHandler.roots =
                host.schemeHandler.roots.rebound(toDocument: boundURL.deletingLastPathComponent())
            refreshTitle()
            // The watcher follows the binding, or it goes on reporting moves
            // of a file the panel is no longer editing and misses the one it
            // is. `noteMovedOnDisk` rebinds and re-watches in one step, so it
            // is the one caller this must not fire for twice.
            startWatching()
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
            NSLog("Birta Writer: write failed: \(error)")
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
        // Above the web view for the same reason the drag strip is, and laid
        // out by frame for the same reason: it spans the window's own bottom
        // edge and the page knows nothing about it.
        contentView.addSubview(missingFileBar)
        missingFileBar.onSaveItBack = { [weak self] in self?.saveMissingNoteBack() }
        missingFileBar.onDiscardAndStartNew = { [weak self] in
            // Clearing the flag first is what lets the new note be created and
            // written at all; the bytes of the old one are what the button
            // says it is discarding.
            self?.noteMissing = false
            self?.newNote()
        }
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
        watcher.onMoved = { [weak self] url in self?.noteMovedOnDisk(to: url) }
        watcher.onDeleted = { [weak self] in self?.noteDeletedOnDisk() }
        startWatching()
        contentView.onLayout = { [weak self] in
            MainActor.assumeIsolated {
                self?.layoutTitlebarDrag()
                self?.layoutMissingFileBar()
            }
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
            NSLog("Birta Writer: hotkey \(Prefs.hotkey.spelling) registration failed (\(status)); another app may own it")
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
            // The window's WIDTH, which is the axis the title's ceiling lives
            // on and the one no other probe here varies. A script cannot drag
            // a window edge (that needs a pointer), and a fresh launch at a
            // width would measure placement rather than the resize path, so
            // the frame is set here and the two titlebar traces are taken
            // again against it.
            if obj["type"] as? String == "__jotResize", let width = obj["width"] as? NSNumber {
                measure.mark("debug-resize")
                var frame = panel.frame
                frame.size.width = CGFloat(width.doubleValue)
                panel.setFrame(frame, display: true)
                // The refit is `contentView.onLayout`'s, so the traces below
                // have to be taken after that pass has actually run rather
                // than after the frame was merely asked to change.
                contentView.layoutSubtreeIfNeeded()
                traceTitleBar()
                traceTitlebarDrag()
                return
            }
            // A PNG of the panel's content, written beside the scratchpad.
            //
            // Rendered by the view itself rather than captured off the screen:
            // `screencapture` needs a Screen Recording grant this repository's
            // checks do not have, and a shell that lacks it fails with a
            // message about a rectangle rather than about permission. This
            // asks the view hierarchy to draw itself, which needs nothing and
            // cannot pick up a window that happens to be in front.
            if obj["type"] as? String == "__jotSnapshot" {
                measure.mark("debug-snapshot")
                writeSnapshot(named: obj["name"] as? String ?? "snapshot")
                return
            }
            // Reload the page against the current settings, as a settings
            // change does. The one gesture that re-reads the note without
            // rebinding, and therefore the only way a script can reach the
            // state where a refused read could downgrade `hasLoaded`.
            if obj["type"] as? String == "__jotReload" {
                measure.mark("debug-reload")
                preferencesChanged()
                return
            }
            // An explicit save, exactly as Cmd+S makes one.
            //
            // Here because the other ways to provoke a write from a script are
            // both indirect: a panel toggle is a toggle rather than a
            // direction, so a hide can show instead and no write happens at
            // all, and autosave needs a document change and a wait. A check
            // that meant to watch a write and silently watched nothing is the
            // failure this exists to remove.
            if obj["type"] as? String == "__jotSaveNow" {
                measure.mark("debug-save-now")
                flushThen { [weak self] in self?.write(.explicitSave) }
                return
            }
            // The missing-note bar's Save It Back button, without the button.
            // It is native chrome that only appears once the bound file has
            // gone, so a script can reach the state and not the control.
            if obj["type"] as? String == "__jotSaveMissingBack" {
                measure.mark("debug-save-missing-back")
                saveMissingNoteBack()
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
        NSLog("Birta Writer: web content process terminated; remounting")
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
        // Taken before anything else on this path, and run at the end, so a
        // handler that summons or hides cannot re-enter its own slot.
        let held = onNextShow
        onNextShow = nil
        defer { held?() }
        if let front = NSWorkspace.shared.frontmostApplication, front != .current {
            previousApp = front
        }
        panel.placeIfUnplaced()
        if panel.isMiniaturized { panel.deminiaturize(nil) }
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        // The first-run screen owns the keyboard while it is up. A hidden view
        // is out of hit testing, so the mouse is already walled off, and
        // `makeFirstResponder` does not refuse a hidden view: without this the
        // editor behind the screen would take every keystroke and autosave
        // would write them.
        if isWelcoming {
            panel.makeFirstResponder(welcome)
        } else {
            panel.makeFirstResponder(host.webView)
            if state == .warm { host.focusEditor() }
        }
        if state == .cold { loadPage() }
        // A note that was there and unreadable when we last looked leaves the
        // panel unwritable, and nothing else would ever look again: the only
        // other reader runs after an agent run, and the download this is
        // waiting on finishes on iCloud's schedule rather than on ours. Being
        // summoned is the natural moment to ask again, and it is bounded by
        // the user doing it.
        if noteUnreadable { retryUnreadableNote() }
        // Summoned under a pointer that never moved: no enter event fires, so
        // the window has to ask where the pointer is.
        contentView.syncHoverFromPointer()
        measure.mark("visible")
        traceTitleBar()
        // Asked again on every summon, because the page can have remounted
        // since (a content-process death reloads it) and the answer is the
        // page's. The first answer comes earlier, on `.ready`, so nothing that
        // depends on it is drawn against a width of zero.
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
                // While the note is missing, rebind only for a setting the
                // user actually changed.
                //
                // `Prefs.activeURL` re-derives the binding through accessors
                // that filter on existence, so a deleted New Note falls back
                // to the scratchpad on its own: the binding changes,
                // `startWatching` clears `noteMissing`, and the read that
                // follows lands another file's contents on the only copy of
                // the deleted one, past the guard in `adopt`, which by then
                // has nothing to see. `storedActiveURL` reads the same
                // settings without that filter, so it moves when somebody
                // moves it and not when a file disappears.
                //
                // The buffer is rescued before a deliberate rebind, because it
                // is still the only copy of a note nobody has answered for.
                if !noteMissing {
                    boundURL = Prefs.activeURL
                } else if Prefs.storedActiveURL.standardizedFileURL != boundURL.standardizedFileURL {
                    rescueMissingNote()
                    boundURL = Prefs.activeURL
                }
                // The disk is the truth on this arm, so nothing is unwritten
                // (`adopt` clears `isEdited`). The other arm keeps it: after a
                // content-process death `latest` can be ahead of the file, and
                // saying it is not would be the one lie this flag must never
                // tell.
                //
                // `hasLoaded` is set only when the read actually produced the
                // note. A file that is there and unreadable leaves it false,
                // so `writeLatest` refuses and the note is never truncated.
                reloadFromDisk = false
                hasLoaded = adopt(readActiveNote())
            }
            host.send(.initDoc(content: latest, syncVersion: guardState.version, viewStateJSON: Prefs.viewStateJSON))
            state = .warm
            // A fresh page starts with its chrome shown; tell it where the
            // pointer is, and say which file it is now bound to.
            refreshTitle()
            // Ask for the width the title's ceiling is computed against as
            // soon as there is a page to ask, rather than waiting for the
            // first summon. Until it answers, the width reads 0, which the
            // arithmetic cannot tell from a page with no controls at all, and
            // a long name would take the whole band for the round trip and
            // then pull back. Prewarm mounts the page before the panel is ever
            // shown, so on that path the answer is in hand first.
            refreshTitlebarControlsWidth()
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
        case let .agentMergeResult(requestId, outcome):
            settleAgentRescue(requestId: requestId, outcome: outcome)
        case let .agentCancel(requestId):
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
            NSLog("Birta Writer: webview crash (\(source)): \(message)")
        case let .uploadImage(id, data, mimeType, _):
            saveAttachment(id: id, data: data, mimeType: mimeType)
        case let .agentAttachment(id, name, bytes):
            saveAgentAttachment(id: id, name: name, bytes: bytes)
        case let .showDatePicker(id, left, top, bottom):
            showDatePicker(id: id, left: left, top: top, bottom: bottom)
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
            host.send(.imageUploadError(id: id, error: "Birta Writer cannot save a \(type) image."))
        } catch {
            NSLog("Birta Writer: attachment save failed: \(error)")
            host.send(.imageUploadError(id: id, error: "The image could not be saved beside this document."))
        }
    }

    /// Write one `/ai-advanced` attachment somewhere the agent can read it and
    /// tell the page where it went.
    ///
    /// Always answers, including on failure, and that is the point rather than
    /// defensiveness: the composer disables Send while an attachment is
    /// unresolved, so a request with no reply leaves the panel unable to send
    /// anything at all, the typed prompt included. A null path is a real
    /// answer, and it is what marks the chip failed and frees the button.
    ///
    /// The counter is read and bumped HERE, on the main thread where every
    /// message is handled, and the write is what goes to a background queue.
    /// Two files of the same name in one request would otherwise race for the
    /// same number and one would overwrite the other.
    private func saveAgentAttachment(id: String, name: String, bytes: Data) {
        agentAttachmentSeq += 1
        let sequence = agentAttachmentSeq
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var path: String?
            do {
                try AgentAttachment.check(byteCount: bytes.count)
                let directory = AgentAttachment.directory(
                    temporaryDirectory: URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true),
                    processID: ProcessInfo.processInfo.processIdentifier)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let target = AgentAttachment.destination(in: directory, sequence: sequence, name: name)
                try bytes.write(to: target, options: .atomic)
                path = target.path
            } catch {
                NSLog("Birta Writer: agent attachment save failed: \(error)")
                path = nil
            }
            let resolved = path
            DispatchQueue.main.async {
                self?.host.send(.agentAttachmentSaved(id: id, path: resolved))
            }
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
        NSLog("Birta Writer: \(failed.count) attachment(s) could not be copied: \(failed.joined(separator: ", "))")
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

    /// Read the bound file, keeping "there is no note" apart from "the note is
    /// there and I could not read it" (`BirtaJotCore.NoteRead`).
    ///
    /// The second case only became reachable when the note could live in
    /// iCloud Drive, and it is the dangerous one: treated as an empty note it
    /// mounts an empty buffer, and the next write puts that buffer where the
    /// note was. `hasLoaded` is the guard that already exists to stop exactly
    /// that, and the caller leaves it false here rather than a new mechanism
    /// being invented for it.
    ///
    /// Asks iCloud for the file on the way past, so the state resolves itself
    /// rather than needing the user to know what to do about it.
    private func readActiveNote() -> NoteRead {
        let result = NoteRead.read(at: boundURL)
        if case .unreadable(.notDownloaded) = result {
            try? FileManager.default.startDownloadingUbiquitousItem(at: boundURL)
        }
        return result
    }

    /// Ask again for a note that was present and unreadable, and put it in the
    /// panel if it has arrived.
    ///
    /// Gated on `noteUnreadable` and NOT on `hasLoaded`, which is the trap
    /// here: `hasLoaded` is also false during an ordinary cold start, before
    /// the first read has happened at all, so keying off it fired this on
    /// every first launch and announced that a note had arrived from iCloud
    /// when nothing had been waiting on. The flag says we actually saw a note
    /// we could not read, which is the only state worth retrying.
    ///
    /// A successful read lifts the write embargo, so the panel stops
    /// discarding what is typed into it.
    private func retryUnreadableNote() {
        let read = readActiveNote()
        guard case .contents(let text) = read else { return }
        noteUnreadable = false
        hasLoaded = true
        latest = text
        isEdited = false
        if state == .warm {
            host.send(.externalUpdate(content: text, syncVersion: guardState.bumpVersion()))
        }
        statusOverlay.flash("This note has arrived. Saving is on again.")
    }

    /// Take a read into the buffer, answering whether the buffer may be
    /// WRITTEN afterwards. The caller ASSIGNS `hasLoaded` from this, so a
    /// refusal is a downgrade rather than a hold: the missing-note arm returns
    /// the flag unchanged for that reason, since the note was readable before
    /// it was deleted and the panel must still be writable once the user
    /// answers the bar. The unreadable arm does return false, and means it.
    private func adopt(_ read: NoteRead) -> Bool {
        // Not for a read this refuses: a buffer that was not replaced still
        // holds bytes the file does not, which is what the flag means.
        if case .absent = read, noteMissing {} else { isEdited = false }
        switch read {
        case .contents(let text):
            noteUnreadable = false
            latest = text
            // The file was there and had the note in it, which is what makes a
            // later disappearance a deletion rather than a first write.
            everSeenOnDisk = true
            return true
        case .absent:
            noteUnreadable = false
            // A note that is missing BECAUSE it was deleted is not the same as
            // one that has never been written, even though the disk cannot
            // tell them apart. In the first case the buffer is the only copy
            // of those bytes, and taking this read would replace it with
            // nothing: the panel would go blank behind the bar that says
            // nothing has been written, and Save It Back would then write an
            // empty file. `writeLatest` was guarded for this and the read side
            // was not, which left every settings change, every reload and
            // every finished agent run as a way to lose the note.
            if noteMissing { return hasLoaded }
            latest = ""
            return true
        case .unreadable:
            noteUnreadable = true
            // The buffer stays empty and unwritable. Saying so matters: an
            // empty panel over a note that exists is indistinguishable from a
            // new note, and the user would otherwise start typing into it.
            latest = ""
            if let message = read.message { statusOverlay.flash(message) }
            return false
        }
    }

    /// Ask the page for its freshest bytes, then run `then`.
    ///
    /// Bounded: a page that does not answer within `flushTimeout`, and a page
    /// that is not warm enough to be asked, run `then` anyway against the
    /// latest admitted content (at most one scheduler window stale, see
    /// webview/syncScheduler.ts).
    ///
    /// It writes NOTHING itself, and that is the point rather than an
    /// omission. Both fallbacks used to write here as well as in `then`,
    /// which was invisible while every caller wrote too: it was a second copy
    /// of a decision `AutosavePolicy` owns, and with autosave off it meant a
    /// wedged web process turned hiding the panel into a write nobody asked
    /// for. `write(_:)` is the one funnel, and every caller that wants bytes
    /// on disk goes through it in `then`.
    private func flushThen(_ then: @escaping () -> Void) {
        guard state == .warm else {
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
            NSLog("Birta Writer: flush timed out; running against the last admitted content")
            finish()
        }
    }

    /// Whether the quit now in flight has anybody in front of it.
    ///
    /// Set by the two paths that quit the app without a person asking: the
    /// SIGTERM handler, which is how an installer replaces a running copy, and
    /// the self-update swap. Neither has anyone to answer a sheet, and both
    /// have something waiting on the process to go, so a question there is a
    /// hang rather than a choice. Those quits write the buffer instead.
    var quitIsUnattended = false

    /// Set once the way out has been decided, so the last-chance write on the
    /// way through `applicationWillTerminate` does not undo the answer.
    private var quitDecided = false

    /// Everything that has to happen before the app may go, and the one place
    /// a quit can be refused.
    ///
    /// `done(false)` means the user cancelled: the app stays up, and nothing
    /// may have been torn down on the way to asking. That ordering is the
    /// whole shape of this method. The hotkey and the running agents used to
    /// be dropped first, which is invisible while every quit succeeds and is a
    /// summon key that stops working for the rest of the session the first
    /// time somebody presses Cancel.
    func prepareToTerminate(_ done: @escaping (Bool) -> Void) {
        flushThen { [weak self] in
            guard let self else { done(true); return }
            self.decideFinalWrite { answer in
                guard answer != .cancel else {
                    // A refused quit leaves nothing decided. The flag exists
                    // so the last-chance write on the way out does not undo an
                    // answer, and a `true` left over from a quit that never
                    // happened would suppress the write on a later one.
                    self.quitDecided = false
                    done(false)
                    return
                }
                self.hotkey.unregister()
                // A child process outliving the app is litter nobody can
                // attribute.
                self.agent.stopAll()
                // Not for a buffer somebody has just said to throw away: this
                // writes it beside the deleted file, which is the opposite of
                // the answer they gave.
                if answer != .discard { self.rescueMissingNote() }
                done(true)
            }
        }
    }

    /// Decide what happens to the buffer on the way out, asking if the setting
    /// says to ask and there is somebody there to answer.
    private func decideFinalWrite(_ then: @escaping (UnsavedChanges.Answer) -> Void) {
        let keep: (UnsavedChanges.Answer) -> Void = { [weak self] answer in
            self?.quitDecided = true
            then(answer)
        }
        switch AutosavePolicy.action(for: .terminating, autosaveEnabled: Prefs.autosave) {
        case .now, .deferred, .skip:
            cancelPendingAutosave()
            writeLatest()
            keep(.save)
        case .ask:
            cancelPendingAutosave()
            // Nothing to ask about: the file already has these bytes, so
            // there is nothing to write and nothing to throw away either.
            // NOT reported as a discard, which is what the caller reads to
            // decide whether to rescue a note that was deleted underneath us:
            // a buffer nobody edited is still the only copy of one of those.
            guard isEdited else { keep(.save); return }
            guard !quitIsUnattended else {
                writeLatest()
                keep(.save)
                return
            }
            // Show what is about to be lost. The panel is hidden most of the
            // time, and a sheet needs a window on screen; summoning it is also
            // the honest thing to do, since the question names a document the
            // person cannot otherwise see.
            if !isOnScreen { show() }
            // And if it still is not up, keep the bytes rather than asking a
            // window that cannot answer. A sheet begun on a window that never
            // appears never calls back, and this quit is waiting on that call
            // (`applicationShouldTerminate` answered `.terminateLater`), so
            // the failure would be an app that cannot be quit.
            guard promptWindow.isVisible else {
                writeLatest()
                keep(.save)
                return
            }
            UnsavedChangesPrompt.present(document: boundURL.lastPathComponent,
                                         on: promptWindow) { [weak self] answer in
                guard let self else { keep(answer); return }
                if answer == .save { self.writeLatest() }
                keep(answer)
            }
        }
    }

    /// Put the buffer somewhere before the app goes away, when its own file is
    /// gone and every write is being refused.
    ///
    /// Quitting is the end of the only copy those bytes have. The bar offers
    /// Save It Back, and taking that offer needs somebody to be looking at it:
    /// a deletion is noticed whether or not the panel is visible, so this
    /// state can be reached without the bar ever having been on screen.
    ///
    /// Written BESIDE the deleted file under a name of its own, never back to
    /// the deleted path. Recreating a file the user threw away is what this
    /// whole path exists to stop, and doing it at quit, unattended, would be
    /// the worst moment to start.
    private func rescueMissingNote() {
        guard noteMissing, !latest.isBlank else { return }
        let directory = boundURL.deletingLastPathComponent()
        let stem = boundURL.deletingPathExtension().lastPathComponent
        let ext = boundURL.pathExtension.isEmpty ? "md" : boundURL.pathExtension
        let target = Coordinator.unusedURL(in: directory, stem: "\(stem) (recovered)", extension: ext)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try AtomicFile.writeString(latest, to: target)
            NSLog("Birta Writer: the deleted note's unwritten text is in \(target.path)")
        } catch {
            NSLog("Birta Writer: could not rescue the deleted note: \(error)")
        }
    }

    /// Last-chance synchronous write, idempotent after `prepareToTerminate`.
    func finalWrite() {
        // What happens to the buffer was settled in `prepareToTerminate`,
        // possibly by the user. Asking the policy again here would write a
        // buffer they have just said to discard, at the one moment nothing is
        // left to undo it.
        guard !quitDecided else { return }
        write(.terminating)
    }

    /// Write `latest` to the bound file, synchronously. Nothing is written
    /// before the file has been read once (`hasLoaded`): before the first
    /// `ready`, or forever when the web assets are missing, `latest` is the
    /// empty string and writing it would truncate the user's scratchpad.
    private func writeLatest() {
        // `noteMissing` alongside `hasLoaded`, and both are about the same
        // thing: a path this write would create rather than update.
        // Every attempt, with the four facts that decide it, for
        // `jot/scripts/measure.sh`. A check about writing needs to know a
        // write was ATTEMPTED: "the file is still absent" is satisfied just as
        // well by a guard that refused and by a path that was never reached,
        // and only one of those is the behaviour being claimed.
        if measure.enabled {
            measure.trace("writeattempt hasLoaded=\(hasLoaded) missing=\(noteMissing) seen=\(everSeenOnDisk) exists=\(FileManager.default.fileExists(atPath: boundURL.path)) at=\(boundURL.lastPathComponent)")
        }
        // Nothing is written while the first-run screen is up. Two reasons,
        // and the second is the one that bites: there is nothing to write,
        // since the editor is not reachable; and `AtomicFile.write` creates
        // the file AND every directory above it, so a write here would build
        // the folder for a location the screen is still asking about. Toggling
        // the iCloud switch would leave an empty note in iCloud Drive and
        // another in Documents.
        guard hasLoaded, !noteMissing, !isWelcoming else { return }
        // A file presenter only hears about COORDINATED changes, which Finder
        // makes and `rm` in a terminal does not, so a delete can reach this
        // point unannounced. `AtomicFile.write` would then recreate the file
        // and its whole directory, silently, which is the behaviour this whole
        // path exists to stop. One `fileExists` per write, and writes already
        // serialize the document and touch the disk.
        //
        // `everSeenOnDisk` is what separates a deletion from a note that has
        // simply never been written: a fresh scratchpad legitimately does not
        // exist yet, and `NoteRead.absent` is treated as an empty note on
        // purpose.
        if everSeenOnDisk, !FileManager.default.fileExists(atPath: boundURL.path) {
            noteDeletedOnDisk()
            return
        }
        writer.submit(latest, to: boundURL)
        writer.drain()
        everSeenOnDisk = true
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
        case .ask:
            // Nobody is being asked on this path, and the policy says what
            // that means: the question exists to protect the bytes, so where
            // it cannot be put, the bytes are kept. The only trigger that
            // reaches `.ask` is a quit, and `prepareToTerminate` asks properly
            // before this is ever reached; what lands here is the quit that
            // did not go through it, which is a quit nobody initiated.
            cancelPendingAutosave()
            writeLatest()
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
            // The bytes the agent opens, and the file they belong to. A
            // finished run compares against both: the bytes to tell its own
            // edit from one typed into the panel while it ran, the file
            // because Settings can rebind the panel to another one meanwhile.
            let handoff = self.latest
            let handoffURL = self.boundURL
            let directory = self.boundURL.deletingLastPathComponent()
            let reference = "\(self.boundURL.lastPathComponent)#L1"
            let line = AgentRequest.compose(prompt: request, reference: reference)
            self.agent.run(requestId: id, line: line, template: command,
                           workingDirectory: directory) { [weak self] status in
                guard let self else { return }
                if status.status == "done" {
                    self.finishAgentRun(requestId: id, status, handoff: handoff, handoffURL: handoffURL)
                } else {
                    self.reportAgent(requestId: id, status)
                }
            }
        }
    }

    /// Land a finished run's edit, by `BirtaJotCore.AgentLandingPolicy`.
    ///
    /// The reload comes BEFORE the report, so the page still has the run live
    /// when the change arrives and takes it into the undo history
    /// (`recordsExternalInHistory`); `settleAgentRun` runs on the report and
    /// would end that.
    private func finishAgentRun(requestId: String, _ status: AgentRunStatus, handoff: String,
                                handoffURL: URL) {
        // The panel moved to another file while the run worked, so the file it
        // edited is not the one on screen. Neither answer below is available:
        // reading it in would replace the note the user switched to, and
        // handing its bytes to the page would merge one document into another.
        guard boundURL == handoffURL else {
            reportAgent(requestId: requestId, status)
            return
        }
        guard !noteMissing, case .contents(let onDisk) = readActiveNote() else {
            // A note that is missing, unreadable, or has never been written:
            // `reloadFromDiskIntoBuffer` holds the judgement for all three,
            // and there is nothing to hand the page either way.
            reloadFromDiskIntoBuffer()
            reportAgent(requestId: requestId, status)
            return
        }
        let landing = AgentLandingPolicy.landing(handoff: handoff, onDisk: onDisk, buffer: latest)
        if landing.reloadsBuffer { reloadFromDiskIntoBuffer() }
        if let diskText = landing.pageText {
            // Written BEFORE the page is told, not after it answers. The page
            // merges, dispatches a transaction, and that restarts the autosave
            // debounce, so the buffer is on its way over the agent's file
            // within half a second. Waiting for `agentMergeResult` to decide
            // whether to keep a copy would be racing that write with an IPC
            // round trip. So the copy is made unconditionally here and removed
            // again when the page reports that nothing was left out.
            rescueAgentVersion(requestId: requestId, text: diskText)
            reportAgent(requestId: requestId, status.merging(diskText))
        } else {
            reportAgent(requestId: requestId, status)
        }
    }

    /// Keep the agent's own version beside the note while the page decides.
    ///
    /// Same answer, and the same spelling, as the rescue for a note deleted
    /// underneath us: a numbered file beside the original, so nothing is ever
    /// overwritten. A failure here is not worth interrupting the run for; what
    /// it costs is the copy, and the run still lands.
    private func rescueAgentVersion(requestId: String, text: String) {
        let directory = boundURL.deletingLastPathComponent()
        let stem = boundURL.deletingPathExtension().lastPathComponent
        let ext = boundURL.pathExtension.isEmpty ? "md" : boundURL.pathExtension
        let target = Coordinator.unusedURL(in: directory, stem: "\(stem) (agent)", extension: ext)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try AtomicFile.writeString(text, to: target)
            agentRescues[requestId] = target
        } catch {
            NSLog("Birta Writer: could not keep the agent's version: \(error)")
        }
    }

    /// The page has said what its merge did, so the copy is either unnecessary
    /// or is the only place the agent's work still exists.
    private func settleAgentRescue(requestId: String, outcome: String) {
        guard let target = agentRescues.removeValue(forKey: requestId) else { return }
        if AgentRescuePolicy.keepsAgentVersion(outcome: outcome) {
            statusOverlay.flash("Some of the agent's changes overlapped yours. Its version is in \(target.lastPathComponent).")
            return
        }
        // Everything it wrote is in the document, so the copy is noise.
        try? FileManager.default.removeItem(at: target)
    }

    private func reportAgent(requestId: String, _ status: AgentRunStatus) {
        guard state == .warm else { return }
        host.send(.agentRun(requestId: requestId, status: status.status,
                            harness: status.harness, text: status.text, message: status.message))
    }

    /// Take what is on disk as the buffer's new truth.
    ///
    /// A file that is present and UNREADABLE is not news: this runs when the
    /// file changed underneath us, and iCloud evicting a note is one of the
    /// ways that happens. Replacing the buffer with an empty string there
    /// would discard what the user has, so that read is ignored and the buffer
    /// stands.
    ///
    /// A file that is absent and NOT known to have been deleted still empties
    /// the buffer: that is a note nobody has written yet. A deletion is the
    /// other case, and the guard below holds the buffer for it.
    private func reloadFromDiskIntoBuffer() {
        // Same rule as `adopt`: a note that is missing because it was deleted
        // must not be read over the buffer holding the only copy of it.
        guard !noteMissing else { return }
        let read = readActiveNote()
        if case .unreadable = read {
            if let message = read.message { statusOverlay.flash(message) }
            return
        }
        let onDisk: String
        if case .contents(let text) = read { onDisk = text } else { onDisk = "" }
        guard onDisk != latest else { return }
        latest = onDisk
        isEdited = false
        if state == .warm {
            host.send(.externalUpdate(content: onDisk, syncVersion: guardState.bumpVersion()))
        }
    }

    /// Leave a document Jot was pointed at, and go back to the notes.
    ///
    /// The `document` slot in `ActiveBinding` outranks the other two, so this
    /// is the only way out of it now that Settings has no switch for it. The
    /// buffer is flushed to the document first: leaving a file is not a reason
    /// to lose what was typed into it.
    func backToNotes() {
        guard Prefs.documentURL != nil else {
            statusOverlay.flash("Birta Writer is already on your notes.")
            return
        }
        flushThen { [weak self] in
            guard let self else { return }
            self.write(.explicitSave)
            Prefs.documentURL = nil
            self.reloadFromDisk = true
            self.loadPage()
            self.refreshTitle()
            self.statusOverlay.flash("Back to your notes.")
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
    /// With ONE exception, and it is the reason the missing-note bar's second
    /// button says Discard rather than New Note: when the bound file has been
    /// deleted there is nowhere to write the buffer to, so the write above is
    /// refused and switching away really does drop those bytes. Nothing else
    /// can reach this state, because every other caller has a file.
    ///
    func newNote() {
        flushThen { [weak self] in
            guard let self else { return }
            self.write(.explicitSave)
            // A bound document is LEFT, not a reason to refuse. This gesture
            // and Back to My Notes beside it are the two ways out of one.
            Prefs.documentURL = nil
            let directory = Prefs.notesDirectory
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            } catch {
                NSLog("Birta Writer: could not create \(directory.path): \(error)")
                self.statusOverlay.flash("Could not make a new note in \(directory.lastPathComponent).")
                return
            }
            let target = Coordinator.unusedNoteURL(in: directory)
            do {
                // Create it now, empty. A note that exists only in memory is
                // one the next launch cannot find its way back to.
                try AtomicFile.writeString("", to: target)
            } catch {
                NSLog("Birta Writer: could not write \(target.path): \(error)")
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
            NSLog("Birta Writer: could not start a blank note in \(directory.path): \(error)")
        }
    }

    /// Point the editor and the file at `url`, with `content` as the truth.
    private func bindTo(_ url: URL, content: String) {
        cancelPendingAutosave()
        boundURL = url
        latest = content
        // The caller has just written this file and is handing back its bytes,
        // so the buffer IS the file. Both read-side embargoes are facts about
        // the path being left, and carrying them across is how a fresh note
        // ends up permanently unwritable: every keystroke refused by
        // `writeLatest`, no bar, nothing said, and the lot gone at quit.
        hasLoaded = true
        noteUnreadable = false
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
            NSLog("Birta Writer: the page did not answer requestEditorContext in time")
            pending(nil)
        }
    }

    /// Show the system date picker at the caret, and report what it returns.
    ///
    /// The page sends the caret rectangle in viewport CSS pixels, and turning
    /// those into the view's own coordinates is `BirtaJotCore.CaretAnchor`'s,
    /// which is testable without a window. `isFlipped` is read off the view
    /// rather than assumed: a `WKWebView` is flipped, so the page's numbers
    /// pass straight through, and a conversion written for AppKit's usual
    /// bottom-left origin would mirror a caret near the top of the panel to
    /// the bottom of it.
    ///
    /// The anchor is relative to the WEB VIEW, never to the window, and that is
    /// worth stating rather than leaving to be inferred: the titlebar here is
    /// transparent, full-size-content, and carries an accessory view, and any
    /// of those could change. None of them can move this popover, because the
    /// coordinates it is given are the page's own and the view it hangs off is
    /// the page's own. A future titlebar arrangement, native window tabbing
    /// included, needs no change here.
    private func showDatePicker(id: String, left: Double, top: Double, bottom: Double) {
        let view = host.webView
        let anchor = CaretAnchor.rect(left: left, top: top, bottom: bottom,
                                      viewHeight: view.bounds.height,
                                      isFlipped: view.isFlipped)
        traceDatePickerAnchor(pageTop: top, anchor: anchor, isFlipped: view.isFlipped)
        let controller = DatePickerPopover()
        controller.show(relativeTo: anchor, of: view, startingAt: CalendarDay(Date())) { [weak self] day in
            // Always answered, a dismissal included: the page holds a pending
            // request against this id and would otherwise wait forever.
            self?.host.send(.datePickerResult(id: id, date: day))
            self?.host.focusEditor()
        }
    }

    /// Say something along the bottom of the panel, from outside.
    ///
    /// The overlay is news rather than state, which is exactly what an update
    /// message is: it says what just happened and goes.
    func flashStatus(_ message: String) {
        statusOverlay.flash(message)
    }

    /// The window an offer about this app should be attached to.
    var promptWindow: NSWindow { panel }

    /// Whether the panel is on screen to be attached to.
    ///
    /// A sheet needs a visible window, and Jot's is hidden most of the time:
    /// it is a menu-bar scratchpad, summoned and dismissed. So this is what
    /// the update offer asks before interrupting, and the answer decides
    /// whether it is shown now or held.
    var isOnScreen: Bool { panel.isVisible && !panel.isMiniaturized }

    /// Whether the buffer is ahead of the file right now.
    var hasUnwrittenBytes: Bool { isEdited }

    /// Something to do the next time the panel is summoned.
    ///
    /// One slot, cleared as it runs. The update offer is the only user, and it
    /// wants exactly this: an interruption that waited for the person to come
    /// back rather than one that went looking for them.
    var onNextShow: (() -> Void)?

    /// Take the panel over with the first-run screen.
    ///
    /// It replaces the editor rather than floating above it, and the web view
    /// is hidden rather than covered: a first launch has no document worth
    /// showing yet, and one reachable underneath would be a document whose
    /// file location is still being asked about. The titlebar names the
    /// application for the same reason, and names nothing that can be clicked.
    func showWelcome() {
        // Whatever is in the panel goes to disk FIRST, and the screen goes up
        // in the COMPLETION rather than beside the call.
        //
        // `flushThen` is a round trip: it posts to the page and returns, so
        // anything after it runs before the reply. Putting the screen up there
        // sets `isWelcoming` in the same turn, and the write embargo then
        // refuses the very write this is here to make. On a first launch there
        // is nothing to write; a development build's Settings can re-show this
        // screen at any time, and with autosave off the text typed before the
        // button was pressed is what would be lost.
        flushThen { [weak self] in
            self?.write(.explicitSave)
            self?.presentWelcome()
        }
    }

    private func presentWelcome() {
        // Before the screen draws, so every switch on it is showing a value
        // that is actually stored. See `Prefs.applyOnboardingDefaults`.
        Prefs.applyOnboardingDefaults()
        AppDelegate.applyActivationPolicy()
        let view = welcome ?? makeWelcome()
        welcome = view
        view.sync()
        view.isHidden = false
        host.webView.isHidden = true
        missingFileBar.isHidden = true
        titleBar.titleView.showAppName(Self.appName)
        show()
        sizePanelForWelcome(view)
    }

    private func makeWelcome() -> WelcomeView {
        let view = WelcomeView(onHotkeyChange: { [weak self] in self?.hotkeyChanged() ?? -1 })
        view.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            // The full height of the content. Clearance for the titlebar
            // band, which is transparent and full height, is the screen's own
            // `topInset` rather than a constraint here, so the band's ground
            // still shows through above the first row.
            view.topAnchor.constraint(equalTo: contentView.topAnchor),
            view.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
        ])
        view.onContinue = { [weak self] in self?.finishWelcome() }
        view.onAllSettings = { [weak self] in
            self?.finishWelcome()
            self?.openPreferences?()
        }
        view.onChange = { [weak self] work in self?.preferencesChanged(beforeReload: work) }
        return view
    }

    /// Give the panel back to the editor.
    ///
    /// `hasSeenWelcome` is set HERE rather than when the screen appears, so a
    /// crash during a first launch does not spend the one chance to ask.
    private func finishWelcome() {
        // Read before the write below, because the seed depends on it.
        let wasFirstRun = !Prefs.hasSeenWelcome
        Prefs.hasSeenWelcome = true
        welcome?.isHidden = true
        restorePanelAfterWelcome()
        host.webView.isHidden = false
        seedFirstRunNote(isFirstRun: wasFirstRun)
        missingFileBar.show(noteMissing, name: boundURL.lastPathComponent)
        layoutMissingFileBar()
        refreshTitle()
        panel.makeFirstResponder(host.webView)
        host.focusEditor()
    }

    /// Put the tour in the note, so a first launch opens on something rather
    /// than on an empty panel. `FirstRunNote` holds the text and the rule.
    ///
    /// HERE rather than at launch, and the first-run screen is the reason:
    /// that screen is what settles where notes live, and `AtomicFile.write`
    /// creates every directory above its target. Seeding before the screen is
    /// answered would build the folder for a location it is still asking
    /// about, and toggling the iCloud switch would then leave a tour in iCloud
    /// Drive and another in Documents. It is the same trap `writeLatest`
    /// guards with `isWelcoming`, reached from the other side.
    ///
    /// Failure is silent on purpose. Nothing is lost by not having the tour:
    /// the panel opens empty, which is what it did before there was one, and a
    /// error the first time somebody sees this app would be worse than the
    /// absence it is reporting.
    private func seedFirstRunNote(isFirstRun: Bool) {
        let url = boundURL
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path))
            .flatMap { $0[.size] as? NSNumber }
        let existing: FirstRunNote.Existing
        if let bytes = size {
            existing = bytes.intValue == 0 ? .empty : .hasContent
        } else {
            existing = .absent
        }
        guard FirstRunNote.shouldWrite(existing: existing,
                                       bufferIsEmpty: latest.isEmpty,
                                       isFirstRun: isFirstRun) else { return }
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try AtomicFile.writeString(FirstRunNote.markdown, to: url)
        } catch {
            NSLog("Birta Writer: could not write the first-run note to \(url.path): \(error)")
            return
        }
        // The file is on disk now, so a later write must treat its absence as
        // a deletion rather than as a note never written. `writeLatest` sets
        // this for its own writes; this one bypasses it.
        everSeenOnDisk = true
        bindTo(url, content: FirstRunNote.markdown)
    }

    /// Whether the panel is showing the first-run screen instead of a document.
    var isWelcoming: Bool { welcome?.isHidden == false }

    /// Grow the panel so the whole first-run screen is on it.
    ///
    /// Only ever grows, and never past the screen: shrinking would fight a
    /// window somebody has already sized, and this runs again every time the
    /// screen is re-shown from Settings.
    ///
    /// Not guarded on `Prefs.isUserStore`, unlike the frame autosave. Nothing
    /// here PERSISTS a size: `JotPanel` only names its autosave under a real
    /// user's defaults, so a checking run resizes a window that is forgotten
    /// when it closes. Guarding it here as well would have made the one thing
    /// worth looking at, whether the screen fits, the one thing no run could
    /// be made to show.
    private func sizePanelForWelcome(_ view: WelcomeView) {
        contentView.layoutSubtreeIfNeeded()
        guard let screen = panel.screen ?? NSScreen.main else { return }
        let chrome = panel.frame.height - panel.contentLayoutRect.height
        let wanted = view.fittingContentHeight + chrome
        let ceiling = screen.visibleFrame.height - 40
        let height = min(max(panel.frame.height, wanted), ceiling)
        guard height > panel.frame.height + 0.5 else { return }
        heightBeforeWelcome = panel.frame.height
        heightAfterWelcome = height
        var frame = panel.frame
        // Grow downward from the title bar, which is where a window grows when
        // a person is looking at it: the titlebar staying put is what makes it
        // read as the same window. Clamped to the screen, because growing
        // downward off the bottom puts the buttons somewhere no scroller can
        // reach: it is the WINDOW that is off screen, not its content.
        frame.origin.y -= height - frame.height
        frame.size.height = height
        frame.origin.y = max(frame.origin.y, screen.visibleFrame.minY)
        panel.setFrame(frame, display: true, animate: false)
    }

    /// The panel's height before the first-run screen grew it, so the editor
    /// is not left in a window sized for a form seen once. Nil once given back.
    private var heightBeforeWelcome: CGFloat?
    /// What this code grew it TO, so the restore can tell its own size from
    /// one the user chose. Recomputing the wanted height instead compares
    /// against a number that is not what the window was set to, and passes for
    /// every size smaller than it: a user who dragged the panel down mid-screen
    /// would have it snapped back under them.
    private var heightAfterWelcome: CGFloat?

    /// Undo `sizePanelForWelcome`, keeping the titlebar where it is.
    ///
    /// Only if the user has not resized in between: their size wins over one
    /// this code chose, and a window that snapped back under them would be
    /// worse than one left tall.
    private func restorePanelAfterWelcome() {
        guard let previous = heightBeforeWelcome, let grown = heightAfterWelcome else { return }
        heightBeforeWelcome = nil
        heightAfterWelcome = nil
        guard abs(panel.frame.height - grown) < 0.5 else { return }
        var frame = panel.frame
        frame.origin.y += frame.height - previous
        frame.size.height = previous
        panel.setFrame(frame, display: true, animate: false)
    }

    /// What the titlebar says when it is not naming a file. The build's own
    /// name, so a development copy says so rather than impersonating the one
    /// somebody uses.
    static var appName: String { AppFlavor.current.displayName }

    /// The missing-note bar spans the window's bottom edge, above the page's
    /// own formatting dock rather than over it.
    private func layoutMissingFileBar() {
        guard !missingFileBar.isHidden else { return }
        let bounds = contentView.bounds
        missingFileBar.frame = NSRect(x: 0, y: 0, width: bounds.width, height: MissingFileBar.height)
    }

    /// Watch whatever the panel is bound to now.
    ///
    /// Rebinding also CLEARS `noteMissing`: the flag is about one path, and
    /// New Note or a chosen document is a different one that has not gone
    /// anywhere.
    private func startWatching() {
        noteMissing = false
        everSeenOnDisk = FileManager.default.fileExists(atPath: boundURL.path)
        watcher.watch(boundURL)
    }

    /// A Finder rename or move: follow it, and write the new path back to
    /// whichever of the three settings supplied the old one.
    private func noteMovedOnDisk(to url: URL) {
        guard url.standardizedFileURL != boundURL.standardizedFileURL else { return }
        Prefs.rebindActive(from: boundURL, to: url)
        // `boundURL`'s `didSet` re-titles and re-watches; a move is the one
        // case where those are already exactly right.
        boundURL = url
    }

    /// The note was deleted or thrown away.
    ///
    /// Nothing is written and nothing is reloaded: the buffer is now the only
    /// copy of those bytes, and reading a file that is not there over the top
    /// of it is exactly the mistake `NoteRead` was added to stop.
    private func noteDeletedOnDisk() {
        guard !noteMissing else { return }
        noteMissing = true
        // Traced because the absence of a file is not evidence on its own: a
        // check that deletes the note and finds it still gone passes whether
        // the write was REFUSED or never attempted, and those are different
        // programs. This says the refusal happened.
        if measure.enabled { measure.trace("noteMissing at=\(boundURL.lastPathComponent)") }
    }

    /// Put the buffer back at the path it came from.
    ///
    /// `AtomicFile.write` recreates the file and its directory, which is the
    /// behaviour that made a silent delete dangerous and is exactly what is
    /// wanted once somebody has asked for it.
    private func saveMissingNoteBack() {
        // `writeLatest` still refuses before the first read has landed, which
        // the presenter can beat. Clearing the bar and flashing "Saved" on the
        // way to a write that did not happen would be the worst possible lie
        // in this state, so the flag comes back if the file is not there
        // afterwards.
        noteMissing = false
        // The pre-write existence check in `writeLatest` would otherwise
        // refuse this too and put the bar straight back, which is correct for
        // every write except the one somebody explicitly asked for. Clearing
        // the flag says "this path has not been seen", so the write is treated
        // as a first one and `AtomicFile` recreates the file and its folder,
        // which is exactly what the button promises.
        everSeenOnDisk = false
        writeLatest()
        guard FileManager.default.fileExists(atPath: boundURL.path) else {
            noteMissing = true
            statusOverlay.flash("Could not write \(boundURL.lastPathComponent).")
            return
        }
        watcher.watch(boundURL)
        statusOverlay.flash("Saved \(boundURL.lastPathComponent) back.")
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
                NSLog("Birta Writer: could not move \(source.path) to \(target.path): \(error)")
                self.measure.trace("relocate failed \(target.lastPathComponent)")
                self.statusOverlay.flash("Could not move the file to \(target.lastPathComponent).")
                return
            }
            Prefs.rebindActive(from: source, to: target)
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

    /// What the user's template calls a note made now, numbered if that name
    /// is taken, so a second note on one day never lands on the first.
    ///
    /// The template is expanded by `NoteNameTemplate`, which uses `strftime`
    /// and therefore spells a date the way every other tool on the machine
    /// does. It also guarantees a usable name from any template at all, which
    /// is what lets this stay a pure naming question: a format somebody is
    /// halfway through typing must never be able to stop a new note.
    static func unusedNoteURL(in directory: URL) -> URL {
        let parts = NoteNameTemplate.parts(Prefs.newNoteNameTemplate)
        return unusedURL(in: directory, stem: parts.stem, extension: parts.ext)
    }

    /// `stem.ext` in `directory`, with a number appended until nothing is
    /// there. Shared so a new note and a rescued one number the same way.
    static func unusedURL(in directory: URL, stem: String, extension ext: String) -> URL {
        var candidate = directory.appendingPathComponent("\(stem).\(ext)")
        var n = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = directory.appendingPathComponent("\(stem) \(n).\(ext)")
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
        // The title's ceiling and the strip's span are two answers to one
        // question, so they are taken from one place and in this order: the
        // title takes what it may, then the strip takes what is left of the
        // same band. Computing the ceiling anywhere else would put the same
        // geometry in two call sites, and the one that went stale would be
        // invisible, because a title is legible whatever width it was cut to.
        //
        // Before the guard below, not after. A window with no band still has a
        // width, and a ceiling left unset because the strip could not be laid
        // out is a ceiling from the last size the window happened to be.
        titleView.setTextCeiling(TitlebarBand.titleTextCeiling(
            windowWidth: contentView.bounds.width,
            titleOriginX: titleView.convert(titleView.bounds, to: contentView).minX,
            titleChromeWidth: TitleBarView.chromeWidth,
            trailingControlsWidth: titlebarControlsWidth))
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

    /// Where the caret the page reported landed in the view, for
    /// `jot/scripts/measure.sh`.
    ///
    /// The one page-to-view coordinate conversion in the app, and it lives in
    /// a target no unit test reaches. `CaretAnchor` is tested on its own, and
    /// what that cannot see is the value of `isFlipped` on the real view: a
    /// conversion written for the wrong convention still produces a rectangle,
    /// the popover still opens, and it opens at the other end of the window,
    /// which reads as placement nobody tuned rather than as an inversion.
    /// Both numbers, because the claim is that they AGREE.
    private func traceDatePickerAnchor(pageTop: Double, anchor: NSRect, isFlipped: Bool) {
        guard measure.enabled else { return }
        measure.trace(String(format: "datepicker pageTop=%.1f anchorY=%.1f flipped=%@",
                             pageTop, anchor.origin.y, isFlipped ? "yes" : "no"))
    }

    /// Draw the panel's content into a PNG beside the scratchpad.
    ///
    /// For looking at, not for asserting on. Layout here is the kind of thing
    /// a number describes badly and a person reads instantly, and the app is
    /// the only thing that can produce the image without a Screen Recording
    /// grant.
    ///
    /// What it CANNOT show, which matters more than what it can: `NSSwitch`,
    /// `NSButton` and the rest of the bezeled controls draw through layers and
    /// come out blank here. A row whose switch is missing in one of these
    /// images is a limit of the drawing path, not a missing control, and
    /// reading it the other way would send somebody looking for a bug that is
    /// not there. The `snapview` lines below are the answer to "is the control
    /// present": they walk the real view tree with frames.
    private func writeSnapshot(named name: String) {
        // The welcome screen when it is up, and the whole content otherwise.
        let target: NSView = (welcome?.isHidden == false) ? welcome! : contentView
        let bounds = target.bounds
        guard bounds.width > 0, bounds.height > 0 else { return }
        // Through the PDF drawing path. `cacheDisplay` and `layer.render`
        // both come back blank here: a `WKWebView` is layer-backed and forces
        // every ancestor to be, and a layer-backed AppKit view has no drawn
        // contents to copy until the window server has asked for them.
        // `dataWithPDF` runs the views' own drawing instead, which does not
        // care. The failure mode of the other two is a blank rectangle of the
        // right size, which reads as "the screen is empty" rather than as
        // "the wrong API".
        let pdf = target.dataWithPDF(inside: bounds)
        guard let image = NSImage(data: pdf) else { return }
        let rendered = NSImage(size: bounds.size)
        rendered.lockFocus()
        NSColor.textBackgroundColor.setFill()
        bounds.fill()
        image.draw(in: bounds)
        rendered.unlockFocus()
        guard let tiff = rendered.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let data = rep.representation(using: .png, properties: [:]) else { return }
        let url = boundURL.deletingLastPathComponent().appendingPathComponent("\(name).png")
        try? data.write(to: url)
        measure.trace("snapshot at=\(url.path) w=\(Int(bounds.width)) h=\(Int(bounds.height))")
        func dump(_ view: NSView, depth: Int) {
            // Deep enough to reach a control. The rows nest through scroll,
            // clip, document, column, form, card, card stack and row before
            // one, and a walk that stops short reports no switches at all,
            // which reads exactly like a screen that has none.
            guard depth < 12 else { return }
            for sub in view.subviews {
                measure.trace("snapview \(String(repeating: "  ", count: depth))\(type(of: sub)) frame=\(NSStringFromRect(sub.frame)) hidden=\(sub.isHidden) alpha=\(sub.alphaValue)")
                dump(sub, depth: depth + 1)
            }
        }
        dump(target, depth: 0)
    }

    /// The panel's window level, for `jot/scripts/measure.sh`.
    ///
    /// `NSPanel` starts at `.floating` and `isFloatingPanel` is a setter for
    /// that level, so the level a panel ends up at is never the absence of a
    /// line and cannot be read off the source by eye. Raw, not
    /// compared to a constant here: the assertion belongs in the script, where
    /// a wrong expectation shows up as a failing arm rather than as a probe
    /// that agrees with itself.
    private func traceWindowLevel() {
        guard measure.enabled else { return }
        // The frame goes out in TOP-LEFT screen coordinates, which is not the
        // convention the frame is in. AppKit measures from the bottom of the
        // main screen and every screen-capture tool measures from the top, so
        // converting here is what stops each reader doing it again and one of
        // them doing it wrong.
        let screenHeight = NSScreen.screens.first?.frame.height ?? panel.frame.maxY
        let frame = panel.frame
        measure.trace(String(
            format: "windowlevel level=%d hidesOnDeactivate=%@ rect=%.0f,%.0f,%.0f,%.0f",
            panel.level.rawValue, panel.hidesOnDeactivate ? "yes" : "no",
            frame.origin.x, screenHeight - frame.maxY, frame.width, frame.height))
    }

    private func traceTitleBar() {
        guard measure.enabled else { return }
        traceWindowLevel()
        let view = titleBar.titleView
        let frame = view.convert(view.bounds, to: nil)
        let text = view.labelFrameInWindow()
        let close = panel.standardWindowButton(.closeButton)
            .map { $0.convert($0.bounds, to: nil) } ?? .zero
        measure.trace(String(
            format: "titlebar x=%.1f y=%.1f w=%.1f h=%.1f visW=%.1f visTextW=%.1f needW=%.1f gotW=%.1f inkW=%.1f fieldW=%.1f cellW=%.1f textMidY=%.1f closeMidY=%.1f attached=%@ text=%@",
            frame.origin.x, frame.origin.y, frame.width, frame.height,
            // What an ANCESTOR leaves of us. Every other number here is a
            // frame this code set, so they agree with each other by
            // construction and none of them can see a container that clips.
            view.visibleRect.width, view.visibleLabelWidth(),
            // What the glyphs need, what they got, and whether they fit on
            // one line in it. The only numbers here about the DRAWING; see
            // TitleBar.titleFit.
            view.titleFit().needed, view.titleFit().given, view.drawnInkWidth(),
            view.titleFieldWidth(), view.titleCellWidth(),
            text.midY, close.midY,
            panel.titlebarAccessoryViewControllers.contains(titleBar) ? "yes" : "no",
            // The DRAWN characters, not the accessibility label. The label now
            // carries the whole name whatever the window's width, which is
            // right for a screen reader and useless to a check asking whether
            // the title was shortened.
            view.drawnTitle))
        traceChevron()
    }

    /// The title's hover affordance, at rest and hovered.
    ///
    /// Both states in one line, because the claim is a DIFFERENCE: an image
    /// view that never draws and one that never hides report the same single
    /// number, and only the pair says the affordance appears. The ink is what
    /// separates "positioned" from "drawn"; `x` against the title's own box is
    /// what says it sits after the name rather than on it.
    private func traceChevron() {
        // Guarded here as well as in the caller, because what this calls sets
        // hover state on a live view. A measurement that writes is one a
        // second caller must not be able to reach by accident.
        guard measure.enabled else { return }
        let view = titleBar.titleView
        let rest = view.chevronForMeasurement(hovered: false)
        let over = view.chevronForMeasurement(hovered: true)
        _ = view.chevronForMeasurement(hovered: false)   // leave it as we found it
        measure.trace(String(
            format: "chevron hasImage=%@ x=%.1f w=%.1f h=%.1f restAlpha=%.2f overAlpha=%.2f restInk=%.1f overInk=%.1f textMaxX=%.1f",
            over.hasImage ? "yes" : "no",
            over.frame.origin.x, over.frame.width, over.frame.height,
            rest.alpha, over.alpha, rest.ink, over.ink,
            view.labelFrameInWindow().width + 8))
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
        // The welcome screen owns the title while it is up, and everything
        // that touches the document goes on running behind it: the file is
        // still bound, still read, still watched. Without this guard the next
        // `isEdited` change would put a file name back over a screen that has
        // no file.
        guard !isWelcoming else { return }
        let edited = WindowTitle.showsEdited(hasUnwrittenBytes: isEdited,
                                             autosaveEnabled: Prefs.autosave)
        titleBar.titleView.show(url: boundURL, edited: edited)
        // The dot in the close button, which macOS draws for us from this one
        // property. THE SAME boolean the word Edited is drawn from, and it has
        // to stay the same one: they are two spellings of a single claim about
        // whether this file on disk is behind the panel, and a titlebar making
        // that claim in one place and not the other is a titlebar nobody can
        // read. That is also why autosave switching on clears both at once,
        // without an edit: with Jot writing as you type there are no unwritten
        // bytes to warn about.
        panel.isDocumentEdited = edited
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

    /// - Parameter beforeReload: see `BeforeReload`. Moving the notes to a new
    ///   location is the only caller that needs it.
    func preferencesChanged(beforeReload: BeforeReload? = nil) {
        // A changed file, document or network setting means a fresh page:
        // flush the current buffer to where it belongs, then reload against
        // the new prefs. Cheap, and it keeps one code path.
        flushThen { [weak self] in
            guard let self else { return }
            let reload: () -> Void = { [weak self] in
                guard let self else { return }
                self.reloadFromDisk = true
                self.loadPage()
                // The bound file may have changed; the titlebar names it.
                self.refreshTitle()
            }
            guard let beforeReload else {
                reload()
                return
            }
            beforeReload(reload)
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
        NSLog("Birta Writer: no web assets found; set BIRTA_JOT_WEB_DIR or run jot/scripts/build-app.sh")
        return URL(fileURLWithPath: "/nonexistent", isDirectory: true)
    }
}

extension String {
    /// Nothing but whitespace, so nothing worth copying or saving. Stops at the
    /// first non-space character, which every real note has near its front.
    var isBlank: Bool { allSatisfy(\.isWhitespace) }
}
