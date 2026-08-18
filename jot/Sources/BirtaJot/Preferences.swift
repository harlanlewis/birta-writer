import AppKit
import BirtaJotCore

/// UserDefaults-backed preferences. Everything Jot remembers between launches
/// that is not the buffer itself: the hotkey, where the scratchpad lives, the
/// optional "open this document instead" path, the network opt-in, and the
/// per-editor state the page reports (toolbar layout, font, width, view state).
///
/// Jot's configuration is wholly its own on purpose: sharing `birta.*`
/// settings with the extension would couple the two release clocks (MAR-370).
enum Prefs {
    private static let d = UserDefaults.standard

    enum Key {
        static let hotkey = "hotkey"
        static let scratchpadPath = "scratchpadPath"
        static let documentPath = "documentPath"
        static let networkEnabled = "networkEnabled"
        static let toolbarLayout = "toolbarLayout"
        static let fontPreset = "fontPreset"
        static let fontSize = "fontSize"
        static let contentWidth = "contentWidth"
        static let viewState = "viewState"
        static let saveAsDirectory = "saveAsDirectory"
    }

    static var hotkey: HotkeyCombo {
        get {
            if let s = d.string(forKey: Key.hotkey), case let .success(c) = HotkeyCombo.parse(s) { return c }
            return .default
        }
        set { d.set(newValue.spelling, forKey: Key.hotkey) }
    }

    /// The scratchpad file. Default: ~/Library/Application Support/Birta Jot/Scratchpad.md.
    static var scratchpadURL: URL {
        get {
            if let p = d.string(forKey: Key.scratchpadPath), !p.isEmpty { return URL(fileURLWithPath: p) }
            return defaultScratchpadURL
        }
        set { d.set(newValue.path, forKey: Key.scratchpadPath) }
    }

    static var defaultScratchpadURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Birta Jot/Scratchpad.md")
    }

    /// When set, Jot edits this document instead of the scratchpad.
    static var documentURL: URL? {
        get {
            guard let p = d.string(forKey: Key.documentPath), !p.isEmpty else { return nil }
            return URL(fileURLWithPath: p)
        }
        set { d.set(newValue?.path ?? "", forKey: Key.documentPath) }
    }

    /// The file the editor is bound to right now.
    static var activeURL: URL { documentURL ?? scratchpadURL }

    static var networkEnabled: Bool {
        get { d.bool(forKey: Key.networkEnabled) }
        set { d.set(newValue, forKey: Key.networkEnabled) }
    }

    static var toolbarLayout: ToolbarLayout {
        get { ToolbarLayout.fromJSON(d.string(forKey: Key.toolbarLayout)) }
        set { d.set(newValue.json, forKey: Key.toolbarLayout) }
    }

    static var fontPreset: String {
        get { d.string(forKey: Key.fontPreset) ?? "editor" }
        set { d.set(newValue, forKey: Key.fontPreset) }
    }

    static var fontSize: Int {
        get { d.object(forKey: Key.fontSize) == nil ? 100 : d.integer(forKey: Key.fontSize) }
        set { d.set(newValue, forKey: Key.fontSize) }
    }

    static var contentWidth: String {
        get { d.string(forKey: Key.contentWidth) ?? "full" }
        set { d.set(newValue, forKey: Key.contentWidth) }
    }

    static var viewStateJSON: String? {
        get { d.string(forKey: Key.viewState) }
        set { d.set(newValue, forKey: Key.viewState) }
    }

    static var saveAsDirectory: URL? {
        get { d.string(forKey: Key.saveAsDirectory).map { URL(fileURLWithPath: $0) } }
        set { d.set(newValue?.path, forKey: Key.saveAsDirectory) }
    }

    static func bootConfig() -> BootConfig {
        BootConfig(
            toolbarJSON: toolbarLayout.json,
            fontPreset: fontPreset,
            fontSize: fontSize,
            contentWidth: contentWidth,
            networkEnabled: networkEnabled,
            // HOST_PROFILES.jot in shared/hostCapabilities.ts, by hand: Swift
            // cannot import it. Change both.
            hostCapabilities: [],
            viewStateJSON: viewStateJSON
        )
    }
}

/// The Preferences window: a small grid built in code. Opened from the status
/// menu; the app activates first or the window opens behind the front app.
@MainActor
final class PreferencesWindowController: NSWindowController, NSTextFieldDelegate {
    private let hotkeyField = NSTextField(string: Prefs.hotkey.spelling)
    private let hotkeyStatus = NSTextField(labelWithString: "")
    private let scratchpadLabel = NSTextField(labelWithString: Prefs.scratchpadURL.path)
    private let documentCheck = NSButton(checkboxWithTitle: "Open this document instead of the scratchpad:", target: nil, action: nil)
    private let documentLabel = NSTextField(labelWithString: Prefs.documentURL?.path ?? "(none chosen)")
    private let networkCheck = NSButton(checkboxWithTitle: "Allow network: link cards and rich embeds", target: nil, action: nil)
    private let onChange: () -> Void

