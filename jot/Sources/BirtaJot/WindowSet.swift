import AppKit
import BirtaJotCore

/// The app's windows, and everything that belongs to the APP rather than to
/// any one of them.
///
/// A `Coordinator` is a window: a panel, a WKWebView, a writer, a title and one
/// bound file. It was also, for as long as there was exactly one of them, the
/// place four process-wide registrations happened to live. That is invisible
/// while there is one instance and wrong the moment there are two, in a
/// different way each time:
///
/// * `GlobalHotkey` installs a handler on the process-wide Carbon event
///   dispatcher and registers a FIXED `EventHotKeyID`. A second instance
///   installs a second handler, so one press runs both, and its exclusive
///   registration can come back `eventHotKeyExistsErr`, which the app would
///   report as "another app may own it": misdiagnosing itself.
/// * The measurement signals are one `SIGUSR1` and one `SIGURG` per process,
///   and the message file they read is one fixed path. N handlers would run
///   every probe N times, against one file, which does not make the harness
///   noisy so much as unable to say which window it measured.
/// * `NSEvent.addLocalMonitorForEvents` is app-wide, so N monitors run on
///   every keystroke in the app. The double-Escape guard would still act only
///   for the key window, so this is a cost rather than a bug, until windows
///   start closing: nothing removes the monitor, so each closed window leaves
///   one behind for the life of the process.
/// * `previousApp` is a fact about the APP, not a window. It is captured only
///   when the frontmost application is not us, so a second window summoned
///   while the app is already frontmost captures nothing, and dismissing that
///   window would fall through to `NSApp.hide` and take the other windows with
///   it.
///
/// So they live here, once. What stays in `Coordinator` is everything that is
/// genuinely about one window, which is nearly all of it.
///
/// ## Summon shows and hides the whole set
///
/// Decided rather than inherited: the hotkey brings up every window and
/// dismisses every window, as one workspace. That is why the overlay manners
/// stay on all of them, and it is also what keeps this file simple, because
/// the alternative (summon the most recent) makes `NSApp.hide` and the
/// return-to-previous-app step a per-window arbitration with no good answer.
@MainActor
final class WindowSet {
    /// The windows, in the order they were made.
    private(set) var windows: [Coordinator] = []

    /// THE summon key: one Carbon registration for the process.
    let hotkey = GlobalHotkey()

    /// What was frontmost when the app was last summoned over it, so dismissal
    /// puts the user back rather than dropping them on the desktop.
    ///
    /// Captured through `Coordinator.onWillShow` rather than only in
    /// `summonAll`, because a window can come forward without the hotkey: Open
    /// With from the Finder is exactly that, and returning to the Finder
    /// afterwards is the behaviour worth keeping.
    private var previousApp: NSRunningApplication?

    private var escMonitor: Any?
    private var lastEscape: TimeInterval = 0
    private var debugSignals: [DispatchSourceSignal] = []

    /// The Settings window is the app's, not a window's, so it is dismissed
    /// when the whole set goes rather than when any one window does.
    var openPreferences: (() -> Void)?
    var hidePreferences: (() -> Void)?

    /// The window a command should act on.
    ///
    /// The key window, and the first one otherwise, which is what an accessory
    /// app needs: it can be asked to do something from its menu-bar item while
    /// none of its windows is key, or while it is not even frontmost.
    var key: Coordinator? {
        windows.first(where: \.isKey) ?? windows.first
    }

    var isAnyVisible: Bool { windows.contains(where: \.isVisible) }

    // MARK: making windows

    /// Adopt a window and give it the hooks that reach back to the app.
    @discardableResult
    func adopt(_ coordinator: Coordinator) -> Coordinator {
        coordinator.openPreferences = { [weak self] in self?.openPreferences?() }
        coordinator.onWillShow = { [weak self] in self?.capturePreviousApp() }
        coordinator.onCloseRequest = { [weak self] in self?.close(coordinator) }
        coordinator.onHotkeyChanged = { [weak self] in self?.registerHotkey() ?? -1 }
        windows.append(coordinator)
        return coordinator
    }

