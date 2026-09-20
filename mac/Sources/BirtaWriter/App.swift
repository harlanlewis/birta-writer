import AppKit
import WebKit
import BirtaWriterCore

/// The app: status item, main menu, and the Coordinator that ties the hotkey,
/// the panel, the web host and the store together.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, RecentsMenuProviding, ThemesMenuProviding {
    private var statusItem: NSStatusItem?
    private var statusMenu: NSMenu!
    /// The View menu, kept so `menuNeedsUpdate` can tell it from the other two
    /// menus that share this delegate. Without the identity check the status
    /// item's Show/Hide retitle would run on every File and View opening, and
    /// the View menu's own repaint on every status-menu one.
    private var viewMenu: NSMenu?
    private var formatMenu: NSMenu?
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
    /// The command palette, built on first use and kept, like the settings
    /// window: it re-reads its catalog on every open, so keeping the panel
    /// keeps only the panel (MAR-458).
    private lazy var palette = PaletteWindowController(
        catalog: { [weak self] in self?.paletteCatalog() ?? PaletteCatalog() },
        onPick: { [weak self] action in self?.perform(action) })
    private var showItem: NSMenuItem!
    /// The File menu and its Close row, held so the row can read Close Tab
    /// while the window in front has tabs.
    private var fileMenu: NSMenu?
    private var closeItem: NSMenuItem?
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
    /// WHAT to do is `BirtaWriterCore.DockPresence`'s, where it is decidable and
    /// checked; this is the AppKit half, which is not. `keepingFrontmost` is
    /// true for a live toggle and false at launch and on the first-run screen,
    /// and the type says why the two differ.
    static func applyActivationPolicy(keepingFrontmost: Bool = false) {
        // The Dock setting decides two things and this is both of them, which
        // is why the windows are told here rather than at the switches: there
        // are two of those (Settings and the first-run screen) and they both
        // already call this. The second thing is which Space a window is on
        // (`BirtaWriterCore.WindowPolicy`), and it is applied ABOVE the branch
        // below rather than inside it, because that branch is skipped when the
        // policy already matches and a window still has to be told.
        shared?.windows.applyWindowPolicy()
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
    /// Deliberately not covered by `BirtaWriterTests`, which is the one place in
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

    /// Whether this launch was asked for by the `bwr` command with no file.
    ///
    /// The one thing the command cannot say through LaunchServices. A file
    /// reaches `application(_:open:)` and summons on its own account; a bare
    /// `bwr` has nothing to open and still has to show, because a call from a
    /// shell is a request rather than a toggle. `open --args` puts this in
    /// `argv` on a COLD launch only, which is exactly when it is needed: a
    /// warm one gets the reopen event the Dock icon sends, and
    /// `applicationShouldHandleReopen` summons from there.
    ///
    /// The word is `CliInvocation.summonArgument` rather than a literal,
    /// because the command spells it too and neither end can see the other's.
    /// It takes the arguments so the reading is checkable, since a process
    /// cannot be relaunched to change its own.
    static func summonedFromShell(_ arguments: [String] = CommandLine.arguments) -> Bool {
        arguments.contains(CliInvocation.summonArgument)
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
    /// ONE item, a file or a folder; `DocumentTypes.firstToOpen` is which one
    /// and why. `Info.plist`'s `CFBundleDocumentTypes` is what decides which
    /// items reach this at all (the Markdown types and `public.folder`), and
    /// `WindowSet.openDocument` turns away anything else, since `open -a`
    /// consults nothing. A folder becomes a directory window (MAR-457).
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
        // Before any Coordinator exists, so a launch that came from Open With
        // mounts against the file it was asked for rather than mounting the
        // last note and swapping it out a moment later. `WindowSet.openAtLaunch`
        // puts it in front of whatever else comes back.
        let launchedWith = pendingOpen
        pendingOpen = nil
        // ONE decision for the whole launch, taken here because the earliest
        // thing it governs happens before the windows are made. `FirstRun`
        // holds every arm and why, including the one Open With adds: nothing
        // about a first run is put in front of a panel bound to somebody's own
        // file. Asked of the BINDING and of this launch's file together, so it
        // holds on every later launch as well as this one.
        // `BIRTA_MAC_DEFAULTS_SUITE` gives a checking run its own domain,
        // which is what `isUserStore` refuses, for the same reason the panel
        // does not remember its frame.
        let opening = FirstRun.opening(
            forced: ProcessInfo.processInfo.environment["BIRTA_MAC_OPEN_WELCOME"] == "1",
            isUserStore: Prefs.isUserStore,
            hasSeenWelcome: Prefs.hasSeenWelcome,
            documentBound: Prefs.documentURL != nil || launchedWith != nil)
        // BEFORE the windows, so the ordinary mount is what opens the tour.
        if opening == .invitation { Self.seedFirstRunNote() }
        windows.openPreferences = { [weak self] in self?.menuOpenSettings() }
        windows.hidePreferences = { [weak self] in self?.settingsWindow?.close() }
        windows.paletteProbe = { [weak self] query, mode in
            self?.probePalette(query: query, mode: mode) ?? "unavailable"
        }
        let firstWindow = windows.openAtLaunch(launchedWith: launchedWith)
        buildStatusMenu()
        applyMenuBarPresence()
        windows.startAll()
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
        // BEFORE the first check, and that ordering is the point rather than
        // an arrangement. The automatic download refuses over a connection
        // somebody pays for by the byte, and the monitor answering that has to
        // be running before anything asks: created on first read instead, it
        // would begin monitoring inside the very check it was being consulted
        // by, and answer from no path at all.
        NetworkPath.start()
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
        // And again on a timer, because this is not an app people quit. A
        // launch-only check stops happening for exactly the person who leaves
        // it running for weeks, which is what a menu-bar scratchpad is for.
        //
        // One timer, two questions, and neither costs a request. Whether a
        // check is due is a date comparison, paced by `UpdatePolicy` and not
        // by this. Whether a downloaded update can go in is three booleans and
        // one read of how long the machine has been untouched, and it is what
        // sets the interval: the window in which nobody is there opens and
        // closes as a person walks away and comes back, and an hourly poll
        // would miss most of them.
        updateTimer = Timer.scheduledTimer(withTimeInterval: UpdatePolicy.pollInterval,
                                           repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.updater.checkIfDue()
                self?.applyStagedUpdateIfUnattended()
            }
        }
        // What the LAST launch did to itself, if it did anything. Nothing is
        // said on screen; this clears the record and writes it to the log.
        recordSilentUpdate()
        // Acted on HERE rather than where it was taken, because both arms need
        // things that do not exist until now: the screen needs a panel to take
        // over, and the invitation needs the status item to point at and the
        // hotkey registration's answer to report.
        switch opening {
        case .screen: showWelcome()
        case .invitation: beginFirstRun(on: firstWindow)
        case .nothing: break
        }
        // A settings window can otherwise only be opened by a person, which
        // makes "does it construct" a question nothing but a human can answer.
        // Same seam as BIRTA_MAC_SCRATCHPAD and BIRTA_MAC_DEFAULTS_SUITE, and
        // used by the same script.
        if let tab = ProcessInfo.processInfo.environment["BIRTA_MAC_OPEN_SETTINGS"], !tab.isEmpty {
            menuOpenSettings()
            // Panes are built on first show, so naming one is what proves it
            // constructs. "1" opens the window on whichever pane is default.
            settingsWindow?.selectTabForTesting(tab)
            // A picture of the pane, for a check on how it LOOKS rather than
            // what it constructs: the window is AppKit throughout, so its
            // views' own drawing is the picture (`PaletteWindow.snapshotPNG`
            // is the same instrument). After a beat, so the pane has been
            // laid out and the window fitted to it.
            if let path = ProcessInfo.processInfo.environment["BIRTA_MAC_SETTINGS_SNAPSHOT"], !path.isEmpty {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                    let png = self?.settingsWindow?.snapshotPNG()
                    let written = png.flatMap { try? $0.write(to: URL(fileURLWithPath: path)) } != nil
                    Measure.trace("settings snapshot written=\(written) path=\(path)")
                }
            }
            // And then move the one control that changes a pane's height after
            // it is built, so a check on the window following its pane has a
            // second sizing to read. Deferred, or the two fits collapse into
            // one and the trace cannot tell them apart.
            if ProcessInfo.processInfo.environment["BIRTA_MAC_TOGGLE_ICLOUD"] == "1" {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                    self?.settingsWindow?.toggleICloudForTesting()
                }
            }
        }
        // A launch prewarms the panel hidden, which is right for a
        // hotkey-summoned app and wrong for one somebody just double-clicked a
        // file in: the file has to appear. Last, so the panel comes up over
        // whatever the settings hooks above built.
        if launchedWith != nil || Self.summonedFromShell() { windows.summonAll() }
        installTerminationSignal()
    }

    /// SIGTERM runs the same flush-then-quit path as the menu's Quit.
    ///
    /// AppKit installs no handler of its own, so the default action would kill
    /// the process outright and `applicationShouldTerminate` would never get to
    /// flush the buffer. mac/scripts/install-app.sh signals a running copy this
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
        // the window list; see `AppMenu.windowMenu`.
        NSApp.windowsMenu = built.windows
        // The system's search field arrives with the assignment, and it
        // searches menu items, which is how a reader finds a row buried in a
        // submenu of Format.
        NSApp.helpMenu = built.help
        // Once over the whole tree, submenus included, which is the floor and
        // not the whole of it: every menu that carries this delegate clears
        // again on each opening through `menuNeedsUpdate`, because macOS
        // decorates when it pleases and a menu cleared once is a menu
        // decorated after the clear. Rows that never change do not exempt a
        // menu from that; whether the ROWS change and whether the CLEAR holds
        // are different questions.
        //
        // The Window menu is spared, and it is spared for the reason the sweep
        // exists. Half that menu is the system's (Fill, Center, Move & Resize),
        // inserted by the assignment above and decorated by AppKit after any
        // clear this app can make; the clear does hold on Minimize and Zoom,
        // which are ours. So sweeping it produces exactly the mixed menu the
        // sweep is for, with our two rows bare among the system's decorated
        // ones. Left alone, every row in it carries the symbol macOS gives it,
        // which is what TextEdit's Window menu looks like.
        AppDelegate.suppressAutomaticIcons(in: built.menu, except: built.windows)
        NSApp.mainMenu = built.menu
    }

    /// Build the bar, install nothing.
    func mainMenu() -> MainMenu {
        let main = NSMenu()

        let appMenu = NSMenu(title: AppFlavor.current.displayName)
        // The rows themselves are `AppMenu.addAppSection`'s, which the
        // menu-bar item's menu builds from too; what is this menu's own is the
        // hide row, which hides an app that is in front rather than toggling a
        // panel that may be away.
        let hide = NSMenuItem(title: "Hide \(AppFlavor.current.displayName)",
                              action: #selector(hidePanel), keyEquivalent: "h")
        AppMenu.addAppSection(to: appMenu, hide: hide, printsChords: true, target: self)
        // Cleared on every opening, like the status menu that draws the same
        // rows. This menu's rows do not change, so it was cleared once at
        // build and that is a different question from whether the CLEAR
        // holds: macOS decorates when it pleases, and a menu cleared once is
        // a menu decorated after the clear.
        appMenu.delegate = self
        let appItem = NSMenuItem(); appItem.submenu = appMenu; main.addItem(appItem)

        // The conventional File menu, with the conventional chords: Cmd+S
        // saves the document being edited and Shift+Cmd+S writes a copy
        // elsewhere. Neither empties the panel.
        let fileMenu = NSMenu(title: "File")
        AppMenu.add(.file, to: fileMenu, target: self)
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
        // what is in front, and hides the panel when the panel is (AppPanel
        // turns `close` into a hide).
        for item in fileMenu.items where item.action != nil { item.target = self }
        fileMenu.addItem(.separator())
        // Close reads Close Tab while the window in front holds several tabs
        // (`menuNeedsUpdate` retitles it), as every tabbed macOS app's does;
        // it still travels the responder chain, so it closes the Settings
        // window when that is in front and the selected tab when the panel is.
        closeItem = fileMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        // Every tab of the window in front, the chord the HIG reserves for it.
        let closeWindow = fileMenu.addItem(withTitle: "Close Window", action: #selector(menuCloseWindow),
                                           keyEquivalent: "W")
        closeWindow.keyEquivalentModifierMask = [.command, .shift]
        closeWindow.target = self
        self.fileMenu = fileMenu
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
        AppMenu.add(.edit, to: editMenu, target: self)
        let editItem = NSMenuItem(); editItem.submenu = editMenu; main.addItem(editItem)

        // File, Edit, View, Format, Window, Help. The rule is that the menus
        // naming the more universal object sit to the left, and View is about
        // the window rather than about the document, so it goes above the menu
        // that writes in the file. Mail is the system app with this exact
        // shape: File, Edit, View, then its own menus, then Format, Window,
        // Help. Any further menu of the app's own would land beside Format,
        // between View and Window, where the app-specific ones go.
        let viewMenu = NSMenu(title: "View")
        AppMenu.add(.view, to: viewMenu, target: self)
        // The rows that draw live state (the proofreading checkmarks, and the
        // outline row's Show/Hide title) are repainted on every opening, which
        // is what a menu whose ITEMS change needs; `menuNeedsUpdate` tells this
        // menu from the others by identity.
        self.viewMenu = viewMenu
        viewMenu.delegate = self
        let viewItem = NSMenuItem(); viewItem.submenu = viewMenu; main.addItem(viewItem)

        let formatMenu = NSMenu(title: "Format")
        AppMenu.add(.format, to: formatMenu, target: self)
        // Repainted on every opening for the same reason the View menu is, and
        // for a different fact: the rows that write a syntax the reader's
        // publishing target does not spell are withdrawn, so this menu and the
        // toolbar in the page below it offer the same tools. The target is a
        // setting, so it can change between two openings of this menu.
        self.formatMenu = formatMenu
        formatMenu.delegate = self
        let formatItem = NSMenuItem(); formatItem.submenu = formatMenu; main.addItem(formatItem)

        let windowMenu = AppMenu.windowMenu()
        let windowItem = NSMenuItem(); windowItem.submenu = windowMenu; main.addItem(windowItem)

        let helpMenu = NSMenu(title: "Help")
        AppMenu.add(.help, to: helpMenu, target: self)
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
    ///
    /// Returns what it built, for the same reason `mainMenu` is a function
    /// that returns one: a menu no test can read back is a menu whose rows are
    /// checked by reading the source that writes them.
    @discardableResult
    func buildStatusMenu() -> NSMenu {
        let menu = NSMenu()
        // The app section, from the builder the app menu uses, so the two
        // menus cannot drift: a row added to one is added to both, in the
        // place both draw it.
        //
        // The panel toggle is this menu's hide row, and nothing here is about
        // where files live: that belongs in the window, next to the note it
        // would act on.
        showItem = NSMenuItem(title: "Show \(AppFlavor.current.displayName)",
                              action: #selector(togglePanel), keyEquivalent: "")
        AppMenu.addAppSection(to: menu, hide: showItem, printsChords: false, target: self)
        menu.delegate = self
        statusMenu = menu
        return menu
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

    /// The app's menus carry no icons.
    ///
    /// macOS 26 draws a symbol of its own beside any item whose action it
    /// recognises, which in this app means one icon next to Quit and none
    /// anywhere else: a single decorated row in an otherwise plain menu, which
    /// reads as a mistake rather than as a system convention. Giving an item an
    /// image and taking it away again is what clears the automatic one. macOS
    /// 27 hides symbol images by default and adds `preferredImageVisibility`,
    /// so this covers the versions in between and is harmless on both sides.
    ///
    /// Within a menu this sweeps, EVERY row ends with no image, with no
    /// exception for any of them, and the exception this used to carry is why
    /// the rule is worth stating. About was given a zero-size image of its own
    /// and this sweep put it back, because the clear was thought not to hold
    /// for that row. An image is an image to AppKit however big it is: the row
    /// reserved the icon column and drew its title a glyph's width right of
    /// every other row in the menu, on both surfaces, which is the same "one
    /// row unlike its neighbours" the sweep exists to prevent, arrived at from
    /// the other side.
    ///
    /// `spared` is a whole MENU rather than a row, and that is the shape the
    /// exception has to take: a menu is either all plain or all decorated, and
    /// the Window menu cannot be all plain because AppKit redecorates the rows
    /// it inserted there itself. `buildMainMenu` names it and says why.
    ///
    /// What replaced the exception is WHEN this runs rather than what it
    /// spares. The app menu was swept once, at build, on the grounds that its
    /// rows do not change; but whether the rows change and whether the CLEAR
    /// holds are different questions, and macOS decorates when it pleases. It
    /// now carries the delegate the status menu always had, so both surfaces
    /// of this one menu are swept on every opening.
    static func suppressAutomaticIcons(in menu: NSMenu, except spared: NSMenu? = nil) {
        guard menu !== spared else { return }
        for item in menu.items {
            // Giving an item an image and taking it away again is what clears
            // the automatic one; nothing else does.
            item.image = NSImage(size: NSSize(width: 1, height: 1))
            item.image = nil
            if let submenu = item.submenu { suppressAutomaticIcons(in: submenu, except: spared) }
        }
    }

    // MARK: actions

    @objc private func togglePanel() { windows.toggle() }
    @objc private func hidePanel() { windows.dismissAll() }
    @objc private func copyEverything() { front?.copyEverything() }
    @objc func menuSaveNow() { front?.saveNow() }
    @objc func menuNewNote() { windows.newNote() }

    /// Cmd+T: a tab beside the window in front, and a plain new window when
    /// nothing is in front to put a tab beside.
    @objc func menuNewTab() {
        if let front { windows.newTab(in: front) } else { windows.newNote() }
    }

    /// Shift+Cmd+W: every tab of the window in front.
    @objc func menuCloseWindow() {
        guard let front else { return }
        windows.closeWindow(front)
    }

    /// Cmd+Shift+E: the file explorer of the window in front, which is the
    /// page's own command; the row is withdrawn where there is no root.
    @objc func menuToggleExplorer() {
        front?.runEditorCommand("toggleFileExplorer", arg: nil)
    }

    /// Cmd+Shift+.: the Finder's chord, flipping the app's setting for every
    /// rooted window at once.
    @objc func menuToggleHiddenFiles() {
        windows.setShowHiddenFiles(!Prefs.explorerShowsHidden)
    }

    /// A row of View > Theme, or the palette's: the payload is the theme's
    /// id, or "" for the system's palette (`ThemesMenu`). It goes into the
    /// slot of the mode in force.
    @objc func menuSelectTheme(_ sender: Any?) {
        let id = (sender as? NSMenuItem)?.representedObject as? String
        windows.chooseTheme(id: id.flatMap { $0.isEmpty ? nil : $0 })
    }

    /// Auto, Light or Dark, at the top of that menu.
    @objc func menuSetAppearanceMode(_ sender: Any?) {
        guard let raw = (sender as? NSMenuItem)?.representedObject as? String,
              let mode = AppearanceMode(rawValue: raw) else { return }
        windows.setAppearanceMode(mode)
    }

    /// Add Theme…, at the bottom of that menu: the Appearance pane, at the
    /// theme row, which is where a theme is added.
    @objc func menuOpenThemeSettings() {
        menuOpenSettings()
        settingsWindow?.show(paneNamed: "appearance", revealing: .theme)
    }

    func makeThemesMenu() -> ThemesMenu { windows.themesMenu() }

    /// View > Line Numbers: the app's setting, flipped for every window at
    /// once; the page draws or removes its gutter without a reload.
    @objc func menuToggleLineNumbers() {
        windows.setLineNumbers(!Prefs.lineNumbers)
    }

    /// Cmd+Shift+P: the palette over everything, above the window in front.
    @objc func menuOpenPalette() {
        openPalette(mode: .all)
    }

    /// Cmd+P: the palette over files alone, which is Go to File.
    @objc func menuGoToFile() {
        openPalette(mode: .files)
    }

    private func openPalette(mode: PaletteMode) {
        // The file list is built off the main thread and swapped in; the
        // palette opens on what is there and refreshes when the rest lands.
        windows.invalidateNotesIndex()
        palette.open(mode: mode, over: front?.window)
    }

    /// What the palette lists: the app as it stands at this moment, read from
    /// the same places the menu bar and Settings read it. `PaletteSources`
    /// says what each source is.
    private func paletteCatalog() -> PaletteCatalog {
        let root = front?.explorerRoot
        var context = PaletteSources.Context(front: front,
                                             allows: { [weak self] selector in self?.allows(selector) ?? false })
        context.windows = windows.windows
        context.menuState = menuState()
        context.syntaxSets = Prefs.syntaxSets
        context.pageCommands = front?.paletteCommands ?? []
        context.recents = Prefs.recentDocuments
        context.themes = windows.themeStore.list()
        context.currentTheme = windows.appearance.themeId
        context.appearanceMode = Prefs.appearance.mode
        let refresh: () -> Void = { [weak self] in self?.palette.refresh() }
        if let root {
            context.root = root
            context.rootIndex = windows.fileIndex(for: root, whenBuilt: refresh)
        } else {
            context.notesFolder = Prefs.notesDirectory
            context.notesIndex = windows.fileIndex(for: Prefs.notesDirectory, whenBuilt: refresh)
        }
        return PaletteSources.catalog(context)
    }

    /// Do what a palette pick asks, after the palette has closed. A menu row
    /// goes through the selector and payload its menu item would carry, so
    /// the palette and the menu bar cannot disagree about what a row does.
    private func perform(_ action: PaletteAction) {
        switch action {
        case let .menu(row):
            // Asked again at the pick, not only at the listing: the state a
            // gate reads can change while the palette is up.
            if let selector = row.action.selector, !allows(selector) { return }
            switch row.action {
            case let .app(selector):
                NSApp.sendAction(selector, to: self, from: nil)
            case let .command(id, arg):
                front?.runEditorCommand(id, arg: arg)
            case let .link(link):
                NSWorkspace.shared.open(link.url)
            case .submenu, .recents, .themes:
                break
            }
        case let .theme(id):
            windows.chooseTheme(id: id)
        case let .appearanceMode(mode):
            windows.setAppearanceMode(mode)
        case let .pageCommand(id):
            front?.runEditorCommand(id, arg: nil)
        case let .window(coordinator):
            coordinator.selectTab()
            coordinator.show()
        case let .file(url):
            // Go to File over a rooted window is the explorer's gesture with
            // a keyboard: a file under the root moves this tab to it. A file
            // from elsewhere (a recent) takes the route a Finder open does.
            if let here = front, let root = here.explorerRoot,
               DirectoryListing.isInside(url, root: root) {
                windows.openFromExplorer(url, from: here, inNewTab: false)
            } else {
                windows.openDocument(at: url)
            }
        case let .setting(pane, row):
            menuOpenSettings()
            settingsWindow?.show(paneNamed: pane, revealing: row)
        }
    }

    /// The palette as `measure.sh` drives it: open in `mode`, type `query`,
    /// report the top rows, close. What comes back is the trace line's tail.
    func probePalette(query: String, mode: String) -> String {
        openPalette(mode: mode == "files" ? .files : .all)
        palette.setQuery(query)
        let top = palette.rows.prefix(3).map { "\($0.title)|\($0.item.detail ?? "-")" }
        var line = "mode=\(mode) query=\(query) rows=\(palette.rows.count) open=\(palette.isOpen)"
            + " top=\(top.joined(separator: ";"))"
        // A picture of it too, beside the scratchpad, since nothing in the
        // window server can be asked for one without a Screen Recording
        // grant and the palette is drawn by AppKit alone.
        if let scratch = ProcessInfo.processInfo.environment["BIRTA_MAC_SCRATCHPAD"],
           let png = palette.snapshotPNG() {
            let url = URL(fileURLWithPath: scratch).deletingLastPathComponent()
                .appendingPathComponent("palette-\(mode)-\(query.isEmpty ? "empty" : query).png")
            if (try? png.write(to: url)) != nil { line += " snapshot=\(url.path)" }
        }
        palette.close()
        return line
    }
    @objc func menuOpenDocument() { windows.openDocumentPanel() }

    /// The titlebar's Open button: Open…, and under it the recent files
    /// (`RecentsMenu`, `leadsWithOpen`), popped under the button that sent it,
    /// for the reason `menuOpenRecent` gives.
    @objc func menuOpenMenu(_ sender: Any?) {
        guard let view = sender as? NSView else { return }
        NSApp.activate(ignoringOtherApps: true)
        windows.recentsMenu(leadsWithOpen: true).popUp(
            positioning: nil,
            at: RecentsMenu.popUpOrigin(in: view.bounds, isFlipped: view.isFlipped),
            in: view)
    }

    /// Raise the recents list alone, under the view that sent this.
    ///
    /// No control sends it: the titlebar's button raises the Open menu above,
    /// and the missing-file card pops its own
    /// (`Coordinator.makeRecentsMenu`). It stays because the selector is the
    /// File menu's Open Recent row's identity (`AppMenu.Action.recents`,
    /// `AppMenu.row(for:)`), and an identity with no method behind it is a
    /// selector the first-run gate below could not name.
    ///
    /// The sender is a view, which is why the selector takes one: a menu
    /// has to be popped IN a view, and the only view that knows where this one
    /// belongs is the one that was pressed.
    @objc func menuOpenRecent(_ sender: Any?) {
        guard let view = sender as? NSView else { return }
        NSApp.activate(ignoringOtherApps: true)
        windows.recentsMenu().popUp(
            positioning: nil,
            at: RecentsMenu.popUpOrigin(in: view.bounds, isFlipped: view.isFlipped),
            in: view)
    }

    /// The same menu, for the two surfaces that cannot reach `windows`
    /// themselves: the File menu's submenu, built by `AppMenu` from a table
    /// that knows nothing about windows, and the missing-file card, which
    /// belongs to one window and must not answer a question about the set.
    func makeRecentsMenu() -> RecentsMenu { windows.recentsMenu() }

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
    /// so a new row is a line in `AppMenu` and nothing here. A method per
    /// command is the shape this replaces, and it does not survive a table
    /// this size.
    @objc func menuRunEditorCommand(_ sender: NSMenuItem) {
        guard let command = sender.representedObject as? AppMenu.Command else { return }
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
    ///
    /// No ordinary launch reaches this any more; `FirstRun` says which do.
    func showWelcome() {
        front?.showWelcome()
    }

    // MARK: - The first run

    /// The popover under the menu bar item, while it is up.
    private var firstRunPopover: FirstRunPopover?
    /// The floor under the first run: the panel comes up on its own if the
    /// chord never does. Invalidated by the panel coming up either way.
    private var firstRunFallback: Timer?
    /// The window whose first appearance ends the first run, so its hook can
    /// be taken back off. Weak: the set owns its windows, and a first run that
    /// outlived its own panel would be holding one alive to hear about it.
    private weak var firstRunWindow: Coordinator?
    /// Whether the wait raised the panel rather than the chord, which is the
    /// one thing `onDidShow` cannot say and the only thing that changes what
    /// happens to the popover.
    private var firstRunOpenedByWait = false

    /// Teach the summon by having it made.
    ///
    /// Nothing opens here. The menu bar says where the app is and which keys
    /// to press, and the chord is the only route to the panel, which is what
    /// makes the gesture teach itself rather than be described. The note
    /// behind it already holds the tour: `seedFirstRunNote` wrote it before
    /// the window was made.
    ///
    /// `applyOnboardingDefaults` still runs, and what it does is now done with
    /// no switch drawn beside it, so the tour is what says so. Its own header
    /// carries the constraint that follows: nothing it writes may turn the
    /// network on.
    private func beginFirstRun(on coordinator: Coordinator) {
        Prefs.applyOnboardingDefaults()
        let invitation = FirstRunInvitation.of(name: AppFlavor.current.displayName,
                                               combo: Prefs.hotkey,
                                               refused: windows.refusedSummonCombo)
        // The panel coming up is what ends this, whichever brought it up. Held
        // on the window rather than on the hotkey, because the wait below
        // raises the same panel by another route and both have to clear the
        // same state.
        firstRunWindow = coordinator
        coordinator.onDidShow = { [weak self] in self?.finishFirstRun() }
        // No menu bar item, no invitation: the sentence has nowhere to hang
        // and a wait with nothing to wait for is a blank screen for the
        // duration. The panel comes up now, on the tour, which teaches the
        // chord in its own words.
        guard let button = statusItem?.button else {
            firstRunOpenedByWait = true
            windows.summonAll()
            return
        }
        let popover = FirstRunPopover(invitation)
        popover.show(from: button)
        firstRunPopover = popover
        let fallback = Timer(timeInterval: invitation.wait, repeats: false) { [weak self] _ in
            Task { @MainActor in
                // Set BEFORE the summon, because the summon is what calls
                // `finishFirstRun`, synchronously, and a flag written after it
                // would be read by nobody.
                self?.firstRunOpenedByWait = true
                self?.windows.summonAll()
            }
        }
        // `.common`, not the default mode, and the popover is why: a popover
        // and a status-item menu both track the run loop in a mode of their
        // own, so a timer in the default mode stops while either is up. The
        // floor under a first run would then be lifted by exactly the surface
        // it is there to back up.
        RunLoop.main.add(fallback, forMode: .common)
        firstRunFallback = fallback
    }

    /// The panel is up, so the first run is over.
    ///
    /// `hasSeenWelcome` is spent HERE rather than at launch, so a crash before
    /// anybody saw anything does not spend the one chance to offer this. The
    /// tour is already on disk by then and `FirstRunNote.shouldWrite` refuses
    /// a note with writing in it, so a second launch finds the tour where it
    /// left it and invites again over the top of nothing.
    private func finishFirstRun() {
        firstRunFallback?.invalidate()
        firstRunFallback = nil
        // Pressing the chord is the proof the sentence was read, and the only
        // one there is: a popover dismissed another way says it was in the
        // way. So it goes when the chord brought the panel up, and stays when
        // the wait did, because then the keys it draws are still unread and
        // the note deliberately cannot name them.
        //
        // The reference is KEPT in that arm, and has to be: this object owns
        // the `NSPopover`, so dropping it here would take the popover off
        // screen by deallocating it, which is the opposite of what the arm
        // asks for.
        if firstRunOpenedByWait {
            firstRunPopover?.letTheFirstClickTakeIt()
        } else {
            firstRunPopover?.close()
            firstRunPopover = nil
        }
        firstRunWindow?.onDidShow = nil
        firstRunWindow = nil
        Prefs.hasSeenWelcome = true
    }

    /// Put the tour on disk before the panel mounts the file it is in.
    ///
    /// BEFORE the windows are made, which is the whole of why it is here
    /// rather than on the Coordinator: a launch reads its note off disk, so a
    /// tour written afterwards would have to be pushed into a page already
    /// holding the empty file, and the two writes would race. Written first,
    /// the ordinary mount is what opens it and there is no second path at all.
    ///
    /// `bufferIsEmpty` is true because there is no buffer: nothing is mounted
    /// yet, and no page exists to hold bytes the file has not been given. The
    /// other three refusals are what does the work here, and `FirstRunNote`
    /// says what each is for.
    ///
    /// Asked of `Prefs.activeURL` and its slot, which is the settings' own
    /// answer to what a launch opens and, with nothing stored, exactly what
    /// `WindowSet.openAtLaunch` falls back to.
    ///
    /// Failure is silent on purpose. Nothing is lost by not having the tour:
    /// the panel opens empty, and an error the first time somebody sees this
    /// app would be worse than the absence it is reporting.
    ///
    /// `isFirstRun` is `Prefs.isFirstLaunch`, the same gate
    /// `applyOnboardingDefaults` acts on, and it has to be the same one: the
    /// tour's opening says the app starts with the Mac, which is only true of
    /// an install whose first launch registered it. An install that predates
    /// the welcome key is invited and gets its panel, and is not told a thing
    /// that was never done to it.
    private static func seedFirstRunNote() {
        let url = Prefs.activeURL
        guard FirstRunNote.shouldWrite(existing: FirstRunNote.existing(at: url),
                                       bufferIsEmpty: true,
                                       isFirstRun: Prefs.isFirstLaunch,
                                       slot: Prefs.activeSlot) else { return }
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try AtomicFile.writeString(FirstRunNote.markdown, to: url)
        } catch {
            NSLog("Birta Writer: could not write the first-run note to \(url.path): \(error)")
            return
        }
        // Whatever was remembered about this path describes a document that no
        // longer exists there, so a scroll offset or a fold anchor kept from
        // it would be applied to the tour.
        Prefs.setViewStateJSON(nil, for: url)
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
    /// raised again until a newer one exists, or the recheck timer turns the
    /// offer into a nag and teaches people to switch updates off. And a panel
    /// that
    /// is not on screen means the person is in another app entirely, so the
    /// offer waits for the next summon instead of taking the screen from
    /// whatever they are actually doing.
    private func offerUpdate(_ tag: String) {
        guard updater.available != nil else { return }
        // One offer on screen at a time. The launch check and the recheck
        // timer are separate callers, and a sheet left up on an unattended
        // machine routinely outlives `UpdatePolicy.recheckInterval`, so
        // without this a second sheet queues behind the first and the person
        // answers the same question twice. Load-bearing rather than
        // defensive, and more so the shorter that interval is.
        guard !offering else { return }
        guard UpdatePolicy.shouldOffer(tag: tag, declined: Prefs.updateDeclinedTag) else { return }
        guard let host = promptHost else {
            front?.onNextShow = { [weak self] in self?.offerUpdate(tag) }
            return
        }
        offering = true
        UpdatePrompt.present(tag: tag,
                             hasUnwrittenBytes: front?.hasUnwrittenBytes ?? false,
                             staged: updater.staged?.tag == tag,
                             on: host) { [weak self] answer in
            guard let self else { return }
            self.offering = false
            guard answer == .install else {
                // Remembered so this version is not raised again. A NEWER one
                // still will be: that is different news.
                //
                // It suppresses the unattended swap as well as the sheet, and
                // that is the point rather than a side effect: a no is an
                // answer about the version, and a version that came back
                // anyway the next time somebody stepped away would make the
                // button a lie. The bytes go with it, because holding an
                // unpacked bundle against a settled question is holding tens
                // of megabytes for nothing.
                Prefs.updateDeclinedTag = tag
                self.updater.discardStaged()
                return
            }
            self.installUpdate()
        }
    }

    /// The window to hang the offer on, or nil when the app has none on screen.
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
            guard ok else {
                self.reportInstallFailure()
                return
            }
            self.restartForSwap()
        }
    }

    /// Say why an install somebody asked for staged nothing, as a sheet.
    ///
    /// The status line has already said it, to a panel that may be hidden
    /// behind the window the press came from. Silent when the updater has no
    /// reason to give, which is the refusal of a swap already armed: that
    /// state answers itself the next time the menu row is used.
    private func reportInstallFailure() {
        guard let reason = updater.lastFailure else { return }
        reportCheck(.couldNotInstall(reason: reason))
    }

    /// Quit so an armed swap can run, through the ordinary terminate path.
    ///
    /// The swap script is already staged and polling for this pid, so this
    /// quit has nothing to ask and nobody waiting to answer; the buffer is
    /// still flushed and written on the way out, as every quit is.
    private func restartForSwap() {
        windows.quitUnattended()
        NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 0)
    }

    /// Check for Updates…: the app menu, the menu-bar menu, and Check Now in
    /// Settings all come here, and every outcome is a sheet on the window it
    /// was asked from.
    ///
    /// A swap already armed for the next quit is answered without a request:
    /// the question then is not what is newest but whether to take it now,
    /// and the bytes are already here.
    @objc func menuCheckForUpdates() {
        if updater.armed, let staged = updater.staged {
            reportCheck(.armed(latest: staged.tag))
            return
        }
        updater.checkNow { [weak self] result in
            guard let self else { return }
            let answer: UpdatePolicy.CheckAnswer
            switch result {
            case let .found(tag): answer = .found(latest: tag, staged: self.updater.staged?.tag == tag)
            case .upToDate: answer = .upToDate
            case .failed: answer = .unreachable
            case .refused: answer = AppFlavor.current.updatesItself ? .busy : .notThisBuild
            }
            // Off the completion's own drain before anything modal, for the
            // reason `onUpdateAvailable` gives above.
            RunLoop.main.perform(inModes: [.common]) {
                MainActor.assumeIsolated { self.reportCheck(answer) }
            }
        }
    }

    /// Put the answer to an asked-for check in front of the person.
    ///
    /// On the window they pressed from where there is one, and otherwise on
    /// the panel, summoned for the purpose: an answer to a press has to land
    /// where they are looking, and the panel's status line, which is where
    /// the checks nobody asked for report, is hidden most of the time and
    /// behind Settings the rest of it.
    private func reportCheck(_ answer: UpdatePolicy.CheckAnswer) {
        let report = UpdatePolicy.checkReport(answer, appName: AppFlavor.current.displayName,
                                              current: updater.environment.currentVersion())
        if promptHost == nil { windows.summonAll() }
        guard let host = promptHost else {
            // The set always holds a window, so this is the answer to a
            // press with nowhere to attach, not the ordinary path: a modal
            // rather than silence, because a button that says nothing back
            // is a button that looks broken.
            //
            // It raises `offering` for the same reason the sheet below does,
            // and the reason is the same on both paths: an answer somebody
            // pressed for must not have the app quit and replace itself
            // underneath it. The modal is safe today for a reason nobody
            // chose, which is that `updateTimer` is a default-mode timer and
            // a nested modal run loop does not service it, and `runModal` is
            // also the one answer `isAnyWindowVisible` cannot see, since it
            // counts the panel, Settings and About and an alert is none of
            // those. Two accidents holding one invariant up is one accident
            // away from not holding it.
            NSApp.activate(ignoringOtherApps: true)
            offering = true
            let choice = UpdateCheckPrompt.choice(
                for: report, response: UpdateCheckPrompt.build(report).runModal())
            offering = false
            answerCheck(report, choice: choice)
            return
        }
        // One sheet about this app at a time, and no swap underneath it:
        // the flag the unasked offer raises does both, and this is the same
        // question on the same window.
        offering = true
        UpdateCheckPrompt.present(report, on: host) { [weak self] choice in
            guard let self else { return }
            self.offering = false
            self.answerCheck(report, choice: choice)
        }
    }

    private func answerCheck(_ report: UpdatePolicy.CheckReport, choice: UpdateCheckPrompt.Choice) {
        switch choice {
        case .installNow:
            installUpdate()
        case .installOnQuit:
            guard let release = updater.available else { return }
            // The status line says what was armed; a failure comes back as
            // a sheet, because the status line is not where they are looking.
            updater.installOnQuit(release) { [weak self] ok in
                if !ok { self?.reportInstallFailure() }
            }
        case .restartNow:
            guard updater.reopenAfterArmedSwap() else { return }
            restartForSwap()
        case .dismiss:
            break
        }
    }

    /// Put the staged update in, with nobody asked, if nobody is there to ask.
    ///
    /// The other half of the offer sheet, and the reason the sheet stopped
    /// being the only way in. This app is a menu-bar scratchpad: it is hidden
    /// nearly all the time, and the sheet can only be shown when it is not, so
    /// an update waited for a summon and then interrupted it. The version that
    /// costs nobody anything is the one that happens while they are elsewhere.
    ///
    /// What has to be true is `UpdatePolicy.mayInstallUnattended`'s to say,
    /// and this only gathers the facts. That split is deliberate: the decision
    /// that quits somebody's app should be one predicate that a test can flip
    /// field by field, rather than a chain of guards here where a clause that
    /// stopped being consulted would be invisible to every green run.
    ///
    /// What a refusal costs is nothing. The update stays staged, and the next
    /// poll asks again a minute later.
    private func applyStagedUpdateIfUnattended() {
        guard let staged = updater.staged, !updater.armed else { return }
        let state = UpdatePolicy.UnattendedInstall(
            isStaged: true,
            autoUpdate: Prefs.autoUpdate,
            wasDeclined: !UpdatePolicy.shouldOffer(tag: staged.tag,
                                                   declined: Prefs.updateDeclinedTag),
            offerOnScreen: offering,
            workInFlight: windows.windows.contains(where: \.hasAgentRunInFlight),
            attendance: UpdatePolicy.Attendance(
                anyWindowVisible: isAnyWindowVisible,
                hasUnwrittenBytes: windows.windows.contains(where: \.hasUnwrittenBytes),
                idle: Updater.systemIdleSeconds()))
        guard UpdatePolicy.mayInstallUnattended(state) else { return }
        guard updater.armStagedSwap(reopen: .background) else { return }
        // Written BEFORE the quit, because after it there is no process left
        // to write anything, and this is the only record that the swap was
        // ever attempted. It is not yet a claim that the swap WORKED:
        // `recordSilentUpdate` asks the next launch's own version about that.
        Prefs.updateInstalledTag = staged.tag
        // Quitting is what performs the swap, through the ordinary terminate
        // path so the buffer is flushed on the way out. Nobody is here to
        // answer a sheet, so no window may raise one.
        windows.quitUnattended()
        NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 0)
    }

    /// Any window of this app on screen, not only a panel.
    ///
    /// Settings and About count. A person reading the About window is as
    /// present as a person typing, and an app that vanished and came back
    /// underneath either of them would be the interruption this whole path is
    /// built to avoid.
    private var isAnyWindowVisible: Bool {
        windows.isAnyVisible
            || settingsWindow?.window?.isVisible == true
            || aboutWindow?.window?.isVisible == true
    }

    /// Write down what the app did to itself while nobody was watching, and
    /// say nothing.
    ///
    /// The log rather than the panel, and it is the same argument `Updater`
    /// makes about a background run: nobody asked for this, the app keeping
    /// itself current is not a thing to act on, and the one surface that
    /// could carry it is hidden most of the time, so a message put there is
    /// spent on whichever window somebody next summoned for something else.
    ///
    /// The running build is still what answers whether the swap happened.
    /// `updateInstalledTag` is written by the process that armed the swap,
    /// before it could know whether the swap would work, and it can fail for
    /// reasons that leave the old app in place: a staged bundle the temporary
    /// directory reclaimed, a move that could not be made. So the version this
    /// build actually is answers the question, and a build older than the tag
    /// means the swap did not happen. That failure is the line worth having,
    /// because nothing else in the app can see it.
    ///
    /// Cleared either way, here. The tag survived a quit so that the next
    /// launch could tell those two apart; once it has, it is answered.
    private func recordSilentUpdate() {
        guard let pending = Prefs.updateInstalledTag else { return }
        Prefs.updateInstalledTag = nil
        let running = updater.environment.currentVersion()
        if ReleaseFeed.isNewer(pending, than: running) {
            NSLog("Birta Writer: the unattended swap to \(pending) did not go in; still \(running)")
        } else {
            NSLog("Birta Writer: updated to \(pending) in the background")
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
        if aboutWindow == nil {
            aboutWindow = AboutWindowController(
                onCheckForUpdates: { [weak self] in self?.menuCheckForUpdates() })
        }
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
                refusedSummonCombo: { [weak self] in self?.windows.refusedSummonCombo },
                onChange: { [weak self] work in self?.front?.preferencesChanged(beforeReload: work) },
                onChangeEverywhere: { [weak self] in self?.windows.preferencesChangedEverywhere() },
                onReset: { [weak self] in self?.windows.settingsWereReset() },
                onShowWelcome: { [weak self] in self?.showWelcome() },
                onCheckForUpdates: { [weak self] in self?.menuCheckForUpdates() },
                themeStore: windows.themeStore,
                onAppearanceChange: { [weak self] settings in self?.windows.setAppearance(settings) },
                onThemesChanged: { [weak self] in self?.windows.themesChanged() },
                onEditorCommand: { [weak self] id in self?.windows.runEditorCommandEverywhere(id) },
                onFormattingRowChange: { [weak self] on in
                    self?.windows.setFormattingRowExpanded(on)
                })
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.showWindow(nil)
        settingsWindow?.window?.makeKeyAndOrderFront(nil)
    }
}

