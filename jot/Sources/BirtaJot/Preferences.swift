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
    /// `BIRTA_JOT_DEFAULTS_SUITE` names a separate defaults domain, so
    /// jot/scripts/measure.sh never rewrites the user's own layout and frame.
    private static let d: UserDefaults = {
        if let suite = ProcessInfo.processInfo.environment["BIRTA_JOT_DEFAULTS_SUITE"], !suite.isEmpty,
           let u = UserDefaults(suiteName: suite) { return u }
        return .standard
    }()

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
        static let saveDirectory = "saveDirectory"
        static let recentDestinations = "recentDestinations"
    }

    static var hotkey: HotkeyCombo {
        get {
            if let s = d.string(forKey: Key.hotkey), case let .success(c) = HotkeyCombo.parse(s) { return c }
            return .default
        }
        set { d.set(newValue.spelling, forKey: Key.hotkey) }
    }

    /// The scratchpad file. Default: ~/Library/Application Support/Birta Jot/Scratchpad.md.
    /// `BIRTA_JOT_SCRATCHPAD` overrides it for a run, so jot/scripts/measure.sh
    /// can type into a throwaway file and never touch the real one.
    static var scratchpadURL: URL {
        get {
            if let env = ProcessInfo.processInfo.environment["BIRTA_JOT_SCRATCHPAD"], !env.isEmpty { return URL(fileURLWithPath: env) }
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

    /// Where the last Save As went, so the next one opens there. A memory of
    /// the panel, not a setting; `saveDirectory` is the setting.
    static var saveAsDirectory: URL? {
        get { d.string(forKey: Key.saveAsDirectory).map { URL(fileURLWithPath: $0) } }
        set { d.set(newValue?.path, forKey: Key.saveAsDirectory) }
    }

    /// The default destination: where Save puts a note when nobody is asked.
    /// A folder of its own under Documents, because a chute produces files at
    /// the rate notes are finished and they should not land on top of the
    /// user's own filing.
    static var saveDirectory: URL {
        get {
            if let p = d.string(forKey: Key.saveDirectory), !p.isEmpty { return URL(fileURLWithPath: p, isDirectory: true) }
            return defaultSaveDirectory
        }
        set { d.set(newValue.path, forKey: Key.saveDirectory) }
    }

    static var defaultSaveDirectory: URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
        return base.appendingPathComponent("Jot", isDirectory: true)
    }

    /// Folders notes have gone to lately, for the overflow menu's one-click
    /// repeat of a destination.
    static var recentDestinations: RecentDestinations {
        get { RecentDestinations(d.stringArray(forKey: Key.recentDestinations) ?? []) }
        set { d.set(newValue.paths, forKey: Key.recentDestinations) }
    }

    static func bootConfig() -> BootConfig {
        BootConfig(
            toolbarJSON: toolbarLayout.json,
            fontPreset: fontPreset,
            fontSize: fontSize,
            contentWidth: contentWidth,
            networkEnabled: networkEnabled,
            // HOST_PROFILES.jot in shared/hostCapabilities.ts is the source;
            // Swift cannot import it, so this literal restates it and
            // shared/__tests__/hostCapabilities.test.ts parses this file and
            // fails when the two disagree.
            hostCapabilities: ["imageUpload"],
            viewStateJSON: viewStateJSON
        )
    }
}
