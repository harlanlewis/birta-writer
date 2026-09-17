import AppKit
import BirtaWriterCore

/// Browse Open VSX for a theme, as a sheet over Settings: a search field,
/// the results, and Add on the one you want, which fetches its VSIX and
/// hands it to the store exactly as a file chosen from disk is.
///
/// Every request here is one somebody asked for by typing and pressing
/// Return, or by pressing Add, to the registry's host (`OpenVsx.host`) and,
/// for the package, to wherever the registry redirects the file (its own
/// file host today), carrying the words typed and nothing else; nothing
/// runs on a timer and nothing rides the network switch, for the reason
/// Check for Updates does not (docs/NETWORK_POSTURE.md). A redirect off
/// https is refused (`RedirectGuard`). `URLSession` is used directly rather
/// than through the page-metadata fetcher, whose guards are about URLs a
/// document named; these are the registry's own.
///
/// Whoever presents this has to HOLD it: the sheet keeps its controller
/// only through targets, delegates and a data source, every one of which
/// AppKit holds weakly, so a controller nobody else owns is gone before the
/// sheet is up and its buttons reach nothing.
@MainActor
final class ThemeBrowserController: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
    private let store: ThemeStore
    private let onAdded: ([ThemeSummary], [String]) -> Void
    private let sheet: NSWindow
    private let search = NSSearchField()
    private let table = NSTableView()
    private let status = NSTextField(labelWithString: "")
    private let addButton = NSButton(title: "Add", target: nil, action: nil)
    private let doneButton = NSButton(title: "Done", target: nil, action: nil)
    private var results: [OpenVsxTheme] = []
    private var task: Task<Void, Never>?
    /// What was added this session, reported once when the sheet closes.
    private var added: [ThemeSummary] = []
    private var failures: [String] = []

    init(store: ThemeStore, onAdded: @escaping ([ThemeSummary], [String]) -> Void) {
        self.store = store
        self.onAdded = onAdded
        sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 420),
                         styleMask: [.titled], backing: .buffered, defer: false)
        super.init()
        sheet.title = "Browse Open VSX"
        build()
    }

    private func build() {
        let content = NSView()
        sheet.contentView = content

        search.placeholderString = "Search themes"
        search.delegate = self
        search.target = self
        search.action = #selector(runSearch)
        search.sendsWholeSearchString = true
        search.sendsSearchStringImmediately = false

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("theme"))
        table.addTableColumn(column)
        table.headerView = nil
        table.rowHeight = 36
        table.columnAutoresizingStyle = .firstColumnOnlyAutoresizingStyle
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.doubleAction = #selector(addSelected)
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder

        status.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        status.textColor = .secondaryLabelColor
        status.lineBreakMode = .byTruncatingTail

        addButton.target = self
        addButton.action = #selector(addSelected)
        addButton.keyEquivalent = ""
        addButton.isEnabled = false
        doneButton.target = self
        doneButton.action = #selector(finish)
        doneButton.keyEquivalent = "\u{1b}"
        let buttons = NSStackView(views: [status, NSView(), addButton, doneButton])
        buttons.orientation = .horizontal
        buttons.spacing = 8
        status.setContentHuggingPriority(.defaultLow, for: .horizontal)
        status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let stack = NSStackView(views: [search, scroll, buttons])
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
    }

    func present(over window: NSWindow) {
        window.beginSheet(sheet) { _ in }
        sheet.makeFirstResponder(search)
    }

    // MARK: searching

    @objc private func runSearch() {
        let query = search.stringValue.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return }
        task?.cancel()
        status.stringValue = "Searching…"
        let url = OpenVsx.searchURL(query: query)
        task = Task { [weak self] in
            do {
                let (data, response) = try await URLSession.shared.data(from: url, delegate: RedirectGuard())
                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    throw NSError(domain: "OpenVsx", code: 2,
                                  userInfo: [NSLocalizedDescriptionKey: "The registry did not answer."])
                }
                let themes = try OpenVsx.parse(data)
                guard !Task.isCancelled else { return }
                self?.show(themes, query: query)
            } catch {
                guard !Task.isCancelled else { return }
                self?.status.stringValue = error.localizedDescription
            }
        }
    }

    private func show(_ themes: [OpenVsxTheme], query: String) {
        results = themes
        table.reloadData()
        status.stringValue = themes.isEmpty ? "Nothing on Open VSX matches \(query)." : ""
        addButton.isEnabled = false
    }

    // MARK: adding

    @objc private func addSelected() {
        let row = table.selectedRow
        guard row >= 0, row < results.count else { return }
        let theme = results[row]
        status.stringValue = "Adding \(theme.displayName)…"
        addButton.isEnabled = false
        let store = self.store
        Task { [weak self] in
            do {
                let (file, response) = try await URLSession.shared.download(from: theme.download, delegate: RedirectGuard())
                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    throw NSError(domain: "OpenVsx", code: 3,
                                  userInfo: [NSLocalizedDescriptionKey: "\(theme.displayName) could not be downloaded."])
                }
                // A name the store recognises as a package; the download
                // lands with none.
                let vsix = file.deletingLastPathComponent().appendingPathComponent("\(theme.id).vsix")
                try? FileManager.default.removeItem(at: vsix)
                try FileManager.default.moveItem(at: file, to: vsix)
                defer { try? FileManager.default.removeItem(at: vsix) }
                let imported = try store.importThemes(from: vsix)
                self?.added += imported
                self?.status.stringValue = "Added \(imported.map(\.name).joined(separator: ", "))."
            } catch {
                self?.failures.append("\(theme.displayName): \(error.localizedDescription)")
                self?.status.stringValue = error.localizedDescription
            }
            self?.addButton.isEnabled = (self?.table.selectedRow ?? -1) >= 0
        }
    }

    @objc private func finish() {
        task?.cancel()
        sheet.sheetParent?.endSheet(sheet)
        onAdded(added, failures)
    }

    /// Whether the sheet's controls still reach this controller, for the
    /// check that whoever presented it is holding it.
    var isWiredForTesting: Bool { search.target === self && table.dataSource === self }
    func dismissForTesting() { finish() }

    /// The package's redirect, decided by `OpenVsx.redirect`: this only
    /// forwards, so the rule is checkable with no session.
    final class RedirectGuard: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(OpenVsx.redirect(request))
        }
    }

    // MARK: the table

    func numberOfRows(in tableView: NSTableView) -> Int { results.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row < results.count else { return nil }
        let theme = results[row]
        let id = NSUserInterfaceItemIdentifier("result")
        let cell = (tableView.makeView(withIdentifier: id, owner: nil) as? ResultRow) ?? ResultRow(identifier: id)
        cell.show(theme)
        return cell
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        addButton.isEnabled = table.selectedRow >= 0
    }

    /// The theme's name over its publisher, and its downloads at the edge.
    final class ResultRow: NSTableCellView {
        private let name = NSTextField(labelWithString: "")
        private let publisher = NSTextField(labelWithString: "")
        private let downloads = NSTextField(labelWithString: "")

        init(identifier: NSUserInterfaceItemIdentifier) {
            super.init(frame: .zero)
            self.identifier = identifier
            name.font = .systemFont(ofSize: NSFont.systemFontSize)
            name.lineBreakMode = .byTruncatingTail
            publisher.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
            publisher.textColor = .secondaryLabelColor
            downloads.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
            downloads.textColor = .secondaryLabelColor
            downloads.setContentHuggingPriority(.required, for: .horizontal)
            let words = NSStackView(views: [name, publisher])
            words.orientation = .vertical
            words.alignment = .leading
            words.spacing = 1
            let stack = NSStackView(views: [words, downloads])
            stack.orientation = .horizontal
            stack.alignment = .centerY
            stack.distribution = .fill
            words.setContentHuggingPriority(.defaultLow, for: .horizontal)
            stack.translatesAutoresizingMaskIntoConstraints = false
            addSubview(stack)
            NSLayoutConstraint.activate([
                stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
                stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
                stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            ])
        }

        required init?(coder: NSCoder) { fatalError("not used") }

        func show(_ theme: OpenVsxTheme) {
            name.stringValue = theme.displayName
            publisher.stringValue = theme.namespace
            downloads.stringValue = OpenVsx.downloadsLabel(theme.downloads)
                + (theme.rating.map { String(format: "  ★ %.1f", $0) } ?? "")
        }
    }
}
