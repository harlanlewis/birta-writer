import AppKit
import BirtaWriterCore

/// The command palette: one field over everything the app can do, drawn as a
/// floating panel over the window that asked (MAR-458).
///
/// Cmd+Shift+P opens it over every source (`PaletteMode.all`); Cmd+P opens it
/// over files alone, which is Go to File, and either chord switches the mode
/// while it is up. Arrows move, Return picks, Escape closes, and a row that
/// holds rows of its own (a submenu, a Settings pane) opens as a level with
/// its title over the field and Backspace on an empty field going back up.
/// What is listed and in what order is `PaletteModel`'s; what a pick does is
/// `PaletteCatalog`'s; this file draws and dispatches.
///
/// Built and read back without being shown, which is how `PaletteWindowTests`
/// asks it questions: `prepare(mode:)` fills the list without ordering the
/// panel front, and the rows and the selection are readable properties.
@MainActor
final class PaletteWindowController: NSObject, NSTextFieldDelegate, NSTableViewDataSource, NSTableViewDelegate,
                                     NSWindowDelegate {
    /// One level of the list: the items shown with nothing typed, and the
    /// title over the field for a level below the top.
    private struct Level {
        let title: String?
        let items: [PaletteItem]
    }

    /// One row of the table: a section heading or an item.
    enum Displayed: Equatable {
        case header(String)
        case row(PaletteRow)
        case empty(String)
    }

    private let panel: PalettePanel
    private let field = NSTextField()
    private let crumb = NSTextField(labelWithString: "")
    private let table = NSTableView()
    private let scroll = NSScrollView()
    private let footer = NSTextField(labelWithString: "")
    private let makeCatalog: () -> PaletteCatalog
    private let onPick: (PaletteAction) -> Void
    private var catalog = PaletteCatalog()
    private var levels: [Level] = []
    private(set) var mode: PaletteMode = .all
    private(set) var displayed: [Displayed] = []
    private(set) var selectedIndex: Int?

    static let width: CGFloat = 620
    private static let fieldHeight: CGFloat = 52
    private static let rowHeight: CGFloat = 30
    private static let headerHeight: CGFloat = 24
    private static let footerHeight: CGFloat = 26
    private static let listCeiling: CGFloat = 12 * rowHeight

    /// - Parameters:
    ///   - catalog: asked on every open and whenever `refresh` is called, so
    ///     the list is the app as it stands, not as it stood.
    ///   - onPick: what to do with the picked action, after the panel closed.
    init(catalog: @escaping () -> PaletteCatalog, onPick: @escaping (PaletteAction) -> Void) {
        self.makeCatalog = catalog
        self.onPick = onPick
        panel = PalettePanel(contentRect: NSRect(x: 0, y: 0, width: Self.width, height: 400))
        super.init()
        panel.delegate = self
        panel.onModeChord = { [weak self] mode in self?.switchMode(mode) }
        build()
    }

    var isOpen: Bool { panel.isVisible }

    /// The rows as items, headings left out, for a check to read.
    var rows: [PaletteRow] {
        displayed.compactMap { if case let .row(row) = $0 { return row } else { return nil } }
    }

    /// The headings in order, for a check to read.
    var headers: [String] {
        displayed.compactMap { if case let .header(title) = $0 { return title } else { return nil } }
    }

    /// The titles of the levels below the top, outermost first.
    var levelTitles: [String] { levels.compactMap(\.title) }

    var query: String { field.stringValue }

    var selectedRow: PaletteRow? {
        guard let selectedIndex, case let .row(row) = displayed[selectedIndex] else { return nil }
        return row
    }

    // MARK: opening

    /// Fill the list for `mode` at the top level with nothing typed, without
    /// showing anything.
    func prepare(mode: PaletteMode) {
        self.mode = mode
        catalog = makeCatalog()
        levels = [Level(title: nil, items: catalog.items)]
        field.stringValue = ""
        requery()
    }

    /// Open over `window` (or the screen with the mouse when there is none),
    /// in `mode`. Open already, this switches the mode and keeps the query.
    func open(mode: PaletteMode, over window: NSWindow?) {
        if panel.isVisible {
            switchMode(mode)
            return
        }
        prepare(mode: mode)
        place(over: window)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
    }

    /// Re-ask for the catalog and re-rank, keeping the query and the level:
    /// what a file index arriving after the palette opened calls.
    func refresh() {
        guard panel.isVisible || !levels.isEmpty else { return }
        catalog = makeCatalog()
        if levels.count == 1 {
            levels = [Level(title: nil, items: catalog.items)]
        }
        requery()
    }

    func switchMode(_ mode: PaletteMode) {
        guard self.mode != mode else { return }
        self.mode = mode
        levels = [Level(title: nil, items: catalog.items)]
        requery()
    }

    func close() {
        guard panel.isVisible else { return }
        panel.orderOut(nil)
        // The catalog holds live windows in its actions; a closed palette
        // must not keep a window it listed alive after the app closed it.
        catalog = PaletteCatalog()
        levels = []
        displayed = []
        selectedIndex = nil
    }

    // MARK: the list

    func setQuery(_ text: String) {
        field.stringValue = text
        requery()
    }

    private func requery() {
        guard let level = levels.last else { return }
        let ranked = PaletteModel.rank(level.items, query: field.stringValue, mode: mode,
                                       recents: Prefs.paletteRecents)
        let trimmed = field.stringValue.trimmingCharacters(in: .whitespaces)
        if ranked.isEmpty {
            displayed = [.empty(mode == .files ? "No files match" : "No matches")]
        } else if trimmed.isEmpty, level.title == nil {
            // Grouped under headings with nothing typed; a query ranks across
            // every section and is shown flat, best first.
            displayed = PaletteModel.sections(ranked).flatMap { section in
                [Displayed.header(section.section)] + section.rows.map(Displayed.row)
            }
        } else {
            displayed = ranked.map(Displayed.row)
        }
        crumb.stringValue = levels.compactMap(\.title).map { "\($0) ›" }.joined(separator: " ")
        crumb.isHidden = crumb.stringValue.isEmpty
        field.placeholderString = mode == .files ? "Go to file…" : "Type a command or search…"
        footer.stringValue = footerText()
        table.reloadData()
        selectedIndex = displayed.firstIndex { if case .row = $0 { return true } else { return false } }
        syncSelection()
        fit()
    }

    private func footerText() -> String {
        var hints = ["↑↓ move", "↩ open", "esc close"]
        if levels.count > 1 { hints.append("⌫ back") }
        if mode == .files, catalog.filesTruncated { hints.append("showing the first files found") }
        return hints.joined(separator: "   ")
    }

    /// Move the selection by `delta` rows, skipping headings, stopping at the
    /// ends.
    func moveSelection(by delta: Int) {
        guard !displayed.isEmpty else { return }
        var index = selectedIndex ?? (delta > 0 ? -1 : displayed.count)
        repeat {
            index += delta > 0 ? 1 : -1
            guard displayed.indices.contains(index) else { return }
        } while !isSelectable(index)
        selectedIndex = index
        syncSelection()
    }

    func selectFirst() {
        selectedIndex = displayed.indices.first(where: isSelectable)
        syncSelection()
    }

    func selectLast() {
        selectedIndex = displayed.indices.last(where: isSelectable)
        syncSelection()
    }

    private func isSelectable(_ index: Int) -> Bool {
        if case .row = displayed[index] { return true }
        return false
    }

    private func syncSelection() {
        if let selectedIndex {
            table.selectRowIndexes(IndexSet(integer: selectedIndex), byExtendingSelection: false)
            table.scrollRowToVisible(selectedIndex)
        } else {
            table.deselectAll(nil)
        }
    }

    /// Pick the selected row: a group opens as a level, anything else closes
    /// the palette and runs.
    func pickSelected() {
        guard let row = selectedRow else { return }
        pick(row)
    }

    private func pick(_ row: PaletteRow) {
        if row.item.kind == .group {
            levels.append(Level(title: row.item.title, items: row.item.children))
            field.stringValue = ""
            requery()
            return
        }
        guard let action = catalog.action(for: row.item.id) else { return }
        Prefs.paletteRecents = PaletteModel.recording(row.item.id, into: Prefs.paletteRecents)
        close()
        onPick(action)
    }

    /// Back up one level; false at the top.
    @discardableResult
    func goUp() -> Bool {
        guard levels.count > 1 else { return false }
        levels.removeLast()
        field.stringValue = ""
        requery()
        return true
    }

    // MARK: building

    private func build() {
        let content = NSVisualEffectView()
        content.material = .popover
        content.blendingMode = .behindWindow
        content.state = .active
        content.wantsLayer = true
        content.layer?.cornerRadius = 12
        content.layer?.cornerCurve = .continuous
        content.layer?.masksToBounds = true
        content.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView = content

        crumb.font = .systemFont(ofSize: 15, weight: .medium)
        crumb.textColor = .secondaryLabelColor
        crumb.isHidden = true
        crumb.setContentHuggingPriority(.required, for: .horizontal)

        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = .systemFont(ofSize: 20, weight: .regular)
        field.textColor = .labelColor
        field.delegate = self
        field.cell?.isScrollable = true
        field.cell?.wraps = false
        field.lineBreakMode = .byTruncatingTail
        field.setAccessibilityLabel("Command palette")

        let fieldRow = NSStackView(views: [crumb, field])
        fieldRow.orientation = .horizontal
        fieldRow.spacing = 8
        fieldRow.alignment = .firstBaseline
        fieldRow.edgeInsets = NSEdgeInsets(top: 0, left: 18, bottom: 0, right: 18)
        fieldRow.translatesAutoresizingMaskIntoConstraints = false

        let rule = NSBox()
        rule.boxType = .separator
        rule.translatesAutoresizingMaskIntoConstraints = false

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("row"))
        column.resizingMask = .autoresizingMask
        table.addTableColumn(column)
        table.headerView = nil
        table.dataSource = self
        table.delegate = self
        table.backgroundColor = .clear
        table.intercellSpacing = .zero
        table.selectionHighlightStyle = .regular
        table.allowsEmptySelection = true
        table.allowsMultipleSelection = false
        table.refusesFirstResponder = true
        table.style = .plain
        table.rowHeight = Self.rowHeight
        table.target = self
        table.action = #selector(rowClicked)
        table.setAccessibilityLabel("Palette results")

        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false

        footer.font = .systemFont(ofSize: 11)
        footer.textColor = .tertiaryLabelColor
        footer.translatesAutoresizingMaskIntoConstraints = false

        content.addSubview(fieldRow)
        content.addSubview(rule)
        content.addSubview(scroll)
        content.addSubview(footer)
        NSLayoutConstraint.activate([
            fieldRow.topAnchor.constraint(equalTo: content.topAnchor),
            fieldRow.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            fieldRow.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            fieldRow.heightAnchor.constraint(equalToConstant: Self.fieldHeight),
            rule.topAnchor.constraint(equalTo: fieldRow.bottomAnchor),
            rule.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            rule.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: rule.bottomAnchor, constant: 6),
            scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 8),
            scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -8),
            footer.topAnchor.constraint(equalTo: scroll.bottomAnchor, constant: 4),
            footer.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 18),
            footer.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -18),
            footer.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -6),
        ])
    }

    /// The panel is as tall as its list, up to a ceiling past which the list
    /// scrolls, and keeps its top edge where it was placed.
    private func fit() {
        let list = displayed.reduce(CGFloat(0)) { sum, row in
            switch row {
            case .header: return sum + Self.headerHeight
            case .row, .empty: return sum + Self.rowHeight
            }
        }
        let height = Self.fieldHeight + 1 + 6 + min(list, Self.listCeiling) + 4 + Self.footerHeight
        var frame = panel.frame
        let top = frame.maxY
        frame.size.height = height
        frame.origin.y = top - height
        panel.setFrame(frame, display: panel.isVisible)
    }

    /// Centred over `window`, a fifth of the way down, or over the screen
    /// under the mouse with no window to sit on.
    private func place(over window: NSWindow?) {
        let anchor = window?.frame
            ?? NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }?.visibleFrame
            ?? NSScreen.main?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        var frame = panel.frame
        frame.origin.x = anchor.midX - frame.width / 2
        frame.origin.y = anchor.maxY - anchor.height * 0.2 - frame.height
        if let screen = window?.screen ?? NSScreen.main {
            let visible = screen.visibleFrame
            frame.origin.x = max(visible.minX + 8, min(frame.origin.x, visible.maxX - frame.width - 8))
            frame.origin.y = max(visible.minY + 8, min(frame.origin.y, visible.maxY - frame.height - 8))
        }
        panel.setFrame(frame, display: false)
    }

    // MARK: field

    func controlTextDidChange(_ notification: Notification) {
        requery()
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        switch selector {
        case #selector(NSResponder.moveDown(_:)), #selector(NSResponder.insertTab(_:)):
            moveSelection(by: 1)
        case #selector(NSResponder.moveUp(_:)), #selector(NSResponder.insertBacktab(_:)):
            moveSelection(by: -1)
        case #selector(NSResponder.moveToBeginningOfDocument(_:)), #selector(NSResponder.scrollToBeginningOfDocument(_:)):
            selectFirst()
        case #selector(NSResponder.moveToEndOfDocument(_:)), #selector(NSResponder.scrollToEndOfDocument(_:)):
            selectLast()
        case #selector(NSResponder.insertNewline(_:)):
            pickSelected()
        case #selector(NSResponder.cancelOperation(_:)):
            close()
        case #selector(NSResponder.deleteBackward(_:)) where field.stringValue.isEmpty:
            return goUp()
        default:
            return false
        }
        return true
    }

    @objc private func rowClicked() {
        let clicked = table.clickedRow
        guard displayed.indices.contains(clicked), case let .row(row) = displayed[clicked] else { return }
        selectedIndex = clicked
        pick(row)
    }

    // MARK: table

    func numberOfRows(in tableView: NSTableView) -> Int { displayed.count }

    func tableView(_ tableView: NSTableView, isGroupRow row: Int) -> Bool {
        if case .header = displayed[row] { return true }
        return false
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { isSelectable(row) }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        if case .header = displayed[row] { return Self.headerHeight }
        return Self.rowHeight
    }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        let view = PaletteRowView()
        view.isGroupRowStyle = false
        return view
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        switch displayed[row] {
        case let .header(title):
            let cell = PaletteHeaderView()
            cell.label.stringValue = title.uppercased()
            return cell
        case let .empty(text):
            let cell = PaletteHeaderView()
            cell.label.stringValue = text
            cell.label.font = .systemFont(ofSize: 13)
            return cell
        case let .row(item):
            let cell = PaletteCellView()
            cell.show(item)
            return cell
        }
    }

    // MARK: window

    func windowDidResignKey(_ notification: Notification) {
        close()
    }
}

