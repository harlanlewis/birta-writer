import AppKit
import WebKit
import BirtaJotCore

/// The app: status item, main menu, and the Coordinator that ties the hotkey,
/// the panel, the web host and the store together.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var statusMenu: NSMenu!
    /// The View menu, kept so `menuNeedsUpdate` can tell it from the other two
    /// menus that share this delegate. Without the identity check the status
    /// item's Show/Hide retitle would run on every File and View opening, and
    /// the View menu's own repaint on every status-menu one.
    private var viewMenu: NSMenu?
    /// The app's windows, and the process-wide things that used to live in
    /// the one window there was. `WindowSet` holds why.
    private let windows = WindowSet()

    /// The window a menu command acts on: the key one, or the only one.
    ///
    /// Optional because an accessory app can genuinely have no window to act
    /// on. Every menu row and every titlebar button targets this object rather
    /// than a coordinator, so this is the one place that question is answered.
    private var front: Coordinator? { windows.key }
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
    /// The Dock setting, as an activation policy.
    ///
    /// WHAT to do is `BirtaJotCore.DockPresence`'s, where it is decidable and
    /// checked; this is the AppKit half, which is not. `keepingFrontmost` is
    /// true for a live toggle and false at launch and on the first-run screen,
    /// and the type says why the two differ.
    static func applyActivationPolicy(keepingFrontmost: Bool = false) {
        let action = DockPresence.action(showInDock: Prefs.showInDock,
                                         isRegular: NSApp.activationPolicy() == .regular,
                                         keepingFrontmost: keepingFrontmost)
        guard case let .change(regular, restoreFrontmost) = action else { return }
        // Read BEFORE the policy changes: the deactivation that follows takes
        // the key window with it, so asking afterwards asks a question whose
        // answer the change has already destroyed.
        let front = restoreFrontmost ? NSApp.keyWindow : nil
        NSApp.setActivationPolicy(regular ? .regular : .accessory)
        guard restoreFrontmost else { return }
        // A runloop turn later. `setActivationPolicy` hands the change to the
        // window server and the deactivation that follows is not synchronous
        // with the call, so activating in the same turn is undone a moment
        // afterwards by the very transition it was meant to survive.
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            front?.makeKeyAndOrderFront(nil)
        }
    }

    /// The running delegate.
    ///
    /// For the settings that act on app-level chrome this object owns, which
    /// `applyActivationPolicy` above does not need because it reaches nothing
    /// but `NSApp`. Derived rather than stored: AppKit already holds exactly
    /// one delegate, and a second reference to it is a second thing that can
    /// be stale.
    static var shared: AppDelegate? { NSApp.delegate as? AppDelegate }

    /// THE menu-bar rule, mirroring `applyActivationPolicy` above, with the
    /// same callers: launch, the Settings switch, and a reset.
    ///
    /// The item is CREATED and DESTROYED rather than hidden, because a status
    /// item holds its slot in the bar for as long as it exists and there is no
    /// state in it worth keeping: the menu it shows is built once, separately,
    /// and outlives every item this makes.
    ///
    /// Turning it off cannot make the app unreachable, and that is not this
    /// method's business to check. `AppPresence` holds the rule and the two
    /// settings rows enforce it between them, which is where a user can be
    /// told why rather than simply prevented.
    ///
    /// Deliberately not covered by `BirtaJotTests`, which is the one place in
    /// this app where that suite's convention cannot hold: it builds windows
    /// and never shows them, and there is no equivalent for a status item.
    /// Asking for one puts an icon in the menu bar of whoever is running the
    /// tests. The decidable half is `AppPresence`'s and is swept there.
    func applyMenuBarPresence() {
        guard Prefs.showInMenuBar else {
            if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
            statusItem = nil
            return
        }
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            button.image = Self.statusItemImage()
            button.toolTip = AppFlavor.current.displayName
            button.target = self
            button.action = #selector(statusItemClicked)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        statusItem = item
    }

    /// A file the user pointed this app at, held until there is a Coordinator
    /// to give it to.
    ///
    /// The buffer is required rather than defensive. A launch that came from
    /// Open With delivers its Apple Event around `applicationWillFinishLaunching`,
    /// and the Coordinator is not built until `applicationDidFinishLaunching`
    /// below, so the URL can and does arrive before there is anything to open
    /// it with. The order is AppKit's rather than ours, so this holds it
    /// either way instead of depending on which one a given macOS picks.
    private var pendingOpen: URL?

    /// Open With in the Finder, a drop on the Dock icon, and `open -a` all
    /// arrive here.
    ///
    /// ONE file, because this app has one buffer and one panel;
    /// `DocumentTypes.firstToOpen` is which one and why. `Info.plist`'s
    /// `CFBundleDocumentTypes` is what decides which files reach this at all,
    /// and `Coordinator.openDocument` turns away anything else, since `open -a`
    /// consults nothing.
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = DocumentTypes.firstToOpen(from: urls) else { return }
        guard !windows.windows.isEmpty else {
            pendingOpen = url
            return
        }
        windows.openDocument(at: url)
    }

    /// Clicking the Dock icon summons the panel. Without this the icon is a
    /// button that does nothing, which is worse than no icon at all.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        windows.summonAll()
        return true
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // First, and off the main thread. Running somebody's login shell to
        // find out where their tools are takes as long as their startup files
        // take, and the alternative to paying for it now is paying for it in
        // front of a person who has just asked for an agent.
        LoginShellPath.shared.prewarm()
        buildMainMenu()
        // BEFORE the Coordinator, and that ordering is the point rather than
        // an arrangement. The notes folder is derived from the product name,
        // so a rename moves it with no setting touched and the writing is left
        // in a folder this launch has stopped using. This is the only path
        // that can reach the offer for it, and it has to be answered while
        // nothing is bound to a file: the binding is the new folder's
        // scratchpad, and a note carried in afterwards can land on the path
        // the panel is already editing. `StrandedNotes` holds the decision.
        NotesMoveOffer.offerAtLaunch()
        // Before the Coordinator exists, so a launch that came from Open With
        // mounts against the file it was asked for rather than mounting the
        // last note and swapping it out a moment later. `document` is the slot
        // that outranks the other two, so writing it here is what decides the
        // URL handed to the Coordinator on the next line.
        let launchedWith = pendingOpen
        pendingOpen = nil
        if let launchedWith { Prefs.documentURL = launchedWith.standardizedFileURL }
        windows.openPreferences = { [weak self] in self?.menuOpenSettings() }
        windows.hidePreferences = { [weak self] in self?.settingsWindow?.close() }
        let first = windows.openFirstWindow()
        buildStatusMenu()
        applyMenuBarPresence()
        first.start()
        // After the window, because the summon key and the measurement signals
        // both act on a window and there has to be one to act on.
        windows.start()
        // The Finder's mark on the notes folders, after everything that has to
        // happen for the app to be usable. It is two `stat` calls on every
        // launch after the first, and the composition and write only ever run
        // once per folder, but launch is the one path where cost is felt and
        // nothing here is worth a millisecond of it.
        DispatchQueue.main.async {
            FolderMarker.markNotesFolders()
        }
        // Asked once a launch, in the background, and silent unless there is
        // something. `Updater` refuses for a development build, when the
        // setting is off, and under a throwaway defaults domain.
        updater.onStatus = { [weak self] message in self?.front?.flashStatus(message) }
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
        // And again on a timer, because Jot is not an app people quit. A
        // launch-only check stops happening for exactly the person who leaves
        // it running for weeks, which is what a menu-bar scratchpad is for.
        // The pacing is `UpdatePolicy`'s; this only decides how often to ask
        // whether it is due, and hourly is cheap because being due is a
        // comparison rather than a request.
        updateTimer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.updater.checkIfDue() }
        }
        // After the panel exists, so the screen has a window to take over.
        // `FirstRunScreen` holds every arm of the decision and why, including
        // the one Open With adds: the screen is not put in front of a panel
        // bound to somebody's own file. Asked of the BINDING rather than of
        // `launchedWith`, so it holds on every later launch too, which is what
        // keeps the tour from being spent on a note it may not write.
        // `BIRTA_JOT_DEFAULTS_SUITE` gives a checking run its own domain, which
        // is what `isUserStore` refuses, for the same reason the panel does not
        // remember its frame.
        if FirstRunScreen.shouldShow(
            forced: ProcessInfo.processInfo.environment["BIRTA_JOT_OPEN_WELCOME"] == "1",
            isUserStore: Prefs.isUserStore,
            hasSeenWelcome: Prefs.hasSeenWelcome,
            documentBound: Prefs.documentURL != nil) {
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
            // And then move the one control that changes a pane's height after
            // it is built, so a check on the window following its pane has a
            // second sizing to read. Deferred, or the two fits collapse into
            // one and the trace cannot tell them apart.
            if ProcessInfo.processInfo.environment["BIRTA_JOT_TOGGLE_ICLOUD"] == "1" {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                    self?.settingsWindow?.toggleICloudForTesting()
                }
            }
        }
        // A launch prewarms the panel hidden, which is right for a
        // hotkey-summoned app and wrong for one somebody just double-clicked a
        // file in: the file has to appear. Last, so the panel comes up over
        // whatever the settings hooks above built.
        if launchedWith != nil { windows.summonAll() }
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
        source.setEventHandler { [weak self] in
            // Nobody sent this by hand, and something is waiting on the
            // process to go: with autosave off the quit writes the buffer
            // rather than putting a sheet in front of an installer.
            self?.windows.quitUnattended()
            NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 0)
        }
        source.resume()
        terminationSignal = source
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // The reply can be NO: with autosave off and unwritten bytes, the
        // window puts the Save / Discard Changes / Cancel sheet on its panel,
        // and Cancel means the app stays up.
        //
        // `NSApp.reply(toApplicationShouldTerminate:)` may be sent exactly
        // once, so a window that is not there has to answer for itself rather
        // than leave the reply unsent and the quit hung forever.
        windows.prepareToTerminate { proceed in
            NSApp.reply(toApplicationShouldTerminate: proceed)
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        windows.finalWrite()
    }

    // MARK: menus

    /// The menu bar, built. The two menus AppKit has to be TOLD about travel
    /// beside it rather than being found again by title.
    ///
    /// Building and installing are separate because installing is what has
    /// side effects: assigning `NSApp.windowsMenu` is what makes the system
    /// insert its tiling rows and append the window list, and `NSApp.helpMenu`
    /// brings the search field. A check that wants to read the bar back should
    /// not have to change the running app to do it, and the alternative to
    /// this seam was widening `buildMainMenu` so a test could poke it.
    struct MainMenu {
        let menu: NSMenu
        let windows: NSMenu
        let help: NSMenu
    }

    /// The main menu is invisible for an accessory app but load-bearing: key
    /// equivalents route through it, and Cmd+C/V/X/Z inside the WKWebView
    /// only work when an Edit menu with the standard selectors exists.
    private func buildMainMenu() {
        let built = mainMenu()
        // The assignment is what makes AppKit insert its own rows and append
        // the window list; see `JotMenu.windowMenu`.
        NSApp.windowsMenu = built.windows
        // The system's search field arrives with the assignment, and it
        // searches menu items, which is how a reader finds a row buried in a
        // submenu of Format.
        NSApp.helpMenu = built.help
        // Once over the whole tree, submenus included. The file, view and
        // status menus also clear theirs on every opening through
        // `menuNeedsUpdate`, which is where a menu whose ITEMS change needs
        // it; these are built once and do not change, so once is where it
        // belongs.
        AppDelegate.suppressAutomaticIcons(in: built.menu)
        NSApp.mainMenu = built.menu
    }

    /// Build the bar, install nothing.
    func mainMenu() -> MainMenu {
        let main = NSMenu()

        let appMenu = NSMenu(title: AppFlavor.current.displayName)
        // Targeted at the delegate, so it opens Jot's own About window rather
        // than travelling up to `NSApplication`'s standard panel.
        let about = appMenu.addItem(withTitle: "About \(AppFlavor.current.displayName)",
                                    action: #selector(menuOpenAbout), keyEquivalent: "")
        about.target = self
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

        // File, Edit, View, Format, Window, Help. The rule is that the menus
        // naming the more universal object sit to the left, and View is about
        // the window rather than about the document, so it goes above the menu
        // that writes in the file. Mail is the system app with this exact
        // shape: File, Edit, View, then its own menus, then Format, Window,
        // Help. Any further menu of Jot's own would land beside Format,
        // between View and Window, where the app-specific ones go.
        let viewMenu = NSMenu(title: "View")
        JotMenu.add(.view, to: viewMenu, target: self)
        // The rows that draw live state (the proofreading checkmarks, and the
        // outline row's Show/Hide title) are repainted on every opening, which
        // is what a menu whose ITEMS change needs; `menuNeedsUpdate` tells this
        // menu from the others by identity.
        self.viewMenu = viewMenu
        viewMenu.delegate = self
        let viewItem = NSMenuItem(); viewItem.submenu = viewMenu; main.addItem(viewItem)

        let formatMenu = NSMenu(title: "Format")
        JotMenu.add(.format, to: formatMenu, target: self)
        let formatItem = NSMenuItem(); formatItem.submenu = formatMenu; main.addItem(formatItem)

        let windowMenu = JotMenu.windowMenu()
        let windowItem = NSMenuItem(); windowItem.submenu = windowMenu; main.addItem(windowItem)

        let helpMenu = NSMenu(title: "Help")
        JotMenu.add(.help, to: helpMenu, target: self)
        let helpItem = NSMenuItem(); helpItem.submenu = helpMenu; main.addItem(helpItem)

        return MainMenu(menu: main, windows: windowMenu, help: helpMenu)
    }

    /// The menu-bar item's menu, on Control-click and right-click, where a
    /// menu belongs. A plain click toggles the panel, which is what the item
    /// is for; `statusItemClicked` holds how the two are told apart.
    ///
    /// Built ONCE, and separately from the item, because the item comes and
    /// goes with `Prefs.showInMenuBar` while this does not change at all.
    /// `showItem` is retitled on every opening rather than rebuilt, so it has
    /// to outlive any particular item.
    private func buildStatusMenu() {
        let menu = NSMenu()
        // The panel toggle, and nothing about where files live: that belongs in
        // the window, next to the note it would act on.
        showItem = menu.addItem(withTitle: "Show \(AppFlavor.current.displayName)", action: #selector(togglePanel), keyEquivalent: "")
        menu.addItem(.separator())
        // With no Dock icon the app menu is invisible, so this menu is the only
        // route to About for most of the people who have Jot: the row belongs
        // in both places rather than in the one an accessory app rarely shows.
        menu.addItem(withTitle: "About \(AppFlavor.current.displayName)", action: #selector(menuOpenAbout), keyEquivalent: "")
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

    /// A click toggles the panel, which is what the item is for; the menu is
    /// on Control-click and right-click, where a menu belongs.
    ///
    /// `statusItem.menu` stays nil for that to work: an item with a menu shows
    /// it on every click and never sends its action, so the menu is attached
    /// for the length of one `performClick` and taken off again.
    @objc private func statusItemClicked() {
        let event = NSApp.currentEvent
        let wantsMenu = event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true
        guard wantsMenu else {
            windows.toggle()
            return
        }
        statusItem?.menu = statusMenu
        statusItem?.button?.performClick(nil) // blocks while the menu tracks
        statusItem?.menu = nil
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

    @objc private func togglePanel() { windows.toggle() }
    @objc private func hidePanel() { windows.dismissAll() }
    @objc private func copyEverything() { front?.copyEverything() }
    @objc func menuSaveNow() { front?.saveNow() }
    @objc func menuNewNote() { windows.newNote() }
    @objc func menuOpenDocument() { windows.openDocumentPanel() }

    /// Raise the recents list from a control that is not a menu row: the
    /// titlebar's button. The File menu reaches the same list as a submenu
    /// (`JotMenu.Action.recents`), so this builds the same menu rather than a
    /// second one, and pops it under the button that sent it.
    ///
    /// The sender is the button, which is why the selector takes one: a menu
    /// has to be popped IN a view, and the only view that knows where this one
    /// belongs is the one that was pressed.
    @objc func menuOpenRecent(_ sender: Any?) {
        guard let view = sender as? NSView else { return }
        NSApp.activate(ignoringOtherApps: true)
        RecentsMenu().popUp(
            positioning: nil,
            at: RecentsMenu.popUpOrigin(in: view.bounds, isFlipped: view.isFlipped),
            in: view)
    }

    /// One row of that list. The file travels in `representedObject`, and the
    /// open goes through the same method the Finder's Open With reaches, so a
    /// file arriving from this menu is flushed, rebound and watched exactly as
    /// one arriving from anywhere else.
    @objc func menuOpenRecentDocument(_ sender: NSMenuItem) {
        guard let url = sender.representedObject as? URL else { return }
        windows.openDocument(at: url)
    }

    /// Forget the list. The files are untouched; this is the only control over
    /// what the menu remembers, which is why it is offered at all.
    @objc func menuClearRecentDocuments() {
        Prefs.recentDocuments = []
    }
    @objc func menuSaveAs() { front?.saveAs() }
    @objc private func revealLastSave() { front?.revealLastSave() }
    /// Run the editor command a menu row carries.
    ///
    /// ONE selector for every command row, with the id in `representedObject`,
    /// so a new row is a line in `JotMenu` and nothing here. A method per
    /// command is the shape this replaces, and it does not survive a table
    /// this size.
    @objc func menuRunEditorCommand(_ sender: NSMenuItem) {
        guard let command = sender.representedObject as? JotMenu.Command else { return }
        front?.runEditorCommand(command.id, arg: command.arg)
    }

    /// Open the destination a Help row carries, in the browser.
    @objc func menuOpenLink(_ sender: NSMenuItem) {
        guard let url = sender.representedObject as? URL else { return }
        NSWorkspace.shared.open(url)
    }


    @objc private func shareNote() { front?.shareNote() }

    /// Show the first-run screen, which lives IN the panel rather than in a
    /// window of its own. The Advanced button that re-shows it comes here too.
    func showWelcome() {
        front?.showWelcome()
    }

    @objc func menuBackToNotes() {
        if let front { windows.backToNotes(front) }
    }

    /// Say a newer release exists, and let the user take it or leave it.
    ///
    /// Asking rather than swapping: replacing the app somebody is typing into
    /// is not a thing to do behind them, and this is the one moment where
    /// asking costs nothing because nothing has been downloaded yet.
    ///
    /// Two things decide WHEN it is asked, and both are about not interrupting
    /// a person who did not summon this. A version already declined is not
    /// raised again until a newer one exists, or the day timer turns the offer
    /// into a nag and teaches people to switch updates off. And a panel that
    /// is not on screen means the person is in another app entirely, so the
    /// offer waits for the next summon instead of taking the screen from
    /// whatever they are actually doing.
    private func offerUpdate(_ tag: String) {
        guard updater.available != nil else { return }
        // One offer on screen at a time. The launch check and the day timer
        // are separate callers, and a sheet left up on an unattended machine
        // outlives the interval between them, so without this a second sheet
        // queues behind the first and the person answers the same question
        // twice.
        guard !offering else { return }
        guard UpdatePolicy.shouldOffer(tag: tag, declined: Prefs.updateDeclinedTag) else { return }
        guard let host = promptHost else {
            front?.onNextShow = { [weak self] in self?.offerUpdate(tag) }
            return
        }
        offering = true
        UpdatePrompt.present(tag: tag,
                             hasUnwrittenBytes: front?.hasUnwrittenBytes ?? false,
                             on: host) { [weak self] answer in
            guard let self else { return }
            self.offering = false
            guard answer == .install else {
                // Remembered so this version is not raised again. A NEWER one
                // still will be: that is different news.
                Prefs.updateDeclinedTag = tag
                return
            }
            self.installUpdate()
        }
    }

    /// The window to hang the offer on, or nil when Jot has none on screen.
    ///
    /// The key window first, which is what makes Check Now work: that button
    /// is in Settings, and the panel behind it may well be hidden, so an offer
    /// that only ever attached to the panel would answer a press by putting
    /// the sheet somewhere nobody is looking, or by holding it until the next
    /// summon and looking like a button that does nothing.
    private var promptHost: NSWindow? {
        if let key = NSApp.keyWindow, key.isVisible { return key }
        guard let front, front.isOnScreen else { return nil }
        return front.promptWindow
    }

    /// Download, verify and arm the swap, then quit so it can run.
    private func installUpdate() {
        guard let release = updater.available else { return }
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
            // The swap script is already staged and polling for this pid, so
            // this quit has nothing to ask and nobody waiting to answer.
            self.windows.quitUnattended()
            NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 0)
        }
    }

    /// Keeps the release build current. Held here rather than on the
    /// coordinator because it outlives any window and belongs to the app.
    let updater = Updater()
    /// Retained so it is not deallocated the moment it is scheduled.
    private var updateTimer: Timer?
    /// Whether an update offer is on screen right now.
    private var offering = false

    /// Kept between openings, like the settings window: reopening puts the same
    /// window back where the user left it rather than building a second one.
    private var aboutWindow: AboutWindowController?

    @objc func menuOpenAbout() {
        if aboutWindow == nil { aboutWindow = AboutWindowController() }
        // An accessory app is not frontmost when its status menu is used, and
        // an ordinary-level window ordered front from a background app opens
        // behind whatever is in front of it.
        NSApp.activate(ignoringOtherApps: true)
        aboutWindow?.showWindow(nil)
        aboutWindow?.window?.makeKeyAndOrderFront(nil)
    }

    @objc func menuOpenSettings() {
        if settingsWindow == nil {
            settingsWindow = SettingsWindowController(
                // Explicit rather than a default the window reads for itself:
                // this literal is the whole of what a test cannot cover, and
                // it is legible here.
                flavour: .current,
                onHotkeyChange: { [weak self] in self?.windows.registerHotkey() ?? -1 },
                onChange: { [weak self] work in self?.front?.preferencesChanged(beforeReload: work) },
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
        // Three menus share this delegate and each wants a different thing, so
        // which one arrived has to be the first question. Answer it by identity
        // rather than by what a menu contains: the status item's retitle and
        // the View menu's repaint are both writes, and a write made on the
        // wrong opening is invisible until somebody reads the menu it landed
        // in.
        if menu === statusMenu {
            // The hotkey as a real key equivalent, not as text appended to the
            // title: AppKit then draws it where every other menu draws one,
            // right aligned and dimmed. It binds nothing new, because a status
            // item's menu is not searched for key equivalents; the global
            // hotkey is registered with Carbon and works whatever has focus.
            let combo = windows.hotkey.combo ?? Prefs.hotkey
            showItem.title = windows.isAnyVisible ? "Hide \(AppFlavor.current.displayName)" : "Show \(AppFlavor.current.displayName)"
            showItem.keyEquivalent = combo.menuKeyEquivalent
            showItem.keyEquivalentModifierMask = combo.menuModifierMask
        } else if menu === viewMenu {
            JotMenu.applyState(menuState(), to: menu)
        }

        AppDelegate.suppressAutomaticIcons(in: menu)
    }

    /// What the View menu's stateful rows draw, read at the moment it opens.
    ///
    /// From the host's own stored answers rather than from the page, because
    /// there is no page-to-host push for the proofread config and a menu that
    /// asked for one would have to draw something while it waited. The page
    /// posts every one of these as the reader flips it (`setProofreadOption`,
    /// `setNoteHighlight`, `tocVisibility`) and the shell stores it, so what is
    /// stored IS what the page is showing.
    /// What the front window shows, which is what its menus must draw.
    ///
    /// The FRONT window's, not the process's, because the commands these rows
    /// run go to the front window. Reading `Prefs` here instead put one value
    /// on a menu bar serving several windows, so a row could draw the state of
    /// a window the reader was not looking at and picking it would invert what
    /// it said. `Coordinator.menuState` carries the argument in full.
    ///
    /// With no window, the stored settings ARE the answer, because they are what
    /// the next window will open with.
    func menuState() -> MenuState {
        front?.menuState ?? MenuState(proofreadOptions: Prefs.proofreadOptions,
                                      noteHighlight: Prefs.noteHighlight,
                                      tocShown: Prefs.tocVisibility == "shown")
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
        if front?.isWelcoming == true, let action = item.action, Self.documentCommands.contains(action) {
            return false
        }
        switch item.action {
        case #selector(copyEverything), #selector(menuSaveAs), #selector(shareNote):
            return front?.hasContent ?? false
        case #selector(revealLastSave):
            return front?.lastSavedURL != nil
        case #selector(menuClearRecentDocuments):
            return !Prefs.recentDocuments.isEmpty
        case #selector(menuBackToNotes):
            // Dead unless THIS window is actually on a document, which today
            // only an install carrying an older `documentPath` can be. The
            // window's own slot and not the global setting: with several
            // windows only one holds it, so gating on the setting would offer
            // the row on every window and refuse it on all but one.
            return front?.bindingSlot == .document && Prefs.documentURL != nil
        default:
            return true
        }
    }

    /// Every menu command that reads or writes the note. Named once so the
    /// first-run gate above cannot drift out of step with the File menu.
    private static let documentCommands: Set<Selector> = [
        #selector(menuNewNote), #selector(menuOpenDocument),
        #selector(menuOpenRecent(_:)), #selector(menuOpenRecentDocument(_:)),
        #selector(menuSaveNow), #selector(menuSaveAs),
        #selector(copyEverything), #selector(shareNote), #selector(revealLastSave),
        #selector(menuBackToNotes), #selector(menuRunEditorCommand(_:)),
    ]
}
