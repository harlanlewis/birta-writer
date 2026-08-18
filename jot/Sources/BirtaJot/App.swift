import AppKit
import WebKit
import BirtaJotCore

/// The app: status item, main menu, and the Coordinator that ties the hotkey,
/// the panel, the web host and the store together.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Items whose title depends on the buffer's state, retitled whenever a
    /// menu holding them opens. Tags rather than outlets because the same two
    /// actions appear in the main menu, the status menu and the overflow.
    private enum ItemTag: Int {
        case chute = 1
        case restore = 2
    }

    private var statusItem: NSStatusItem!
    private var statusMenu: NSMenu!
    private var coordinator: Coordinator!
    private var settingsWindow: SettingsWindowController?
    private var showItem: NSMenuItem!
    private var terminationSignal: DispatchSourceSignal?
    /// The view the overflow menu was opened from, for the sharing picker,
    /// which needs somewhere on screen to point at.
    private weak var overflowAnchor: NSView?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMainMenu()
        coordinator = Coordinator()
        coordinator.makeOverflowMenu = { [weak self] anchor in
            self?.overflowAnchor = anchor
            return self?.buildOverflowMenu() ?? NSMenu()
        }
        buildStatusItem()
        coordinator.start()
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

        let appMenu = NSMenu(title: "Birta Jot")
        appMenu.addItem(withTitle: "About Birta Jot", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Birta Jot", action: #selector(hidePanel), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Birta Jot", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem(); appItem.submenu = appMenu; main.addItem(appItem)

        // The chute, in the order the row along the bottom of the panel has it.
        // Copy and Delete takes Option+Cmd+C rather than anything more obvious:
        // the panel is a live editor, so a chord the editor itself binds
        // (Cmd+Return, Shift+Cmd+X) would be taken away from typing, which the
        // main menu wins outright (shared/__tests__/keymapChords.ts lists what
        // the webview claims).
        let fileMenu = NSMenu(title: "File")
        let chute = fileMenu.addItem(withTitle: "Copy and Delete", action: #selector(copyAndDelete), keyEquivalent: "c")
        chute.keyEquivalentModifierMask = [.command, .option]
        chute.tag = ItemTag.chute.rawValue
        fileMenu.addItem(withTitle: "Copy Everything", action: #selector(copyEverything), keyEquivalent: "")
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Save", action: #selector(saveNote), keyEquivalent: "s")
        let saveAsItem = fileMenu.addItem(withTitle: "Save As…", action: #selector(saveAs), keyEquivalent: "s")
        saveAsItem.keyEquivalentModifierMask = [.command, .shift]
        fileMenu.addItem(withTitle: "Discard", action: #selector(discard), keyEquivalent: "")
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Reopen Last Saved", action: #selector(restoreLastNote), keyEquivalent: "")
            .tag = ItemTag.restore.rawValue
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
        editMenu.addItem(withTitle: "Find…", action: #selector(findInEditor), keyEquivalent: "f")
        editMenu.addItem(withTitle: "Insert Link…", action: #selector(insertLink), keyEquivalent: "k")
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
            button.image = NSImage(systemSymbolName: "square.and.pencil", accessibilityDescription: "Birta Jot")
            button.toolTip = "Birta Jot"
            button.target = self
            button.action = #selector(statusItemClicked)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        let menu = NSMenu()
        // The panel toggle, and nothing about where files live: that belongs in
        // the window, next to the note it would act on.
        showItem = menu.addItem(withTitle: "Show Birta Writer Jot", action: #selector(togglePanel), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Birta Jot", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        for item in menu.items where item.action != nil && item.action != #selector(NSApplication.terminate(_:)) {
            item.target = self
        }
        menu.delegate = self
        statusMenu = menu
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

    /// The panel's ··· menu: everything the chute can do that the two buttons
    /// do not. Built fresh on each click, so an item that cannot act right now
    /// is simply absent rather than present and dead.
    private func buildOverflowMenu() -> NSMenu {
        let menu = NSMenu()

        let saveAsItem = menu.addItem(withTitle: "Save As…", action: #selector(saveAs), keyEquivalent: "")
        saveAsItem.isEnabled = coordinator.hasContent

        let recents = Prefs.recentDestinations.urls.filter { $0.path != Prefs.saveDirectory.standardizedFileURL.path }
        if coordinator.hasContent, !recents.isEmpty {
            let submenu = NSMenu()
            for folder in recents {
                let item = submenu.addItem(withTitle: folder.lastPathComponent, action: #selector(saveToRecent(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = folder
                item.toolTip = folder.path
            }
            menu.addItem(withTitle: "Save to", action: nil, keyEquivalent: "").submenu = submenu
        }

        menu.addItem(.separator())
        menu.addItem(withTitle: "Copy Everything", action: #selector(copyEverything), keyEquivalent: "")
            .isEnabled = coordinator.hasContent
        menu.addItem(withTitle: "Share…", action: #selector(shareNote), keyEquivalent: "")
            .isEnabled = coordinator.hasContent
        if coordinator.chuteEmptiesBuffer {
            menu.addItem(withTitle: "Discard", action: #selector(discard), keyEquivalent: "")
                .isEnabled = coordinator.hasContent
        }

        if coordinator.restoreActionTitle != nil || coordinator.lastSavedURL != nil {
            menu.addItem(.separator())
            if let title = coordinator.restoreActionTitle {
                menu.addItem(withTitle: title, action: #selector(restoreLastNote), keyEquivalent: "")
            }
            if coordinator.lastSavedURL != nil {
                menu.addItem(withTitle: "Reveal Last Save in Finder", action: #selector(revealLastSave), keyEquivalent: "")
            }
        }

        menu.addItem(.separator())
        menu.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: "")

        // The menu answers for its own items: automatic validation would ask
        // the responder chain and re-enable everything disabled above.
        menu.autoenablesItems = false
        for item in menu.items where item.action != nil && item.target == nil { item.target = self }
        AppDelegate.suppressAutomaticIcons(in: menu)
        return menu
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
    @objc private func copyAndDelete() { coordinator.copyAndDelete() }
    @objc private func copyEverything() { coordinator.copyEverything() }
    @objc private func discard() { coordinator.discard() }
    @objc private func saveNote() { coordinator.saveToDefaultDestination() }
    @objc private func saveAs() { coordinator.saveAs() }
    @objc private func restoreLastNote() { coordinator.restoreLastNote() }
    @objc private func revealLastSave() { coordinator.revealLastSave() }
    @objc private func findInEditor() { coordinator.runEditorCommand("openFind") }
    @objc private func insertLink() { coordinator.runEditorCommand("insertLink") }

    @objc private func saveToRecent(_ sender: NSMenuItem) {
        guard let folder = sender.representedObject as? URL else { return }
        coordinator.saveNote(into: folder)
    }

    @objc private func shareNote() {
        guard let anchor = overflowAnchor else { return }
        coordinator.shareNote(from: anchor)
    }

    @objc private func openSettings() {
        if settingsWindow == nil {
            settingsWindow = SettingsWindowController(
                onHotkeyChange: { [weak self] in self?.coordinator.hotkeyChanged() ?? -1 },
                onChange: { [weak self] in self?.coordinator.preferencesChanged() })
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
        showItem.title = coordinator.isVisible ? "Hide Birta Writer Jot" : "Show Birta Writer Jot"
        showItem.keyEquivalent = combo.menuKeyEquivalent
        showItem.keyEquivalentModifierMask = combo.menuModifierMask

        for item in menu.items {
            switch ItemTag(rawValue: item.tag) {
            case .chute: item.title = coordinator.chuteActionTitle
            case .restore: item.title = coordinator.restoreActionTitle ?? "Reopen Last Saved"
            case nil: break
            }
        }
        AppDelegate.suppressAutomaticIcons(in: menu)
    }

    /// Enablement for the main menu and the status menu, which keep their items
    /// between openings. The overflow menu answers for its own.
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        switch item.action {
        case #selector(copyAndDelete), #selector(copyEverything), #selector(saveNote), #selector(saveAs):
            return coordinator.hasContent
        case #selector(discard):
            return coordinator.hasContent && coordinator.chuteEmptiesBuffer
        case #selector(restoreLastNote):
            return coordinator.restoreActionTitle != nil
        case #selector(revealLastSave):
            return coordinator.lastSavedURL != nil
        default:
            return true
        }
    }
}