/// A borderless panel that can be key, so the field takes typing, and that
/// hands the two palette chords back to its controller instead of letting the
/// menu bar reopen the palette over itself.
final class PalettePanel: NSPanel {
    var onModeChord: ((PaletteMode) -> Void)?

    init(contentRect: NSRect) {
        super.init(contentRect: contentRect,
                   styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
                   backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .floating
        hidesOnDeactivate = false
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isMovableByWindowBackground = false
        animationBehavior = .utilityWindow
        becomesKeyOnlyIfNeeded = false
        collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection([.command, .shift, .option, .control])
        if event.charactersIgnoringModifiers?.lowercased() == "p" {
            if flags == [.command] {
                onModeChord?(.files)
                return true
            }
            if flags == [.command, .shift] {
                onModeChord?(.all)
                return true
            }
        }
        return super.performKeyEquivalent(with: event)
    }
}

/// A row whose selection is a rounded accent block, as a menu draws it.
final class PaletteRowView: NSTableRowView {
    override func drawSelection(in dirtyRect: NSRect) {
        guard selectionHighlightStyle != .none else { return }
        let rect = bounds.insetBy(dx: 4, dy: 1)
        NSColor.controlAccentColor.setFill()
        NSBezierPath(roundedRect: rect, xRadius: 7, yRadius: 7).fill()
    }

