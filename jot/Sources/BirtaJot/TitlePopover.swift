import AppKit
import BirtaJotCore

/// The document popover, the one macOS opens when you click a document
/// window's title.
///
///     ┌──────────────────────────────────┐
///     │  Name:  [ Birta Writer.md         ] │
///     │  Tags:  [                      ] │
///     │ Where:  [ 📁 Birta Writer    ⌄ ] │
///     └──────────────────────────────────┘
///
/// Built rather than inherited, and that is worth saying because it looks
/// free. AppKit gives this popover to `NSDocument` applications, driven by
/// autosaving-in-place; a window with a `representedURL` and no NSDocument
/// behind it gets the Cmd-click path menu and nothing else. Jot is one panel
/// holding one buffer, and adopting the document architecture to reach a
/// popover would be a rewrite of the thing that works.
///
/// Three rows, and each one is the same question macOS asks:
///
///   Name    rename the file, keeping its extension when you edit only the
///           stem (`BirtaJotCore.DocumentName` decides, and is tested)
///   Tags    the Finder tags, as Finder holds them (`BirtaJotCore.FinderTags`)
///   Where   the folder, its ancestors up to the volume, and Other… for one
///           they name themselves
///
/// Nothing here touches a file. Every row hands a decision to its callback and
/// the coordinator does the work, because a rename has to flush the buffer,
/// move the bytes and rebind the editor in one order, and none of that is a
/// popover's business.
@MainActor
final class TitlePopoverController: NSViewController {
    /// Rename the bound file to this leaf name, in the folder it is in.
    var onRename: ((String) -> Void)?
    /// Move the bound file into this directory, keeping its name.
    var onMove: ((URL) -> Void)?
    /// Put exactly these Finder tags on the bound file.
    var onTags: (([String]) -> Void)?
    /// Close the popover showing this form. Injected, because the popover is
    /// the caller's: `dismiss(nil)` is for a view controller PRESENTED as a
    /// popover, and this one is set as an `NSPopover`'s content, where it has
    /// no presenting controller to ask.
    var onDismissRequest: (() -> Void)?

    private let nameField = NSTextField()
    private let tagsField = NSTokenField()
    private let wherePopUp = NSPopUpButton()
    /// The directories `wherePopUp`'s items stand for, by index. Other… is the
    /// one item with no entry, so a nil lookup IS the "let them choose" case
    /// rather than a value to compare against.
    private var whereTargets: [Int: URL] = [:]

    private var url: URL?
    /// The tags the file had when the form was filled, so a close that edited
    /// nothing writes nothing.
    private var loadedTags: [String] = []

    /// Wide enough for a path row and a name that is not a scratchpad's.
    private static let fieldWidth: CGFloat = 260

