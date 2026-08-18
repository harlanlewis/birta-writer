import AppKit
import WebKit
import BirtaJotCore

/// The app: status item, main menu, and the Coordinator that ties the hotkey,
/// the panel, the web host and the store together.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var coordinator: Coordinator!
    private var prefsWindow: PreferencesWindowController?
    private var reopenItem: NSMenuItem!
    private var showItem: NSMenuItem!

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMainMenu()
        coordinator = Coordinator()
        buildStatusItem()
        coordinator.start()
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
        appMenu.addItem(withTitle: "Preferences…", action: #selector(openPreferences), keyEquivalent: ",")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Birta Jot", action: #selector(hidePanel), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Birta Jot", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem(); appItem.submenu = appMenu; main.addItem(appItem)

        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(withTitle: "Save As…", action: #selector(saveAs), keyEquivalent: "s")
        reopenItem = fileMenu.addItem(withTitle: "Reopen Last Saved", action: #selector(reopenLastSaved), keyEquivalent: "")
        reopenItem.isEnabled = false
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Close", action: #selector(hidePanel), keyEquivalent: "w")
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
        let editItem = NSMenuItem(); editItem.submenu = editMenu; main.addItem(editItem)

        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        let windowItem = NSMenuItem(); windowItem.submenu = windowMenu; main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "square.and.pencil", accessibilityDescription: "Birta Jot")
            button.toolTip = "Birta Jot"
        }
        let menu = NSMenu()
        showItem = menu.addItem(withTitle: "Show Jot", action: #selector(togglePanel), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Save As…", action: #selector(saveAs), keyEquivalent: "")
        let reopen = menu.addItem(withTitle: "Reopen Last Saved", action: #selector(reopenLastSaved), keyEquivalent: "")
        reopen.isEnabled = false
        menu.addItem(.separator())
        menu.addItem(withTitle: "Preferences…", action: #selector(openPreferences), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Birta Jot", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        menu.delegate = self
        statusItem.menu = menu
        // Two menus show the reopen item; keep both in step.
        let mainReopen = reopenItem!
        coordinator.onUndoSlotChange = { hasSlot in
            mainReopen.isEnabled = hasSlot
            reopen.isEnabled = hasSlot
        }
    }

    // MARK: actions

    @objc private func togglePanel() { coordinator.toggle() }
    @objc private func hidePanel() { coordinator.hide() }
    @objc private func saveAs() { coordinator.saveAs() }
    @objc private func reopenLastSaved() { coordinator.reopenLastSaved() }

    @objc private func openPreferences() {
        if prefsWindow == nil {
            prefsWindow = PreferencesWindowController(onChange: { [weak self] in self?.coordinator.preferencesChanged() })
        }
        NSApp.activate(ignoringOtherApps: true)
        prefsWindow?.showWindow(nil)
        prefsWindow?.window?.makeKeyAndOrderFront(nil)
    }
}

extension AppDelegate: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        let combo = coordinator.hotkey.combo ?? Prefs.hotkey
        showItem.title = (coordinator.isVisible ? "Hide Jot" : "Show Jot") + "  \(combo.symbols)"
    }
}
