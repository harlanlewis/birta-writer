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
        case showInMenuBar
        case openToBlankNote
        case currentNotePath
        case storeInICloud
        case hasSeenWelcome
        case autoUpdate
        case agentEnabled
        case newNoteNameTemplate
        case lastUpdateCheck
        case updateDeclinedTag
        case lastNotesDirectory
        case lastScratchpadFile
        case tocVisibility
        case tocWidth
        case recentDocuments
        case proofreadOptions
        case styleExceptions
    }

    /// The keys a reset must NOT clear, each for a reason of its own.
    ///
    /// `hasSeenWelcome`: clearing it would make the next launch a first
    /// launch, and a first launch writes the onboarding answers, so a reset
    /// done to get back to a quiet, no-network state would put the network
    /// switch back on one launch later. The sheet says every setting goes back
    /// to its default, and that is what a default IS here; seeing the screen
    /// again is its own button.
    ///
    /// `lastNotesDirectory`: not a setting at all, but the record a launch
    /// compares against to notice that the notes folder moved. A reset can
    /// itself move it, by putting the iCloud switch and the chosen path back
    /// to their defaults, and clearing the record in the same breath is what
    /// would make that move the silent one this record exists to catch.
    ///
    /// `lastScratchpadFile`: the same record, one level down. A rename moves
    /// the folder and renames the note inside it, and the folder alone cannot
    /// say which of the carried files was the scratchpad.
    private static let survivesReset: Set<Key> = [
        .hasSeenWelcome, .lastNotesDirectory, .lastScratchpadFile,
    ]

    /// Put every setting back to its default, and touch no file on disk.
    ///
    /// The note is deliberately not in scope. A reset is about the settings a
    /// person can no longer reason about, and deleting their writing to fix a
    /// hotkey is not a trade anybody would take; the file stays exactly where
    /// it is, and Jot rebinds to the default location, so the old note is one
    /// Choose away rather than gone.
    ///
    /// Two things beyond `Key` that a reset has to reach, each of which
    /// would otherwise survive it and make the reset a lie:
    ///
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
        for key in Key.allCases where !survivesReset.contains(key) {
            d.removeObject(forKey: key.rawValue)
        }
        hasSeenWelcome = true
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
            return storedScratchpadURL
        }
        // Nil clears the stored path, which puts the off branch back on the
        // folder under Documents. Nothing clears it to make the iCloud switch
        // work: `storedScratchpadURL` reads it only under the branch that owns
        // it, so a path left set overrules nothing.
        set { d.set(newValue?.path ?? "", forKey: Key.scratchpadPath.rawValue) }
    }

    /// The scratchpad the SETTINGS name: no environment override, no
    /// existence filter, and the branch in force deciding.
    ///
    /// One rule with two readers, `scratchpadURL` and `storedActiveURL`, so
    /// the two cannot come to disagree about which folder a stored path
    /// belongs to.
    private static var storedScratchpadURL: URL {
        guard noteHome == .chosen,
              let path = d.string(forKey: Key.scratchpadPath.rawValue), !path.isEmpty else {
            return defaultScratchpadURL
        }
        return URL(fileURLWithPath: path)
    }

    /// Whether the user has named a folder of their own.
    ///
    /// The OFF branch's stored value rather than an override of the iCloud
    /// switch: `NoteHome.inForce` reads it only once the switch has landed on
    /// that branch, which is what lets the choice be remembered rather than
    /// thrown away every time somebody tries iCloud. Whether it is in force is
    /// a different question, and `noteHome == .chosen` is the one that answers
    /// it.
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
    /// name is what the window titles itself with, and "Birta Writer" is
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

    /// WHICH of the three settings supplies `activeURL`.
    ///
    /// The pair a window is opened with: the file, and the slot it came
    /// through, so a rename later writes back to the same one. Both derive
    /// from `ActiveBinding`, which is written so the two cannot disagree.
    ///
    /// Never nil, unlike a window's own `bindingSlot`: this answers what the
    /// app would open right now, and something always supplies that, down to
    /// the default scratchpad location.
    static var activeSlot: ActiveBinding.Slot {
        ActiveBinding.slot(hasDocument: documentURL != nil, hasCurrentNote: currentNoteURL != nil)
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
                          scratchpad: storedScratchpadURL)
    }

    /// WHICH stored setting names `url`, if any.
    ///
    /// Nil is the default scratchpad location, which no setting names, and a
    /// caller asking whose file this is should read it as the scratchpad
    /// rather than as an unknown.
    ///
    /// Against the STORED strings rather than through the accessors, which
    /// filter on existence: a file that has just been moved or is not yet on
    /// disk still belongs to the setting that names it.
    static func slot(holding url: URL) -> ActiveBinding.Slot? {
        ActiveBinding.slot(holding: url,
                           document: stored(.documentPath),
                           currentNote: stored(.currentNotePath),
                           scratchpad: stored(.scratchpadPath))
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
    /// Write a moved file back to the slot the WINDOW holding it was bound
    /// through.
    ///
    /// The slot is the window's rather than something derived here from the
    /// old path, and that difference is the whole point. Matching a path
    /// against the stored settings answers "which setting names this file",
    /// which was the same question while there was one window and is a
    /// different one once there are several: a window can be on a file that no
    /// setting names, because another window has since claimed the slot it was
    /// opened through.
    ///
    /// `nil` therefore means what it says: nothing to write back. It used to
    /// mean "the default scratchpad location", and adopting the scratchpad was
    /// right for that, because with one window the only way to be named by no
    /// setting was to be the default. Keeping that fallback here would take a
    /// person's scratchpad setting and point it at whatever unrelated file they
    /// happened to rename in a second window. The default-scratchpad case is
    /// still handled, one level up: a window on it is bound through
    /// `.scratchpad` and says so.
    static func rebind(from old: URL, to url: URL, slot: ActiveBinding.Slot?) {
        _ = old
        switch slot {
        case .document: documentURL = url
        case .currentNote: currentNoteURL = url
        case .scratchpad: adoptScratchpad(url)
        case nil: break
        }
    }

    /// Point the scratchpad setting at a file that has just moved, and put the
    /// location choice where that file now is.
    ///
    /// Writing the path alone would be a write nothing reads. The stored path
    /// is the off branch's value (`NoteHome`), so under the iCloud branch the
    /// scratchpad goes on being derived and the renamed file is abandoned at
    /// the next resolve. Moving that file IS the choice of a folder of one's
    /// own, so the switch has to name that branch rather than be left claiming
    /// a note the app no longer opens.
    private static func adoptScratchpad(_ url: URL) {
        scratchpadURL = url
        storeInICloud = false
        // What is derived has just changed with it, and the record a launch
        // compares against is only useful while it is in step.
        recordNotesDerivation()
    }

    static var networkEnabled: Bool {
        get { d.bool(forKey: Key.networkEnabled.rawValue) }
        set { d.set(newValue, forKey: Key.networkEnabled.rawValue) }
    }

    static var toolbarLayout: ToolbarLayout {
        get { ToolbarLayout.fromJSON(d.string(forKey: Key.toolbarLayout.rawValue)) }
        set { d.set(newValue.json, forKey: Key.toolbarLayout.rawValue) }
    }

    /// The three display defaults, named once rather than inlined in each
    /// getter, so `changedSettingsDescription` can ask whether a value still
    /// IS the default without a second copy of it to keep in step.
    static let defaultFontPreset = "serif"
    static let defaultFontSize = 100
    static let defaultContentWidth = "full"

    static var fontPreset: String {
        get { d.string(forKey: Key.fontPreset.rawValue) ?? defaultFontPreset }
        set { d.set(newValue, forKey: Key.fontPreset.rawValue) }
    }

    static var fontSize: Int {
        get { d.object(forKey: Key.fontSize.rawValue) == nil ? defaultFontSize : d.integer(forKey: Key.fontSize.rawValue) }
        set { d.set(newValue, forKey: Key.fontSize.rawValue) }
    }

    static var contentWidth: String {
        get { d.string(forKey: Key.contentWidth.rawValue) ?? defaultContentWidth }
        set { d.set(newValue, forKey: Key.contentWidth.rawValue) }
    }

    /// The Checks menu's answers, by the page's own option key.
    ///
    /// Stored opaquely: the keys are the page's vocabulary
    /// (`ProofreadOptionKey`), and the one of them whose name differs from its
    /// config field is translated in the page, where that mapping already
    /// lives. Nothing here knows what a key means, which is deliberate, because
    /// a shell that thought it knew is what switched this whole feature off for
    /// as long as it did (`initialConfig` in webview/plugins/proofread.ts).
    ///
    /// Only what the reader has CHANGED is kept, so a default that moves later
    /// moves for everyone who never touched the row.
    static var proofreadOptions: [String: Bool] {
        get { (d.dictionary(forKey: Key.proofreadOptions.rawValue) as? [String: Bool]) ?? [:] }
        set { d.set(newValue, forKey: Key.proofreadOptions.rawValue) }
    }

    /// Phrases the reader has claimed as their own, in the order they claimed
    /// them. No cap: a person adds these one at a time, by hand, on a phrase
    /// they wrote, so the list is bounded by how much writing they have done.
    static var styleExceptions: [String] {
        get { (d.array(forKey: Key.styleExceptions.rawValue) as? [String]) ?? [] }
        set { d.set(newValue, forKey: Key.styleExceptions.rawValue) }
    }

    /// Keep one phrase, unless it is already kept.
    static func rememberStyleException(_ phrase: String) {
        var kept = styleExceptions
        guard !kept.contains(phrase) else { return }
        kept.append(phrase)
        styleExceptions = kept
    }

    /// Record one row of the Checks menu.
    static func rememberProofreadOption(key: String, value: Bool) {
        var options = proofreadOptions
        options[key] = value
        proofreadOptions = options
    }

    /// The files the app has been pointed at lately, newest first.
    ///
    /// Paths rather than bookmarks, matching every other file this app
    /// remembers (`documentPath`, `currentNotePath`, `scratchpadPath`). A
    /// bookmark would follow a file that moved, which is the better answer and
    /// a different one from the rest of this file's; a row whose file has gone
    /// is simply not drawn (`RecentFiles.rows`).
    ///
    /// Bounded on the way IN rather than on the way out, so nothing here can
    /// grow without limit whatever a later reader does with it.
    static var recentDocuments: [URL] {
        get { (d.array(forKey: Key.recentDocuments.rawValue) as? [String] ?? []).map { URL(fileURLWithPath: $0) } }
        set {
            d.set(Array(newValue.prefix(RecentFiles.capacity)).map(\.path),
                  forKey: Key.recentDocuments.rawValue)
        }
    }

    /// Put `url` at the front of the list.
    static func rememberRecent(_ url: URL) {
        recentDocuments = RecentFiles.recording(url, into: recentDocuments)
    }

    /// The outline panel as the reader last left it, so a page load puts it
    /// back rather than starting from a rule of this app's own.
    ///
    /// A memory of the window rather than a setting, which is why none of the
    /// three is in Settings: each has a control on the panel itself (the hide
    /// button, the flip arrows, the drag handle), and a control whose result
    /// the next launch throws away is a control that half works.
    ///
    /// "hidden" is the first-launch answer. The page's other value, "auto",
    /// opens the sidebar once a document has enough headings, which is a good
    /// rule for an editor pane and the wrong one for a window this size.
    static var tocVisibility: String {
        get { d.string(forKey: Key.tocVisibility.rawValue) ?? "hidden" }
        set { d.set(newValue, forKey: Key.tocVisibility.rawValue) }
    }

    /// Nil until the reader has dragged the panel's edge, so the page keeps its
    /// own default width until then. The page clamps whatever it is given, so
    /// its bounds are not restated here.
    static var tocWidth: Int? {
        get { d.object(forKey: Key.tocWidth.rawValue) == nil ? nil : d.integer(forKey: Key.tocWidth.rawValue) }
        set { d.set(newValue, forKey: Key.tocWidth.rawValue) }
    }

    /// The editor's own memory of a DOCUMENT: where it was scrolled, which
    /// sections were folded, where the caret was.
    ///
    /// Keyed by file, where it used to be one value for the whole app. One
    /// value was indistinguishable from correct while there was one buffer,
    /// and is a visible defect with several windows: every window writes this
    /// on every view-state message, so a window would mount at whatever
    /// position another one was left at, and a reload would restore one
    /// window's scroll into another.
    ///
    /// By PATH rather than by window, which is the more correct answer to
    /// begin with: a scroll position belongs to the document, so keying it
    /// this way also survives closing a file and opening it again, which a
    /// per-window slot would not.
    static func viewStateJSON(for url: URL) -> String? {
        viewStates[url.standardizedFileURL.path]
    }

    /// Bounded by the RECENTS list rather than by a counter of its own.
    ///
    /// This map grows with every file ever opened and nothing else would ever
    /// remove an entry. A file that has fallen off the last `RecentFiles`
    /// entries is one whose scroll position nobody is coming back for, and
    /// reusing that order means there is no second piece of recency
    /// bookkeeping to be kept in step with the first. The file being written
    /// is always kept, because it may not have joined the list yet.
    static func setViewStateJSON(_ json: String?, for url: URL) {
        let key = url.standardizedFileURL.path
        var states = viewStates
        if let json { states[key] = json } else { states.removeValue(forKey: key) }
        if states.count > RecentFiles.capacity {
            let keep = Set(recentDocuments.map(\.standardizedFileURL.path)).union([key])
            states = states.filter { keep.contains($0.key) }
        }
        d.set(states, forKey: Key.viewState.rawValue)
    }

    /// Nil for the single string this key used to hold, so an install
    /// upgrading across this change forgets one scroll position rather than
    /// failing to read its settings.
    private static var viewStates: [String: String] {
        (d.dictionary(forKey: Key.viewState.rawValue) as? [String: String]) ?? [:]
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
        // The default is the fallback preset's own template rather than a
        // second copy of that string, so the template menu can always reach
        // the command a fresh install holds.
        get { d.string(forKey: Key.agentCommand.rawValue) ?? AgentPreset.fallback.template }
        set { d.set(newValue, forKey: Key.agentCommand.rawValue) }
    }

    /// Whether this host can hand a prompt to an agent at all.
    ///
    /// Two ways to have none, and the row and the capability must agree with
    /// both: the switch is off, or there is no command to run. Asking here
    /// rather than at each call site is what keeps them from disagreeing.
    static var agentAvailable: Bool {
        AgentAvailability.isAvailable(enabled: agentEnabled, command: agentCommand)
    }

    /// Whether Jot has a Dock icon, and so appears in Cmd+Tab and gets an
    /// application menu bar of its own.
    ///
    /// OFF, which is what the first-run screen therefore shows, because that
    /// screen draws live settings and nothing writes this one before it. A
    /// menu-bar accessory is what Jot is; the Dock icon is for somebody who
    /// wants it in Cmd+Tab, and it is one switch away on the first screen they
    /// see.
    ///
    /// `LSUIElement` in Info.plist matches this, so a launch never flashes an
    /// icon before the value is read; `Entry.main` applies it, and
    /// `AppDelegate` re-applies it when the switch moves.
    static var showInDock: Bool {
        get { d.bool(forKey: Key.showInDock.rawValue) }
        set { d.set(newValue, forKey: Key.showInDock.rawValue) }
    }

    /// Whether the app has an icon in the menu bar.
    ///
    /// ON, and the opposite default to the Dock icon beside it, because a
    /// menu-bar accessory is what this app IS: the item is where the panel is
    /// toggled from, and for anybody running without a Dock icon it is also
    /// the only route to About and Settings.
    ///
    /// Neither switch is free of the other. `AppPresence` holds the rule and
    /// both rows read it: either surface alone is enough to reach the app, and
    /// whichever is currently the last one on cannot be turned off. Nothing in
    /// this file enforces that, deliberately, because a setter that refused a
    /// value would leave the two switches disagreeing with what is stored.
    ///
    /// `AppDelegate.applyMenuBarPresence()` is what acts on it, at launch and
    /// whenever the switch moves, exactly as `applyActivationPolicy()` does
    /// for the Dock.
    static var showInMenuBar: Bool {
        get { d.object(forKey: Key.showInMenuBar.rawValue) == nil ? true : d.bool(forKey: Key.showInMenuBar.rawValue) }
        set { d.set(newValue, forKey: Key.showInMenuBar.rawValue) }
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

    /// Make true what the first-run screen is about to SHOW, before it draws.
    ///
    /// The screen presents live settings, so anything it displays as on has to
    /// be on. Almost nothing is left to do here, and that is the point rather
    /// than an omission: every switch it shows now agrees with the accessor
    /// default beside it, so the two cannot disagree by construction. Only the
    /// login item is not a preference, and a system registration has no
    /// default to agree with.
    ///
    /// Link previews and embeds is the row this function must never grow back.
    /// It
    /// is the only setting that reaches the network, it ships off, and the
    /// first-run screen does not ask about it, so nothing here may switch it
    /// on. That is the whole of the claim in `docs/NETWORK_POSTURE.md`.
    ///
    /// FIRST LAUNCH ONLY. An existing install reaches this screen too, because
    /// `hasSeenWelcome` is absent for everybody who had Jot before it existed,
    /// and registering a login item for them would be reaching into something
    /// they have been living with.
    ///
    /// AND THE PERSON'S OWN STORE ONLY, which is the same gate `Updater`
    /// keeps and for the same reason: `jot/scripts/measure.sh` launches a
    /// bundle out of `jot/build/` against a throwaway domain, so every run is
    /// a first launch, and without this each one registers a login item
    /// pointing into a build directory that the next checkout replaces. That
    /// is the hazard `LoginItem`'s own header names, and it is machine-wide
    /// litter that `jot/scripts/reap.sh` cannot see: a login item lives in
    /// BTM, not in a plist under our domain.
    ///
    /// The two halves and the effect are parameters so the arms can be tested
    /// without one. Both halves read TRUE inside an xctest process, because
    /// nothing sets `BIRTA_JOT_DEFAULTS_SUITE` there and the runner's own
    /// standard domain holds none of our keys, so a test that called this
    /// without a seam would take the acting branch and register a login item
    /// pointing at whatever ran the suite. That is worse than ordinary litter:
    /// it lives in BTM rather than in a plist under our domain, so
    /// `jot/scripts/reap.sh` cannot see it and cannot clear it.
    static func applyOnboardingDefaults(firstLaunch: Bool = isFirstLaunch,
                                        userStore: Bool = isUserStore,
                                        register: (Bool) -> Void = { _ = try? LoginItem.set($0) }) {
        let apply = firstLaunch && userStore
        // Traced because the interesting outcome is the one that does NOTHING,
        // and an absence is invisible: a login item lives in BTM rather than
        // in a plist, so a checking run cannot observe it having been written.
        // `jot/scripts/measure.sh` reads this.
        if ProcessInfo.processInfo.environment["BIRTA_JOT_MEASURE"] == "1" {
            FileHandle.standardError.write(Data(
                "jot-trace onboarding loginitem=\(apply ? "registered" : "skipped")\n".utf8))
        }
        guard apply else { return }
        // Shown on, so it is on. macOS can refuse, and the row says so.
        register(true)
    }

    /// Whether `/ai` is offered at all.
    ///
    /// OFF by default, which is a change of posture rather than a default
    /// picked at random: `/ai` runs a shell command on this Mac, and a
    /// capability that runs commands is one somebody should switch on rather
    /// than one they should discover already on. `agentCommand` still holds
    /// WHAT would run, so switching this on does not ask the question again.
    ///
    /// The command being empty still withdraws the capability too, so there
    /// are two ways to have no agent and neither of them can offer a row that
    /// runs nothing.
    static var agentEnabled: Bool {
        get { d.bool(forKey: Key.agentEnabled.rawValue) }
        set { d.set(newValue, forKey: Key.agentEnabled.rawValue) }
    }

    /// What a new note is called, as a `strftime` template.
    ///
    /// A template rather than a fixed name because the only thing anybody
    /// wants to change here is the date in it, and `strftime` is the spelling
    /// every other tool on the machine already uses for that. Ours is not a
    /// dialect: `NoteNameTemplate` expands the standard tokens and nothing
    /// else, so a format somebody knows from `date(1)` works here unchanged.
    static var newNoteNameTemplate: String {
        get {
            let stored = d.string(forKey: Key.newNoteNameTemplate.rawValue) ?? ""
            return stored.isEmpty ? NoteNameTemplate.default : stored
        }
        set { d.set(newValue, forKey: Key.newNoteNameTemplate.rawValue) }
    }

    /// The settings that differ from their defaults, one safe line each, for a
    /// feedback report to carry (MAR-395).
    ///
    /// The privacy rule is `shared/feedback/compose.ts`'s, and it is why this
    /// is a hand-written list rather than a dump of the defaults domain: **a
    /// setting's NAME is diagnostic, a setting's VALUE may be the user's
    /// data.** A note path, an agent command line and a filename template can
    /// each carry a directory name or a person's name, so those report only
    /// that they differ. What is quoted is what cannot carry either: a
    /// boolean, a number, a chord, or a value from a fixed set.
    ///
    /// Nothing here names the note, its path, or the folder it is in.
    ///
    /// Derived settings are reported and the facts they are derived FROM are
    /// not, so one choice produces one line: `noteHome` already says whether a
    /// path was chosen, and `openToBlankNote` is what `noteMode` reads.
    static func changedSettingsDescription() -> [String] {
        var lines: [String] = []
        func report(_ name: String, _ changed: Bool, _ value: String? = nil) {
            guard changed else { return }
            lines.append(value.map { "\(name): \($0)" } ?? "\(name): customized")
        }
        report("hotkey", hotkey != AppFlavor.current.defaultHotkey, hotkey.spelling)
        report("autosave", !autosave, "off")
        report("network", !networkEnabled, "off")
        report("automatic updates", !autoUpdate, "off")
        report("show in Dock", showInDock, "on")
        report("show in menu bar", !showInMenuBar, "off")
        report("agent", !agentEnabled, "off")
        report("agent command", agentEnabled && agentCommand != AgentPreset.fallback.template)
        report("note home", noteHome != .iCloud, noteHome.rawValue)
        report("open to a blank note", openToBlankNote, "on")
        report("new note name", newNoteNameTemplate != NoteNameTemplate.default)
        report("font", fontPreset != defaultFontPreset, fontPreset)
        report("font size", fontSize != defaultFontSize, String(fontSize))
        report("content width", contentWidth != defaultContentWidth, contentWidth)
        return lines
    }

    /// When the app last ASKED the release host, successfully or not.
    ///
    /// Stored so a re-check is paced by wall-clock time rather than by how
    /// often the panel is summoned. Jot is a menu-bar app that stays running
    /// for weeks, so a check tied to launch alone is a check that stops
    /// happening exactly for the people who use it most.
    static var lastUpdateCheck: Date? {
        get {
            let seconds = d.double(forKey: Key.lastUpdateCheck.rawValue)
            return seconds > 0 ? Date(timeIntervalSince1970: seconds) : nil
        }
        set { d.set(newValue?.timeIntervalSince1970 ?? 0, forKey: Key.lastUpdateCheck.rawValue) }
    }

    /// The release tag the user last said no to.
    ///
    /// One offer per version. Without it the re-check interval becomes a nag:
    /// somebody who declines an update is asked again every day until they
    /// give in, which teaches people to turn the setting off rather than to
    /// take the update. A NEWER tag still asks, because that is different news.
    static var updateDeclinedTag: String? {
        get {
            let tag = d.string(forKey: Key.updateDeclinedTag.rawValue) ?? ""
            return tag.isEmpty ? nil : tag
        }
        set { d.set(newValue ?? "", forKey: Key.updateDeclinedTag.rawValue) }
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

    /// The notes folder the app DERIVES, whether or not it is the one in
    /// force.
    ///
    /// Deliberately not `notesDirectory`, which answers to a path the user
    /// chose and to `BIRTA_JOT_SCRATCHPAD`. This one is spelled from the
    /// product name by `ScratchpadLocation`, which makes it the one a rename
    /// can move, and the only one worth recording.
    static var derivedNotesDirectory: URL {
        defaultScratchpadURL.deletingLastPathComponent()
    }

    /// The derived notes folder the last launch used.
    ///
    /// A stored fact rather than a derived one, and that is the whole point:
    /// after a rename the old spelling exists nowhere else, so without this
    /// there is nothing to compare the new derivation against.
    static var lastNotesDirectory: URL? {
        get { stored(.lastNotesDirectory) }
        set { d.set(newValue?.path ?? "", forKey: Key.lastNotesDirectory.rawValue) }
    }

    /// The derived scratchpad FILE the last launch used.
    ///
    /// The folder record answers where the writing was left; this answers
    /// which file in it the panel was opening. A rename changes both, and
    /// after one the old spelling of the file exists nowhere else either.
    static var lastScratchpadFile: URL? {
        get { stored(.lastScratchpadFile) }
        set { d.set(newValue?.path ?? "", forKey: Key.lastScratchpadFile.rawValue) }
    }

    /// Bring that record up to date. Called by whatever has just resolved the
    /// folder or changed where it is derived from.
    static func recordNotesDerivation() {
        lastNotesDirectory = derivedNotesDirectory
        lastScratchpadFile = defaultScratchpadURL
    }

    /// What the stranded folder's scratchpad was called, when that is known.
    ///
    /// Nil until a launch has recorded one, which is every launch from the
    /// first that runs this code. An install that is renamed in the window
    /// before then carries its notes across under their own names, exactly as
    /// it did before the file was recorded: the same price `StrandedNotes`
    /// already states for the folder, and stated rather than hidden.
    static var strandedScratchpadName: String? {
        guard let recorded = lastScratchpadFile, let stranded = strandedNotesDirectory else {
            return nil
        }
        guard recorded.deletingLastPathComponent().standardizedFileURL
            == stranded.standardizedFileURL else { return nil }
        return recorded.lastPathComponent
    }

    /// The folder a launch should offer to carry notes out of, if any.
    /// `StrandedNotes` holds every arm of the decision and why.
    static var strandedNotesDirectory: URL? {
        StrandedNotes.directory(
            recorded: lastNotesDirectory,
            derived: derivedNotesDirectory,
            usesChosenPath: noteHome == .chosen,
            exists: { url in
                var isDirectory: ObjCBool = false
                return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
                    && isDirectory.boolValue
            })
    }

    /// - Parameter viewStateFor: the file the window being booted is on, so
    ///   it is restored to its OWN remembered position. Every window asks with
    ///   its own binding.
    static func bootConfig(viewStateFor url: URL) -> BootConfig {
        BootConfig(
            toolbarJSON: toolbarLayout.json,
            fontPreset: fontPreset,
            fontSize: fontSize,
            contentWidth: contentWidth,
            proofreadOptions: proofreadOptions,
            styleExceptions: styleExceptions,
            tocVisibility: tocVisibility,
            tocWidth: tocWidth,
            networkEnabled: networkEnabled,
            // HOST_PROFILES.jot in shared/hostProfile.ts is the source;
            // Swift cannot import it, so this literal restates it and
            // shared/__tests__/hostProfile.test.ts parses this file and
            // fails when the two disagree.
            // The literal IS the profile, and the filter is what a user
            // setting withdraws from it. Kept as a literal on purpose: it is
            // the copy `shared/__tests__/hostProfile.test.ts` parses against
            // `HOST_PROFILES.jot`, and a list built by appending would give
            // that guard nothing to read.
            //
            // Withdrawing `agent` is a capability doing its job rather than a
            // feature flag sneaking in: a capability names what the HOST
            // provides, and with `/ai` switched off, or with no command to
            // run, this host provides no agent. `BootConfigTests` holds both
            // arms.
            hostCapabilities: ["spellAndGrammar", "imageUpload", "toc", "appPreferences", "agent"]
                .filter { $0 != "agent" || agentAvailable },
            viewStateJSON: viewStateJSON(for: url),
            hostShortcuts: JotMenu.shortcuts
        )
    }
}
