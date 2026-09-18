import AppKit
import BirtaWriterCore

/// Pick which of VS Code's installed themes to add, as a sheet over
/// Settings: a checkbox per theme, the extension it comes from under its
/// name, and Add with the count in it.
///
/// `InstalledThemesPick` decides what is listed and what a tick means; this
/// draws it. Whoever presents this has to HOLD it, for the reason
/// `ThemeBrowserController` gives: the sheet reaches its controller only
/// through targets and a data source, and AppKit holds every one of those
/// weakly.
@MainActor
final class InstalledThemesSheetController: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    private var pick: InstalledThemesPick
    private let onDone: ([ThemeSource]) -> Void
    private let sheet: NSWindow
    private let table = NSTableView()
    private let addButton = NSButton(title: "Add", target: nil, action: nil)
    private let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)

    init(pick: InstalledThemesPick, onDone: @escaping ([ThemeSource]) -> Void) {
        self.pick = pick
        self.onDone = onDone
        sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 440),
                         styleMask: [.titled], backing: .buffered, defer: false)
        super.init()
        sheet.title = "Add Themes Installed in VS Code"
        build()
    }

    private func build() {
        let content = NSView()
        sheet.contentView = content

        let heading = NSTextField(labelWithString: "Choose the themes to add. Each becomes a copy of its own, so an extension updated or removed in VS Code leaves it as it is.")
        heading.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        heading.textColor = .secondaryLabelColor
        heading.lineBreakMode = .byWordWrapping
        heading.maximumNumberOfLines = 0
        heading.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("theme"))
        table.addTableColumn(column)
        table.headerView = nil
        table.rowHeight = 38
        table.columnAutoresizingStyle = .firstColumnOnlyAutoresizingStyle
        table.selectionHighlightStyle = .none
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.action = #selector(rowClicked)
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder

        addButton.target = self
        addButton.action = #selector(add)
        addButton.keyEquivalent = "\r"
        cancelButton.target = self
        cancelButton.action = #selector(cancel)
        cancelButton.keyEquivalent = "\u{1b}"
        let buttons = NSStackView(views: [NSView(), cancelButton, addButton])
        buttons.orientation = .horizontal
        buttons.spacing = 8

        let stack = NSStackView(views: [heading, scroll, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
        ])
        for view in stack.arrangedSubviews { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        syncAddButton()
    }

    func present(over window: NSWindow) {
        window.beginSheet(sheet) { _ in }
    }

    private func syncAddButton() {
        addButton.title = pick.addTitle
        addButton.isEnabled = !pick.chosen.isEmpty
    }

    // MARK: picking

    @objc private func rowClicked() {
        let row = table.clickedRow
        guard row >= 0, row < pick.rows.count else { return }
        toggle(pick.rows[row])
    }

    private func toggle(_ row: InstalledThemesPick.Row) {
        pick.toggle(row)
        if let index = pick.rows.firstIndex(of: row) {
            table.reloadData(forRowIndexes: [index], columnIndexes: [0])
        }
        syncAddButton()
    }

    @objc private func add() {
        let chosen = pick.chosen
        sheet.sheetParent?.endSheet(sheet)
        onDone(chosen)
    }

    @objc private func cancel() {
        sheet.sheetParent?.endSheet(sheet)
        onDone([])
    }

    /// Whether the sheet's controls still reach this controller, for the
    /// check that whoever presented it is holding it.
    var isWiredForTesting: Bool { table.dataSource === self && addButton.target === self }
    var addTitleForTesting: String { addButton.title }
    var rowsForTesting: [InstalledThemesPick.Row] { pick.rows }
    func toggleForTesting(_ row: Int) { toggle(pick.rows[row]) }
    func addForTesting() { add() }
    func cancelForTesting() { cancel() }

    // MARK: the table

    func numberOfRows(in tableView: NSTableView) -> Int { pick.rows.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row < pick.rows.count else { return nil }
        let id = NSUserInterfaceItemIdentifier("pick")
        let cell = (tableView.makeView(withIdentifier: id, owner: nil) as? PickRow) ?? PickRow(identifier: id)
        let entry = pick.rows[row]
        cell.show(entry, picked: pick.isPicked(entry))
        cell.onToggle = { [weak self] in self?.toggle(entry) }
        return cell
    }

    /// A checkbox, the theme's name, and where it comes from under it.
    final class PickRow: NSTableCellView {
        private let box = NSButton(checkboxWithTitle: "", target: nil, action: nil)
        private let name = NSTextField(labelWithString: "")
        private let detail = NSTextField(labelWithString: "")
        var onToggle: (() -> Void)?

        init(identifier: NSUserInterfaceItemIdentifier) {
            super.init(frame: .zero)
            self.identifier = identifier
            box.target = self
            box.action = #selector(toggled)
            box.setContentHuggingPriority(.required, for: .horizontal)
            name.font = .systemFont(ofSize: NSFont.systemFontSize)
            name.lineBreakMode = .byTruncatingTail
            detail.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
            detail.textColor = .secondaryLabelColor
            detail.lineBreakMode = .byTruncatingTail
            let words = NSStackView(views: [name, detail])
            words.orientation = .vertical
            words.alignment = .leading
            words.spacing = 1
            let stack = NSStackView(views: [box, words])
            stack.orientation = .horizontal
            stack.alignment = .centerY
            stack.spacing = 8
            stack.translatesAutoresizingMaskIntoConstraints = false
            addSubview(stack)
            NSLayoutConstraint.activate([
                stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
                stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
                stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            ])
        }

        required init?(coder: NSCoder) { fatalError("not used") }

        func show(_ row: InstalledThemesPick.Row, picked: Bool) {
            name.stringValue = row.name
            // A theme the library holds is said to be there, in the box's
            // own state, rather than left out: it is still a fact about what
            // VS Code has, and a list that quietly dropped it would read as
            // a theme VS Code lost.
            box.state = (row.alreadyAdded || picked) ? .on : .off
            box.isEnabled = !row.alreadyAdded
            detail.stringValue = row.alreadyAdded
                ? [row.detail, "Added"].filter { !$0.isEmpty }.joined(separator: ", ")
                : row.detail
            name.textColor = row.alreadyAdded ? .secondaryLabelColor : .labelColor
        }

        @objc private func toggled() { onToggle?() }
    }
}