    /// Where the next spawned window goes, carried between spawns so a third
    /// window steps off the second rather than back onto the first.
    private var cascadePoint: NSPoint?

    /// The first window, at launch.
    ///
    /// "Open to a blank note" is decided here rather than inside a window,
    /// because it is a rule about LAUNCHING and not about being a window: a
    /// window opened later by New Note or Open must not consult it. It runs
    /// before the first page loads, so the editor mounts against the file it
    /// will actually edit rather than mounting the last one and swapping it
    /// out a moment later.
    @discardableResult
    func openFirstWindow() -> Coordinator {
        if Prefs.openToBlankNote, Prefs.documentURL == nil { Self.startBlankNote() }
        return makeWindow(on: Prefs.activeURL, slot: Prefs.activeSlot)
    }

    /// The launch half of New Note: a fresh file, chosen before anything has
    /// loaded, so there is no buffer to flush and nothing to write first.
    private static func startBlankNote() {
        do {
            Prefs.currentNoteURL = try Coordinator.makeNoteFile()
        } catch {
            // The scratchpad is the fallback, and it is a good one: the setting
            // says where to START, not that the old note may be lost.
            NSLog("Birta Writer: could not start a blank note: \(error)")
        }
    }

    /// Cmd+N: a new note, in a new window.
    ///
    /// Nothing is flushed or written first, which is the difference from what
    /// this gesture used to do. It used to replace the buffer, so the note
    /// being left had to be put beyond doubt before it went; now it is not
    /// being left at all, and the window it is in keeps it.
    func newNote() {
        do {
            let target = try Coordinator.makeNoteFile()
            Prefs.currentNoteURL = target
            open(makeWindow(on: target, slot: .currentNote))
        } catch {
            NSLog("Birta Writer: could not make a new note: \(error)")
            key?.flashStatus("Could not make a new note.")
        }
    }

    /// Open a file: the Finder's Open With, a drop on the Dock icon, `open -a`,
    /// Cmd+O, or a row of Open Recent. In a new window.
    ///
    /// A file already open brings ITS window forward instead of opening a
    /// second one. That is a data-loss guard rather than tidiness: two windows
    /// over one path hold two uncoordinated `CoalescingWriter`s, each writing
    /// the whole file, so the later write wins silently, and this app has no
    /// external-change detection anywhere that would notice.
    ///
    /// `FileIdentity.sameFile` rather than comparing paths, because the
    /// question is whether it is the same FILE: two paths through a symlinked
    /// folder, `/tmp` against `/private/tmp`, and a case-insensitive volume are
    /// all the same file spelled differently, and each is a way to end up with
    /// two windows over one note.
    func openDocument(at url: URL) {
        let target = url.standardizedFileURL
        guard DocumentTypes.accepts(target) else {
            summonAll()
            key?.flashStatus("Birta Writer does not open \(target.lastPathComponent).")
            return
        }
        if let open = windows.first(where: { FileIdentity.sameFile($0.boundFile, target) }) {
            open.show()
            return
        }
        Prefs.documentURL = target
        open(makeWindow(on: target, slot: .document))
    }

    /// Cmd+O. Ask for a file, then open it the way the Finder's Open With does.
    ///
    /// Everything about opening is `openDocument(at:)`'s, so this is only the
    /// chooser. That is the point of the split: a file arriving from a panel
    /// and a file arriving from the Finder must reach a window by one path, or
    /// the two acquire different answers about what happens to what is open.
    ///
    /// App-modal rather than a sheet on the window it was raised from, which is
    /// what it used to be. The file chosen here does not belong to that window;
    /// it gets one of its own. A sheet would say the opposite, and it would
    /// also be a sheet on a window an accessory app may not have on screen.
    ///
    /// The chooser starts in the folder of the file in front, which is where a
    /// second note usually is. `Prefs.saveAsDirectory` is deliberately not
    /// reused: that is where copies are written OUT to, and starting there
    /// points at a folder of exports rather than at the notes.
    func openDocumentPanel() {
        NSApp.activate(ignoringOtherApps: true)
        let chooser = NSOpenPanel()
        chooser.title = "Open"
        chooser.allowedContentTypes = DocumentTypes.openedContentTypes
        chooser.allowsMultipleSelection = false
        chooser.canChooseDirectories = false
        chooser.canChooseFiles = true
        chooser.directoryURL = (key?.boundFile ?? Prefs.activeURL).deletingLastPathComponent()
        guard chooser.runModal() == .OK, let url = chooser.url else { return }
        openDocument(at: url)
    }

