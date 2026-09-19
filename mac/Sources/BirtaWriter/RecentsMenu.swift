import AppKit
import BirtaWriterCore

/// Something that can build a recents menu knowing which window is asking.
///
/// A protocol rather than a closure passed down through `AppMenu.add`, because
/// the menu table already routes everything else to a TARGET and this is one
/// more thing that target knows. It is answered by `AppDelegate` alone.
@MainActor
protocol RecentsMenuProviding: AnyObject {
    func makeRecentsMenu() -> RecentsMenu
}

/// The Open Recent list, as a menu that fills itself.
///
///     Note.md
///     Meeting.md
///     …                     ten rows
///     More            ▸     the next twenty
///     ─────────
///     Clear Menu
///
/// Three surfaces show this and none of them owns it: the File menu's Open
/// Recent row (`AppMenu.Action.recents`), the titlebar's Open button
/// (`AppDelegate.menuOpenMenu`), and the missing-file card's Open Recent
/// button (`Coordinator.makeRecentsMenu`). It fills ITSELF rather than being
/// filled by whichever surface raised it, which is what keeps the three from
/// becoming three lists that agree today.
///
/// The titlebar's is the same list under a different first row
/// (`leadsWithOpen`), because that button is Open and Open Recent in one:
///
///     Open…           ⌘O
///     ─────────
///     Note.md
///     Meeting.md
///     ─────────
///     Clear Recents
///
/// With nothing recent it is Open… alone. The dead "No Recent Files" row is
/// the other form's, where the alternative is a submenu with one live row in
/// it; here the menu has a first row that always works, and a line under it
/// saying what is not there would be the longest thing in it.
///
/// What it cannot fill in for itself is WHICH WINDOW is asking, because that is
/// a fact about the set of windows and this is one menu shared by all of them.
/// `WindowSet.recentsMenu` is the one place that answers it, and every surface
/// goes through it.
///
/// ## Why it rebuilds on every open
///
/// The menu bar is built once, at launch, and the list changes every time a
/// file is opened. A menu whose rows were decided at build time would be the
/// list as it stood when the app started, and would look right the whole time
/// it was wrong. It is also populated at INIT rather than only on open, so it
/// is never an empty submenu hanging off a live row: AppKit will show a menu
/// it has not had a chance to update in a few places, and an empty one there
/// reads as a broken menu rather than an empty list.
///
/// ## Why the rows have no target
///
/// Same rule as the titlebar's buttons: a nil target sends the click up the
/// responder chain to the application's delegate, so the row and the button
/// end at one implementation instead of two that happen to agree.
///
/// That is also what makes the group at the top need no wiring of its own. A
/// row there names a file already open in another window, and the selector it
/// sends reaches `WindowSet.openDocument`, which brings that file's window
/// forward rather than opening a second one over it. So the group is a
/// statement about what the rows MEAN and not a second code path; the rule it
/// leans on is a data-loss guard that was already there.
@MainActor
final class RecentsMenu: NSMenu, NSMenuDelegate {
    /// Where to pop this menu up so it hangs BELOW `bounds`, in that view's own
    /// coordinates.
    ///
    /// `NSMenu.popUp(positioning:at:in:)` puts the menu's top-left at the point
    /// it is given, so the point wanted is the view's BOTTOM-left. Which edge
    /// that is depends on the view: AppKit's default coordinates grow upward,
    /// so the bottom is `minY`, and a flipped view's grow downward, so the
    /// bottom is `maxY`. A point written for one convention lands the menu on
    /// top of the button under the other, which is what it did.
    ///
    /// The gap is the same air the page's own menus leave under the bar they
    /// open from, so a menu opened from either half of this band sits the same
    /// distance below it.
    static func popUpOrigin(in bounds: NSRect, isFlipped: Bool, gap: CGFloat = 4) -> NSPoint {
        NSPoint(x: bounds.minX,
                y: isFlipped ? bounds.maxY + gap : bounds.minY - gap)
    }

    /// Where the list comes from, and how a file's presence is decided. Both
    /// injected so a check can put a fixed list in front of the menu without a
    /// defaults domain or a disk.
    private let source: () -> [URL]
    private let exists: (URL) -> Bool