    override func loadView() {
        let name = label("Name:")
        let tags = label("Tags:")
        let place = label("Where:")

        nameField.target = self
        nameField.action = #selector(commitName)
        // Commit on Return AND on losing focus, which is what the macOS
        // popover does: dismissing it by clicking away keeps what was typed.
        nameField.delegate = self
        nameField.isEditable = true
        nameField.isBezeled = true
        nameField.bezelStyle = .roundedBezel
        nameField.focusRingType = .default

        tagsField.target = self
        tagsField.action = #selector(commitTags)
        tagsField.delegate = self
        tagsField.isBezeled = true
        tagsField.bezelStyle = .roundedBezel
        tagsField.placeholderString = "Add tags"

        wherePopUp.target = self
        wherePopUp.action = #selector(pickWhere)

        let grid = NSGridView(views: [
            [name, nameField],
            [tags, tagsField],
            [place, wherePopUp],
        ])
        grid.rowSpacing = 10
        grid.columnSpacing = 8
        grid.column(at: 0).xPlacement = .trailing
        grid.rowAlignment = .firstBaseline
        grid.translatesAutoresizingMaskIntoConstraints = false

        let root = NSView()
        root.addSubview(grid)
        NSLayoutConstraint.activate([
            grid.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            grid.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            grid.topAnchor.constraint(equalTo: root.topAnchor, constant: 16),
            grid.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -16),
            nameField.widthAnchor.constraint(equalToConstant: Self.fieldWidth),
            tagsField.widthAnchor.constraint(equalToConstant: Self.fieldWidth),
            wherePopUp.widthAnchor.constraint(equalToConstant: Self.fieldWidth),
        ])
        view = root
    }

    private func label(_ text: String) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.alignment = .right
        field.textColor = .secondaryLabelColor
        return field
    }

    // MARK: state

    /// Fill the rows from `url`. Called every time the popover opens, never
    /// cached: the file can have been renamed, moved or tagged by Finder since
    /// it last closed, and a stale field is one that would write the old value
    /// back on a commit.
    func show(url: URL) {
        loadViewIfNeeded()
        self.url = url
        nameField.stringValue = url.lastPathComponent
        loadedTags = FinderTags.read(url)
        tagsField.objectValue = loadedTags
        buildWhereMenu(for: url.deletingLastPathComponent())
    }

    /// The containing folder, then each one above it up to the volume, and
    /// Other… last. The same walk the Cmd-click path menu makes, taken from
    /// `WindowTitle` rather than repeated here: `ancestry` standardizes every
    /// step, without which a path holding `..` climbs forever.
    private func buildWhereMenu(for directory: URL) {
        let menu = NSMenu()
        whereTargets = [:]
        for target in WindowTitle.ancestry(of: directory) {
            let item = menu.addItem(withTitle: WindowTitle.displayName(of: target),
                                    action: nil, keyEquivalent: "")
            let icon = NSWorkspace.shared.icon(forFile: target.path)
            icon.size = NSSize(width: 16, height: 16)
            item.image = icon
            whereTargets[menu.numberOfItems - 1] = target
        }
        menu.addItem(.separator())
        menu.addItem(withTitle: "Other…", action: nil, keyEquivalent: "")
        wherePopUp.menu = menu
        wherePopUp.selectItem(at: 0)
    }

    // MARK: measurement

    /// What the form is showing, for `jot/scripts/measure.sh`. Every row, so a
    /// popover that opened with an empty Name or a Where menu of one entry is
    /// visibly different from one that filled itself in; "it opened" is the
    /// claim a presence check makes and not the one worth making.
    func describeForMeasurement(shown: Bool) -> String {
        let tags = (tagsField.objectValue as? [String]) ?? []
        return "shown=\(shown ? "yes" : "no") name=\(nameField.stringValue)"
            + " where=\(wherePopUp.titleOfSelectedItem ?? "") folders=\(whereTargets.count)"
            + " rows=\(wherePopUp.numberOfItems) tags=\(tags.count)"
    }

    /// Type `name` into the Name field and commit it, as Return would.
    func commitNameForMeasurement(_ name: String) {
        nameField.stringValue = name
        commitName()
    }

    // MARK: actions

    @objc private func commitName() {
        guard let url else { return }
        switch DocumentName.resolve(typed: nameField.stringValue, current: url.lastPathComponent) {
        case .unchanged:
            // Put the canonical spelling back, so a field holding "Notes"
            // shows "Notes.md" once it has been told the extension stayed.
            nameField.stringValue = url.lastPathComponent
        case let .rename(to: name):
            // Take the new name as ours BEFORE handing it on, because this
            // runs twice for one rename: Return commits it, and closing the
            // popover ends editing and commits it again. The second call has
            // to resolve to `.unchanged`, or it asks for the same move a
            // second time while the first is still in flight, finds the file
            // already at the destination, and reports a name collision with
            // itself.
            self.url = url.deletingLastPathComponent().appendingPathComponent(name)
            nameField.stringValue = name
            onRename?(name)
        case let .rejected(reason):
            nameField.stringValue = url.lastPathComponent
            NSSound.beep()
            present(reason)
        }
    }

    @objc private func commitTags() {
        let tags = (tagsField.objectValue as? [String]) ?? []
        // Only when they differ from what the file had. This runs on every
        // close, edited or not, and writing the same tags back would touch a
        // file the reader only looked at.
        guard tags != loadedTags else { return }
        loadedTags = tags
        onTags?(tags)
    }

    @objc private func pickWhere() {
        let index = wherePopUp.indexOfSelectedItem
        if let target = whereTargets[index] {
            // Item 0 is the folder the file is already in, so choosing it is
            // the no-op every popup makes available by being open at all.
            if index != 0 { onMove?(target) }
            return
        }
        chooseOtherFolder()
    }

    private func chooseOtherFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.prompt = "Move"
        panel.directoryURL = url?.deletingLastPathComponent()
        // The popover is dismissed first: a modal sheet over a popover leaves
        // the popover to close under it, and the panel then has no parent.
        onDismissRequest?()
        panel.begin { [weak self] response in
            MainActor.assumeIsolated {
                guard response == .OK, let target = panel.url else { return }
                self?.onMove?(target)
            }
        }
    }

    private func present(_ message: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.alertStyle = .warning
        alert.runModal()
    }
}

/// Commit on focus loss as well as on Return, which is what the macOS popover
/// does: clicking away from it keeps what was typed rather than discarding it.
///
/// `NSTokenFieldDelegate` rather than `NSTextFieldDelegate`, which it refines:
/// the token field's `delegate` accepts only the narrower protocol, and one
/// conformance serves both fields.
extension TitlePopoverController: NSTokenFieldDelegate {
    func controlTextDidEndEditing(_ notification: Notification) {
        guard let control = notification.object as? NSControl else { return }
        if control === nameField { commitName() }
        if control === tagsField { commitTags() }
    }
}