extension AppDelegate: NSMenuDelegate, NSMenuItemValidation {
    func menuNeedsUpdate(_ menu: NSMenu) {
        // Every menu that carries this delegate arrives here, and they want
        // different things, so which one arrived has to be the first question.
        // Only the sweep at the end is owed to all of them. Answer it by identity
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
        } else if menu === fileMenu {
            // What Cmd+W will do, said before it is pressed. With one tab it
            // is the window (or the hide the last window does), and with
            // several it is the tab.
            closeItem?.title = (front?.tabCount ?? 1) > 1 ? "Close Tab" : "Close"
        } else if menu === viewMenu || menu === formatMenu {
            // One call for both, because both menus are asking the same
            // question of the same table: which of my rows is withdrawn right
            // now. The View menu has the toggles and the Format menu has the
            // syntax targets, and neither has to know which of the two gates
            // is the one that applies to it.
            AppMenu.applyState(menuState(), syntaxSets: Prefs.syntaxSets, to: menu)
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
                                      tocShown: Prefs.tocVisibility == "shown",
                                      explorerShown: Prefs.explorerVisibility == "shown",
                                      hiddenFilesShown: Prefs.explorerShowsHidden,
                                      lineNumbers: Prefs.lineNumbers)
    }

    /// Enablement for the main menu and the status menu, which keep their items
    /// between openings.
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        guard let action = item.action else { return true }
        return allows(action)
    }

    /// Whether a menu row's action can run right now: THE gate, asked by the
    /// menu bar for each item and by the command palette for each row it
    /// lists and each pick it runs, so the palette can never offer a row the
    /// menu would have dimmed (`PaletteSources`).
    func allows(_ action: Selector) -> Bool {
        // Nothing that touches the document while the first-run screen is up.
        // Hiding the web view walls off the mouse and, with the first
        // responder moved, the keyboard; the menu bar reaches past both. Cmd+N
        // there would make a note in the folder the screen is still asking
        // about and bind to it, outranking the answer being given, and its
        // status message would be drawn behind the screen.
        if front?.isWelcoming == true, Self.documentCommands.contains(action) {
            return false
        }
        switch action {
        case #selector(copyEverything), #selector(menuSaveAs), #selector(shareNote):
            return front?.hasContent ?? false
        case #selector(revealLastSave):
            return front?.lastSavedURL != nil
        case #selector(menuClearRecentDocuments):
            return !Prefs.recentDocuments.isEmpty
        case #selector(menuToggleExplorer), #selector(menuToggleHiddenFiles):
            // Live only in a window rooted at a folder, which is the only kind
            // with an explorer to show or hide. Disabled rather than withdrawn
            // (`AppMenu.viewRows` says why).
            return front?.explorerRoot != nil
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
        #selector(menuNewNote), #selector(menuNewTab), #selector(menuOpenDocument),
        #selector(menuOpenMenu(_:)), #selector(menuOpenRecent(_:)), #selector(menuOpenRecentDocument(_:)),
        #selector(menuSaveNow), #selector(menuSaveAs),
        #selector(copyEverything), #selector(shareNote), #selector(revealLastSave),
        #selector(menuBackToNotes), #selector(menuRunEditorCommand(_:)),
    ]
}