    /// The file the window this menu belongs to is on, so that row is not
    /// offered back to somebody already reading it. Injected for the same
    /// reason the other two are: a check can put a list and a current file in
    /// front of this menu with no defaults domain and no disk.
    ///
    /// `Prefs.activeURL` is the default and is the WRONG answer once there are
    /// two windows, which is why every real construction site passes the front
    /// window's own file instead. It stays the default because it is the only
    /// answer available with no app to ask, and a menu built with nothing to
    /// ask is a menu in a test.
    private let current: () -> URL?

    /// The folder the window this menu belongs to is rooted at, for the same
    /// reason `current` exists: a directory window IS its root, and a row
    /// that brought the window you raised the menu from forward is the "you
    /// are here" row this menu does not have. Nil for a loose window.
    private let currentRoot: () -> URL?

    /// The files open in OTHER windows, most recently fronted first, for the
    /// group at the top. Empty by default, which is the one-window app and the
    /// menu as it was.
    private let openElsewhere: () -> [URL]

    /// Whether this is the titlebar's form: Open… above the list, and the list
    /// allowed to be absent. See the type's note.
    private let leadsWithOpen: Bool

    init(leadsWithOpen: Bool = false,
         source: @escaping () -> [URL] = { Prefs.recentDocuments },
         exists: @escaping (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) },
         current: @escaping () -> URL? = { Prefs.activeURL },
         currentRoot: @escaping () -> URL? = { nil },
         openElsewhere: @escaping () -> [URL] = { [] }) {
        self.leadsWithOpen = leadsWithOpen
        self.source = source
        self.exists = exists
        self.current = current
        self.currentRoot = currentRoot
        self.openElsewhere = openElsewhere
        super.init(title: "Open Recent")
        identifier = AppMenu.recentsMenuIdentifier
        delegate = self
        rebuild()
    }

    required init(coder: NSCoder) { fatalError("not used") }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === self else { return }
        rebuild()
    }

    private func rebuild() {
        removeAllItems()
        let menu = RecentFiles.menu(stored: source(),
                                    openElsewhere: openElsewhere(),
                                    here: current(),
                                    rootedAt: currentRoot(),
                                    exists: exists)
        let (first, more) = RecentFiles.pages(menu.recent)

        if leadsWithOpen {
            // The row the File menu has, by its own selector and with no
            // target, so this Open… and that one are one action. The chord is
            // printed because the row it repeats prints it; a popped-up menu
            // only answers key equivalents while it is being tracked, so this
            // is not a second binding of the chord.
            let open = addItem(withTitle: "Open…",
                               action: #selector(AppDelegate.menuOpenDocument),
                               keyEquivalent: "o")
            open.keyEquivalentModifierMask = .command
            open.target = nil
            if menu.isEmpty {
                AppDelegate.suppressAutomaticIcons(in: self)
                return
            }
            addItem(.separator())
        }

        if menu.isEmpty {
            // A dead row rather than a menu with only Clear Menu in it: an
            // empty list is a fact worth stating, and a menu that opens onto
            // one live row reads as though the rows failed to load. No action
            // is what makes it dead: AppKit validates every row that has one,
            // so an `isEnabled` written here would be overwritten on the next
            // pass and the row would light up.
            //
            // Asked of the WHOLE menu, so it never appears under a group of
            // windows saying there is nothing here. `RecentFiles.Menu.isEmpty`
            // holds the reasoning.
            addItem(withTitle: "No Recent Files", action: nil, keyEquivalent: "")
        } else {
            if !menu.elsewhere.isEmpty {
                // A heading, not a row: it names what the rows under it do,
                // and it is dead for the reason the empty-state row is. macOS
                // has no group header in a menu, so this is the shape every
                // app that wants one arrives at, and the separator beneath is
                // what closes the group.
                let heading = addItem(withTitle: "Open in Other Windows",
                                      action: nil, keyEquivalent: "")
                heading.attributedTitle = NSAttributedString(
                    string: heading.title,
                    attributes: [.font: NSFont.menuFont(ofSize: NSFont.smallSystemFontSize),
                                 .foregroundColor: NSColor.secondaryLabelColor])
                for row in menu.elsewhere { addItem(fileRow(row)) }
                if !first.isEmpty || !more.isEmpty { addItem(.separator()) }
            }
            for row in first { addItem(fileRow(row)) }
            if !more.isEmpty {
                let item = addItem(withTitle: "More", action: nil, keyEquivalent: "")
                let sub = NSMenu(title: "More")
                for row in more { sub.addItem(fileRow(row)) }
                item.submenu = sub
            }
        }

        addItem(.separator())
        // Enablement is `AppDelegate.validateMenuItem`'s, for the reason above:
        // this row has an action, so AppKit asks before every showing and the
        // answer has to come from the place it asks.
        //
        // Two titles for one action, and the menu it is in decides which.
        // "Clear Menu" is what macOS calls this row under Open Recent, where
        // the menu IS the list. Under Open… it would promise to clear a menu
        // whose first row is not clearable, so there it names what goes.
        addItem(withTitle: leadsWithOpen ? "Clear Recents" : "Clear Menu",
                action: #selector(AppDelegate.menuClearRecentDocuments),
                keyEquivalent: "").target = nil

        // This menu is built after the one sweep that clears the system's
        // automatic symbols, so it does its own. See `suppressAutomaticIcons`.
        AppDelegate.suppressAutomaticIcons(in: self)
        // ...and the rows are inked AFTER that sweep, which clears every
        // item's image and cannot tell one this menu set on purpose from one
        // macOS added. Found by the payload the rows already carry rather
        // than by a second list kept in step with the one built above.
        Self.drawKinds(in: self)
    }

    /// Give every row that opens something the Finder's own icon for it.
    ///
    /// The list holds folders as well as files, and a name alone does not say
    /// which: an extension nearly always does, and nearly always is not a
    /// rule a reader can use. The icon is the channel that always says it.
    ///
    /// The Finder's picture rather than a pair of SF Symbols, because this
    /// menu is now a picture of the filesystem and the app already made that
    /// choice once, for the titlebar's path popup (`TitleBarView.showPathMenu`).
    /// A notes folder this app has badged then arrives wearing its own mark,
    /// which no symbol could say.
    ///
    /// Every row that opens something, and not only the folders: inked on the
    /// folders alone, the icon would be a mark on the unusual row rather than
    /// a column saying what each row is, and the file rows would be the ones
    /// that looked odd. The rows that open NOTHING (the heading, More, Clear
    /// Recents, the empty state) carry none, so the one distinction the
    /// column draws is between a place to go and a thing to do.
    ///
    /// It asks the disk once per row, on every opening, which is a cost worth
    /// naming rather than hiding: a path on a volume that has gone away can
    /// hold up the answer. It is not a new hazard, because the rows were
    /// already filtered by `exists` a few lines above and that asks the same
    /// disk the same number of times; what a slow volume costs here it was
    /// already costing before any of this was drawn.
    private static func drawKinds(in menu: NSMenu) {
        for item in menu.items {
            if let submenu = item.submenu { drawKinds(in: submenu) }
            guard let url = item.representedObject as? URL else { continue }
            let icon = NSWorkspace.shared.icon(forFile: url.path)
            icon.size = NSSize(width: 16, height: 16)
            item.image = icon
        }
    }

    private func fileRow(_ row: RecentFiles.Row) -> NSMenuItem {
        let item = NSMenuItem(title: row.title,
                              action: #selector(AppDelegate.menuOpenRecentDocument(_:)),
                              keyEquivalent: "")
        item.target = nil
        item.representedObject = row.url
        // No checkmark on any row, and no row for the file this window is on.
        // That mark used to say "you are here", which is what a macOS menu does
        // for the one of its rows you are looking at, and it was decided from
        // an APP-WIDE setting: with two windows open it could tick a row in the
        // wrong window's menu. `RecentFiles.menu` leaves that file out of the
        // list entirely instead, which is a stronger version of the same
        // statement and cannot be wrong about which window is asking.
        //
        // The path, for the case the title cannot answer: two files with the
        // same name in two folders that are also named the same.
        item.toolTip = (row.url.path as NSString).abbreviatingWithTildeInPath
        return item
    }
}
