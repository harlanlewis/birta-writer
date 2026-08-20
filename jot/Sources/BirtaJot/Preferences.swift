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
        static let agentCommand = "agentCommand"
        static let showInDock = "showInDock"
        static let hideWhenInactive = "hideWhenInactive"
        static let openToBlankNote = "openToBlankNote"
        static let currentNotePath = "currentNotePath"
        static let storeInICloud = "storeInICloud"
    }

    static var hotkey: HotkeyCombo {
        get {
            if let s = d.string(forKey: Key.hotkey), case let .success(c) = HotkeyCombo.parse(s) { return c }
            return .default
        }
        set { d.set(newValue.spelling, forKey: Key.hotkey) }
    }

    /// The scratchpad file. Default: `defaultScratchpadURL` below.
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

    /// Whether the user has pointed the scratchpad at a path of their own,
    /// which overrides both homes: `scratchpadURL` prefers the stored path, so
    /// the iCloud switch decides nothing while this is true and the Settings
    /// row says as much rather than offering a choice that does nothing.
    static var hasExplicitScratchpadPath: Bool {
        !(d.string(forKey: Key.scratchpadPath) ?? "").isEmpty
    }

    /// Whether the note lives in iCloud Drive, so it is the same note on every
    /// machine the user has.
    ///
    /// ON by default, and subject to iCloud Drive actually being switched on:
    /// `scratchpadLocation` resolves the two together, and a machine without
    /// iCloud falls back to the local folder rather than failing. Syncing a
    /// scratchpad is what most people want from one and the least surprising
    /// thing a note can do; the switch is there because it is also an outbound
    /// copy of everything typed into it, which is a choice that belongs to the
    /// user rather than to us.
    static var storeInICloud: Bool {
        get { d.object(forKey: Key.storeInICloud) == nil ? true : d.bool(forKey: Key.storeInICloud) }
        set { d.set(newValue, forKey: Key.storeInICloud) }
    }

    /// Whether this machine has iCloud Drive switched on.
    static var iCloudAvailable: Bool { ScratchpadLocation.iCloudDriveRoot() != nil }

    /// Which of the two homes the default note is in right now.
    static var scratchpadLocation: ScratchpadLocation {
        ScratchpadLocation.inForce(preferICloud: storeInICloud, iCloudAvailable: iCloudAvailable)
    }

    /// The default note's path, in whichever home is in force.
    ///
    /// The file is named after the app rather than after what it is for. It is
    /// the one document a person who has changed no settings ever sees, its
    /// name is what the window titles itself with, and "Birta Writer Jot" is
    /// what they would call the thing that window is. A description of the
    /// file's role is a word they never chose and would have to learn.
    ///
    /// The two homes and the folder each uses are `ScratchpadLocation`'s, which
    /// is where the reasoning for them lives and which is testable without a
    /// real home directory.
    static var defaultScratchpadURL: URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        switch scratchpadLocation {
        case .iCloud:
            // `iCloudAvailable` is what put us here, so the root is there; the
            // fallback covers only the race where iCloud Drive is switched off
            // between the two reads, and lands on the same folder the `.local`
            // case would have chosen.
            guard let root = ScratchpadLocation.iCloudDriveRoot() else {
                return ScratchpadLocation.local.url(root: home.appendingPathComponent("Documents", isDirectory: true))
            }
            return ScratchpadLocation.iCloud.url(root: root)
        case .local:
            return ScratchpadLocation.local.url(root: home.appendingPathComponent("Documents", isDirectory: true))
        }
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
    ///
    /// The precedence lives in `BirtaJotCore.ActiveBinding`, which also
    /// answers WHICH of the three settings supplied it. Renaming or moving the
    /// file from the title popover has to write back to that same setting, and
    /// a `??` chain says nothing about which one it took.
    static var activeURL: URL {
        ActiveBinding.url(document: documentURL, currentNote: currentNoteURL, scratchpad: scratchpadURL)
    }

    /// Which setting `activeURL` just read from, so a move updates it and not
    /// one of the others.
    static var activeSlot: ActiveBinding.Slot {
        ActiveBinding.slot(hasDocument: documentURL != nil, hasCurrentNote: currentNoteURL != nil)
    }

    /// Point the setting the panel is currently bound through at `url`. The
    /// one write-back a rename or a move makes, so it cannot pick the wrong
    /// one of the three.
    static func rebindActive(to url: URL) {
        switch activeSlot {
        case .document: documentURL = url
        case .currentNote: currentNoteURL = url
        case .scratchpad: scratchpadURL = url
        }
    }

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

    /// Whether the panel hides itself when Jot stops being the active app.
    ///
    /// Off by default, and only meaningful while `showInDock` is off: the two
    /// answer the same question about what kind of thing Jot is, and
    /// `hidesWhenInactive` is what makes it a true overlay — summon it, type,
    /// click back into your work and it is gone, with no window to dismiss.
    ///
    /// Meaningless WITH a Dock icon, which is why the Settings row is disabled
    /// there rather than merely unhelpful. An ordinary application whose window
    /// vanished every time you looked at another one would be one you could not
    /// use: Cmd+Tab to it, glance at the browser, and the window you tabbed to
    /// is gone. `hidesWhenInactiveInForce` is the one place that pairing is
    /// resolved, so the panel and the Settings row cannot disagree about it.
    static var hideWhenInactive: Bool {
        get { d.bool(forKey: Key.hideWhenInactive) }
        set { d.set(newValue, forKey: Key.hideWhenInactive) }
    }

    /// Whether the panel actually hides on deactivation right now: the setting
    /// AND the absence of a Dock icon.
    static var hidesWhenInactiveInForce: Bool { hideWhenInactive && !showInDock }

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