    /// The close button and Cmd+W.
    ///
    /// The LAST window hides rather than closing, and that is load-bearing
    /// rather than a nicety. Hiding keeps the page mounted, which is what makes
    /// the next summon instant; tearing the WKWebView down would turn every
    /// summon after a Cmd+W into a cold start, which is the promise this whole
    /// app is built around. Somebody running one window therefore sees exactly
    /// the behaviour they always did.
    ///
    /// Any other window really closes, through the same question a quit asks of
    /// it: with autosave off and unwritten bytes it asks, and Cancel leaves the
    /// window where it is.
    func close(_ coordinator: Coordinator) {
        guard windows.count > 1 else {
            dismissAll()
            return
        }
        coordinator.prepareToClose { [weak self] proceed in
            guard proceed, let self else { return }
            self.windows.removeAll { $0 === coordinator }
            coordinator.tearDown()
        }
    }

    /// Mount a freshly made window's page and put it on screen.
    ///
    /// Separate from `makeWindow` because the FIRST window does neither at the
    /// same moment: launch builds it, then builds the menus and the status
    /// item, then starts it, and shows it only if this launch was asked to
    /// open something. Every window made later is wanted now.
    private func open(_ coordinator: Coordinator) {
        coordinator.start()
        coordinator.show()
    }

    /// Build a window, hand it its hooks, and place it off the one in front.
    @discardableResult
    private func makeWindow(on url: URL, slot: ActiveBinding.Slot?) -> Coordinator {
        // Only one window may hold a slot, so taking it releases whoever had
        // it. Otherwise two windows would both believe a rename of their file
        // should be written to the same setting, and the second would overwrite
        // what the first had written there.
        if let slot {
            windows.filter { $0.bindingSlot == slot }.forEach { $0.bindingSlot = nil }
        }
        let spawn = key
        // The FIRST window is the one that remembers its frame between
        // launches, under the historic autosave name, so a panel somebody has
        // spent months positioning is where they left it.
        let made = Coordinator(boundTo: url, slot: slot, remembersFrame: windows.isEmpty)
        adopt(made)
        if let spawn { cascadePoint = made.cascade(after: spawn, from: cascadePoint) }
        return made
    }

    // MARK: quitting

    /// Every window's answer, joined into the one reply AppKit accepts.
    ///
    /// Serial rather than concurrent, because each window may put a sheet up
    /// and macOS asks about one document at a time; N sheets at once, on
    /// windows several of which are hidden and would summon themselves to ask,
    /// is not a quit anybody could answer.
    ///
    /// One Cancel refuses the whole quit, and the windows that already answered
    /// have to forget their answers: they are marked decided, which suppresses
    /// their last-chance write, and the quit they decided for is not happening.
    ///
    /// The summon key is given up only once every window has agreed, for the
    /// same reason it is not given up inside a window: releasing it early would
    /// leave the app running with no way to summon it as soon as the third
    /// window said Cancel.
    func prepareToTerminate(_ done: @escaping (Bool) -> Void) {
        var remaining = windows
        func ask() {
            guard !remaining.isEmpty else {
                releaseHotkey()
                done(true)
                return
            }
            let next = remaining.removeFirst()
            next.prepareToClose { [weak self] proceed in
                guard let self else { done(proceed); return }
                guard proceed else {
                    self.windows.forEach { $0.forgetQuitDecision() }
                    done(false)
                    return
                }
                ask()
            }
        }
        ask()
    }

    /// The last-chance write, for every window rather than the front one.
    func finalWrite() {
        windows.forEach { $0.finalWrite() }
    }