    override var isEmphasized: Bool {
        get { true }
        set {}
    }
}

/// A section heading: small, secondary, spaced.
final class PaletteHeaderView: NSTableCellView {
    let label = NSTextField(labelWithString: "")

    init() {
        super.init(frame: .zero)
        label.font = .systemFont(ofSize: 11, weight: .semibold)
        label.textColor = .secondaryLabelColor
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            label.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -14),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

/// One item: the title with its matched letters emphasised, the detail (a
/// chord, a folder) at the right, and a chevron on a row that opens rows.
final class PaletteCellView: NSTableCellView {
    private let title = NSTextField(labelWithString: "")
    private let detail = NSTextField(labelWithString: "")
    private let chevron = NSTextField(labelWithString: "›")

    init() {
        super.init(frame: .zero)
        title.font = .systemFont(ofSize: 14)
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        detail.font = .systemFont(ofSize: 12)
        detail.textColor = .secondaryLabelColor
        detail.alignment = .right
        detail.lineBreakMode = .byTruncatingMiddle
        detail.setContentHuggingPriority(.required, for: .horizontal)
        chevron.font = .systemFont(ofSize: 15, weight: .medium)
        chevron.textColor = .secondaryLabelColor
        chevron.setContentHuggingPriority(.required, for: .horizontal)
        let stack = NSStackView(views: [title, detail, chevron])
        stack.orientation = .horizontal
        stack.spacing = 10
        stack.alignment = .centerY
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 14, bottom: 0, right: 14)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func show(_ row: PaletteRow) {
        title.attributedStringValue = Self.emphasised(row.title, at: row.matched)
        detail.stringValue = row.item.detail ?? ""
        detail.isHidden = row.item.detail == nil
        chevron.isHidden = row.item.kind != .group
        // Non-Markdown files are dimmed in the explorer; the palette lists
        // only what the index admitted, so nothing here is dimmed.
    }

    override var backgroundStyle: NSView.BackgroundStyle {
        didSet {
            let selected = backgroundStyle == .emphasized
            title.textColor = selected ? .alternateSelectedControlTextColor : .labelColor
            detail.textColor = selected ? NSColor.alternateSelectedControlTextColor.withAlphaComponent(0.8) : .secondaryLabelColor
            chevron.textColor = detail.textColor
        }
    }

    /// The title with the matched letters in a heavier weight, which reads
    /// as the letters the query hit without a second colour.
    static func emphasised(_ text: String, at ranges: [Range<Int>]) -> NSAttributedString {
        let result = NSMutableAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: 14)])
        let characters = Array(text)
        for range in ranges {
            guard range.lowerBound >= 0, range.upperBound <= characters.count else { continue }
            let start = String(characters[0..<range.lowerBound]).utf16.count
            let length = String(characters[range]).utf16.count
            result.addAttribute(.font, value: NSFont.systemFont(ofSize: 14, weight: .bold),
                                range: NSRange(location: start, length: length))
        }
        return result
    }
}
