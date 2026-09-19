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
    /// The other mode and its chord, at the field's trailing end: the one
    /// thing a reader can do here that typing does not reveal.
    private let modeHint = NSTextField(labelWithString: "")
    private let table = NSTableView()
    private let scroll = NSScrollView()
    private let footer = NSTextField(labelWithString: "")
    private var footerRule: NSBox?
    private let makeCatalog: () -> PaletteCatalog
    private let onPick: (PaletteAction) -> Void
    private var catalog = PaletteCatalog()
    private var levels: [Level] = []
    private(set) var mode: PaletteMode = .all
    private(set) var displayed: [Displayed] = []
    private(set) var selectedIndex: Int?

    static let width: CGFloat = 640
    private static let fieldHeight: CGFloat = 46
    private static let rowHeight: CGFloat = 32
    private static let headerHeight: CGFloat = 28
    private static let footerHeight: CGFloat = 28
    private static let listCeiling: CGFloat = 11 * rowHeight

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
        // The chords are the panel's own (`PalettePanel.performKeyEquivalent`),
        // so printing them here is printing a binding this window holds.
        modeHint.attributedStringValue = Self.hint(mode == .files ? "Commands" : "Files",
                                                   chord: mode == .files ? "⇧⌘P" : "⌘P")
        footer.attributedStringValue = Self.hint(footerText())
        table.reloadData()
        selectedIndex = displayed.firstIndex { if case .row = $0 { return true } else { return false } }
        syncSelection()
        fit()
    }

    private func footerText() -> String {
        var hints = ["↑↓ move", "↩ open", "esc close"]
        if levels.count > 1 { hints.append("⌫ back") }
        if mode == .files, catalog.filesTruncated { hints.append("showing the first files found") }
        return hints.joined(separator: "      ")
    }

    /// Small tertiary text, with an optional chord after it in a slightly
    /// heavier weight so the symbols read as keys rather than as punctuation.
    private static func hint(_ text: String, chord: String? = nil) -> NSAttributedString {
        let out = NSMutableAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.tertiaryLabelColor,
        ])
        if let chord {
            out.append(NSAttributedString(string: "  " + chord, attributes: [
                .font: NSFont.systemFont(ofSize: 11, weight: .medium), .foregroundColor: NSColor.tertiaryLabelColor,
            ]))
        }
        return out
    }

    /// The panel's content as a PNG, for `mac/scripts/measure.sh` and the
    /// like: the palette is AppKit through and through, so the views' own
    /// drawing is the picture, with no window server involved.
    func snapshotPNG() -> Data? {
        guard let content = panel.contentView else { return nil }
        let bounds = content.bounds
        let pdf = content.dataWithPDF(inside: bounds)
        guard let image = NSImage(data: pdf) else { return nil }
        let rendered = NSImage(size: bounds.size)
        rendered.lockFocus()
        NSColor.windowBackgroundColor.setFill()
        bounds.fill()
        image.draw(in: bounds)
        rendered.unlockFocus()
        guard let tiff = rendered.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
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
        content.layer?.cornerRadius = 10
        content.layer?.cornerCurve = .continuous
        content.layer?.masksToBounds = true
        content.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView = content

        crumb.font = .systemFont(ofSize: 13, weight: .medium)
        crumb.textColor = .secondaryLabelColor
        crumb.isHidden = true
        crumb.setContentHuggingPriority(.required, for: .horizontal)

        // Chrome-sized rather than display-sized: the field is a place to
        // type three letters, and a large face there reads as a title over
        // the list rather than as the filter beside it.
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = .systemFont(ofSize: 15, weight: .regular)
        field.textColor = .labelColor
        field.delegate = self
        field.cell?.isScrollable = true
        field.cell?.wraps = false
        field.lineBreakMode = .byTruncatingTail
        field.setAccessibilityLabel("Command palette")

        modeHint.alignment = .right
        modeHint.setContentHuggingPriority(.required, for: .horizontal)
        modeHint.setContentCompressionResistancePriority(.required, for: .horizontal)

        let fieldRow = NSStackView(views: [crumb, field, modeHint])
        fieldRow.orientation = .horizontal
        fieldRow.spacing = 8
        fieldRow.alignment = .centerY
        fieldRow.edgeInsets = NSEdgeInsets(top: 0, left: 16, bottom: 0, right: 16)
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
        // No floating headings: a group row pinned at the top paints over
        // the selection of the first row under it. The list is short and the
        // headings are ranks, not anchors, so nothing needs to float.
        table.floatsGroupRows = false
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

        footer.translatesAutoresizingMaskIntoConstraints = false

        // A rule over the footer, so a list that scrolls is cut by a line
        // rather than by the hints' baseline.
        let footerRule = NSBox()
        footerRule.boxType = .separator
        footerRule.translatesAutoresizingMaskIntoConstraints = false
        self.footerRule = footerRule

        content.addSubview(fieldRow)
        content.addSubview(rule)
        content.addSubview(scroll)
        content.addSubview(footerRule)
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
            footerRule.topAnchor.constraint(equalTo: scroll.bottomAnchor, constant: 6),
            footerRule.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            footerRule.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            // The hints sit in the MIDDLE of the footer's band. A label given
            // the band's whole height draws its text at its top, against the
            // rule, and the air the band was meant to hold ends up under the
            // words instead of around them.
            footer.centerYAnchor.constraint(equalTo: footerRule.bottomAnchor, constant: Self.footerHeight / 2),
            footer.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            footer.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -16),
            content.bottomAnchor.constraint(equalTo: footerRule.bottomAnchor, constant: Self.footerHeight),
        ])
    }

    /// The air over and under the footer's hints, for a check: the words are
    /// centred in the band under the rule, not sat against it.
    var footerAirForMeasurement: (above: CGFloat, below: CGFloat)? {
        guard let footerRule, let content = footer.superview else { return nil }
        content.layoutSubtreeIfNeeded()
        let text = footer.frame
        return (above: footerRule.frame.minY - text.maxY, below: text.minY - content.bounds.minY)
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
        // The field, its rule, the list with its inset, the footer's rule and
        // the footer: the same terms the constraints in `build` sum to.
        let height = Self.fieldHeight + 1 + 6 + min(list, Self.listCeiling) + 6 + 1 + Self.footerHeight
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

/// A row whose selection is a quiet rounded wash, as a picker draws it: the
/// ink keeps its colours, so a chord's key caps and a folder's grey read the
/// same on the selected row as on every other.
final class PaletteRowView: NSTableRowView {
    override func drawSelection(in dirtyRect: NSRect) {
        guard selectionHighlightStyle != .none else { return }
        let rect = bounds.insetBy(dx: 6, dy: 1)
        NSColor.labelColor.withAlphaComponent(0.09).setFill()
        NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6).fill()
    }

    /// Never emphasized: the wash above is the whole selection, and the cell
    /// keeps its own ink rather than inverting to white.
    override var isEmphasized: Bool {
        get { false }
        set {}
    }
}

