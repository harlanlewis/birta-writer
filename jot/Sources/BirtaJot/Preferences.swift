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
        static let autosave = "autosave"
        static let floatAboveOtherWindows = "floatAboveOtherWindows"
        static let agentCommand = "agentCommand"
        static let showInDock = "showInDock"
        static let openToBlankNote = "openToBlankNote"
        static let currentNotePath = "currentNotePath"
    }

    static var hotkey: HotkeyCombo {
        get {
            if let s = d.string(forKey: Key.hotkey), case let .success(c) = HotkeyCombo.parse(s) { return c }
            return .default
        }
        set { d.set(newValue.spelling, forKey: Key.hotkey) }
    }

    /// The app's own name, and the only spelling of it in this file.
    ///
    /// `JOT_PRODUCT_NAME` in shared/product.ts is the source; Swift cannot
    /// import TypeScript, so this restates it and the drift test in
    /// `shared/__tests__/editorCommandsContributions.test.ts` reads this file
    /// and fails when the two disagree. It is a constant rather than two
    /// literals because the folder and the file inside it are the same name,
    /// and a rename that moved one of them would leave the app keeping
    /// "Birta Jot.md" in a folder called something else.
    static let productName = "Birta Jot"

    /// The scratchpad file. Default: ~/Library/Application Support/Birta Jot/Birta Jot.md.
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

    /// The app's name, twice: the folder Jot keeps its things in, and the note
    /// inside it.
    ///
    /// The file is named after the app rather than after what it is for. It is
    /// the one document a person who has changed no settings ever sees, its
    /// name is what the window titles itself with, and "Birta Jot" is what
    /// they would call the thing that window is. A description of the file's
    /// role is a word they never chose and would have to learn.
    static var defaultScratchpadURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return base
            .appendingPathComponent(productName, isDirectory: true)
            .appendingPathComponent("\(productName).md")
    }

    /// When set, Jot edits this document instead of the scratchpad.
    static var documentURL: URL? {
        get {
            guard let p = d.string(forKey: Key.documentPath), !p.isEmpty else { return nil }
            return URL(fileURLWithPath: p)
        }
        set { d.set(newValue?.path ?? "", forKey: Key.documentPath) }
    }

    /// The note the last New Note made, if any. Between the chosen document
    /// and the scratchpad in precedence: a document the user pointed Jot at
    /// outranks it, and it outranks the scratchpad, which is where Jot starts
    /// and returns when no note has been made.
    static var currentNoteURL: URL? {
        get {
            guard let p = d.string(forKey: Key.currentNotePath), !p.isEmpty else { return nil }
            let url = URL(fileURLWithPath: p)
            // A note deleted from Finder must not leave Jot bound to nothing.
            return FileManager.default.fileExists(atPath: url.path) ? url : nil
        }
        set { d.set(newValue?.path ?? "", forKey: Key.currentNotePath) }
    }

    /// The file the editor is bound to right now.
    static var activeURL: URL { documentURL ?? currentNoteURL ?? scratchpadURL }

    static var networkEnabled: Bool {
        get { d.bool(forKey: Key.networkEnabled) }
        set { d.set(newValue, forKey: Key.networkEnabled) }
    }

    static var toolbarLayout: ToolbarLayout {
        get { ToolbarLayout.fromJSON(d.string(forKey: Key.toolbarLayout)) }
        set { d.set(newValue.json, forKey: Key.toolbarLayout) }
    }

    static var fontPreset: String {
        get { d.string(forKey: Key.fontPreset) ?? "serif" }
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
    /// the panel rather than a setting, which is why it is not in Settings.
    static var saveAsDirectory: URL? {
        get { d.string(forKey: Key.saveAsDirectory).map { URL(fileURLWithPath: $0) } }
        set { d.set(newValue?.path, forKey: Key.saveAsDirectory) }
    }

    /// Write while you type. Off means Jot stops writing on edits and nothing
    /// else: hiding the panel and quitting still write, because a preference
    /// that drops the buffer is not one anybody asked for
    /// (`BirtaJotCore.AutosavePolicy` holds that rule and its tests).
    static var autosave: Bool {
        get { d.object(forKey: Key.autosave) == nil ? true : d.bool(forKey: Key.autosave) }
        set { d.set(newValue, forKey: Key.autosave) }
    }

    /// Whether the panel stays above other applications' windows. Off by
    /// default: a window that will not go behind anything is a window you
    /// fight, and the hotkey already brings the panel back in one keystroke.
    static var floatAboveOtherWindows: Bool {
        get { d.bool(forKey: Key.floatAboveOtherWindows) }
        set { d.set(newValue, forKey: Key.floatAboveOtherWindows) }
    }

    /// The shell command `/ai` runs, with `{prompt}` where the quoted request
    /// goes. The same shape as the extension's `birta.agent.command`, so a
    /// command tuned there can be pasted here unchanged. Empty turns `/ai` off:
    /// the capability is withdrawn and the page never offers the row.
    static var agentCommand: String {
        get { d.string(forKey: Key.agentCommand) ?? "claude -p {prompt} --permission-mode acceptEdits" }
        set { d.set(newValue, forKey: Key.agentCommand) }
    }

    /// Whether Jot has a Dock icon, and so appears in Cmd+Tab and gets an
    /// application menu bar of its own.
    ///
    /// Off by default, which is what `LSUIElement` in Info.plist declares: a
    /// scratchpad summoned by a hotkey is a thing you reach past your other
    /// applications for, not one of them. On makes it an ordinary application,
    /// which is what someone who leaves the panel open all day wants. The
    /// plist stays the default so a launch never flashes an icon before this
    /// is read; `Entry.main` applies it, and `AppDelegate` re-applies it when
    /// the switch moves.
    static var showInDock: Bool {
        get { d.bool(forKey: Key.showInDock) }
        set { d.set(newValue, forKey: Key.showInDock) }
    }

    /// Whether launching starts a new empty note rather than reopening the
    /// last one. Off by default: a scratchpad that survives a restart is what
    /// most people summon a scratchpad for.
    static var openToBlankNote: Bool {
        get { d.bool(forKey: Key.openToBlankNote) }
        set { d.set(newValue, forKey: Key.openToBlankNote) }
    }

    /// Where a new note goes: beside the scratchpad, in Jot's own folder. Not
    /// a setting of its own, because the scratchpad's location already answers
    /// "where does Jot keep things" and two answers would disagree.
    static var notesDirectory: URL {
        scratchpadURL.deletingLastPathComponent()
    }

    static func bootConfig() -> BootConfig {
        BootConfig(
            toolbarJSON: toolbarLayout.json,
            fontPreset: fontPreset,
            fontSize: fontSize,
            contentWidth: contentWidth,
            networkEnabled: networkEnabled,
            // HOST_PROFILES.jot in shared/hostProfile.ts is the source;
            // Swift cannot import it, so this literal restates it and
            // shared/__tests__/hostProfile.test.ts parses this file and
            // fails when the two disagree.
            hostCapabilities: ["imageUpload", "appPreferences", "agent"],
            viewStateJSON: viewStateJSON,
            hostShortcuts: JotMenu.shortcuts.map { HostShortcut(keys: $0.chord, label: $0.title) }
        )
    }
}
