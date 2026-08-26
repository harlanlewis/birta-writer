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
        coordinator.onDismissRequest = { [weak self] in self?.dismissAll() }
        coordinator.onHotkeyChanged = { [weak self] in self?.registerHotkey() ?? -1 }
        windows.append(coordinator)
        return coordinator
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