    /// Nobody is there to answer a sheet, so every window writes instead of
    /// asking. On all of them: a sheet on the second window would wait just as
    /// forever as one on the first.
    func quitUnattended() {
        windows.forEach { $0.quitIsUnattended = true }
    }

    // MARK: summon and dismiss

    func toggle() {
        if isAnyVisible && NSApp.isActive { dismissAll() } else { summonAll() }
    }

    func summonAll() {
        windows.forEach { $0.show() }
    }

    /// Dismiss first, flush after, which is `Coordinator.hide`'s rule and the
    /// reason it is not a teardown.
    func dismissAll() {
        guard isAnyVisible else { return }
        // Settings belongs to the app, not to a window. Left behind it is a
        // window with no editor to change the settings OF, floating over
        // whatever the user went back to.
        hidePreferences?()
        windows.forEach { $0.hide() }
        returnToPreviousApp()
    }

    private func capturePreviousApp() {
        if let front = NSWorkspace.shared.frontmostApplication, front != .current {
            previousApp = front
        }
    }

    private func returnToPreviousApp() {
        if let prev = previousApp, prev.isTerminated == false {
            prev.activate()
        } else {
            NSApp.hide(nil)
        }
        previousApp = nil
    }

    // MARK: process-wide registrations

    func start() {
        let status = registerHotkey()
        if status != noErr {
            NSLog("Birta Writer: hotkey \(Prefs.hotkey.spelling) registration failed (\(status)); another app may own it")
        }
        installEscapeMonitor()
        if Measure.isEnabled { installDebugSignals() }
    }

    /// Register or re-register the summon key. The Settings recorder and the
    /// first-run screen both reach this, and both need the status back: an
    /// exclusive registration is the only way a chord another app already owns
    /// is ever reported at all.
    @discardableResult
    func registerHotkey() -> OSStatus {
        hotkey.onPress = { [weak self] in
            self?.key?.markHotkeyPressed()
            self?.toggle()
        }
        return hotkey.register(Prefs.hotkey)
    }

    /// Given up only once a quit is certain. Unregistering before the last
    /// window has answered would leave the app running with no summon key for
    /// the rest of the session if any of them said Cancel.
    func releaseHotkey() {
        hotkey.unregister()
    }

    /// Double-Escape dismisses: the first bare Escape belongs to the editor
    /// (block selection, closing a menu); a second within the window dismisses.
    ///
    /// ONE monitor for the app, dispatching to whichever window is key, rather
    /// than one per window each filtering the same keystroke.
    private func installEscapeMonitor() {
        escMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.key?.isKey == true, event.keyCode == 53,
                  event.modifierFlags.intersection([.command, .option, .control, .shift]).isEmpty else { return event }
            let now = ProcessInfo.processInfo.systemUptime
            if now - self.lastEscape < 0.4 {
                self.lastEscape = 0
                self.dismissAll()
                return nil
            }
            self.lastEscape = now
            return event
        }
    }

    /// Measurement hooks, only under BIRTA_JOT_MEASURE=1: SIGUSR1 summons and
    /// dismisses as the hotkey would (a shell cannot press a global hotkey
    /// without an Accessibility grant); SIGURG posts a message file to the
    /// page. `jot/scripts/measure.sh` drives both, and stages cold recovery
    /// itself by killing the WebContent helper (the private
    /// `_killWebContentProcess` selector does not reach
    /// `webViewWebContentProcessDidTerminate`).
    private func installDebugSignals() {
        let actions: [(Int32, () -> Void)] = [
            (SIGUSR1, { [weak self] in
                self?.key?.markHotkeyPressed()
                self?.toggle()
            }),
            (SIGURG, { [weak self] in self?.key?.postDebugMessageFile() }),
        ]
        for (sig, action) in actions {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler(handler: action)
            source.resume()
            debugSignals.append(source)
        }
        if ProcessInfo.processInfo.environment["BIRTA_JOT_SHOW_ON_LAUNCH"] == "1" {
            DispatchQueue.main.async { [weak self] in self?.summonAll() }
        }
    }
}