/// A section heading: small, tertiary, sitting at the bottom of its row so
/// the space it holds is above it, between sections.
final class PaletteHeaderView: NSTableCellView {
    let label = NSTextField(labelWithString: "")

    init() {
        super.init(frame: .zero)
        label.font = .systemFont(ofSize: 11, weight: .medium)
        label.textColor = .tertiaryLabelColor
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 18),
            label.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -18),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -5),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

/// One item: the title with its matched letters emphasised, then at the
/// trailing edge either the chord as key caps (a command) or the detail as
/// text (a file's folder, a window's root), and a chevron on a row that
/// opens rows. The trailing cluster is right-aligned across every row, so
/// the chords form a column the eye can run down.
///
/// ## What a long name may not do
///
/// Every row is one line tall (`rowHeight`), and the two labels compete for
/// one row's width, so both of those have to be settled here rather than left
/// to a cell's defaults. The defaults are wrong in three ways that only show
/// on the long names a file list is full of, and each is a separate rule
/// below: a title that WRAPS is drawn in a box one line tall and has its tail
/// clipped away with no ellipsis to say so; a title with no floor is
/// compressed by a long folder path until the name the query matched is not
/// drawn at all; and a path truncated in the middle keeps a prefix every row
/// shares ("Work/Notable/") and spends the ellipsis on the folders that tell
/// the rows apart.
final class PaletteCellView: NSTableCellView {
    private let title = NSTextField(labelWithString: "")
    private let detail = NSTextField(labelWithString: "")
    private let keys = NSStackView(views: [])
    private let chevron = NSTextField(labelWithString: "›")

    /// The most of a row the folder path may take.
    ///
    /// A ceiling rather than a column: a path shorter than this keeps its own
    /// width and sits against the trailing edge with the chords, and only the
    /// long ones are cut. Under half, because the name is the thing the query
    /// matched and the path is where it happens to live, so what is left over
    /// is the larger share.
    ///
    /// It is also the floor under the NAME, which is the load-bearing part: a
    /// row is one width, so a ceiling on one label is a floor under the other,
    /// and without it a deep folder compresses the file name to nothing at all.
    static let detailShare: CGFloat = 0.45

