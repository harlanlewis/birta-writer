import AppKit
import WebKit
import BirtaJotCore

/// The app: status item, main menu, and the Coordinator that ties the hotkey,
/// the panel, the web host and the store together.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var statusMenu: NSMenu!
    private var coordinator: Coordinator!
    private var settingsWindow: SettingsWindowController?
    private var showItem: NSMenuItem!
    private var terminationSignal: DispatchSourceSignal?
    /// The view the overflow menu was opened from, for the sharing picker,
    /// which needs somewhere on screen to point at.

    /// THE activation-policy rule, with two callers: `Entry.main` at launch
    /// and the Settings switch when it moves. A Dock icon means Cmd+Tab, an
    /// app menu of its own, and a Dock click that has to lead somewhere.
    /// `.accessory` is the default and what `LSUIElement` declares, so a launch
    /// never flashes an icon it is about to take away.
    static func applyActivationPolicy() {
        NSApp.setActivationPolicy(Prefs.showInDock ? .regular : .accessory)
    }

    /// Clicking the Dock icon summons the panel. Without this the icon is a
    /// button that does nothing, which is worse than no icon at all.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        coordinator.show()
        return true
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Before anything reads a preference, and before the panel is built.
        Prefs.sweepRetiredKeys()
        buildMainMenu()
        coordinator = Coordinator()
        coordinator.openPreferences = { [weak self] in self?.menuOpenSettings() }
        coordinator.hidePreferences = { [weak self] in self?.settingsWindow?.close() }
        buildStatusItem()
        coordinator.start()
        // Asked once a launch, in the background, and silent unless there is
        // something. `Updater` refuses for a development build, when the
        // setting is off, and under a throwaway defaults domain.
        updater.onStatus = { [weak self] message in self?.coordinator.flashStatus(message) }
        // Off the main-queue drain before anything modal. `onUpdateAvailable`
        // fires from inside `Updater`'s continuation, and an `NSAlert` spun
        // from there runs a nested run loop that libdispatch will not
        // re-enter: every `DispatchQueue.main.async` in the app, the sync
        // scheduler's max-wait and the flush timeout among them, stops being
        // serviced for as long as the alert is on screen. On an unattended
        // machine that is indefinitely.
        updater.onUpdateAvailable = { [weak self] tag in
            RunLoop.main.perform(inModes: [.common]) {
                MainActor.assumeIsolated { self?.offerUpdate(tag) }
            }
        }
        updater.checkInBackground()
        // First launch only, and after the panel exists, so the screen has a
        // window to take over.
        // `BIRTA_JOT_DEFAULTS_SUITE` gives a checking run its own domain, so a
        // run would meet this window every time; skipped there for the same
        // reason the panel does not remember its frame.
        //
        // `BIRTA_JOT_OPEN_WELCOME=1` shows it regardless, which is how the
        // screen is proven to construct without a person and without a first
        // launch: the gate below deliberately never fires under a throwaway
        // domain, so nothing else would ever build it.
        if ProcessInfo.processInfo.environment["BIRTA_JOT_OPEN_WELCOME"] == "1"
            || (Prefs.isUserStore && !Prefs.hasSeenWelcome) {
            showWelcome()
        }
        // A settings window can otherwise only be opened by a person, which
        // makes "does it construct" a question nothing but a human can answer.
        // Same seam as BIRTA_JOT_SCRATCHPAD and BIRTA_JOT_DEFAULTS_SUITE, and
        // used by the same script.
        if let tab = ProcessInfo.processInfo.environment["BIRTA_JOT_OPEN_SETTINGS"], !tab.isEmpty {
            menuOpenSettings()
            // Panes are built on first show, so naming one is what proves it
            // constructs. "1" opens the window on whichever pane is default.
            settingsWindow?.selectTabForTesting(tab)
        }
        installTerminationSignal()
    }

    /// SIGTERM runs the same flush-then-quit path as the menu's Quit.
    ///
    /// AppKit installs no handler of its own, so the default action would kill
    /// the process outright and `applicationShouldTerminate` would never get to
    /// flush the buffer. jot/scripts/install-app.sh signals a running copy this
    /// way before replacing it, and anything else that manages the process
    /// (a shell, a login-item manager) reaches for SIGTERM too.
    ///
    /// The terminate is handed to the RUN LOOP rather than called here, and it
    /// must stay that way. `applicationShouldTerminate` answers `.terminateLater`
    /// and the reply arrives on the main queue; starting that wait from inside a
    /// main-queue drain, which is where this handler runs, means the reply's own
    /// block never gets serviced. The app then sits alive forever, having run
    /// neither the flush nor the quit.
    private func installTerminationSignal() {
        signal(SIGTERM, SIG_IGN) // the source below handles it, not the default action
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler {
            NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 0)
        }
        source.resume()
        terminationSignal = source
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        coordinator.prepareToTerminate {
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        coordinator.finalWrite()
    }

    // MARK: menus

    /// The main menu is invisible for an accessory app but load-bearing: key
    /// equivalents route through it, and Cmd+C/V/X/Z inside the WKWebView
    /// only work when an Edit menu with the standard selectors exists.
    private func buildMainMenu() {
        let main = NSMenu()

        let appMenu = NSMenu(title: AppFlavor.current.displayName)
        appMenu.addItem(withTitle: "About \(AppFlavor.current.displayName)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        JotMenu.add(.app, to: appMenu, target: self)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide \(AppFlavor.current.displayName)", action: #selector(hidePanel), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit \(AppFlavor.current.displayName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem(); appItem.submenu = appMenu; main.addItem(appItem)

        // The conventional File menu, with the conventional chords: Cmd+S
        // saves the document being edited and Shift+Cmd+S writes a copy
        // elsewhere. Neither empties the panel.
        let fileMenu = NSMenu(title: "File")
        JotMenu.add(.file, to: fileMenu, target: self)
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Back to My Notes", action: #selector(menuBackToNotes), keyEquivalent: "")
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Copy Everything", action: #selector(copyEverything), keyEquivalent: "")
        // Share is a File-menu verb on macOS, and this is now its only route:
        // the panel's ··· menu is gone, and the other three rows it carried
        // were already here.
        fileMenu.addItem(withTitle: "Share…", action: #selector(shareNote), keyEquivalent: "")
        fileMenu.addItem(withTitle: "Reveal Last Save in Finder", action: #selector(revealLastSave), keyEquivalent: "")
        fileMenu.delegate = self
        // Before Close is added: it goes to the key window through the
        // responder chain, so Cmd+W closes the Settings window when that is
        // what is in front, and hides the panel when the panel is (JotPanel
        // turns `close` into a hide).
        for item in fileMenu.items where item.action != nil { item.target = self }
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let fileItem = NSMenuItem(); fileItem.submenu = fileMenu; main.addItem(fileItem)

        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(.separator())
        // The extension binds these as VS Code keybindings; here the menu is
        // the binding, and each runs the same editor command in the page.
        JotMenu.add(.edit, to: editMenu, target: self)
        let editItem = NSMenuItem(); editItem.submenu = editMenu; main.addItem(editItem)

        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        let windowItem = NSMenuItem(); windowItem.submenu = windowMenu; main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }

    /// The menu-bar item. A click toggles the panel, which is what the item is
    /// for; the menu is on Control-click and right-click, where a menu belongs.
    ///
    /// `statusItem.menu` stays nil for that to work: an item with a menu shows
    /// it on every click and never sends its action, so the menu is attached
    /// for the length of one `performClick` and taken off again.
    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = Self.statusItemImage()
            button.toolTip = AppFlavor.current.displayName
            button.target = self
            button.action = #selector(statusItemClicked)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        let menu = NSMenu()
        // The panel toggle, and nothing about where files live: that belongs in
        // the window, next to the note it would act on.
        showItem = menu.addItem(withTitle: "Show \(AppFlavor.current.displayName)", action: #selector(togglePanel), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Settings…", action: #selector(menuOpenSettings), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit \(AppFlavor.current.displayName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        for item in menu.items where item.action != nil && item.action != #selector(NSApplication.terminate(_:)) {
            item.target = self
        }
        menu.delegate = self
        statusMenu = menu
    }

    /// The menu-bar mark. A template image, so macOS draws it from its alpha
    /// alone and it inverts for a dark menu bar and for the highlighted state;
    /// a coloured image would stay dark on dark. PDF, so it is drawn at the
    /// display's own backing scale rather than resampled from one bitmap.
    ///
    /// Drawn smaller than the bar's own thickness, so the GLYPH stands as tall
    /// as the ones beside it. The SF Symbols in the menu bar carry their
    /// padding inside the box they are asked for, so their visible mark is
    /// shorter than the size they are given, and matching that size draws a
    /// visibly larger neighbour.
    ///
    /// The number is about the DRAWN HEIGHT and not about the artwork's shape,
    /// and the distinction is load-bearing because the artwork has changed
    /// under it more than once. The mark today is a stroked square holding a
    /// letter; a square reaches its own edges, so the drawn height and the box
    /// are the same thing and this number holds directly. A mark that did not
    /// fill its box would land shorter at the same number.
    ///
    /// Check that by measuring against the running bar rather than by looking:
    /// a lighter mark reads small at exactly the size that makes it the right
    /// height, and the answer to that is the drawing rather than this constant.
    ///
    /// The symbol is the fallback for `swift run`, which has no bundle to read.
    /// An app with no menu-bar item has no way in at all, so this degrades to
    /// the wrong picture rather than to nothing.
    private static func statusItemImage() -> NSImage? {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("MenuBarTemplate.pdf"),
              let image = NSImage(contentsOf: url) else {
            return NSImage(systemSymbolName: "square.and.pencil", accessibilityDescription: AppFlavor.current.displayName)
        }
        image.isTemplate = true
        image.size = NSSize(width: 16, height: 16)
        image.accessibilityDescription = AppFlavor.current.displayName
        return image
    }

    @objc private func statusItemClicked() {
        let event = NSApp.currentEvent
        let wantsMenu = event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true
        guard wantsMenu else {
            coordinator.toggle()
            return
        }
        statusItem.menu = statusMenu
        statusItem.button?.performClick(nil) // blocks while the menu tracks
        statusItem.menu = nil
    }

    /// Jot's menus carry no icons.
    ///
    /// macOS 26 draws a symbol of its own beside any item whose action it
    /// recognises, which in this app means one icon next to Quit and none
    /// anywhere else: a single decorated row in an otherwise plain menu, which
    /// reads as a mistake rather than as a system convention. Giving an item an
    /// image and taking it away again is what clears the automatic one. macOS
    /// 27 hides symbol images by default and adds `preferredImageVisibility`,
    /// so this covers the versions in between and is harmless on both sides.
    static func suppressAutomaticIcons(in menu: NSMenu) {
        for item in menu.items {
            item.image = NSImage(size: NSSize(width: 1, height: 1))
            item.image = nil
            if let submenu = item.submenu { suppressAutomaticIcons(in: submenu) }
        }
    }

    // MARK: actions

    @objc private func togglePanel() { coordinator.toggle() }
    @objc private func hidePanel() { coordinator.hide() }
    @objc private func copyEverything() { coordinator.copyEverything() }
    @objc func menuSaveNow() { coordinator.saveNow() }
    @objc func menuNewNote() { coordinator.newNote() }
    @objc func menuSaveAs() { coordinator.saveAs() }
    @objc private func revealLastSave() { coordinator.revealLastSave() }
    @objc func menuFind() { coordinator.runEditorCommand("openFind") }
    @objc func menuInsertLink() { coordinator.runEditorCommand("insertLink") }
    @objc func menuToggleTaskChecked() { coordinator.runEditorCommand("toggleTaskChecked") }


    @objc private func shareNote() { coordinator.shareNote() }

    /// Show the first-run screen, which lives IN the panel rather than in a
    /// window of its own. The Advanced button that re-shows it comes here too.
    func showWelcome() {
        coordinator.showWelcome()
    }

    @objc func menuBackToNotes() { coordinator.backToNotes() }

    /// Say a newer release exists, and let the user take it or leave it.
    ///
    /// A sheet rather than a silent swap: replacing the app somebody is typing
    /// into is not a thing to do behind them, and this is the one moment where
    /// asking costs nothing because nothing has been downloaded yet.
    private func offerUpdate(_ tag: String) {
        guard let release = updater.available else { return }
        let alert = NSAlert()
        alert.messageText = "\(AppFlavor.current.displayName) \(tag) is available."
        alert.informativeText = "It will be downloaded, checked, and installed, and Jot will restart. "
            + "Your note is written first and is not touched."
        alert.addButton(withTitle: "Install and Restart")
        alert.addButton(withTitle: "Later")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        updater.install(release) { ok in
            // Quitting is what performs the swap: the staged script waits for
            // this process to go. Through the ordinary
            // `applicationShouldTerminate` path, so the buffer is flushed and
            // written on the way out.
            //
            // Handed to the RUN LOOP, for the reason `installTerminationSignal`
            // gives above and for the same mechanism: this completion runs
            // inside a main-queue drain, `applicationShouldTerminate` answers
            // `.terminateLater`, and the reply arrives on the main queue.
            // libdispatch does not re-enter that drain, so calling terminate
            // directly here leaves the app in a nested run loop with its hotkey
            // already unregistered, alive and unquittable, while the staged
            // script polls for a pid that never goes.
            //
            // NOT `prepareToTerminate` directly either: `applicationShouldTerminate`
            // is its only caller, and calling it here would run the flush twice.
            guard ok else { return }
            NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 0)
        }
    }

    /// Keeps the release build current. Held here rather than on the
    /// coordinator because it outlives any window and belongs to the app.
    let updater = Updater()

    @objc func menuOpenSettings() {
        if settingsWindow == nil {
            settingsWindow = SettingsWindowController(
                onHotkeyChange: { [weak self] in self?.coordinator.hotkeyChanged() ?? -1 },
                onChange: { [weak self] in self?.coordinator.preferencesChanged() },
                onShowWelcome: { [weak self] in self?.showWelcome() },
                onCheckForUpdates: { [weak self] in self?.updater.checkNow() })
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.showWindow(nil)
        settingsWindow?.window?.makeKeyAndOrderFront(nil)
    }
}

extension AppDelegate: NSMenuDelegate, NSMenuItemValidation {
    func menuNeedsUpdate(_ menu: NSMenu) {
        // The hotkey as a real key equivalent, not as text appended to the
        // title: AppKit then draws it where every other menu draws one, right
        // aligned and dimmed. It binds nothing new, because a status item's
        // menu is not searched for key equivalents; the global hotkey is
        // registered with Carbon and works whatever has focus.
        let combo = coordinator.hotkey.combo ?? Prefs.hotkey
        showItem.title = coordinator.isVisible ? "Hide \(AppFlavor.current.displayName)" : "Show \(AppFlavor.current.displayName)"
        showItem.keyEquivalent = combo.menuKeyEquivalent
        showItem.keyEquivalentModifierMask = combo.menuModifierMask

        AppDelegate.suppressAutomaticIcons(in: menu)
    }

    /// Enablement for the main menu and the status menu, which keep their items
    /// between openings.
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        // Nothing that touches the document while the first-run screen is up.
        // Hiding the web view walls off the mouse and, with the first
        // responder moved, the keyboard; the menu bar reaches past both. Cmd+N
        // there would make a note in the folder the screen is still asking
        // about and bind to it, outranking the answer being given, and its
        // status message would be drawn behind the screen.
        if coordinator.isWelcoming, let action = item.action, Self.documentCommands.contains(action) {
            return false
        }
        switch item.action {
        case #selector(copyEverything), #selector(menuSaveAs), #selector(shareNote):
            return coordinator.hasContent
        case #selector(revealLastSave):
            return coordinator.lastSavedURL != nil
        case #selector(menuBackToNotes):
            // Dead unless Jot is actually on a document, which today only an
            // install carrying an older `documentPath` can be.
            return Prefs.documentURL != nil
        default:
            return true
        }
    }

    /// Every menu command that reads or writes the note. Named once so the
    /// first-run gate above cannot drift out of step with the File menu.
    private static let documentCommands: Set<Selector> = [
        #selector(menuNewNote), #selector(menuSaveNow), #selector(menuSaveAs),
        #selector(copyEverything), #selector(shareNote), #selector(revealLastSave),
        #selector(menuBackToNotes), #selector(menuFind), #selector(menuInsertLink),
        #selector(menuToggleTaskChecked),
    ]
}
