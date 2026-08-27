import AppKit
import BirtaWriterCore

/// The Open Recent list, as a menu that fills itself.
///
///     Note.md
///     Meeting.md
///     …                     ten rows
///     More            ▸     the next twenty
///     ─────────
///     Clear Menu
///
/// Two surfaces show this and neither of them owns it: the File menu's Open
/// Recent row (`AppMenu.Action.recents`) and the titlebar's recents button
/// (`AppDelegate.menuOpenRecent`). It fills ITSELF rather than being filled by
/// whichever surface raised it, which is what keeps the two from becoming two
/// lists that agree today.
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

    /// The file the panel is on right now, so its row can say so. Injected for
    /// the same reason the other two are: a check can put a list and a current
    /// file in front of this menu with no defaults domain and no disk.
    private let current: () -> URL?

    init(source: @escaping () -> [URL] = { Prefs.recentDocuments },
         exists: @escaping (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) },
         current: @escaping () -> URL? = { Prefs.activeURL }) {
        self.source = source
        self.exists = exists
        self.current = current
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
        let (first, more) = RecentFiles.pages(RecentFiles.rows(from: source(), exists: exists))

        if first.isEmpty {
            // A dead row rather than a menu with only Clear Menu in it: an
            // empty list is a fact worth stating, and a menu that opens onto
            // one live row reads as though the rows failed to load. No action
            // is what makes it dead: AppKit validates every row that has one,
            // so an `isEnabled` written here would be overwritten on the next
            // pass and the row would light up.
            addItem(withTitle: "No Recent Files", action: nil, keyEquivalent: "")
        } else {
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
        addItem(withTitle: "Clear Menu",
                action: #selector(AppDelegate.menuClearRecentDocuments),
                keyEquivalent: "").target = nil

        // This menu is built after the one sweep that clears the system's
        // automatic symbols, so it does its own. See `suppressAutomaticIcons`.
        AppDelegate.suppressAutomaticIcons(in: self)
    }

    private func fileRow(_ row: RecentFiles.Row) -> NSMenuItem {
        let item = NSMenuItem(title: row.title,
                              action: #selector(AppDelegate.menuOpenRecentDocument(_:)),
                              keyEquivalent: "")
        item.target = nil
        item.representedObject = row.url
        // A checkmark on the file already open, which is what a macOS menu
        // does for the one of its rows you are looking at. The list holds the
        // current file because every rebind records the file it moves TO, so
        // without this the row a reader is already in is offered back to them
        // as though it were somewhere else to go.
        //
        // Compared by standardized path, which is the SAME rule
        // `RecentFiles.recording` dedupes the list with, so a file the list
        // treats as one file ticks as one file. Standardizing removes `.` and
        // `..` and does not resolve symlinks; that limit is the list's as much
        // as this row's, which is the reason to share the rule rather than
        // pick a stricter one here.
        if let current = current(),
           current.standardizedFileURL.path == row.url.standardizedFileURL.path {
            item.state = .on
        }
        // The path, for the case the title cannot answer: two files with the
        // same name in two folders that are also named the same.
        item.toolTip = (row.url.path as NSString).abbreviatingWithTildeInPath
        return item
    }
}
