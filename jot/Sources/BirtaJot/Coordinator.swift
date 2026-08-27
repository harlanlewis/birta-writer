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

    private let panel: JotPanel
    private let contentView = AppearanceObservingView()
    /// The draggable middle of the titlebar band (TitlebarDrag.swift). Above
    /// the web view, which is what covers the band and swallowed the drag.
    private let titlebarDrag = TitlebarDragView()
    /// What the page's trailing controls take from the band, as last reported.
    /// Held so a resize can resize the strip without asking the page again.
    private var titlebarControlsWidth: CGFloat = 0

    /// How tall the titlebar band is right now.
    ///
    /// Asked of the window rather than written down: `contentLayoutRect` is
    /// the part of the frame BELOW the titlebar, so the difference is the
    /// band, whatever height the system is using today. Zero before the window
    /// has been laid out, which every reader here treats as "not known yet".
    private var titlebarBandHeight: CGFloat {
        panel.frame.height - panel.contentLayoutRect.height
    }
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

    /// Raised at the top of every `show`, so the app can note what it is about
    /// to cover. Every path that brings a window forward passes through here,
    /// Open With from the Finder included, which is the one worth keeping:
    /// dismissing afterwards should put the user back in the Finder.
    var onWillShow: (() -> Void)?

    /// The close button and Cmd+W. What closing MEANS is the app's to decide
    /// rather than this window's, because it depends on how many there are:
    /// the last window hides, so the editor stays mounted and the next summon
    /// is still instant, and any other really closes.
    var onCloseRequest: (() -> Void)?

    /// This window took the keyboard, so the app can keep its idea of which
    /// window is in front true even when none of them is key later.
    var onBecameKey: (() -> Void)?

    /// Ask the app for another window, under BIRTA_JOT_MEASURE only. Making
    /// one is the app's, so a window can only ask.
    var onNewWindowRequest: (() -> Void)?

    /// Ask the app to open a file, under BIRTA_JOT_MEASURE only, and answer
    /// how many windows are open once it has. Which window takes the file is
    /// the app's rule (`WindowSet.openDocument`) and the count is what says
    /// which way it went.
    var onOpenRequest: ((URL) -> Int)?

    /// Re-register the summon key after the recorder on the first-run screen
    /// has changed it. The key is one registration for the process, so this
    /// window can only ask.
    var onHotkeyChanged: (() -> OSStatus)?
    /// A flush in flight: what to run when it lands, and whether its own
    /// result may be written straight to disk.
    ///
    /// The flag travels WITH the flush rather than sitting in a set beside it,
    /// because two structures keyed by the same id are two things to keep in
    /// step and one of them will eventually be forgotten on a path that
    /// removes from the other.
    private struct PendingFlush {
        let persists: Bool
        let resolve: (String?) -> Void
    }
    private var pendingFlushes: [String: PendingFlush] = [:]
    /// In-flight `requestEditorContext` calls, by id. Bounded the same way the
    /// flushes are: a page that never answers must not leave a closure holding
    /// the coordinator for the life of the app.
    private var pendingContexts: [String: (AgentReference.Selection?) -> Void] = [:]
    private let agent = AgentRunner()
    /// Spelling and grammar for the page, from the system's own checker. Held
    /// for the app's lifetime so its spell-document tag, and with it anything
    /// ignored in this session, survives a page reload.
    private let spell = SpellService()
    /// Per run, the file holding the agent's own version while the page's
    /// merge decides whether the document ended up with all of it.
    private var agentRescues: [String: URL] = [:]
    private var autosaveTimer: Timer?
    private var autosaveDeadline: Date?
    /// The typing pause that ends a burst, and the ceiling a burst cannot pass.
    private let autosaveDebounce: TimeInterval = 0.5
    private let autosaveMaxWait: TimeInterval = 2
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
    private let missingFileScreen = MissingFileScreen()
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
            showMissingFileScreen()
        }
    }

    /// The file the buffer's bytes belong to.
    ///
    /// A Preferences change that points at another file first flushes to THIS
    /// one, then rebinds, so a scratchpad is never written over the document
    /// the user just chose to open. Its folder is also what the page may read
    /// images from, so the two move together by construction rather than by
    /// two call sites remembering to.
    ///
    /// Handed in at init and never re-derived from a global afterwards. This
    /// is the property that decides WHICH file a window is, so a default of
    /// `Prefs.activeURL` would make every window the same window, and a
    /// re-read on any later path would let one window's rebind move another's.
    /// `rebindFromSettings` is the single deliberate exception and names its
    /// two callers.
    private var boundURL: URL {
        didSet {
            guard boundURL != oldValue else { return }
            host.schemeHandler.roots =
                host.schemeHandler.roots.rebound(toDocument: boundURL.deletingLastPathComponent())
            refreshTitle()
            // Both files join the recents list: the one being left and the one
            // arriving, oldest first.
            //
            // Recording the arriving file is the fix for what the menu was:
            // only `openDocument` recorded anything, so a document chosen
            // through a file chooser joined the list and a note made with
            // Cmd+N did not, and somebody who had just switched away from a
            // note found a menu saying "No Recent Files". Here rather than at
            // the gestures, because this is the one slot every rebind passes
            // through, so a way in added later joins by construction.
            //
            // Recording the file being LEFT is how the one this launch opened
            // on ever reaches the list, and it is deliberately this rather
            // than a write at launch. `didSet` does not fire for a property's
            // own initializer, so the launch binding has to be recorded
            // somewhere, and the obvious place is `start()`: that is a
            // preference WRITTEN AT LAUNCH, and `Prefs.isFirstLaunch` asks
            // whether any key is stored at all. Writing one before
            // `applyOnboardingDefaults` has read it turns a first launch into
            // an existing one, and the onboarding defaults silently stop
            // applying. `Prefs.applyOnboardingDefaults` names that trap; this
            // is what walking into it looks like.
            //
            // Nothing is lost by waiting. The file you have not left yet is
            // the one on screen, which is the one thing Open Recent is not
            // for, and it joins the list the moment you go anywhere else.
            Prefs.rememberRecent(oldValue)
            Prefs.rememberRecent(boundURL)
            // The watcher follows the binding, or it goes on reporting moves
            // of a file the panel is no longer editing and misses the one it
            // is. `noteMovedOnDisk` rebinds and re-watches in one step, so it
            // is the one caller this must not fire for twice.
            startWatching()
        }
    }
    private let flushTimeout: TimeInterval = 1.0
    private let measure = Measure()

    /// The key-window notification observers, held so a window that closes
    /// stops listening. `NotificationCenter` retains a block observer for the
    /// life of the process, so discarding these tokens was invisible while a
    /// window lived as long as the app and is a leak per closed window now.
    private var observers: [NSObjectProtocol] = []

    var isVisible: Bool { panel.isVisible }

    /// Put this window one step off `other` and answer where the next goes.
    func cascade(after other: Coordinator, from point: NSPoint?) -> NSPoint {
        panel.cascade(after: other.panel, from: point)
    }

    /// Let this window go, after `prepareToClose` has said it may.
    ///
    /// Everything here is a registration that outlives the object unless it is
    /// given back: a file presenter sits in a process-wide registry, and a
    /// block observer is retained by `NotificationCenter` for the life of the
    /// process. Neither mattered while a window lived exactly as long as the
    /// app did.
    func tearDown() {
        watcher.stop()
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
        cancelPendingAutosave()
        // Cleared FIRST, which is what turns the next line from a request to
        // hide into a real close: `JotPanel.close` states that rule. A window
        // only ordered out stays in `NSApp.windows` and so stays in the Window
        // menu, listed as open long after it was closed.
        panel.onHideRequest = nil
        panel.close()
        panel.contentView = nil
        host.webView.removeFromSuperview()
    }

    /// Whether this is the window the keyboard is talking to.
    var isKey: Bool { panel.isKeyWindow }

    /// The file this window is on.
    ///
    /// Published because the question "is this file already open" belongs to
    /// whoever owns the set of windows rather than to any one of them, and
    /// `BirtaJotCore.FileIdentity.sameFile` is how it is answered: two buffers
    /// over one path both write the whole file and the later write wins
    /// silently, and there is no watcher anywhere in this app that would
    /// notice.
    var boundFile: URL { boundURL }

    /// WHICH app-wide setting this window's file was reached through, so a
    /// rename writes back to the same one.
    ///
    /// Nil is a real answer and not an absence: a window can be on a file no
    /// setting names, because the slots are app-wide and only one window can
    /// hold each. `WindowSet` is what hands them out and takes them away, so
    /// two windows never both believe they own `.document`.
    var bindingSlot: ActiveBinding.Slot?

    /// This window is standing on a file that is not there, with nothing in the
    /// buffer to lose, so another file may take it over.
    ///
    /// BOTH halves, and the second is the safety one: a missing note whose
    /// buffer still holds text is holding the only copy of that text, and it
    /// is the buffer AS THE PANEL LAST HEARD IT, which is the same value the
    /// card is drawn from (`showMissingFileScreen`), so the two always agree
    /// about whether anything is at stake. The page reports its first edit
    /// within an IPC hop (`webview/syncScheduler.ts`), which is what keeps
    /// that value from trailing the writing it describes.
    /// rebinding away from it is what `rescueMissingNote` exists to catch at
    /// quit. A window in that state keeps its file and Open makes a new window,
    /// which is also the honest answer to the question the screen is asking:
    /// Save It Back has not been answered yet.
    var isVacant: Bool { noteMissing && latest.isBlank }

    /// Take `url` over in this window, in place of the file that has gone.
    ///
    /// Nothing is flushed and nothing is written first, and both are safe here
    /// rather than skipped: `isVacant` is the caller's gate, so the buffer is
    /// blank and `writeLatest` is refusing every write anyway while the note is
    /// missing.
    ///
    /// `boundURL`'s own `didSet` does most of it, which is why this is short:
    /// it re-titles, records both files in the recents list, and re-watches,
    /// and `startWatching` is what clears `noteMissing` and takes the screen
    /// down. What is left is the page, which has to be loaded again against the
    /// new binding, and the slot, which is `WindowSet`'s to hand out.
    func openInPlace(_ url: URL, slot: ActiveBinding.Slot?) {
        bindingSlot = slot
        boundURL = url
        reloadFromDisk = true
        loadPage()
        refreshTitle()
        show()
    }

    /// A window on `url`, which is the only thing that distinguishes one of
    /// these from another and so is required rather than defaulted.
    /// - Parameter remembersFrame: whether this is the window that keeps its
    ///   size and position between launches. Exactly one is; `JotPanel` says
    ///   why it cannot be all of them.
    init(boundTo url: URL, slot: ActiveBinding.Slot?, remembersFrame: Bool) {
        boundURL = url
        bindingSlot = slot
        panel = JotPanel(remembersFrame: remembersFrame)
        let webRoot = Coordinator.locateWebRoot()
        host = WebHost(webRoot: webRoot, documentDirectory: url.deletingLastPathComponent())
        writer = CoalescingWriter(onError: { error in
            NSLog("Birta Writer: write failed: \(error)")
        })
    }

    // MARK: lifecycle

    func start() {
        // No fallback to the app's active file when this window is gone: that
        // would be the global read this window exists not to do, and a window
        // being torn down has no view state worth restoring. `WebHost`'s own
        // default is the honest answer.
        host.bootConfig = { [weak self] in
            self.map { Prefs.bootConfig(viewStateFor: $0.boundURL) } ?? BootConfig()
        }
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
        contentView.addSubview(missingFileScreen)
        missingFileScreen.onSaveItBack = { [weak self] in self?.saveMissingNoteBack() }
        missingFileScreen.onOpenRecent = { [weak self] anchor in
            guard self != nil else { return }
            RecentsMenu().popUp(
                positioning: nil,
                at: RecentsMenu.popUpOrigin(in: anchor.bounds, isFlipped: anchor.isFlipped),
                in: anchor)
        }
        missingFileScreen.onDiscardAndStartNew = { [weak self] in
            // Clearing the flag first is what lets the new note be created and
            // written at all; the bytes of the old one are what the button
            // says it is discarding.
            self?.noteMissing = false
            self?.startNewNoteHere()
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
        contentView.onHoverChange = { [weak self] _ in self?.applyChromeVisibility() }
        watcher.onMoved = { [weak self] url in self?.noteMovedOnDisk(to: url) }
        watcher.onDeleted = { [weak self] in self?.noteDeletedOnDisk() }
        startWatching()
        contentView.onLayout = { [weak self] in
            MainActor.assumeIsolated {
                self?.layoutTitlebarDrag()
                self?.layoutMissingFileScreen()
            }
        }
        panel.addTitlebarAccessoryViewController(titleBar)
        titleBar.titleView.onReveal = { url in
            NSWorkspace.shared.activateFileViewerSelecting([url])
        }
        titleBar.titleView.onRelocate = { [weak self] target in
            MainActor.assumeIsolated { self?.relocateActiveFile(to: target) }
        }
        // The file actions, beside the name of the file they act on. Each is
        // the menu row's own selector, sent up the responder chain, so the
        // button IS the row rather than a second thing that agrees with it.
        // What the set IS, and the argument for every symbol in it, is
        // `TitlebarActionsView.shipped`.
        titleBar.titleView.setActions(TitlebarActionsView.shipped)
        // The file buttons name themselves with the PAGE'S tooltip, so the two
        // halves of this band label their controls the same way. `NSView`'s
        // own `toolTip` is what this replaces: it draws the system tooltip,
        // which is a different ground and a different shape from the chip the
        // toolbar's buttons use a few inches away, and arrives after a delay
        // theirs does not have.
        //
        // The conversion is the only part that has to happen here. AppKit
        // window coordinates grow upward from the bottom and the page's grow
        // downward from the top, and the page is drawn under the full-height
        // titlebar, so the web view's box IS the window's and the flip is the
        // whole of the arithmetic. Getting it wrong draws a correct label at
        // the other end of the window.
        titleBar.titleView.onTooltip = { [weak self] label, box in
            guard let self else { return }
            guard let label else {
                self.host.send(.hostTooltip(text: nil, rect: nil))
                return
            }
            let flipped = CGRect(x: box.origin.x,
                                 y: self.panel.frame.height - box.maxY,
                                 width: box.width,
                                 height: box.height)
            self.host.send(.hostTooltip(text: label, rect: flipped))
        }
        // The band is one strip to the eye, so pointing anywhere along it
        // offers what the strip holds, rather than only the width of the name.
        // That hover now arrives from the WINDOW rather than from the strip
        // (`applyChromeVisibility`), because the page's own chrome answers to
        // the window and the two halves of the band have to agree: a pointer in
        // the middle of the document would otherwise light one end and not the
        // other. The strip is a subview of the content view, so its hover is a
        // strict subset of the window's and nothing is lost; wiring it as a
        // second writer of the same flag is what would be wrong, since leaving
        // the strip for the document would report false while the window still
        // had the pointer.
        // Title ink follows the window's key state, as every macOS title does,
        // and so does whether the page draws its own chrome at all: key is one
        // of the two halves of "awake" (`applyChromeVisibility`), and the only
        // half that has a notification rather than a tracking area. Both
        // notifications are needed: a panel loses key to another app's window
        // without any pointer event, which is exactly the case where the
        // pointer half would report nothing and the chrome would stay lit on a
        // window in the background.
        for (name, key) in [(NSWindow.didBecomeKeyNotification, true),
                            (NSWindow.didResignKeyNotification, false)] {
            observers.append(NotificationCenter.default.addObserver(
                forName: name, object: panel, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.titleBar.titleView.setWindowKey(key)
                    if key { self.onBecameKey?() }
                    self.applyChromeVisibility()
                }
            })
        }
        titleBar.titleView.setWindowKey(panel.isKeyWindow)
        refreshTitle()
        panel.contentView = contentView
        panel.onHideRequest = { [weak self] in self?.onCloseRequest?() }
        applyTheme(initial: true)

        // The activation policy the Dock switch decides, as the app actually
        // took it. A setting whose only evidence is that its own getter
        // returns what was written to it is a setting nobody has checked.
        measure.trace("policy \(NSApp.activationPolicy() == .regular ? "regular" : "accessory") showInDock=\(Prefs.showInDock)")

        // Prewarm: load and mount now, hidden, so the first summon finds the editor mounted.
        measure.mark("launch")
        loadPage()

    }

    /// Deliver one `measure.sh` message to this window's page. Raised by
    /// `WindowSet`, which owns the signal that asks for it, because a signal
    /// is one per process and this is one per window.
    func postDebugMessageFile() {
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
            // What the app currently believes a setting is, and NOTHING else.
            //
            // A script sets a preference from outside the process, and a
            // running `UserDefaults` learns about that when the system tells
            // it, so "has the app been told yet" is a real question with no
            // other way to ask it. Every other way of provoking an answer acts
            // as well as reports: `__jotSave` was tried here and it writes the
            // buffer, which is the file the autosave check then inspects, so
            // the instrument was changing the thing it measured.
            // Point at one of the titlebar's file buttons, and report what the
            // page drew. A pointer on a titlebar accessory is not something a
            // script can synthesize, so the hover is set the way every other
            // check here sets it, and what is being asked is the half beyond
            // it: the message reached the page and the page drew the chip.
            if obj["type"] as? String == "__jotHoverButton" {
                measure.mark("debug-hover-button")
                let index = (obj["index"] as? NSNumber)?.intValue ?? 0
                let buttons = titleBar.titleView.actionsView.buttons
                guard index >= 0, index < buttons.count else {
                    measure.trace("hovertooltip no button at \(index)")
                    return
                }
                let wanted = (obj["hovered"] as? NSNumber)?.boolValue ?? true
                _ = buttons[index].hoverForMeasurement(wanted)
                // After the message has had a turn to reach the page and the
                // page a turn to lay the chip out.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                    self?.host.reportTooltip { line in
                        MainActor.assumeIsolated { self?.measure.trace("hovertooltip \(line)") }
                    }
                }
                return
            }
            if obj["type"] as? String == "__jotPrefs" {
                measure.trace("prefs autosave=\(Prefs.autosave ? "yes" : "no")")
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
            // A second window, which a shell has no other way to ask for: the
            // gestures that open one are a menu chord an accessory app cannot
            // always take, and a file chooser nothing can click.
            if obj["type"] as? String == "__jotNewWindow" {
                measure.mark("debug-new-window")
                onNewWindowRequest?()
                return
            }
            // Open a file, exactly as Cmd+O and the titlebar's folder button
            // do: the chooser is skipped and `WindowSet.openDocument` is not,
            // so what runs is the rule about WHICH window takes the file. A
            // script cannot click a file chooser, and a closure here that
            // opened a window itself would be a second answer to that question
            // able to agree with the real one while it was being checked.
            //
            // The window count comes back from the set, because that is the
            // whole of what this is asked to prove: whether the file landed in
            // the window that was already open or in a new one beside it.
            if obj["type"] as? String == "__jotOpen", let path = obj["path"] as? String {
                measure.mark("debug-open")
                let count = onOpenRequest?(URL(fileURLWithPath: path)) ?? -1
                measure.trace("open windows=\(count) at=\(boundURL.lastPathComponent)"
                                + " missing=\(noteMissing)")
                return
            }
            // What the band's trailing controls look like with the window at
            // rest, which a script cannot reach: resting is the pointer and the
            // key window, and a shell driving this app has neither.
            if obj["type"] as? String == "__jotResting" {
                measure.mark("debug-resting")
                host.reportRestingChrome { [weak self] line in
                    MainActor.assumeIsolated {
                        guard let self else { return }
                        self.measure.trace("restingchrome \(line)")
                        // The app's own writer, asked again, so the read leaves
                        // the page in the state the window actually implies
                        // rather than in whatever the query last set.
                        self.applyChromeVisibility()
                    }
                }
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
                    //
                    // Shift is APPLIED to that one, which is the part this got
                    // wrong. "Ignoring modifiers" means ignoring Command and
                    // Option; a keyboard producing ⇧⌘O reports "O", never "o".
                    // Sending the bare letter made an event no keyboard makes,
                    // so every shifted LETTER chord driven from here was
                    // delivered as something the system never sees. It went
                    // unnoticed because the only shifted chord under test is
                    // ⇧⌘8, and a digit has no case to get wrong.
                    //
                    // What this does NOT establish is how AppKit matches such
                    // a chord against a menu that also holds the unshifted
                    // one. That question was asked here and the answers did not
                    // agree between runs, so nothing in this repository claims
                    // it either way.
                    let ignoring = heldFlags.contains(.shift) ? chars.uppercased() : chars
                    let typed = heldFlags.contains(.command) ? "" : ignoring
                    if let ev = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: heldFlags, timestamp: ProcessInfo.processInfo.systemUptime,
                                                 windowNumber: self.panel.windowNumber, context: nil, characters: typed,
                                                 charactersIgnoringModifiers: ignoring, isARepeat: false, keyCode: code) {
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

    /// Note the summon for the harness. The gesture itself is the app's;
    /// what is per-window is the clock the interval is measured against.
    func markHotkeyPressed() {
        measure.mark("hotkey")
    }

    func show() {
        // Taken before anything else on this path, and run at the end, so a
        // handler that summons or hides cannot re-enter its own slot.
        let held = onNextShow
        onNextShow = nil
        defer { held?() }
        onWillShow?()
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
    /// This window only. Returning the user to whatever they were in before
    /// is the APP's move and happens once, in `WindowSet.dismissAll`, after
    /// every window has gone: doing it here would send them away while other
    /// windows were still on screen.
    func hide() {
        guard panel.isVisible else { return }
        panel.orderOut(nil)
        flushThen(persisting: false) { [weak self] in self?.write(.panelHidden) }
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
                // The binding is NOT re-derived here. It used to be, on every
                // page load, which was indistinguishable from correct while
                // there was one window: the two gestures that move a window by
                // writing a setting now ask for it by name, through
                // `rebindFromSettings`, and every other reload keeps the file
                // it was already on.
                //
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
            host.send(.initDoc(content: latest, syncVersion: guardState.version,
                               viewStateJSON: Prefs.viewStateJSON(for: boundURL)))
            state = .warm
            // A fresh page starts with its chrome shown; tell it where the
            // pointer is, and say which file it is now bound to.
            refreshTitle()
            // ...and whether that file is there at all. A class on the body is
            // the page's whole memory of this, so a remount for any reason
            // brings the band back with every control in it while the card in
            // the middle of the window is still saying the note is gone. It is
            // set BEFORE the width query below, which measures the row this
            // decides the contents of.
            host.setNoteMissing(noteMissing)
            // Ask for the width the title's ceiling is computed against as
            // soon as there is a page to ask, rather than waiting for the
            // first summon. Until it answers, the width reads 0, which the
            // arithmetic cannot tell from a page with no controls at all, and
            // a long name would take the whole band for the round trip and
            // then pull back. Prewarm mounts the page before the panel is ever
            // shown, so on that path the answer is in hand first.
            refreshTitlebarControlsWidth()
            applyChromeVisibility()
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
            let pending = pendingFlushes.removeValue(forKey: id)
            switch guardState.judge(baseSyncVersion: base, seq: seq) {
            case .admit:
                latest = content
                // Only for a caller that has said its own `then` does not
                // decide. `flushThen` holds the argument; the short version is
                // that this used to write unconditionally, on the belief that
                // every flush was asked for by something that always writes,
                // and hiding the panel with autosave off is a flush asked for
                // by something that does not (MAR-420).
                if pending?.persists ?? true {
                    cancelPendingAutosave()
                    writeLatest("flushResult")
                }
                host.send(.flushAck(id: id, applied: true))
                pending?.resolve(content)
            case .repush:
                host.send(.flushAck(id: id, applied: false))
                host.send(.externalUpdate(content: latest, syncVersion: guardState.version))
                pending?.resolve(nil)
            case .staleSeq:
                host.send(.flushAck(id: id, applied: false))
                pending?.resolve(nil)
            }
        case let .viewState(json):
            Prefs.setViewStateJSON(json, for: boundURL)
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
        // The outline panel's three memories. Recorded as the page settles
        // each, and handed back at the next page load, which the window does
        // on every file it opens: without this the sidebar would shut itself
        // the moment you opened a second note.
        case let .lintBlocks(id, blocks):
            spell.lint(blocks: blocks) { [weak self] results in
                guard let self else { return }
                // Traced because this is the one chain no other instrument
                // reaches end to end: the Swift tests stop at the service and
                // the browser harness cannot run `NSSpellChecker` at all, so
                // `measure.sh` reads this line to say the round trip works in
                // the real app.
                self.measure.trace("lint blocks=\(blocks.count) "
                    + "lints=\(results.reduce(0) { $0 + $1.lints.count })")
                self.host.send(.lintResults(id: id, results: results))
            }
        case let .spellAddWord(word):
            // Nothing is sent back, and nothing needs to be: the page holds its
            // own set of learned words and stops drawing the hit the moment the
            // row is picked (`webview/proofread/engine.ts`), exactly as it does
            // in the extension, where this write is also one-way.
            spell.learn(word)
        case let .setProofreadOption(key, value):
            Prefs.rememberProofreadOption(key: key, value: value)
        case let .styleAddException(phrase):
            // One-way, like `spellAddWord`: the page has already stopped
            // drawing the hit from its own set, and this is what makes it
            // stick past the next page load.
            Prefs.rememberStyleException(phrase)
        case let .setTocVisibility(v): Prefs.tocVisibility = v
        case .setTocPosition:
            // Nothing to remember: the side is this app's rather than the
            // reader's (`fixedTocSide`, and `BirtaSchemeHandler.renderPage`
            // writes `toc-right` on every page). Ignored rather than removed
            // from the vocabulary, because the vocabulary is the extension's
            // and a message a host declines is the protocol working.
            break
        case let .setTocWidth(w): Prefs.tocWidth = w
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
        case let .hostPrompt(id, step):
            showHostPrompt(id: id, step: step)
        case let .requestHostDiagnostics(id):
            host.send(.hostDiagnosticsResult(id: id, diagnostics: hostDiagnostics()))
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
    /// Take the binding from the app's stored settings.
    ///
    /// The two gestures that change which file a window is on by writing a
    /// SETTING rather than by naming a path: leaving a bound document, and a
    /// settings change that moved the notes. Both write the slot and then ask
    /// for this, before the page is reloaded against it.
    ///
    /// By name, because `ready` used to do it implicitly on every load. With
    /// one window that was invisible; with several it is the sharpest hazard
    /// in the file, since a reload for any reason at all, a settings change or
    /// a content-process death, would take whichever file another window had
    /// bound last.
    ///
    /// While the note is missing, rebind only for a setting the user actually
    /// changed. `Prefs.activeURL` re-derives through accessors that filter on
    /// existence, so a deleted New Note falls back to the scratchpad on its
    /// own: the binding changes, `startWatching` clears `noteMissing`, and the
    /// read that follows lands another file's contents on the only copy of the
    /// deleted one, past the guard in `adopt`, which by then has nothing to
    /// see. `storedActiveURL` reads the same settings without that filter, so
    /// it moves when somebody moves it and not when a file disappears.
    ///
    /// The buffer is rescued before a deliberate rebind, because it is still
    /// the only copy of a note nobody has answered for.
    private func rebindFromSettings() {
        if !noteMissing {
            boundURL = Prefs.activeURL
            bindingSlot = Prefs.activeSlot
        } else if Prefs.storedActiveURL.standardizedFileURL != boundURL.standardizedFileURL {
            rescueMissingNote()
            boundURL = Prefs.activeURL
            bindingSlot = Prefs.activeSlot
        }
    }

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
    ///
    /// - Parameter persisting: whether the flush's own RESULT may be written
    ///   as soon as it lands. That arm was left writing when the two fallbacks
    ///   above were fixed, so the rule this comment states was true of two
    ///   paths out of three, and the third is the one that runs when the page
    ///   answers, which is nearly always (MAR-420).
    ///
    ///   True is the default because most callers follow with an explicit save
    ///   and the write is theirs either way. Pass false when `then` consults
    ///   `AutosavePolicy`, which is to say when the answer might be "do not
    ///   write": hiding the panel, and quitting. Writing first makes the
    ///   policy's refusal meaningless, and on the quit path it pre-empts the
    ///   Save / Don't Save sheet, so somebody who answers Don't Save has
    ///   already had their buffer written.
    private func flushThen(persisting: Bool = true, _ then: @escaping () -> Void) {
        guard state == .warm else {
            then()
            return
        }
        let id = "flush-\(UUID().uuidString)"
        var done = false
        let finish: () -> Void = { if !done { done = true; then() } }
        pendingFlushes[id] = PendingFlush(persists: persisting) { _ in finish() }
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
    ///
    /// It can arrive LATE, which is the case the observer below is for: the
    /// sheet is already on the panel from a quit somebody started by hand, and
    /// then a signal arrives from an installer or a logout. `NSApp.terminate`
    /// does nothing while a terminate is already pending, so setting this flag
    /// is the whole of what that signal can do, and without the observer it
    /// would do nothing at all: the app would sit behind the question with
    /// something waiting on it to go (MAR-411).
    var quitIsUnattended = false {
        didSet {
            guard quitIsUnattended, !oldValue else { return }
            answerQuitPromptUnattended()
        }
    }

    /// Whether the quit question is on the panel right now.
    ///
    /// It is what tells the sheet below apart from the other one this same
    /// window hosts (`HostPromptSheet`), which asks about something else
    /// entirely and must not be answered on somebody's behalf.
    private var quitPromptIsUp = false

    /// Answer the question the way an unattended quit would have, if one is up.
    ///
    /// Ended through `endSheet` with the Save button's code rather than by
    /// deciding here, so the answer runs the completion the sheet already has:
    /// there is one place that turns an answer into a write, and a second copy
    /// of that decision beside the sheet is how the two drift apart. The code
    /// names a POSITION, so `UnsavedChangesPromptTests` pins Save to the first
    /// button as well as the mapping.
    private func answerQuitPromptUnattended() {
        guard quitPromptIsUp, let sheet = promptWindow.attachedSheet else { return }
        promptWindow.endSheet(sheet, returnCode: .alertFirstButtonReturn)
    }

    /// Set once the way out has been decided, so the last-chance write on the
    /// way through `applicationWillTerminate` does not undo the answer.
    private var quitDecided = false

    /// Forget an answer given during a quit that was then refused.
    ///
    /// The fan-out asks each window in turn, so by the time one of them says
    /// Cancel the earlier ones have already decided and written. Leaving them
    /// decided would suppress their last-chance write on the NEXT quit, which
    /// is the one that goes through.
    func forgetQuitDecision() { quitDecided = false }

    /// Everything that has to happen before this window may go, and the one
    /// place closing it can be refused.
    ///
    /// One window's half of a quit, and also the whole of closing a window,
    /// which is the same question asked of one buffer: with autosave off and
    /// unwritten bytes it asks, and Cancel means the window stays. Reusing it
    /// is what stops closing a window acquiring a second, quieter answer to
    /// "what happens to what I typed".
    ///
    /// `done(false)` means the user cancelled: the app stays up, and nothing
    /// may have been torn down on the way to asking. That ordering is the
    /// whole shape of this method. The hotkey and the running agents used to
    /// be dropped first, which is invisible while every quit succeeds and is a
    /// summon key that stops working for the rest of the session the first
    /// time somebody presses Cancel.
    func prepareToClose(_ done: @escaping (Bool) -> Void) {
        // `decideFinalWrite` may ask, and with autosave off it does. A flush
        // that wrote as it landed would put the bytes on disk before the sheet
        // was even on screen, so Don't Save would be answering a question the
        // app had already settled.
        flushThen(persisting: false) { [weak self] in
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
            writeLatest("decideFinalWrite")
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
                writeLatest("decideFinalWrite")
                keep(.save)
                return
            }
            // Show what is about to be lost. The panel is hidden most of the
            // time, and a sheet needs a window on screen; summoning it is also
            // the honest thing to do, since the question names a document the
            // person cannot otherwise see.
            if !isOnScreen { show() }
            // And if there is nowhere to put the question, keep the bytes
            // rather than asking a panel that cannot answer. `canAsk` holds
            // both ways that happens and the argument for each; what they
            // share is that the answer never arrives, and this quit is waiting
            // on it (`applicationShouldTerminate` answered `.terminateLater`),
            // so the failure is an app that cannot be quit (MAR-411).
            //
            // The write is a no-op on the first-run arm, because `writeLatest`
            // is embargoed while that screen is up, and it stays here rather
            // than being branched around: this is the one funnel every write
            // goes through, and the embargo is that funnel's decision to make.
            // So nothing was going to reach disk on that arm either way, which
            // is what the embargo already decided; asking added the hang and
            // nothing else, since Save there could not write either.
            guard AutosavePolicy.canAsk(panelIsUp: promptWindow.isVisible,
                                        firstRunScreenIsUp: isWelcoming,
                                        anotherSheetIsUp: promptWindow.attachedSheet != nil) else {
                writeLatest("decideFinalWrite")
                keep(.save)
                return
            }
            quitPromptIsUp = true
            UnsavedChangesPrompt.present(document: boundURL.lastPathComponent,
                                         on: promptWindow) { [weak self] answer in
                guard let self else { keep(answer); return }
                self.quitPromptIsUp = false
                if answer == .save { self.writeLatest("quitPromptSave") }
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
        let ext = boundURL.pathExtension.isEmpty ? DocumentTypes.written : boundURL.pathExtension
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
    private func writeLatest(_ reason: StaticString) {
        // `noteMissing` alongside `hasLoaded`, and both are about the same
        // thing: a path this write would create rather than update.
        // Every attempt, with the four facts that decide it, for
        // `jot/scripts/measure.sh`. A check about writing needs to know a
        // write was ATTEMPTED: "the file is still absent" is satisfied just as
        // well by a guard that refused and by a path that was never reached,
        // and only one of those is the behaviour being claimed.
        if measure.enabled {
            measure.trace("writeattempt by=\(reason) hasLoaded=\(hasLoaded) missing=\(noteMissing) seen=\(everSeenOnDisk) exists=\(FileManager.default.fileExists(atPath: boundURL.path)) at=\(boundURL.lastPathComponent)")
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
        let autosave = Prefs.autosave
        // What the app BELIEVED when it decided, for `jot/scripts/measure.sh`.
        //
        // The rule itself is a pure function with its own tests, so the arm
        // that script owns is the wiring: did the setting reach this decision.
        // Without this line a failure there has two causes that look
        // identical, and only one of them is a defect. The script sets the
        // preference from OUTSIDE the process, and an external write reaches a
        // running `UserDefaults` when the system gets round to it, so a probe
        // that hides the panel too soon measures an app that has not been told
        // yet and reports the product as ignoring a setting it never saw.
        measure.trace("writedecision trigger=\(trigger) autosave=\(autosave ? "yes" : "no")")
        switch AutosavePolicy.action(for: trigger, autosaveEnabled: autosave) {
        case .now:
            cancelPendingAutosave()
            writeLatest("write")
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
            writeLatest("write")
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
        writeLatest("autosaveFired")
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
        let ext = boundURL.pathExtension.isEmpty ? DocumentTypes.written : boundURL.pathExtension
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
    /// The window half of Back to My Notes. `WindowSet.backToNotes` is the
    /// whole gesture, and it has already decided that this window may take the
    /// file it is about to land on.
    ///
    /// - Parameter took: called with the slot this window now holds, so the app
    ///   can take that slot away from any other window. A window cannot do that
    ///   itself, and a slot two windows both believe they own is a rename
    ///   written to a setting the other one is also writing to.
    func leaveDocument(_ took: @escaping (ActiveBinding.Slot?) -> Void) {
        flushThen { [weak self] in
            guard let self else { return }
            self.write(.explicitSave)
            Prefs.documentURL = nil
            self.rebindFromSettings()
            took(self.bindingSlot)
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
    /// Make the empty file a new note starts as, and answer where it went.
    ///
    /// Created now rather than held in memory, because a note that exists only
    /// in a buffer is one the next launch cannot find its way back to.
    ///
    /// Static because two callers make one: the app, when New Note opens a
    /// window, and this window, when the missing-note screen's Discard has
    /// nowhere left to write. Throwing rather than reporting, so each caller
    /// puts the message where its own gesture was made.
    static func makeNoteFile() throws -> URL {
        let directory = Prefs.notesDirectory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let target = Coordinator.unusedNoteURL(in: directory)
        try AtomicFile.writeString("", to: target)
        return target
    }

    /// Replace THIS window's buffer with a fresh note.
    ///
    /// Not what Cmd+N does any more, which opens a window. The one caller left
    /// is the missing-note screen's Discard, where there is no file to write
    /// the buffer back to and opening a second window would leave the broken
    /// one on screen.
    func startNewNoteHere() {
        flushThen { [weak self] in
            guard let self else { return }
            self.write(.explicitSave)
            do {
                let target = try Coordinator.makeNoteFile()
                if self.bindingSlot == .document { Prefs.documentURL = nil }
                Prefs.currentNoteURL = target
                self.bindingSlot = .currentNote
                self.bindTo(target, content: "")
                self.statusOverlay.flash("New note.")
            } catch {
                NSLog("Birta Writer: could not make a new note: \(error)")
                self.statusOverlay.flash("Could not make a new note.")
            }
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

    /// Draw one step of a flow the page is driving, as a sheet on the panel.
    ///
    /// Answered exactly once, and answered in every arm: the page holds a
    /// pending request against this id, so a step this build cannot draw says
    /// `unsupported` rather than going quiet. Silence here is indistinguishable
    /// from a message correctly ignored (MAR-390), which would leave the flow
    /// waiting out its own timeout for a question that was never asked.
    /// Every arm replies. `HostPromptDisposition` is where the arms are chosen
    /// and where they are tested; reaching `.cancel` needs the panel to go
    /// away between the keystroke and the message, because `/help` is typed
    /// into the document, so it is the arm existing rather than the case being
    /// common that matters.
    private func showHostPrompt(id: String, step: HostPromptStep?) {
        switch HostPromptStep.disposition(step: step, windowIsVisible: promptWindow.isVisible) {
        case .unsupported:
            host.send(.hostPromptResult(id: id, value: nil, unsupported: true))
        case .cancel:
            host.send(.hostPromptResult(id: id, value: nil, unsupported: false))
        case let .draw(step):
            HostPromptSheet.present(step, on: promptWindow) { [weak self] value in
                self?.host.send(.hostPromptResult(id: id, value: value, unsupported: false))
                self?.host.focusEditor()
            }
        }
    }

    /// What this app reports about itself when a feedback report asks.
    ///
    /// The app and macOS rather than an extension and a VS Code, because those
    /// are what is actually running, and this app's own settings rather than
    /// `birta.*` keys it does not have. Never the note, its path, or the folder
    /// it is in: the composer is never given any of the three.
    private func hostDiagnostics() -> HostDiagnostics {
        let os = ProcessInfo.processInfo.operatingSystemVersion
        // Compile-time, so it names the slice actually running rather than the
        // slices the binary was built with.
        #if arch(arm64)
        let architecture = "arm64"
        #else
        let architecture = "x86_64"
        #endif
        // The flavour belongs here because it changes what a reader can
        // reproduce: a development build has its own settings, its own note
        // and its own chord, so a report from one that omitted it would send
        // somebody looking in the release copy's state.
        let flavour = AppFlavor.current == .dev ? " (development build)" : ""
        return HostDiagnostics(
            appVersion: AboutInfo.current.versionLine,
            systemVersion: "macOS \(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
            platform: "darwin \(architecture)\(flavour)",
            changedSettings: Prefs.changedSettingsDescription())
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
        missingFileScreen.isHidden = true
        titleBar.titleView.showAppName(Self.appName)
        show()
        sizePanelForWelcome(view)
    }

    private func makeWelcome() -> WelcomeView {
        let view = WelcomeView(onHotkeyChange: { [weak self] in self?.onHotkeyChanged?() ?? -1 })
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
        //
        // A PROXY for a genuine first launch, and Show Welcome forges it on
        // purpose: that button clears the flag before opening this screen, so
        // the tour is offered again to somebody replaying their first run.
        // Deliberate rather than leaked, because it is the only route back to
        // the tour that exists, and `shouldWrite` is what keeps the forgery
        // harmless by refusing any note with writing in it. Do not tighten
        // this to a real first-launch flag without replacing that route; the
        // Settings caption promises it.
        //
        // Reset all settings does NOT reach here. `Prefs.reset` keeps
        // `hasSeenWelcome` set, for its own older reason, so the screen never
        // reopens and the seed is never asked.
        let wasFirstRun = !Prefs.hasSeenWelcome
        Prefs.hasSeenWelcome = true
        welcome?.isHidden = true
        restorePanelAfterWelcome()
        host.webView.isHidden = false
        seedFirstRunNote(isFirstRun: wasFirstRun)
        showMissingFileScreen()
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
        // Nil is the default scratchpad location, which no setting names.
        let slot = Prefs.slot(holding: url) ?? .scratchpad
        guard FirstRunNote.shouldWrite(existing: FirstRunNote.existing(at: url),
                                       bufferIsEmpty: latest.isEmpty,
                                       isFirstRun: isFirstRun,
                                       slot: slot) else { return }
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

    /// Put the screen up, or take it down, and say which of its two shapes.
    ///
    /// `latest` is what decides the shape: the file is gone either way, so the
    /// question is whether anything on screen exists nowhere else. A buffer
    /// with nothing in it has nothing to save and nothing to discard, and
    /// offering either would be offering a choice about nothing.
    ///
    /// The editor is hidden while it is up. The strip this replaced left the
    /// text showing on the argument that covering what is at risk would be
    /// perverse; what actually protects the text is the offer to write it,
    /// which is on the screen doing the covering.
    private func showMissingFileScreen() {
        missingFileScreen.show(noteMissing,
                               name: boundURL.lastPathComponent,
                               hasUnsavedText: !latest.isBlank)
        layoutMissingFileScreen()
        // The band's other half. With no file there is nothing for Find, the
        // checks, the outline or the typography controls to act on, and the
        // gear is the one control in this state that still has a job: on a
        // panel with no Dock icon it is the way to preferences.
        host.setNoteMissing(noteMissing)
        // The cluster just changed WIDTH, which the drag strip is sized from.
        // Without this the strip keeps the width of a row that is no longer
        // there and lies over the gear, so the click that reaches preferences
        // drags the window instead.
        refreshTitlebarControlsWidth()
    }

    /// The area the card centres in: the DOCUMENT, and not the band above it.
    ///
    /// The web view is never hidden while this is up. Find, the checks, the
    /// outline and the Settings gear are all drawn by the page, in the titlebar
    /// band, so hiding the view leaves a window whose only way to Settings is
    /// the menu bar, and somebody whose file has just gone missing is exactly
    /// the person who might want to look at where their notes are kept.
    ///
    /// The frame given here is the area, not the covering: `MissingFileScreen`
    /// paints and hit-tests only its own card inside it, and keeps the tooltip
    /// lane at the top of this box clear so the band's labels are readable.
    ///
    /// The keyboard is deliberately not walled off: a hidden view can still be
    /// first responder, so typing reaches the buffer here. It is safe because
    /// `writeLatest` refuses while the note is missing, and it is what makes
    /// "what you were writing is still on screen" true rather than a
    /// description of something the user cannot touch.
    private func layoutMissingFileScreen() {
        guard !missingFileScreen.isHidden else { return }
        let bounds = contentView.bounds
        // Zero before the window has been laid out, which is the same "not
        // known yet" the drag strip reads it for. Taking the whole view is the
        // right answer then: it is never less than the document's area.
        let band = max(0, titlebarBandHeight)
        missingFileScreen.frame = NSRect(x: bounds.minX, y: bounds.minY,
                                         width: bounds.width,
                                         height: max(0, bounds.height - band))
        // What decides whether the band's controls are reachable AND readable,
        // for `jot/scripts/measure.sh`. Geometry rather than appearance, and
        // that is not a compromise: the page's controls are drawn by WebKit,
        // which contributes nothing to the PDF path `writeSnapshot` uses, so a
        // screenshot of this state cannot show them whether they are there or
        // not.
        //
        // `cardTop` is reported in the PAGE's coordinates, y down from the top
        // of the window, because the thing it has to be compared against is the
        // tooltip chip's box and that is what the page measures in. Reporting
        // it in AppKit's would give a difference that looks like clearance and
        // is an inversion.
        if measure.enabled {
            // Only for the reading. AppKit lays the screen out in this same
            // pass, so the app needs nothing here; forcing it in the ordinary
            // path would be a layout run inside the one that asked for it.
            missingFileScreen.layoutSubtreeIfNeeded()
            let card = missingFileScreen.cardRect
            let cardTop = band + (missingFileScreen.bounds.height - card.maxY)
            measure.trace("missingscreen webviewHidden=\(host.webView.isHidden)"
                            + " band=\(Int(band)) area=\(Int(missingFileScreen.frame.height))"
                            + " content=\(Int(bounds.height))"
                            + " cardTop=\(Int(cardTop)) cardH=\(Int(card.height))")
        }
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
        Prefs.rebind(to: url, slot: bindingSlot)
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
        writeLatest("saveMissingNoteBack")
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
    ///   4. point the setting this WINDOW is bound through at the new path
    ///      (`Prefs.rebind`, with this window's `bindingSlot`), which is the
    ///      one that was read to get here. Writing any of the others would
    ///      leave the next launch opening a file that never moved, and with
    ///      several windows would move another window's binding.
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
            Prefs.rebind(to: target, slot: bindingSlot)
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
    /// `titleBar.titleView.frame.maxX` is where the window's own furniture
    /// ends. It already accounts for the traffic lights, because AppKit places
    /// a leading accessory after them, so nothing here repeats a number the
    /// system owns.
    func layoutTitlebarDrag() {
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
            titleChromeWidth: titleView.chromeWidth,
            trailingControlsWidth: titlebarControlsWidth))
        let leading = titleView.convert(titleView.bounds, to: contentView).maxX
        let bandHeight = titlebarBandHeight
        guard bandHeight > 0,
              let span = TitlebarBand.draggableSpan(
                  windowWidth: contentView.bounds.width,
                  leading: leading,
                  trailingControlsWidth: titlebarControlsWidth) else {
            titlebarDrag.isHidden = true
            // A hidden view gets no `mouseExited`, so the hover it last
            // reported would stand for as long as the window stayed narrow.
            titleBar.titleView.setBandHovered(false)
            return
        }
        titlebarDrag.isHidden = false
        // And again here, because this is where a band that has CHANGED height
        // is noticed (full screen, a titlebar style the system swaps under us),
        // and nothing else asks. `refreshTitlebarControlsWidth` sends it too,
        // for an ordering reason of its own; the send is guarded on the value
        // having moved, so whichever of the two is second costs nothing.
        host.setTitlebarBandHeight(bandHeight)
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
        // Bring the page's band height up to date BEFORE the measuring query,
        // and the order is the whole reason this line is here rather than only
        // in the layout pass. The page's first row takes that height and
        // centres its controls in it, so a row measured before it arrives is a
        // row still on its fallback, and every number that comes back
        // describes a layout that is about to change. Two evaluations on one
        // web view run in the order they were made.
        host.setTitlebarBandHeight(titlebarBandHeight)
        host.reportTitlebarControls { [weak self] controls in
            MainActor.assumeIsolated {
                guard let self, let controls else { return }
                self.titlebarControlsWidth = controls.width
                self.titleBar.titleView.actionsView.setBandChrome(
                    hoverFill: controls.hoverFill, cornerRadius: controls.cornerRadius)
                self.layoutTitlebarDrag()
                self.traceTitlebarDrag()
                self.traceTitlebarStrip(controls)
            }
        }
    }

    /// The two halves of the band, side by side, for `jot/scripts/measure.sh`.
    ///
    /// The claim is that they read as ONE strip of controls, and it is a claim
    /// about a pair: each half is defensible alone and no screenshot of either
    /// says whether they agree. Four things carry it, and each names a way the
    /// pair has been visibly wrong.
    ///
    ///   midY    the axis the glyphs sit on. macOS centres a window title on
    ///           the close button, and the native strip follows the title, so
    ///           this is the number the page has to meet rather than the other
    ///           way round.
    ///   box     the target a pointer has to find.
    ///   gap     the air between two buttons, which is what the eye reads as
    ///           the rhythm of a row.
    ///   wash    whether hover is said the same way at all. The colour itself
    ///           is not compared, because the native half takes it FROM the
    ///           page and a comparison would be asking a value whether it
    ///           equals itself. What can go wrong is that it never arrives,
    ///           and that is what this reports.
    ///
    /// Reported in the page's coordinates for both halves: y down from the top
    /// of the window, which is what the page measures in and what the native
    /// side has to be converted into. Mixing the two conventions here would
    /// produce a difference that looks like a misalignment and is an inversion.
    private func traceTitlebarStrip(_ controls: WebHost.TitlebarControls) {
        guard measure.enabled else { return }
        let buttons = titleBar.titleView.actionsView.buttons
        let boxes = buttons.map { $0.convert($0.bounds, to: nil) }
        // AppKit window coordinates are y-up from the bottom; the page is
        // y-down from the top.
        let height = panel.frame.height
        let mids = boxes.map { height - $0.midY }
        let nativeMidY = mids.isEmpty ? 0 : mids.reduce(0, +) / CGFloat(mids.count)
        let ordered = boxes.sorted { $0.minX < $1.minX }
        let gaps = zip(ordered.dropFirst(), ordered).map { $0.minX - $1.maxX }
        measure.trace(String(
            format: "titlebarstrip nativeCount=%d nativeMidY=%.1f nativeBoxW=%.1f nativeBoxH=%.1f nativeGap=%.1f " +
                    "nativeWash=%@ pageCount=%d pageMidY=%.1f pageBoxW=%.1f pageBoxH=%.1f pageGap=%.1f " +
                    "pageRowH=%.1f pageRowPadTop=%.1f pageBandVar=%@",
            boxes.count, nativeMidY, boxes.first?.width ?? 0, boxes.first?.height ?? 0, gaps.min() ?? 0,
            buttons.first?.hasHoverFill == true ? "yes" : "none",
            controls.count, controls.midY, controls.boxWidth, controls.boxHeight, controls.gap,
            controls.rowHeight, controls.rowPadTop, controls.bandVar))
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
        traceTitleActions()
    }

    /// The two file buttons the titlebar draws, at rest and hovered.
    ///
    /// The same shape as `traceChevron` and for the same reasons, plus one
    /// claim that view cannot make: the buttons' GEOMETRY has to be identical
    /// in both states. The drag strip is laid out by the window and starts
    /// where the accessory ends, so buttons that took their width on hover
    /// would leave the strip lying over them, and the clicks would land on the
    /// window drag. Both frames are reported rather than compared here,
    /// because a probe that did its own comparison would report one boolean
    /// and lose the two numbers that say which way it went.
    ///
    /// `symbols` is the arm that stops the rest reporting healthily about
    /// nothing: `NSImage(systemSymbolName:)` answers nil for a name the system
    /// does not carry, so a renamed or withdrawn SF Symbol gives two buttons
    /// that are positioned, offered, and blank.
    private func traceTitleActions() {
        guard measure.enabled else { return }
        let view = titleBar.titleView
        let rest = view.actionsForMeasurement(hovered: false)
        let over = view.actionsForMeasurement(hovered: true)
        _ = view.actionsForMeasurement(hovered: false)   // leave it as we found it
        let box = { (frames: [NSRect]) -> String in
            frames.map { String(format: "%.1f:%.1f", $0.origin.x, $0.width) }.joined(separator: ",")
        }
        measure.trace(String(
            format: "titleactions count=%d symbols=%d restShown=%@ overShown=%@ restBoxes=%@ overBoxes=%@ chevronMaxX=%.1f",
            over.frames.count, over.symbols,
            rest.shown ? "yes" : "no", over.shown ? "yes" : "no",
            box(rest.frames), box(over.frames),
            view.labelFrameInWindow().width + view.chromeWidth - view.actionsView.room))
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

    /// Chrome follows attention: everything on while the window has the
    /// pointer OR the keyboard, and a page with a caret in it when it has
    /// neither. Wholly the page's, as a body class its own stylesheet reads;
    /// the window's own title is not part of it, because macOS titles a window
    /// whether or not you are looking at it.
    ///
    /// BOTH, and the pointer alone was the bug. A window you are typing in,
    /// with the pointer parked somewhere else on the screen, is not at rest,
    /// and hiding its controls mid-sentence is the version of this idea that
    /// makes people turn it off. What is left is the case it was for: a window
    /// in the background that nobody is pointing at.
    ///
    /// Takes NOTHING and reads both inputs itself, which is the whole reason it
    /// can be called from anywhere. `NoteContentView.isHovering` is assigned
    /// before `onHoverChange` fires, so a caller holding the new value has
    /// nothing the callee cannot read, and a parameter would only offer each
    /// site a way to pass a different answer than the one in force.
    ///
    /// What is pinned and what is not, because the two halves are not equally
    /// covered. The native half's rule is a property of `TitleBarView` and
    /// `TitlebarActionsTests` asks it directly, both ways. The page half is
    /// this line, and the thing most likely to break it is the WIRING: it has
    /// to be called from the pointer's tracking area, from BOTH key
    /// notifications, and once at boot, and a missing one of those is silent.
    /// Nothing checks that, because what it writes is JavaScript into a live
    /// WKWebView. If this file grows a spy for the host, that is the check to
    /// add. Until then, every call site being the same bare call is the cheap
    /// half of the protection: what is left to get wrong is whether a site
    /// calls it, not what it passes.
    private func applyChromeVisibility() {
        let awake = contentView.isHovering || panel.isKeyWindow
        host.setChromeResting(!awake)
        // The native half of the same band takes the same answer. It has its
        // own two hover sources, the title view's tracking area and the drag
        // strip's, and both are strips of the titlebar: without this, a pointer
        // resting in the middle of the document on a window that is not key
        // would light the page's buttons and leave the file buttons dark, and a
        // titlebar that fills from one end reads as a fault rather than as a
        // window waking up.
        //
        // The POINTER, not `awake`: the native side reads key state itself
        // (`TitleBarView.isKey`), so handing it the combined answer would tell
        // it the pointer is on the band whenever the window is key, and the
        // band would stop being able to tell those two apart.
        titleBar.titleView.setBandHovered(contentView.isHovering)
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
            panel.allowedContentTypes = DocumentTypes.writtenContentTypes
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

    /// Run an editor command in the page: the one path every command row in
    /// `JotMenu` reaches, whether it was picked from a menu or fired by its key
    /// equivalent, which AppKit takes before the page sees the keydown.
    ///
    /// Summoning first is what makes the key equivalents work at all from the
    /// Settings or About window, whose responder chain reaches this menu and
    /// not the panel's editor.
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
                // A settings change can have moved the notes under this
                // window, which is one of the two gestures that rebind by
                // writing a slot rather than by naming a path.
                self.rebindFromSettings()
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
        if !initial {
            host.setThemeClass(cls)
            // The page's palette has just flipped, and half this band's chrome
            // is taken from it (`refreshTitlebarControlsWidth` reads the hover
            // wash). Nothing else re-asks: a theme change swaps a class on the
            // live page rather than reloading it, so without this the native
            // buttons keep washing in the colour of the theme you left.
            refreshTitlebarControlsWidth()
        }
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