    init(onChange: @escaping () -> Void) {
        self.onChange = onChange
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 260),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Birta Jot Preferences"
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.contentView = buildContent()
        window.center()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func buildContent() -> NSView {
        hotkeyField.delegate = self
        hotkeyField.placeholderString = "cmd+alt+ctrl+j"
        hotkeyStatus.textColor = .secondaryLabelColor
        hotkeyStatus.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        scratchpadLabel.lineBreakMode = .byTruncatingMiddle
        documentLabel.lineBreakMode = .byTruncatingMiddle
        documentCheck.state = Prefs.documentURL == nil ? .off : .on
        documentCheck.target = self
        documentCheck.action = #selector(toggleDocument)
        networkCheck.state = Prefs.networkEnabled ? .on : .off
        networkCheck.target = self
        networkCheck.action = #selector(toggleNetwork)

        let chooseScratch = NSButton(title: "Choose…", target: self, action: #selector(chooseScratchpad))
        let chooseDoc = NSButton(title: "Choose…", target: self, action: #selector(chooseDocument))

        let grid = NSGridView(views: [
            [NSTextField(labelWithString: "Global hotkey:"), hotkeyField],
            [NSView(), hotkeyStatus],
            [NSTextField(labelWithString: "Scratchpad file:"), row(scratchpadLabel, chooseScratch)],
            [documentCheck, row(documentLabel, chooseDoc)],
            [NSView(), networkCheck],
            [NSView(), NSTextField(wrappingLabelWithString: "Off by default. When on, pasted links may fetch titles and cards, and embeds load from their providers.")],
        ])
        grid.rowSpacing = 10
        grid.columnSpacing = 12
        grid.column(at: 0).xPlacement = .trailing
        grid.column(at: 1).width = 360
        grid.translatesAutoresizingMaskIntoConstraints = false
        documentCheck.contentTintColor = nil

        let container = NSView()
        container.addSubview(grid)
        NSLayoutConstraint.activate([
            grid.topAnchor.constraint(equalTo: container.topAnchor, constant: 20),
            grid.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 20),
            grid.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -20),
            grid.bottomAnchor.constraint(lessThanOrEqualTo: container.bottomAnchor, constant: -20),
        ])
        return container
    }

    private func row(_ a: NSView, _ b: NSView) -> NSView {
        let s = NSStackView(views: [a, b])
        s.orientation = .horizontal
        s.spacing = 8
        a.setContentHuggingPriority(.defaultLow, for: .horizontal)
        a.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return s
    }

    // MARK: hotkey

    func controlTextDidEndEditing(_ obj: Notification) {
        switch HotkeyCombo.parse(hotkeyField.stringValue) {
        case .success(let combo):
            Prefs.hotkey = combo
            hotkeyField.stringValue = combo.spelling
            hotkeyStatus.stringValue = "Registered as \(combo.symbols)."
            hotkeyStatus.textColor = .secondaryLabelColor
            onChange()
        case .failure(let err):
            hotkeyStatus.stringValue = err.description
            hotkeyStatus.textColor = .systemRed
        }
    }

    // MARK: files

    @objc private func chooseScratchpad() {
        let panel = NSSavePanel()
        panel.title = "Scratchpad location"
        panel.nameFieldStringValue = Prefs.scratchpadURL.lastPathComponent
        panel.directoryURL = Prefs.scratchpadURL.deletingLastPathComponent()
        panel.allowedContentTypes = [.init(filenameExtension: "md") ?? .plainText]
        panel.beginSheetModal(for: window!) { [weak self] resp in
            guard resp == .OK, let url = panel.url, let self else { return }
            Prefs.scratchpadURL = url
            self.scratchpadLabel.stringValue = url.path
            self.onChange()
        }
    }

    @objc private func chooseDocument() {
        let panel = NSOpenPanel()
        panel.title = "Document to open"
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.init(filenameExtension: "md") ?? .plainText, .plainText]
        panel.beginSheetModal(for: window!) { [weak self] resp in
            guard resp == .OK, let url = panel.url, let self else { return }
            Prefs.documentURL = url
            self.documentCheck.state = .on
            self.documentLabel.stringValue = url.path
            self.onChange()
        }
    }

    @objc private func toggleDocument() {
        if documentCheck.state == .off {
            Prefs.documentURL = nil
            documentLabel.stringValue = "(none chosen)"
            onChange()
        } else if Prefs.documentURL == nil {
            chooseDocument()
        }
    }

    @objc private func toggleNetwork() {
        Prefs.networkEnabled = networkCheck.state == .on
        onChange()
    }
}