    /// What the path is holding on to: whatever it needs, up to the ceiling.
    ///
    /// Set per row, because the ceiling alone is only half the rule. With a
    /// ceiling and nothing else, a long enough NAME compresses the path away
    /// instead, which is the same defect wearing the other label. Its priority
    /// sits above the title's compression resistance, so the name gives way
    /// first, and below required, so the ceiling still trims it and no window
    /// width can make the pair unsatisfiable.
    private var detailWanted: NSLayoutConstraint!

    init() {
        super.init(frame: .zero)
        title.font = .systemFont(ofSize: 13)
        // One line, with an ellipsis where the name does not fit. The
        // paragraph style rides the STRING, which is the half that matters: a
        // cell lays an attributed value out under the style that value
        // carries and never under the field's own `lineBreakMode`, so a title
        // set this way wraps whatever the field was told (`emphasised` is
        // where the style is put on). The two field settings are the belt
        // beside it: no wrapping, and a line that does not fit ending in an
        // ellipsis rather than at whatever pixel the box ends on.
        //
        // The trade, which `TitleBar.swift` names from the other side: a cell
        // in a truncating style wants its box a shade wider than the string
        // measures, so a name that only just fits can draw an ellipsis it did
        // not need. Here that is the cheaper of the two failures, because the
        // box is whatever is left after the path takes its share; the window
        // title does not take this style, because there the box is sized to
        // the string and the ellipsis would be a lie about the window.
        title.usesSingleLineMode = true
        title.cell?.truncatesLastVisibleLine = true
        // The name is the half that keeps its width when the two cannot both
        // fit: it is what the query matched, and the path is where it happens
        // to live. The path's own two constraints below are what stop that
        // from erasing the path in turn.
        title.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        // The title is what takes the row's spare width, so the trailing
        // cluster stays a cluster. Both priorities have to say so: a stack's
        // own hugging is `setHuggingPriority`, not the view one, and at its
        // default it ties the label's, which lets the spare width go to the
        // caps instead.
        title.setContentHuggingPriority(NSLayoutConstraint.Priority(rawValue: 1), for: .horizontal)
        detail.font = .systemFont(ofSize: 12)
        detail.textColor = .secondaryLabelColor
        detail.alignment = .right
        // From the HEAD: the tail of a path is the folders that tell one row
        // from another, and the head is the prefix every row in a rooted
        // window shares.
        detail.lineBreakMode = .byTruncatingHead
        detail.setContentHuggingPriority(.required, for: .horizontal)
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        keys.orientation = .horizontal
        keys.spacing = 3
        keys.setHuggingPriority(.required, for: .horizontal)
        chevron.font = .systemFont(ofSize: 14, weight: .medium)
        chevron.textColor = .tertiaryLabelColor
        chevron.setContentHuggingPriority(.required, for: .horizontal)
        let stack = NSStackView(views: [title, detail, keys, chevron])
        stack.orientation = .horizontal
        stack.spacing = 10
        stack.alignment = .centerY
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 18, bottom: 0, right: 16)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        detailWanted = detail.widthAnchor.constraint(greaterThanOrEqualToConstant: 0)
        detailWanted.priority = NSLayoutConstraint.Priority(rawValue: 900)
        NSLayoutConstraint.activate([
            detailWanted,
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            // The ceiling on the path. Written against the cell rather than
            // as a number of points, so it holds at every window width the
            // palette is drawn at.
            detail.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor,
                                          multiplier: Self.detailShare),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func show(_ row: PaletteRow) {
        title.attributedStringValue = Self.emphasised(row.title, at: row.matched)
        let asKeys = row.item.kind == .command && row.item.detail != nil
        detail.stringValue = asKeys ? "" : (row.item.detail ?? "")
        detail.isHidden = asKeys || row.item.detail == nil
        // What this row's path needs, which the ceiling then trims. Zero for a
        // row that draws none, so the constraint says nothing about a hidden
        // label (`detailWanted`).
        detailWanted.constant = detail.isHidden ? 0 : detail.intrinsicContentSize.width
        keys.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if asKeys, let chord = row.item.detail {
            for cap in Self.keyCaps(chord) { keys.addArrangedSubview(KeyCapView(cap)) }
        }
        keys.isHidden = !asKeys
        chevron.isHidden = row.item.kind != .group
        // Non-Markdown files are dimmed in the explorer; the palette lists
        // only what the index admitted, so nothing here is dimmed.
    }

    /// Where the two labels ended up once the row was laid out, for a check
    /// with no window.
    ///
    /// Boxes rather than strings, because what goes wrong here is geometry:
    /// every model-side number about a squeezed title is correct, and the
    /// only thing that disagrees is the width the label was left with. The
    /// height is in it for the same reason: a wrapped title is two lines tall
    /// in a row that is one line high, and nothing else reports that.
    func labelBoxesForMeasurement() -> (title: NSRect, detail: NSRect) {
        layoutSubtreeIfNeeded()
        return (title.frame, detail.frame)
    }

    /// How tall the title's cell would DRAW the string in the box the layout
    /// left it.
    ///
    /// The only number that says whether the title wrapped, and two nearer
    /// ones cannot stand in for it. A label with no `preferredMaxLayoutWidth`
    /// reports a one-line intrinsic height whatever box it is given, so every
    /// frame in the row agrees with every other frame and with nothing on
    /// screen; and `cellSize(forBounds:)` answers with the width the string
    /// WANTS rather than laying it out in the box, so it reports one line for
    /// a string that wraps to two. Asked of the attributed string, which is
    /// where the paragraph style that decides this lives.
    func titleDrawnHeightForMeasurement() -> CGFloat {
        layoutSubtreeIfNeeded()
        let box = CGSize(width: title.frame.width, height: .greatestFiniteMagnitude)
        return title.attributedStringValue
            .boundingRect(with: box, options: [.usesLineFragmentOrigin, .usesFontLeading])
            .height
    }

    /// One line of the title's own font, which is what that height is
    /// compared against. Asked of the font rather than written down, so it
    /// follows the system's text size.
    static var titleLineHeight: CGFloat {
        let font = NSFont.systemFont(ofSize: 13)
        return ceil(font.ascender - font.descender + font.leading)
    }

    /// A chord in menu-bar symbols, split into the caps a keyboard has: each
    /// modifier glyph on its own and the key after them (`⇧⌘K` is three).
    static func keyCaps(_ chord: String) -> [String] {
        var caps: [String] = []
        var key = ""
        for ch in chord {
            if "⌃⌥⇧⌘".contains(ch), key.isEmpty { caps.append(String(ch)) } else { key.append(ch) }
        }
        if !key.isEmpty { caps.append(key) }
        return caps
    }

    /// The title with the matched letters in a heavier weight, which reads
    /// as the letters the query hit without a second colour.
    ///
    /// It carries its own paragraph style, and that is the load-bearing part
    /// rather than a detail of the attributed string: a cell lays an
    /// attributed value out under the style THAT VALUE carries and never
    /// under the field's `lineBreakMode`, so a title set this way wraps under
    /// the default style whatever the field was told. `TitleBar.swift`
    /// documents the same trap from the other side.
    static func emphasised(_ text: String, at ranges: [Range<Int>]) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        let result = NSMutableAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: 13),
            .paragraphStyle: paragraph,
        ])
        let characters = Array(text)
        for range in ranges {
            guard range.lowerBound >= 0, range.upperBound <= characters.count else { continue }
            let start = String(characters[0..<range.lowerBound]).utf16.count
            let length = String(characters[range]).utf16.count
            result.addAttribute(.font, value: NSFont.systemFont(ofSize: 13, weight: .bold),
                                range: NSRange(location: start, length: length))
        }
        return result
    }
}

/// One key of a chord, drawn as a small cap: a rounded fill with the glyph
/// centred in it, sized to the glyph with a floor so a single letter is as
/// wide as a modifier symbol.
final class KeyCapView: NSView {
    private let label = NSTextField(labelWithString: "")

    init(_ text: String) {
        super.init(frame: .zero)
        label.stringValue = text
        label.font = .systemFont(ofSize: 11, weight: .medium)
        label.textColor = .secondaryLabelColor
        label.alignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        translatesAutoresizingMaskIntoConstraints = false
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            widthAnchor.constraint(greaterThanOrEqualToConstant: 20),
            widthAnchor.constraint(equalTo: label.widthAnchor, constant: 10).with(priority: .defaultHigh),
            heightAnchor.constraint(equalToConstant: 20),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Drawn rather than a layer background, so the cap is there on every
    /// path that draws the view, the PDF snapshot included.
    override func draw(_ dirtyRect: NSRect) {
        NSColor.labelColor.withAlphaComponent(0.08).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 4, yRadius: 4).fill()
    }
}

private extension NSLayoutConstraint {
    func with(priority: NSLayoutConstraint.Priority) -> NSLayoutConstraint {
        self.priority = priority
        return self
    }
}
