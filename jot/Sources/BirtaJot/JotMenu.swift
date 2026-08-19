import AppKit
import BirtaJotCore

/// The shortcuts Jot binds itself, in one table.
///
/// One table because there are two consumers and they must not drift: the main
/// menu is BUILT from this, and the same rows are declared to the page as
/// `hostShortcuts` so the keyboard cheatsheet can print them. A second list
/// maintained by hand would eventually print a key the menu no longer binds,
/// and a cheatsheet that lies is worse than one that omits.
///
/// Only Jot's OWN actions are here. Undo, Cut, Copy, Paste, Select All, Close
/// and Minimize are the system's, bound by AppKit to the standard chords and
/// already known to everyone; printing them would pad the panel with things no
/// reader came to look up.
enum JotMenu {
    struct Shortcut {
        let title: String
        let key: String
        let modifiers: NSEvent.ModifierFlags
        let action: Selector
        /// Which menu it belongs to.
        let menu: Menu

        enum Menu { case app, file, edit }

        /// The chord in the page's notation, which is what the cheatsheet
        /// prints. Derived rather than written twice.
        var chord: String {
            HostShortcut.chord(
                key: key,
                command: modifiers.contains(.command),
                shift: modifiers.contains(.shift),
                option: modifiers.contains(.option),
                control: modifiers.contains(.control))
        }
    }

    /// The rows, in menu order within each menu.
    static let shortcuts: [Shortcut] = [
        .init(title: "Settings", key: ",", modifiers: [.command],
              action: #selector(AppDelegate.menuOpenSettings), menu: .app),
        .init(title: "New Note", key: "n", modifiers: [.command],
              action: #selector(AppDelegate.menuNewNote), menu: .file),
        .init(title: "Save", key: "s", modifiers: [.command],
              action: #selector(AppDelegate.menuSaveNow), menu: .file),
        .init(title: "Save a Copy As…", key: "s", modifiers: [.command, .shift],
              action: #selector(AppDelegate.menuSaveAs), menu: .file),
        .init(title: "Find…", key: "f", modifiers: [.command],
              action: #selector(AppDelegate.menuFind), menu: .edit),
        .init(title: "Insert Link…", key: "k", modifiers: [.command],
              action: #selector(AppDelegate.menuInsertLink), menu: .edit),
        .init(title: "Toggle Task Done", key: "d", modifiers: [.command, .shift],
              action: #selector(AppDelegate.menuToggleTaskChecked), menu: .edit),
    ]

    /// Append this menu's rows, with their chords, targeting `target`.
    @MainActor
    static func add(_ menu: Shortcut.Menu, to nsMenu: NSMenu, target: AnyObject) {
        for shortcut in shortcuts where shortcut.menu == menu {
            let item = nsMenu.addItem(withTitle: shortcut.title, action: shortcut.action,
                                      keyEquivalent: shortcut.key)
            item.keyEquivalentModifierMask = shortcut.modifiers
            item.target = target
        }
    }
}
