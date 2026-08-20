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

    /// Whether the store above is the person's own.
    ///
    /// Everything Jot remembers goes through `d` and is therefore covered by
    /// the throwaway domain, with ONE exception that is not: AppKit's window
    /// frame autosave writes to the app's standard defaults whatever this file
    /// is pointed at. So a checking run that resizes the panel leaves the
    /// person's own window at whatever width the run finished on. `JotPanel`
    /// reads this to stop remembering at all when the defaults are not theirs.
    static var isUserStore: Bool { d === UserDefaults.standard }

    /// Every key Jot stores, as a type rather than as a list of constants.
    ///
    /// `CaseIterable` is load-bearing: `reset()` walks the cases, so a key
    /// added later is cleared without anyone remembering to add it anywhere.
    /// A hand-written list is a list a new key never joins.
    enum Key: String, CaseIterable {
        case hotkey
        case scratchpadPath
        case documentPath
        case networkEnabled
        case toolbarLayout
        case fontPreset
        case fontSize
        case contentWidth
        case viewState
        case saveAsDirectory
        case autosave
        case agentCommand
        case showInDock
        case openToBlankNote
        case currentNotePath
        case storeInICloud
        case hasSeenWelcome
        case autoUpdate
    }

    /// Keys no accessor reads any more.
    ///
    /// A removed setting leaves its value behind, and a value nothing reads is
    /// invisible until the name comes back meaning something else. Swept once
    /// at launch so the domain holds only what is live, and cleared again by
    /// `reset()`, which walks `Key` and would otherwise leave behind exactly
    /// the keys a reset is for.
    static let retiredKeys = [
        "floatAboveOtherWindows",
        "hideWhenInactive",
    ]

    /// Drop the retired keys. Cheap, idempotent, and called before anything
    /// reads a preference.
    static func sweepRetiredKeys() {
        for key in retiredKeys { d.removeObject(forKey: key) }
    }

    /// Put every setting back to its default, and touch no file on disk.
    ///
    /// The note is deliberately not in scope. A reset is about the settings a
    /// person can no longer reason about, and deleting their writing to fix a
    /// hotkey is not a trade anybody would take; the file stays exactly where
    /// it is, and Jot rebinds to the default location, so the old note is one
    /// Choose away rather than gone.
    ///
    /// Three things beyond `Key` that a reset has to reach, each of which
    /// would otherwise survive it and make the reset a lie:
    ///
    ///   - the retired keys, which no accessor reads and no walk of `Key`
    ///     covers,
    ///   - AppKit's own window-frame autosave, which writes to the standard
    ///     domain whatever `BIRTA_JOT_DEFAULTS_SUITE` says, so a reset that
    ///     used `d` alone would leave the panel at whatever size it was
    ///     dragged to,
    ///   - the login item, which is a registration with the system rather
    ///     than a value here.
    ///
    /// Applying the result is the CALLER'S: activation policy, hotkey and the
    /// bound file all have to be re-read, and the file has to be flushed
    /// before it is rebound. `SettingsWindowController.resetAllSettings` is
    /// the one place that sequence is written down.
    static func reset() {
        for key in Key.allCases where key != .hasSeenWelcome {
            d.removeObject(forKey: key.rawValue)
        }
        // `hasSeenWelcome` deliberately survives. Clearing it would make the
        // next launch a first launch, and a first launch writes the onboarding
        // answers, so a reset done to get back to a quiet, no-network state
        // would put the network switch back on one launch later. The sheet
        // says every setting goes back to its default, and that is what a
        // default IS here; seeing the screen again is its own button.
        hasSeenWelcome = true
        sweepRetiredKeys()
        UserDefaults.standard.removeObject(forKey: panelFrameAutosaveDefaultsKey)
        // Deliberately discarded: the caller re-reads `LoginItem.state` to
        // redraw its row, and a reset that stopped because macOS declined to
        // deregister would leave every other setting half-reset.
        _ = try? LoginItem.set(false)
    }

    /// Where AppKit keeps `setFrameAutosaveName("JotPanel")`'s frame. Spelled
    /// out because `reset` has to remove a key nothing else here writes.
    static let panelFrameAutosaveDefaultsKey = "NSWindow Frame JotPanel"

    static var hotkey: HotkeyCombo {
        get {
            if let s = d.string(forKey: Key.hotkey.rawValue), case let .success(c) = HotkeyCombo.parse(s) { return c }
            return .default
        }
        set { d.set(newValue.spelling, forKey: Key.hotkey.rawValue) }
    }

    /// The scratchpad file. Default: `defaultScratchpadURL` below.
    /// `BIRTA_JOT_SCRATCHPAD` overrides it for a run, so jot/scripts/measure.sh
    /// can type into a throwaway file and never touch the real one.
    static var scratchpadURL: URL! {
        get {
            if let env = ProcessInfo.processInfo.environment["BIRTA_JOT_SCRATCHPAD"], !env.isEmpty { return URL(fileURLWithPath: env) }
            if let p = d.string(forKey: Key.scratchpadPath.rawValue), !p.isEmpty { return URL(fileURLWithPath: p) }
            return defaultScratchpadURL
        }
        // Nil CLEARS the chosen path, which is how the home menu hands the
        // decision back to the iCloud/Documents pair; a chosen path outranks
        // both, so leaving one set would overrule that menu invisibly.
        set { d.set(newValue?.path ?? "", forKey: Key.scratchpadPath.rawValue) }
    }

    /// Whether the user has pointed the scratchpad at a path of their own,
    /// which overrides both homes: `scratchpadURL` prefers the stored path, so
    /// the iCloud switch decides nothing while this is true and the Settings
    /// row says as much rather than offering a choice that does nothing.
    static var hasExplicitScratchpadPath: Bool {
        !(d.string(forKey: Key.scratchpadPath.rawValue) ?? "").isEmpty
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
        get { d.object(forKey: Key.storeInICloud.rawValue) == nil ? true : d.bool(forKey: Key.storeInICloud.rawValue) }
        set { d.set(newValue, forKey: Key.storeInICloud.rawValue) }
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
                return ScratchpadLocation.local.url(root: home.appendingPathComponent("Documents", isDirectory: true),
                                                    nameSuffix: AppFlavor.current.nameSuffix)
            }
            return ScratchpadLocation.iCloud.url(root: root, nameSuffix: AppFlavor.current.nameSuffix)
        case .local:
            return ScratchpadLocation.local.url(root: home.appendingPathComponent("Documents", isDirectory: true),
                                                nameSuffix: AppFlavor.current.nameSuffix)
        }
    }

    /// When set, Jot edits this document instead of the scratchpad.
    static var documentURL: URL? {
        get {
            guard let p = d.string(forKey: Key.documentPath.rawValue), !p.isEmpty else { return nil }
            return URL(fileURLWithPath: p)
        }
        set { d.set(newValue?.path ?? "", forKey: Key.documentPath.rawValue) }
    }

    /// The note the last New Note made, if any. Between the chosen document
    /// and the scratchpad in precedence: a document the user pointed Jot at
    /// outranks it, and it outranks the scratchpad, which is where Jot starts
    /// and returns when no note has been made.
    static var currentNoteURL: URL? {
        get {
            guard let p = d.string(forKey: Key.currentNotePath.rawValue), !p.isEmpty else { return nil }
            let url = URL(fileURLWithPath: p)
            // A note deleted from Finder must not leave Jot bound to nothing.
            return FileManager.default.fileExists(atPath: url.path) ? url : nil
        }
        set { d.set(newValue?.path ?? "", forKey: Key.currentNotePath.rawValue) }
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

    /// One stored path, with no existence filter on it.
    private static func stored(_ key: Key) -> URL? {
        guard let path = d.string(forKey: key.rawValue), !path.isEmpty else { return nil }
        return URL(fileURLWithPath: path)
    }

    /// The active file as the stored settings NAME it.
    ///
    /// `activeURL` resolves the same three settings through accessors that
    /// drop a path which is not on disk, which is right for opening a file and
    /// wrong for asking whether a setting moved: a note that was deleted makes
    /// `activeURL` change on its own. This one changes only when somebody
    /// changes a setting.
    static var storedActiveURL: URL {
        ActiveBinding.url(document: stored(.documentPath),
                          currentNote: stored(.currentNotePath),
                          scratchpad: stored(.scratchpadPath) ?? defaultScratchpadURL)
    }

    /// Write a moved file's new path back to the setting it came from.
    ///
    /// Asking which slot is in force cannot answer this: `currentNoteURL`'s
    /// getter returns nil for a path
    /// that is not on disk, so after a move it reports the slot the binding
    /// has fallen back to rather than the slot it came from. A Finder rename
    /// would then write the new path into `scratchpadPath` and leave
    /// `currentNotePath` naming a file that is gone: the panel follows the
    /// note, which looks right, while the scratchpad setting has been
    /// repointed at somebody's renamed note.
    ///
    /// Matched against the STORED strings rather than through the accessors,
    /// for the same reason: the accessors are what filter on existence.
    static func rebindActive(from old: URL, to url: URL) {
        switch ActiveBinding.slot(holding: old,
                                  document: stored(.documentPath),
                                  currentNote: stored(.currentNotePath),
                                  scratchpad: stored(.scratchpadPath)) {
        case .document: documentURL = url
        case .currentNote: currentNoteURL = url
        case .scratchpad: scratchpadURL = url
        // Nothing stored names it, so it is the default scratchpad location,
        // and pointing the scratchpad setting at where it went is what keeps
        // the panel on it next launch.
        case nil: scratchpadURL = url
        }
    }

    static var networkEnabled: Bool {
        get { d.bool(forKey: Key.networkEnabled.rawValue) }
        set { d.set(newValue, forKey: Key.networkEnabled.rawValue) }
    }

    static var toolbarLayout: ToolbarLayout {
        get { ToolbarLayout.fromJSON(d.string(forKey: Key.toolbarLayout.rawValue)) }
        set { d.set(newValue.json, forKey: Key.toolbarLayout.rawValue) }
    }

    static var fontPreset: String {
        get { d.string(forKey: Key.fontPreset.rawValue) ?? "serif" }
        set { d.set(newValue, forKey: Key.fontPreset.rawValue) }
    }

    static var fontSize: Int {
        get { d.object(forKey: Key.fontSize.rawValue) == nil ? 100 : d.integer(forKey: Key.fontSize.rawValue) }
        set { d.set(newValue, forKey: Key.fontSize.rawValue) }
    }

    static var contentWidth: String {
        get { d.string(forKey: Key.contentWidth.rawValue) ?? "full" }
        set { d.set(newValue, forKey: Key.contentWidth.rawValue) }
    }

    static var viewStateJSON: String? {
        get { d.string(forKey: Key.viewState.rawValue) }
        set { d.set(newValue, forKey: Key.viewState.rawValue) }
    }

    /// Where the last Save As went, so the next one opens there. A memory of
    /// the panel rather than a setting, which is why it is not in Settings.
    static var saveAsDirectory: URL? {
        get { d.string(forKey: Key.saveAsDirectory.rawValue).map { URL(fileURLWithPath: $0) } }
        set { d.set(newValue?.path, forKey: Key.saveAsDirectory.rawValue) }
    }

    /// Write while you type. Off means Jot stops writing on edits and nothing
    /// else: hiding the panel and quitting still write, because a preference
    /// that drops the buffer is not one anybody asked for
    /// (`BirtaJotCore.AutosavePolicy` holds that rule and its tests).
    static var autosave: Bool {
        get { d.object(forKey: Key.autosave.rawValue) == nil ? true : d.bool(forKey: Key.autosave.rawValue) }
        set { d.set(newValue, forKey: Key.autosave.rawValue) }
    }

    /// The shell command `/ai` runs, with `{prompt}` where the quoted request
    /// goes. The same shape as the extension's `birta.agent.command`, so a
    /// command tuned there can be pasted here unchanged. Empty turns `/ai` off:
    /// the capability is withdrawn and the page never offers the row.
    static var agentCommand: String {
        get { d.string(forKey: Key.agentCommand.rawValue) ?? "claude -p {prompt} --permission-mode acceptEdits" }
        set { d.set(newValue, forKey: Key.agentCommand.rawValue) }
    }

    /// Whether Jot has a Dock icon, and so appears in Cmd+Tab and gets an
    /// application menu bar of its own.
    ///
    /// Whether Jot has a Dock icon, and so appears in Cmd+Tab and gets an
    /// application menu bar of its own.
    ///
    /// OFF here, and ON in the welcome screen, and the two do not disagree:
    /// `applyOnboardingDefaults` writes the welcome's answer before that
    /// screen draws, so the switch and the setting are the same thing from the
    /// first frame. What this default governs is the case where the screen is
    /// never shown, and there the accessory app is what Jot has always been.
    ///
    /// `LSUIElement` in Info.plist matches this, so a launch never flashes an
    /// icon before the value is read; `Entry.main` applies it, and
    /// `AppDelegate` re-applies it when the switch moves.
    static var showInDock: Bool {
        get { d.bool(forKey: Key.showInDock.rawValue) }
        set { d.set(newValue, forKey: Key.showInDock.rawValue) }
    }

    /// Whether this install has never stored a setting.
    ///
    /// The absence of every key, which is what a first launch looks like and
    /// nothing else does.
    ///
    /// EVERY key, `hasSeenWelcome` included. Its setter stores `false` rather
    /// than removing it, so the key is present either way, and `reset`
    /// deliberately leaves it set: excluding it here would make the state
    /// after a reset indistinguishable from a first launch, and Show Welcome
    /// would then write the onboarding answers over a reset that was done to
    /// get out of them.
    static var isFirstLaunch: Bool {
        Key.allCases.allSatisfy { d.object(forKey: $0.rawValue) == nil }
    }

    /// Write the answers the welcome screen is about to SHOW, before it draws.
    ///
    /// The screen presents live settings, so anything it displays as on has to
    /// be on. Writing them here rather than flipping `showInDock`'s and
    /// `networkEnabled`'s accessor defaults is what keeps two different things
    /// apart: an onboarding default is a value somebody was shown and can
    /// refuse in the same gesture, and an accessor default is what applies to
    /// somebody who was never shown anything.
    ///
    /// FIRST LAUNCH ONLY, and that is the whole of the rule. An existing
    /// install reaches this screen too, because `hasSeenWelcome` is absent for
    /// everybody who had Jot before the screen existed, and writing onboarding
    /// answers there would reach into settings they have been living with: a
    /// Dock icon would appear on an app that never had one, and rich link
    /// previews would start making requests, both before a single click.
    /// Somebody already running Jot has answered these by leaving them alone.
    ///
    /// So an existing install sees the screen showing what it already does,
    /// which is the right thing for it to say.
    static func applyOnboardingDefaults() {
        guard isFirstLaunch else { return }
        showInDock = true
        autosave = true
        storeInICloud = true
        networkEnabled = true
    }

    /// Whether Jot checks for a newer release on its own.
    ///
    /// ON by default, and deliberately NOT riding `networkEnabled`. The two
    /// are different consents: that switch is about what happens to what you
    /// type, and this is about the app replacing itself. Riding it would mean
    /// somebody who wants no link previews also gets no fixes, and Jot is on
    /// no app store, so without this the only way to get one is to notice a
    /// release happened and run a shell script. `docs/NETWORK_POSTURE.md`
    /// carries the argument and the rung.
    ///
    /// The check is automatic; the replacement is never. Swapping the app
    /// somebody is typing into is not a thing to do behind them.
    static var autoUpdate: Bool {
        get { d.object(forKey: Key.autoUpdate.rawValue) == nil ? true : d.bool(forKey: Key.autoUpdate.rawValue) }
        set { d.set(newValue, forKey: Key.autoUpdate.rawValue) }
    }

    /// Whether the first-run screen has been shown and resolved.
    ///
    /// Set when that screen is RESOLVED rather than when it appears, so a
    /// crash during a first launch does not spend the one chance to ask.
    /// Cleared by the Advanced button that shows it again, which is the only
    /// other thing that writes it, and deliberately survived by `reset`.
    static var hasSeenWelcome: Bool {
        get { d.bool(forKey: Key.hasSeenWelcome.rawValue) }
        set { d.set(newValue, forKey: Key.hasSeenWelcome.rawValue) }
    }

    /// What summoning the panel opens, as the setting it always was.
    ///
    /// Stored as `openToBlankNote` still, because renaming a key strands the
    /// value a user already chose and this is the same question with a better
    /// name on it.
    static var noteMode: NoteMode {
        get { d.bool(forKey: Key.openToBlankNote.rawValue) ? .newEachSession : .sameNote }
        set { d.set(newValue == .newEachSession, forKey: Key.openToBlankNote.rawValue) }
    }

    /// Which of the three homes notes are in right now.
    static var noteHome: NoteHome {
        NoteHome.inForce(preferICloud: storeInICloud,
                         hasChosenPath: hasExplicitScratchpadPath,
                         iCloudAvailable: iCloudAvailable)
    }

    /// Whether launching starts a new empty note rather than reopening the
    /// last one. Off by default: a scratchpad that survives a restart is what
    /// most people summon a scratchpad for.
    static var openToBlankNote: Bool {
        get { d.bool(forKey: Key.openToBlankNote.rawValue) }
        set { d.set(newValue, forKey: Key.openToBlankNote.rawValue) }
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
